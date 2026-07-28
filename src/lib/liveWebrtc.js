/* =========================================================
   liveWebrtc — browser-native live publish/watch over WebRTC.

   Two flows, both talking WHIP/WHEP (the standard "one HTTP POST
   of an SDP offer, get an SDP answer back" handshake) to MediaMTX:

     · publishCamera(whipUrl)  — capture the camera + mic and GO LIVE.
       This is how you broadcast straight from the browser, the way
       TikTok / YouTube / Facebook do. Browsers CANNOT publish RTMP —
       only WebRTC — so this is the only in-app "go live" that works.
     · playWhep(whepUrl, video) — watch with sub-second latency.
       (HLS is the higher-latency, universal-reach fallback and stays
       in LivePage; this is the low-latency path.)

   Both return a handle with `.stop()` — always call it on teardown so
   the camera light goes off and the peer connection is released.
   ========================================================= */

/** Publish URLs (WHIP) carry the secret stream key as `?pass=`; MediaMTX
 *  forwards it to the backend auth hook. Nothing else here needs the key. */

// A plain STUN server helps ICE when you later run this off-localhost. On
// localhost it is harmless. Swap in your TURN server for viewers behind
// strict NATs in production.
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }]

/** Wait until ICE candidates are gathered, then we POST the complete offer
 *  (non-trickle WHIP/WHEP). On localhost this resolves almost instantly; the
 *  1.2s cap keeps a slow network from hanging the "Go live" button forever. */
function iceGathered(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    const done = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', done)
        resolve()
      }
    }
    pc.addEventListener('icegatheringstatechange', done)
    setTimeout(resolve, 1200)
  })
}

/** Prefer H264 on the video sender so the server's HLS remux works too
 *  (WHEP viewers are codec-agnostic, but HLS/mpegts-fmp4 wants H264). No-op
 *  where the API is missing — never let it break publishing. */
function preferH264(pc) {
  try {
    const tx = pc.getTransceivers().find((t) => t.sender?.track?.kind === 'video')
    if (!tx?.setCodecPreferences || !RTCRtpSender.getCapabilities) return
    const caps = RTCRtpSender.getCapabilities('video')
    if (!caps) return
    const h264 = caps.codecs.filter((c) => /H264/i.test(c.mimeType))
    if (h264.length) tx.setCodecPreferences([...h264, ...caps.codecs.filter((c) => !/H264/i.test(c.mimeType))])
  } catch { /* codec preferences are best-effort */ }
}

/**
 * Wait until the camera is actually DELIVERING frames, not merely opened.
 *
 * This is load-bearing, and the bug it fixes is invisible until you play the
 * recording back. `getUserMedia` resolves as soon as the device is acquired,
 * but Chrome starts the video *encoder* lazily — the first encoded frame can be
 * a second or more later, and longer on a tab that isn't focused. MediaMTX
 * finalises a WebRTC session's track list a beat after the peer connection is
 * established: whatever has produced data by then IS the stream, permanently.
 * Lose that race and the session is registered as AUDIO ONLY — viewers get
 * sound with no picture and, worse, the recording is written with no video
 * track at all, which plays back as a black rectangle.
 *
 * Observed directly in the MediaMTX log, same code, same machine:
 *     [recorder] recording 2 tracks (Opus, H264)   ← won the race
 *     [recorder] recording 1 track (Opus)          ← lost it
 *
 * So: pull one real frame through a detached <video> before we offer. Bounded,
 * because a camera that never yields a frame must not wedge "Go live" — going
 * live without the warm-up is still better than not going live.
 */
async function firstVideoFrame(media, timeoutMs = 4000) {
  const track = media.getVideoTracks?.()[0]
  if (!track) return
  const el = document.createElement('video')
  el.muted = true
  el.playsInline = true
  el.srcObject = media
  try {
    el.play?.().catch(() => { /* autoplay policy — muted playback is allowed */ })
    await new Promise((resolve) => {
      let settled = false
      const finish = () => { if (!settled) { settled = true; resolve() } }
      const timer = setTimeout(finish, timeoutMs)
      const done = () => { clearTimeout(timer); finish() }
      // rVFC fires on a DECODED frame — the real signal. `loadeddata` is the
      // fallback for engines without it (Firefox).
      if (typeof el.requestVideoFrameCallback === 'function') el.requestVideoFrameCallback(done)
      else el.addEventListener('loadeddata', done, { once: true })
    })
  } finally {
    // Detach only the element; the tracks stay live for the peer connection.
    el.srcObject = null
  }
}

/**
 * Tune the video sender so degradation can never take the picture to zero.
 *
 * Chrome's default `degradationPreference` for a camera is "balanced": under CPU
 * or uplink pressure it sheds BOTH resolution and framerate, and the framerate
 * floor is low enough to look like a freeze. `maintain-framerate` sheds pixels
 * instead, which is what a talking-head broadcast wants. The bitrate cap is the
 * other half — an uncapped sender on a weak uplink drives itself into loss, and
 * lost H264 packets are unrecoverable until the next keyframe (see watchVideo).
 */
function tuneVideoSender(pc, track) {
  try { if (track) track.contentHint = 'motion' } catch { /* not supported */ }
  const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
  if (!sender?.getParameters) return
  try {
    const params = sender.getParameters()
    params.degradationPreference = 'maintain-framerate'
    params.encodings = params.encodings?.length ? params.encodings : [{}]
    params.encodings[0].maxBitrate = 2_500_000
    params.encodings[0].maxFramerate = 30
    sender.setParameters(params).catch(() => { /* best-effort */ })
  } catch { /* best-effort — never let tuning break publishing */ }
}

/**
 * Outbound video encoder progress + downstream loss, gathered in one getStats
 * pass. Null before the first frame.
 *
 * `framesEncoded` only proves the LOCAL encoder is still running — it keeps
 * climbing even when every packet is lost in transit. `fractionLost` comes from
 * the RECEIVER's (MediaMTX's) RTCP reports via the remote-inbound entry, so it
 * reflects what actually arrived. That distinction is the whole point of the
 * loss check in watchVideo: an advancing encoder with a frozen picture.
 */
async function videoOutbound(pc) {
  try {
    const stats = await pc.getStats()
    let out = null
    let fractionLost = null
    stats.forEach((r) => {
      if (r.type === 'outbound-rtp' && (r.kind || r.mediaType) === 'video') out = r
      if (r.type === 'remote-inbound-rtp' && (r.kind || r.mediaType) === 'video'
          && typeof r.fractionLost === 'number') fractionLost = r.fractionLost
    })
    if (!out) return null
    return { framesEncoded: out.framesEncoded, fractionLost }
  } catch { return null }
}

/**
 * Keep the PICTURE alive for the whole broadcast — the fix for "the recording
 * freezes partway through but the sound keeps playing".
 *
 * A WebRTC video track can stop feeding the encoder mid-broadcast without the
 * peer connection ever leaving `connected`: the OS suspends the camera when the
 * display sleeps, another app grabs the device, a USB camera re-enumerates, or
 * a burst of loss leaves the H264 chain undecodable with no IDR coming (Chrome
 * only emits keyframes on request, so nothing ever repairs it). Audio is Opus —
 * every packet stands alone — so sound sails on regardless.
 *
 * Downstream that is silent and permanent: MediaMTX simply has no more video
 * samples to write, so the recording holds one frame to the end of the file
 * while the audio runs out the full duration.
 *
 * So: poll `framesEncoded`. If it stops advancing while the camera is meant to
 * be on, re-acquire the camera and `replaceTrack`. A brand-new encoder always
 * opens with a keyframe, which repairs both the live picture and everything
 * written from that point on. The transceiver is reused, so the published track
 * SET never changes — which matters, because a changed track set is exactly
 * what makes MediaMTX restart its recorder and split the file into parts
 * (BACKEND_LIVE_FINDINGS.md, P1).
 */
function watchVideo(pc, media, constraints, opts) {
  const POLL_MS = 2000
  const STALL_POLLS = 3          // ~6s of no encoded frames before we act
  const GRACE_MS = 6000          // the encoder is allowed to be slow to start
  const LOSS_FRACTION = 0.12     // >12% of an interval lost = the chain is breaking
  const LOSS_POLLS = 3           // sustained ~6s, so a one-off blip is ignored
  const LOSS_COOLDOWN_MS = 20000 // force at most one keyframe re-acquire / 20s

  let dead = false
  let last = -1
  let stalls = 0
  let lossy = 0
  let lastForcedKeyframeAt = 0
  let healing = false
  let startedAt = null

  const report = (state, detail) => { try { opts.onHealth?.(state, detail) } catch { /* host callback */ } }

  /* Swap in a fresh camera track. The old one is stopped FIRST: a device that
     was yanked or is held by another app will refuse a second concurrent open,
     and we would rather re-take the one we had than fail. */
  const heal = async (why) => {
    if (dead || healing) return
    healing = true
    report('stalled', why)
    try {
      const old = media.getVideoTracks()[0]
      try { old?.stop() } catch { /* already gone */ }
      const fresh = await navigator.mediaDevices.getUserMedia({ video: constraints.video, audio: false })
      const track = fresh.getVideoTracks()[0]
      if (!track) throw new Error('no video track')
      if (dead) { track.stop(); return }

      const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
      if (!sender) throw new Error('no video sender')
      await sender.replaceTrack(track)

      if (old) media.removeTrack(old)
      media.addTrack(track)
      /* Inherit the host's Camera-off state — healing must not silently switch
         their camera back on behind them. */
      if (old) track.enabled = old.enabled
      tuneVideoSender(pc, track)
      arm(track)

      last = -1; stalls = 0; lossy = 0; startedAt = null
      opts.onLocalStream?.(media)
      report('recovered')
    } catch (e) {
      report('lost', e?.message || 'the camera could not be reopened')
    } finally {
      healing = false
    }
  }

  /* `ended` is the device going away for good; `mute` is the browser telling us
     frames stopped arriving (screen lock, another app took the camera). Both
     mean the picture is gone right now — no need to wait out the poll. */
  function arm(track) {
    if (!track) return
    track.addEventListener('ended', () => heal('the camera was disconnected'))
    track.addEventListener('mute', () => heal('the camera stopped sending frames'))
  }
  arm(media.getVideoTracks()[0])

  const timer = setInterval(async () => {
    if (dead || healing) return
    const track = media.getVideoTracks()[0]
    // Camera deliberately off: black frames are correct, so don't "repair" them.
    if (!track || track.enabled === false) { last = -1; stalls = 0; lossy = 0; return }
    if (pc.connectionState !== 'connected' && pc.connectionState !== 'new') return

    const rtp = await videoOutbound(pc)
    const frames = rtp?.framesEncoded
    if (typeof frames !== 'number') return

    if (startedAt === null) startedAt = Date.now()
    if (Date.now() - startedAt < GRACE_MS) { last = frames; return }

    if (frames > last) {
      if (stalls) report('ok')
      last = frames; stalls = 0

      // The encoder is alive, but the PICTURE can still be frozen downstream: a
      // burst of loss breaks the H264 decode chain and — with no PLI coming back
      // from the media server — no keyframe ever repairs it, while framesEncoded
      // keeps climbing so the stall check above never fires. Detect sustained
      // receiver-reported loss and force a fresh keyframe by re-acquiring (a new
      // encoder always opens with an IDR). Rate-limited so a weak uplink, where
      // the re-acquire's keyframe would add to the congestion, can't thrash the
      // camera.
      const frac = typeof rtp.fractionLost === 'number' ? rtp.fractionLost : 0
      if (frac >= LOSS_FRACTION) {
        lossy += 1
        if (lossy >= LOSS_POLLS && Date.now() - lastForcedKeyframeAt >= LOSS_COOLDOWN_MS) {
          lastForcedKeyframeAt = Date.now()
          lossy = 0
          heal('packet loss froze the picture')
        }
      } else if (lossy) {
        lossy = 0
      }
      return
    }
    stalls += 1
    if (stalls >= STALL_POLLS) heal('the camera stopped producing frames')
  }, POLL_MS)

  return () => { dead = true; clearInterval(timer) }
}

/** Hold a screen wake lock while broadcasting. A sleeping display suspends the
 *  camera on most laptops — the single most common way a live picture dies with
 *  the tab still open. Re-taken on tab focus, because the lock is dropped
 *  whenever the page is hidden. */
function holdWakeLock() {
  if (!navigator.wakeLock?.request) return () => {}
  let sentinel = null
  let dead = false
  const take = () => {
    if (dead || document.visibilityState !== 'visible') return
    navigator.wakeLock.request('screen').then((s) => {
      if (dead) { s.release().catch(() => {}); return }
      sentinel = s
    }).catch(() => { /* denied or unsupported — not fatal */ })
  }
  take()
  document.addEventListener('visibilitychange', take)
  return () => {
    dead = true
    document.removeEventListener('visibilitychange', take)
    try { sentinel?.release() } catch { /* already released */ }
  }
}

/** POST an SDP offer to a WHIP/WHEP endpoint, return the answer SDP text. */
async function exchangeSdp(url, offerSdp, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: offerSdp,
    signal,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`)
  }
  return res.text()
}

/**
 * Capture the camera + mic and publish them to `whipUrl` (WebRTC/WHIP).
 * @param {string} whipUrl  host-only publish URL (carries the stream key).
 * @param {object} [opts]
 * @param {(state:string)=>void} [opts.onState]  RTCPeerConnection.connectionState changes.
 * @param {(media:MediaStream)=>void} [opts.onLocalStream]  fires as soon as the
 *        camera is captured, BEFORE the SDP exchange — attach the preview here.
 * @param {MediaStreamConstraints} [opts.constraints]
 * @param {(state:'stalled'|'recovered'|'lost'|'ok', detail?:string)=>void} [opts.onHealth]
 *        the PICTURE's health while live, independent of the connection state —
 *        see watchVideo. `stalled` → repairing, `recovered` → picture is back,
 *        `lost` → the camera could not be reopened and the host must act.
 * @returns {Promise<{pc:RTCPeerConnection, media:MediaStream, stop:()=>void}>}
 */
export async function publishCamera(whipUrl, opts = {}) {
  if (!whipUrl) throw new Error('This stream has no publish URL (are you the host?)')
  const constraints = opts.constraints || {
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: 'user' },
    audio: { echoCancellation: true, noiseSuppression: true },
  }

  const media = await navigator.mediaDevices.getUserMedia(constraints)
  const pc = new RTCPeerConnection({ iceServers: ICE })
  let stopped = false
  let unwatch = null
  let unlock = null
  const stop = () => {
    if (stopped) return
    stopped = true
    unwatch?.(); unlock?.()
    try { pc.close() } catch { /* already closed */ }
    media.getTracks().forEach((t) => t.stop())
  }

  try {
    /* Hand the caller the stream the moment it exists, BEFORE the handshake.
       Two reasons: the host sees their own camera immediately instead of
       staring at a black stage through the SDP round trip, and a preview that
       is already rendering keeps the capture pipeline awake going into it. */
    opts.onLocalStream?.(media)

    media.getTracks().forEach((t) => pc.addTrack(t, media))
    preferH264(pc)
    if (opts.onState) pc.addEventListener('connectionstatechange', () => opts.onState(pc.connectionState))

    // Don't offer until video is genuinely flowing — see firstVideoFrame.
    await firstVideoFrame(media)

    await pc.setLocalDescription(await pc.createOffer())
    await iceGathered(pc)
    const answer = await exchangeSdp(whipUrl, pc.localDescription.sdp, opts.signal)
    await pc.setRemoteDescription({ type: 'answer', sdp: answer })

    /* Tuning has to wait for the answer: encoding parameters only exist once
       the transceiver has been negotiated. */
    tuneVideoSender(pc, media.getVideoTracks()[0])
    unwatch = watchVideo(pc, media, constraints, opts)
    unlock = holdWakeLock()
    return { pc, media, stop }
  } catch (e) {
    stop()
    throw e
  }
}

/**
 * Watch a stream over WebRTC/WHEP (sub-second latency).
 * @param {string} whepUrl  public playback URL.
 * @param {HTMLVideoElement} videoEl
 * @param {object} [opts]
 * @param {(state:string)=>void} [opts.onState]
 * @returns {Promise<{pc:RTCPeerConnection, stop:()=>void}>}
 */
export async function playWhep(whepUrl, videoEl, opts = {}) {
  if (!whepUrl) throw new Error('This stream has no low-latency URL')
  const pc = new RTCPeerConnection({ iceServers: ICE })
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    try { pc.close() } catch { /* already closed */ }
    if (videoEl && videoEl.srcObject) videoEl.srcObject = null
  }

  try {
    // recvonly — we are only pulling the host's tracks down.
    pc.addTransceiver('video', { direction: 'recvonly' })
    pc.addTransceiver('audio', { direction: 'recvonly' })
    pc.ontrack = (e) => { if (videoEl && e.streams[0]) videoEl.srcObject = e.streams[0] }
    if (opts.onState) pc.addEventListener('connectionstatechange', () => opts.onState(pc.connectionState))

    await pc.setLocalDescription(await pc.createOffer())
    await iceGathered(pc)
    const answer = await exchangeSdp(whepUrl, pc.localDescription.sdp, opts.signal)
    await pc.setRemoteDescription({ type: 'answer', sdp: answer })
    return { pc, stop }
  } catch (e) {
    stop()
    throw e
  }
}
