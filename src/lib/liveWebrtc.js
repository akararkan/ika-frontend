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
 * @returns {Promise<{pc:RTCPeerConnection, media:MediaStream, stop:()=>void}>}
 */
export async function publishCamera(whipUrl, opts = {}) {
  if (!whipUrl) throw new Error('This stream has no publish URL (are you the host?)')
  const constraints = opts.constraints || {
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    audio: { echoCancellation: true, noiseSuppression: true },
  }

  const media = await navigator.mediaDevices.getUserMedia(constraints)
  const pc = new RTCPeerConnection({ iceServers: ICE })
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
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
