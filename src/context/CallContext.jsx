/* =========================================================
   Call context — voice/video over the ONE chat SSE stream.
   ---------------------------------------------------------
   The server owns the call LIFECYCLE (ring → answer → end) and is
   a BLIND RELAY for WebRTC signalling: it forwards `payload`
   verbatim and never parses it. The audio/video itself never
   touches the backend — it flows peer-to-peer, so everything
   below is ordinary WebRTC glued to six REST verbs and six SSE
   events.

   Mounted ABOVE <Layout/> (inside <ChatProvider>) for the same
   reason the chat provider is: a call must ring wherever you are
   in the app, not only on /chat, and there is exactly one socket
   to hear it on.

   Topology is a MESH — one RTCPeerConnection per remote peer.
   That is right for a 1:1 call and fine for a small group; a
   large group needs an SFU, which is deployment configuration
   sitting in front of these same signalling frames.

   Who offers? A deterministic tie-break on the two user ids
   (`myId < peerId` → I offer). Both sides run the same comparison
   and reach opposite answers, so exactly one offer is made and
   there is no glare to resolve. Do NOT replace this with "the
   caller always offers": in a group everyone is somebody's
   callee.
   ========================================================= */
/* eslint-disable react-refresh/only-export-components */
import React from 'react'
import { api } from '../api/index.js'
import { showToast } from '../components/ui.jsx'
import { useAuth } from './AuthContext.jsx'
import { useChat } from './ChatContext.jsx'
import { chatError } from '../components/chat/chatErrors.js'
import { openCallLog, recordCall } from '../components/chat/callLog.js'

const CallCtx = React.createContext(null)

/* STUN gets you through most home NATs; symmetric NATs need a TURN relay,
   which is per-deployment. Ship the URL list through the env rather than
   hardcoding, and fall back to public STUN so a dev build still connects. */
function iceServers() {
  const raw = import.meta.env?.VITE_ICE_SERVERS
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length) return parsed
    } catch { /* malformed env → fall through to the default */ }
  }
  return [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
}

/* ---------------------------------------------------------
   Ringtone — synthesised, not an asset.
   A two-tone warble on a WebAudio oscillator: no network fetch,
   no bundled mp3, and it can be started/stopped precisely. The
   context is created lazily on the first ring because browsers
   refuse to construct one before a user gesture on some engines.
   --------------------------------------------------------- */
function makeRinger() {
  let ctx = null, timer = null, stopped = true

  const beep = (freq, at, dur) => {
    if (!ctx) return
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    // Envelope the tone — a bare gain step clicks audibly on every repeat.
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(0.14, at + 0.04)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur)
    osc.connect(gain); gain.connect(ctx.destination)
    osc.start(at); osc.stop(at + dur + 0.05)
  }

  return {
    start(pattern = 'incoming') {
      if (!stopped) return
      stopped = false
      try {
        const AC = window.AudioContext || window.webkitAudioContext
        if (!AC) return
        ctx = ctx || new AC()
        ctx.resume?.()
      } catch { return }
      const cycle = () => {
        if (stopped || !ctx) return
        const t = ctx.currentTime
        if (pattern === 'outgoing') {
          beep(440, t, 0.9)                       // long single tone = ringing out
        } else {
          beep(660, t, 0.35); beep(880, t + 0.42, 0.35)   // warble = someone is calling
        }
        timer = setTimeout(cycle, pattern === 'outgoing' ? 3000 : 1800)
      }
      cycle()
    },
    stop() {
      stopped = true
      clearTimeout(timer); timer = null
    },
    dispose() {
      this.stop()
      try { ctx?.close() } catch { /* already closed */ }
      ctx = null
    },
  }
}

/* ---------------------------------------------------------
   Voice-activity meters.
   ---------------------------------------------------------
   "Who is talking" cannot come off the wire — there is no such
   signal in the relay — so it is measured locally from the audio
   itself: one AnalyserNode per stream, sampled on a single
   shared interval, RMS → 0..1.

   Two details that are easy to get wrong:
   · ONE AudioContext for the whole call. A context per stream
     exhausts the browser's hard limit (~6) in a five-person call
     and every meter after that silently reads zero.
   · A remote MediaStream only produces samples once it is also
     attached to a media element. The overlay does that (the
     <video> in every tile, including the 1px ones in the
     collapsed pill), which is why those elements are shrunk
     rather than unmounted.
   --------------------------------------------------------- */
function makeMeters() {
  let ctx = null
  const nodes = new Map()      // key -> { source, analyser, buf, stream }

  const ensureCtx = () => {
    if (ctx) return ctx
    try {
      const AC = window.AudioContext || window.webkitAudioContext
      ctx = AC ? new AC() : null
      ctx?.resume?.()
    } catch { ctx = null }
    return ctx
  }

  return {
    attach(key, stream) {
      if (!stream || nodes.has(key)) return
      if (!stream.getAudioTracks?.().length) return
      const c = ensureCtx()
      if (!c) return
      try {
        const source = c.createMediaStreamSource(stream)
        const analyser = c.createAnalyser()
        analyser.fftSize = 512
        analyser.smoothingTimeConstant = 0.7
        source.connect(analyser)
        // Deliberately NOT connected to the destination: the audio is already
        // playing through the media element, and a second path would double it.
        nodes.set(key, { source, analyser, buf: new Uint8Array(analyser.frequencyBinCount), stream })
      } catch { /* a stream with no live audio track */ }
    },
    detach(key) {
      const n = nodes.get(key)
      if (!n) return
      try { n.source.disconnect() } catch { /* already gone */ }
      nodes.delete(key)
    },
    keys() { return [...nodes.keys()] },
    /** key → 0..1 loudness, sampled now. */
    read() {
      const out = {}
      for (const [key, n] of nodes) {
        n.analyser.getByteTimeDomainData(n.buf)
        let sum = 0
        for (let i = 0; i < n.buf.length; i++) {
          const v = (n.buf[i] - 128) / 128
          sum += v * v
        }
        // RMS is tiny for speech (~0.03–0.15); ×4 puts a normal voice near 0.5.
        out[key] = Math.min(1, Math.sqrt(sum / n.buf.length) * 4)
      }
      return out
    },
    dispose() {
      for (const key of [...nodes.keys()]) this.detach(key)
      try { ctx?.close() } catch { /* already closed */ }
      ctx = null
    },
  }
}

/** Above this, the tile lights up. Low enough for a quiet talker, high enough
 *  that keyboard clatter and fan noise do not strobe every tile in the grid. */
const SPEAKING_AT = 0.12

export function CallProvider({ children }) {
  const { user } = useAuth()
  const { subscribe, getConvo } = useChat()
  const myId = user?.id || null

  const [call, setCall] = React.useState(null)          // the CallResponse view
  const [phase, setPhase] = React.useState('idle')      // idle|incoming|outgoing|active|ending
  const [localStream, setLocalStream] = React.useState(null)
  const [remotes, setRemotes] = React.useState([])       // [{ userId, stream }]
  const [micOn, setMicOn] = React.useState(true)
  const [camOn, setCamOn] = React.useState(true)
  const [screenOn, setScreenOn] = React.useState(false)
  const [startedAt, setStartedAt] = React.useState(null)
  const [minimized, setMinimized] = React.useState(false)
  const [levels, setLevels] = React.useState({})         // 'me' | peerUserId -> 0..1
  const [peerStates, setPeerStates] = React.useState({}) // peerUserId -> RTCPeerConnectionState
  const [quality, setQuality] = React.useState('good')   // good | fair | poor — worst peer
  const [devices, setDevices] = React.useState({ audio: [], video: [] })

  // ----- refs read synchronously inside async signalling handlers -----
  const myIdRef = React.useRef(null)
  const callRef = React.useRef(null)
  const phaseRef = React.useRef('idle')
  const localRef = React.useRef(null)
  const pcsRef = React.useRef(new Map())                 // peerUserId -> RTCPeerConnection
  const iceQueueRef = React.useRef(new Map())            // peerUserId -> [candidate] (pre-SDP arrivals)
  const ringerRef = React.useRef(null)
  const metersRef = React.useRef(null)
  const camTrackRef = React.useRef(null)                 // parked while a screen share is up
  const screenTrackRef = React.useRef(null)
  const statsRef = React.useRef(new Map())               // peerUserId -> last stats sample
  /* The call being logged. Filled the moment a call exists (in either
     direction), stamped with `answeredAt` when it connects, and committed
     exactly once by `teardown`. */
  const draftRef = React.useRef(null)

  React.useEffect(() => { myIdRef.current = myId }, [myId])
  React.useEffect(() => { callRef.current = call }, [call])
  React.useEffect(() => { phaseRef.current = phase }, [phase])
  React.useEffect(() => { localRef.current = localStream }, [localStream])

  // The log is per-account: point it at whoever is signed in, and swap the
  // whole store (never merge) when that changes.
  React.useEffect(() => { openCallLog(myId) }, [myId])

  /* The ringer owns an AudioContext, so it is built in an effect rather than
     lazily during render — a render-phase side effect would leak a second
     context under StrictMode's double-invoke and again on every remount.
     Every call site uses `?.`, so the one frame before this runs is safe. */
  React.useEffect(() => {
    const ringer = makeRinger()
    ringerRef.current = ringer
    return () => { ringer.dispose(); ringerRef.current = null }
  }, [])

  /* ---------------- the call log ---------------- */

  /** Open a draft entry. Called once per call, in whichever direction. */
  const beginLog = React.useCallback((c, outgoing) => {
    if (!c?.id) return
    if (draftRef.current?.id === String(c.id)) return
    draftRef.current = {
      id: String(c.id),
      convId: String(c.conversationId || ''),
      video: !!c.video,
      outgoing: !!outgoing,
      startedAt: Date.now(),
      answeredAt: null,
      peerIds: (c.participants || [])
        .map(p => String(p.userId))
        .filter(uid => uid !== String(myIdRef.current)),
    }
  }, [])

  const answeredLog = React.useCallback(() => {
    const d = draftRef.current
    if (d && !d.answeredAt) d.answeredAt = Date.now()
  }, [])

  /** Commit exactly once. `outcome` may be omitted — a call that connected is
   *  "answered", one that never did is "no answer" outbound / "missed" in. */
  const commitLog = React.useCallback((outcome) => {
    const d = draftRef.current
    if (!d) return
    draftRef.current = null
    if (!d.convId) return                       // nothing to attach a card to
    const endedAt = Date.now()
    const answered = !!d.answeredAt
    recordCall({
      id: d.id,
      convId: d.convId,
      video: d.video,
      outgoing: d.outgoing,
      outcome: answered ? 'answered' : (outcome || (d.outgoing ? 'noanswer' : 'missed')),
      startedAt: d.startedAt,
      endedAt,
      durationMs: answered ? endedAt - d.answeredAt : 0,
      peerIds: d.peerIds,
    })
  }, [])

  /* ---------------- teardown ---------------- */

  const closePeers = React.useCallback(() => {
    for (const pc of pcsRef.current.values()) {
      try { pc.onicecandidate = null; pc.ontrack = null; pc.onconnectionstatechange = null; pc.close() }
      catch { /* already closed */ }
    }
    pcsRef.current.clear()
    iceQueueRef.current.clear()
    statsRef.current.clear()
    setRemotes([])
    setPeerStates({})
  }, [])

  /* Every exit path funnels through here, and every one of them passes the
     REASON the call ended — that word is the difference between "Missed call"
     and "Outgoing call · 4:12" in the timeline, and it is not recoverable
     afterwards. Stopping the local tracks is what turns the camera light off;
     closing the peer connections does not. */
  const teardown = React.useCallback((outcome) => {
    ringerRef.current?.stop()
    commitLog(outcome)
    closePeers()
    metersRef.current?.dispose()
    metersRef.current = null
    const s = localRef.current
    if (s) { for (const t of s.getTracks()) { try { t.stop() } catch { /* noop */ } } }
    // A screen share owns a second, independent track: stopping only the
    // camera leaves the browser's "sharing your screen" bar up after the call.
    try { screenTrackRef.current?.stop() } catch { /* noop */ }
    try { camTrackRef.current?.stop() } catch { /* noop */ }
    screenTrackRef.current = null
    camTrackRef.current = null
    localRef.current = null
    setLocalStream(null)
    setCall(null); callRef.current = null
    setPhase('idle'); phaseRef.current = 'idle'
    setStartedAt(null)
    setMicOn(true); setCamOn(true); setScreenOn(false)
    setMinimized(false)
    setLevels({}); setQuality('good')
  }, [closePeers, commitLog])

  React.useEffect(() => () => teardown(), [teardown])

  /* ---------------- media ---------------- */

  const acquireMedia = React.useCallback(async (wantVideo) => {
    if (localRef.current) return localRef.current
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser cannot access the microphone.')
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: wantVideo ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false,
    })
    localRef.current = stream
    setLocalStream(stream)
    return stream
  }, [])

  /* ---------------- signalling ---------------- */

  const sendSignal = React.useCallback((toUserId, kind, payload) => {
    const c = callRef.current
    if (!c?.id || !toUserId) return
    // Fire-and-forget: a dropped ICE frame is normal and the next candidate or
    // an ICE restart recovers. Surfacing every failure here would spam toasts
    // during a perfectly healthy connection.
    api.chat.calls.signal(c.id, { toUserId, kind, payload: JSON.stringify(payload) }).catch(() => {})
  }, [])

  /** Get (or build) the peer connection for one remote participant. */
  const peerFor = React.useCallback((peerId) => {
    const existing = pcsRef.current.get(peerId)
    if (existing) return existing

    const pc = new RTCPeerConnection({ iceServers: iceServers() })
    pcsRef.current.set(peerId, pc)

    for (const track of (localRef.current?.getTracks() || [])) {
      try { pc.addTrack(track, localRef.current) } catch { /* track already added */ }
    }

    pc.onicecandidate = (e) => { if (e.candidate) sendSignal(peerId, 'ICE', e.candidate.toJSON()) }

    pc.ontrack = (e) => {
      const stream = e.streams?.[0]
      if (!stream) return
      // Replace-by-userId, not append: renegotiation fires ontrack again and a
      // push would render the same peer twice.
      setRemotes(prev => {
        const rest = prev.filter(r => String(r.userId) !== String(peerId))
        return [...rest, { userId: peerId, stream }]
      })
    }

    pc.onconnectionstatechange = () => {
      // Surfaced so the overlay can say "Reconnecting…" instead of showing a
      // frozen tile with no explanation. `disconnected` is usually transient —
      // it is a warning, not an ending.
      setPeerStates(prev => ({ ...prev, [String(peerId)]: pc.connectionState }))
      if (pc.connectionState === 'failed') {
        // A failed transport is recoverable — restart ICE from the offering
        // side only, so both peers don't fight over a fresh offer.
        if (String(myIdRef.current) < String(peerId)) {
          pc.restartIce?.()
        }
      }
      if (pc.connectionState === 'closed') {
        setRemotes(prev => prev.filter(r => String(r.userId) !== String(peerId)))
      }
    }

    return pc
  }, [sendSignal])

  /** Drain candidates that arrived before we had a remote description. */
  const drainIce = React.useCallback(async (peerId, pc) => {
    const queued = iceQueueRef.current.get(peerId)
    if (!queued?.length) return
    iceQueueRef.current.delete(peerId)
    for (const cand of queued) {
      try { await pc.addIceCandidate(cand) } catch { /* stale candidate */ }
    }
  }, [])

  /** Offer to every JOINED peer I am responsible for (deterministic split). */
  const negotiate = React.useCallback(async (c) => {
    const me = String(myIdRef.current)
    const peers = (c?.participants || [])
      .filter(p => p.state === 'JOINED' && String(p.userId) !== me)
      .map(p => String(p.userId))

    for (const peerId of peers) {
      if (pcsRef.current.has(peerId)) continue          // already negotiating/connected
      if (!(me < peerId)) continue                      // the other side owns this offer
      const pc = peerFor(peerId)
      try {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        sendSignal(peerId, 'OFFER', pc.localDescription)
      } catch {
        showToast('Could not start the call media')
      }
    }
  }, [peerFor, sendSignal])

  const onSignal = React.useCallback(async (signal) => {
    const from = String(signal?.fromUserId || '')
    if (!from || !callRef.current) return
    let payload = signal.payload
    if (typeof payload === 'string') { try { payload = JSON.parse(payload) } catch { /* raw */ } }
    if (!payload) return

    if (signal.kind === 'OFFER') {
      const pc = peerFor(from)
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(payload))
        await drainIce(from, pc)
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        sendSignal(from, 'ANSWER', pc.localDescription)
      } catch { /* the offerer will retry on ICE failure */ }
      return
    }

    if (signal.kind === 'ANSWER') {
      const pc = pcsRef.current.get(from)
      if (!pc) return
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(payload))
        await drainIce(from, pc)
      } catch { /* out-of-order answer */ }
      return
    }

    // ICE. A candidate can legitimately beat the SDP it belongs to — queue it
    // rather than dropping it, or the connection stalls on a slow relay.
    const pc = pcsRef.current.get(from)
    const cand = new RTCIceCandidate(payload)
    if (!pc || !pc.remoteDescription) {
      const q = iceQueueRef.current.get(from) || []
      q.push(cand)
      iceQueueRef.current.set(from, q)
      return
    }
    try { await pc.addIceCandidate(cand) } catch { /* stale */ }
  }, [peerFor, drainIce, sendSignal])

  /* ---------------- voice activity ----------------
     One interval for the whole call rather than one per tile. It runs at 12Hz
     — fast enough that a speaking ring feels attached to the voice, slow
     enough that it costs nothing — and only commits to state when a level
     actually moved, because this is the one thing in the app that would
     otherwise re-render on a timer for the entire duration of a call. */
  React.useEffect(() => {
    if (phase !== 'active') return undefined
    const meters = metersRef.current || (metersRef.current = makeMeters())
    const wanted = new Set(['me', ...remotes.map(r => String(r.userId))])
    if (localStream) meters.attach('me', localStream)
    for (const r of remotes) meters.attach(String(r.userId), r.stream)
    for (const key of meters.keys()) { if (!wanted.has(key)) meters.detach(key) }

    const iv = setInterval(() => {
      const next = meters.read()
      setLevels(prev => {
        const keys = new Set([...Object.keys(prev), ...Object.keys(next)])
        let changed = false
        const out = {}
        for (const k of keys) {
          const v = Math.round((next[k] ?? 0) * 20) / 20      // 5% buckets
          out[k] = v
          if (prev[k] !== v) changed = true
        }
        return changed ? out : prev
      })
    }, 80)
    return () => clearInterval(iv)
  }, [phase, remotes, localStream])

  /* ---------------- link quality ----------------
     Sampled from getStats every 3s and reported as one word. Packet loss is a
     DELTA between samples — the cumulative counter only ever grows, so a call
     that dropped packets in its first ten seconds would read "poor" forever. */
  React.useEffect(() => {
    if (phase !== 'active') return undefined
    let alive = true
    const sample = async () => {
      let worst = 'good'
      const rank = { good: 0, fair: 1, poor: 2 }
      for (const [peerId, pc] of pcsRef.current) {
        let lost = 0, received = 0, rtt = 0
        try {
          const report = await pc.getStats()
          report.forEach(s => {
            if (s.type === 'inbound-rtp' && !s.isRemote) {
              lost += s.packetsLost || 0
              received += s.packetsReceived || 0
            }
            if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.currentRoundTripTime) {
              rtt = Math.max(rtt, s.currentRoundTripTime)
            }
          })
        } catch { continue }
        const prev = statsRef.current.get(peerId) || { lost: 0, received: 0 }
        const dLost = Math.max(0, lost - prev.lost)
        const dRecv = Math.max(0, received - prev.received)
        statsRef.current.set(peerId, { lost, received })
        const ratio = dRecv + dLost > 0 ? dLost / (dRecv + dLost) : 0
        const grade = (ratio > 0.08 || rtt > 0.6) ? 'poor'
          : (ratio > 0.02 || rtt > 0.3) ? 'fair'
            : 'good'
        if (rank[grade] > rank[worst]) worst = grade
      }
      if (alive) setQuality(worst)
    }
    sample()
    const iv = setInterval(sample, 3000)
    return () => { alive = false; clearInterval(iv) }
  }, [phase])

  /* ---------------- devices ----------------
     Labels are empty until a getUserMedia grant exists, so the list is only
     worth building once a call is up. `devicechange` covers the headset that
     is plugged in mid-call — the single most common reason anyone opens this
     menu at all. */
  const refreshDevices = React.useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      setDevices({
        audio: all.filter(d => d.kind === 'audioinput'),
        video: all.filter(d => d.kind === 'videoinput'),
      })
    } catch { /* permission-gated; the menu just stays short */ }
  }, [])

  React.useEffect(() => {
    if (phase !== 'active') return undefined
    refreshDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices)
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices)
  }, [phase, refreshDevices])

  /** Swap the live track on every peer connection without renegotiating.
   *  `replaceTrack` is the whole point: adding/removing tracks would need a
   *  fresh offer/answer round with every peer in the mesh. */
  const replaceOnPeers = React.useCallback((kind, track) => {
    for (const pc of pcsRef.current.values()) {
      const sender = pc.getSenders().find(s => s.track?.kind === kind)
      if (sender) { sender.replaceTrack(track).catch(() => {}) }
      else if (track) {
        // No sender of this kind yet (a voice call growing a video track).
        // That DOES need renegotiation, so offer once the track is attached.
        try { pc.addTrack(track, localRef.current) } catch { /* already added */ }
      }
    }
  }, [])

  /** Re-offer to peers I am responsible for. Only from `stable`, so a
   *  renegotiation can never collide with an in-flight offer. */
  const renegotiate = React.useCallback(async () => {
    const me = String(myIdRef.current)
    for (const [peerId, pc] of pcsRef.current) {
      if (!(me < peerId)) continue
      if (pc.signalingState !== 'stable') continue
      try {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        sendSignal(peerId, 'OFFER', pc.localDescription)
      } catch { /* the next ICE restart recovers */ }
    }
  }, [sendSignal])

  const switchInput = React.useCallback(async (kind, deviceId) => {
    const stream = localRef.current
    if (!stream) return
    try {
      const fresh = await navigator.mediaDevices.getUserMedia(
        kind === 'audio'
          ? { audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
          : { video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } },
      )
      const track = kind === 'audio' ? fresh.getAudioTracks()[0] : fresh.getVideoTracks()[0]
      if (!track) return
      // Honour the current mute state — switching microphones must not
      // silently un-mute someone who muted themselves.
      if (kind === 'audio') track.enabled = micOn
      else if (!screenOn) track.enabled = camOn

      const old = kind === 'audio' ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0]
      if (kind === 'video' && screenOn) {
        // A share is up: park the new camera track, leave the wire alone.
        try { camTrackRef.current?.stop() } catch { /* noop */ }
        camTrackRef.current = track
        return
      }
      replaceOnPeers(kind, track)
      if (old) { stream.removeTrack(old); try { old.stop() } catch { /* noop */ } }
      stream.addTrack(track)
      // Same MediaStream object, new tracks — React needs a new identity to
      // re-attach the local <video>, so clone the reference.
      setLocalStream(new MediaStream(stream.getTracks()))
      localRef.current = stream
    } catch {
      showToast('Could not switch device')
    }
  }, [micOn, camOn, screenOn, replaceOnPeers])

  /* ---------------- screen share ----------------
     Camera track is PARKED, not stopped: stopping it drops the camera
     permission prompt back in the user's face when the share ends. */
  const stopScreen = React.useCallback(() => {
    const share = screenTrackRef.current
    screenTrackRef.current = null
    setScreenOn(false)
    const cam = camTrackRef.current
    camTrackRef.current = null
    const stream = localRef.current
    if (cam && stream) {
      replaceOnPeers('video', cam)
      const cur = stream.getVideoTracks()[0]
      if (cur) stream.removeTrack(cur)
      stream.addTrack(cam)
      cam.enabled = camOn
      setLocalStream(new MediaStream(stream.getTracks()))
    } else if (stream) {
      // A voice call that grew a share: drop the video sender back to nothing.
      replaceOnPeers('video', null)
      const cur = stream.getVideoTracks()[0]
      if (cur) { stream.removeTrack(cur); setLocalStream(new MediaStream(stream.getTracks())) }
    }
    try { share?.stop() } catch { /* already stopped */ }
  }, [camOn, replaceOnPeers])

  const toggleScreen = React.useCallback(async () => {
    if (screenOn) { stopScreen(); return }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      showToast('Screen sharing is not available in this browser')
      return
    }
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } }, audio: false })
      const track = display.getVideoTracks()[0]
      if (!track) return
      const stream = localRef.current
      const cam = stream?.getVideoTracks()[0] || null
      const hadVideoSender = [...pcsRef.current.values()].some(pc => pc.getSenders().some(s => s.track?.kind === 'video'))
      if (cam) { camTrackRef.current = cam; stream.removeTrack(cam) }
      screenTrackRef.current = track
      replaceOnPeers('video', track)
      if (stream) { stream.addTrack(track); setLocalStream(new MediaStream(stream.getTracks())) }
      // A voice call has no video sender yet, so the track had to be ADDED —
      // which only reaches the peer after a fresh offer.
      if (!hadVideoSender) renegotiate()
      setScreenOn(true)
      // The browser's own "Stop sharing" bar bypasses this UI entirely.
      track.addEventListener('ended', () => stopScreen(), { once: true })
    } catch (e) {
      // A cancelled picker is a choice, not a failure.
      if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') showToast('Could not share the screen')
    }
  }, [screenOn, stopScreen, replaceOnPeers, renegotiate])

  /* ---------------- public actions ---------------- */

  const startCall = React.useCallback(async (conversationId, type = 'VOICE') => {
    if (phaseRef.current !== 'idle') { showToast('You are already in a call'); return null }
    if (!conversationId) return null
    setPhase('outgoing'); phaseRef.current = 'outgoing'
    try {
      await acquireMedia(type === 'VIDEO')
      let c = await api.chat.calls.start(conversationId, type)

      /* There is ONE live call per conversation, so this verb is overloaded:
         it starts a fresh call, or hands back the one already in progress.
         Those two need different follow-ups. `POST /conversations/{id}/calls`
         only *returns* an in-progress call — it does not put me in it;
         `accept` is the verb documented as "Answer; you join". Without this
         the local UI went straight to "active" while the server never marked
         me JOINED and never told the other side I was there: `negotiate`
         would then offer to peers who had never heard of me, and the call
         looked connected and carried no audio. */
      if (c?.ongoing) {
        const meJoined = (c.participants || []).some(
          p => String(p.userId) === String(myIdRef.current) && p.state === 'JOINED',
        )
        if (!meJoined) c = (await api.chat.calls.accept(c.id)) || c
      }

      setCall(c); callRef.current = c
      beginLog(c, true)
      if (c?.ongoing) {
        setPhase('active'); phaseRef.current = 'active'
        setStartedAt(Date.now())
        answeredLog()
        negotiate(c)
      } else {
        ringerRef.current?.start('outgoing')
      }
      return c
    } catch (e) {
      teardown('failed')
      // BLOCKED here means the same thing it means on a send, so it must read
      // the same — the catalog owns that wording, not this call site.
      showToast(chatError(e, 'Could not start the call'))
      return null
    }
  }, [acquireMedia, negotiate, teardown, beginLog, answeredLog])

  const acceptCall = React.useCallback(async () => {
    const c = callRef.current
    if (!c?.id) return
    ringerRef.current?.stop()
    try {
      await acquireMedia(c.video)
      const fresh = await api.chat.calls.accept(c.id)
      setCall(fresh); callRef.current = fresh
      setPhase('active'); phaseRef.current = 'active'
      setStartedAt(Date.now())
      answeredLog()
      negotiate(fresh)
    } catch (e) {
      showToast(chatError(e, 'Could not answer the call'))
      teardown('failed')
    }
  }, [acquireMedia, negotiate, teardown, answeredLog])

  const declineCall = React.useCallback(async () => {
    const c = callRef.current
    teardown('declined')
    if (c?.id) { try { await api.chat.calls.decline(c.id) } catch { /* it rang out anyway */ } }
  }, [teardown])

  const hangUp = React.useCallback(async () => {
    const c = callRef.current
    /* Which word this call gets in the log depends on WHEN I hung up: after it
       connected the log records the conversation (commitLog upgrades any
       outcome to "answered" once `answeredAt` is set); before it connected,
       hanging up is a cancellation, and the other end will read it as missed. */
    teardown(phaseRef.current === 'active' ? 'answered' : 'cancelled')
    if (c?.id) { try { await api.chat.calls.end(c.id) } catch { /* already ended */ } }
  }, [teardown])

  const toggleMic = React.useCallback(() => {
    const tracks = localRef.current?.getAudioTracks() || []
    if (!tracks.length) return
    const next = !tracks[0].enabled
    for (const t of tracks) t.enabled = next
    setMicOn(next)
  }, [])

  const toggleCam = React.useCallback(() => {
    const tracks = localRef.current?.getVideoTracks() || []
    if (!tracks.length) { showToast('This is a voice call'); return }
    const next = !tracks[0].enabled
    for (const t of tracks) t.enabled = next
    setCamOn(next)
  }, [])

  /* ---------------- stream events ---------------- */

  React.useEffect(() => subscribe((evt) => {
    if (!evt?.type?.startsWith('call.')) return
    const c = evt.call

    switch (evt.type) {
      case 'call.incoming': {
        // My own devices also see this frame when I place the call — ignore it
        // there, or the caller rings themselves.
        if (String(c?.initiatorId) === String(myIdRef.current)) return
        if (phaseRef.current !== 'idle') {
          // Busy. Decline immediately so the caller isn't left ringing a tab
          // that will never answer.
          if (c?.id) api.chat.calls.decline(c.id).catch(() => {})
          return
        }
        setCall(c); callRef.current = c
        setPhase('incoming'); phaseRef.current = 'incoming'
        beginLog(c, false)
        ringerRef.current?.start('incoming')
        break
      }
      case 'call.accepted': {
        if (!c || String(c.id) !== String(callRef.current?.id)) return
        setCall(c); callRef.current = c
        ringerRef.current?.stop()
        if (phaseRef.current !== 'active') {
          setPhase('active'); phaseRef.current = 'active'
          setStartedAt(prev => prev || Date.now())
        }
        answeredLog()
        negotiate(c)
        break
      }
      case 'call.participant': {
        if (!c || String(c.id) !== String(callRef.current?.id)) return
        setCall(c); callRef.current = c
        // Someone left: drop their peer connection and tile.
        const joined = new Set((c.participants || []).filter(p => p.state === 'JOINED').map(p => String(p.userId)))
        for (const [peerId, pc] of pcsRef.current) {
          if (!joined.has(peerId)) {
            try { pc.close() } catch { /* noop */ }
            pcsRef.current.delete(peerId)
            setRemotes(prev => prev.filter(r => String(r.userId) !== peerId))
          }
        }
        if (phaseRef.current === 'active') negotiate(c)
        break
      }
      case 'call.declined': {
        if (!c || String(c.id) !== String(callRef.current?.id)) return
        setCall(c); callRef.current = c
        if (c.status !== 'ONGOING' && c.status !== 'RINGING') { showToast('Call declined'); teardown('declined') }
        break
      }
      case 'call.ended': {
        if (!c || String(c.id) !== String(callRef.current?.id)) return
        const iRang = String(c.initiatorId) === String(myIdRef.current)
        /* The terminal status is the server's word for what happened, and the
           two ends translate it differently — the same CANCELLED is "I hung
           up before they answered" to the caller and "missed call" to the
           callee. `commitLog` overrides all of this with "answered" if the
           call had actually connected. */
        teardown(
          c.status === 'MISSED' ? (iRang ? 'noanswer' : 'missed')
            : c.status === 'CANCELLED' ? (iRang ? 'cancelled' : 'missed')
              : c.status === 'DECLINED' ? 'declined'
                : undefined,
        )
        /* The same terminal status means opposite things to the two ends, so
           each gets its own word — and the side that CAUSED the ending is
           told nothing, because it already knows.
             MISSED    (rang out ≥60s, set by the server sweep)
                       → caller: "No answer".  callee: "Missed call".
             CANCELLED (caller hung up before an answer)
                       → callee: "Missed call". caller: silent, it was them.
           An ordinary ENDED after a real conversation is silent both ways. */
        if (c.status === 'MISSED') showToast(iRang ? 'No answer' : 'Missed call')
        else if (c.status === 'CANCELLED' && !iRang) showToast('Missed call')
        break
      }
      case 'call.signal':
        if (String(evt.signal?.callId) !== String(callRef.current?.id)) return
        onSignal(evt.signal)
        break
      default:
        break
    }
  }), [subscribe, negotiate, onSignal, teardown, beginLog, answeredLog])

  /* ---------------- derived ---------------- */

  const convo = call?.conversationId ? getConvo(call.conversationId) : null
  const peerParticipant = React.useMemo(() => {
    if (!call) return null
    return (call.participants || []).find(p => String(p.userId) !== String(myId)) || null
  }, [call, myId])

  /** Is this participant audibly talking right now? `'me'` for the local mic —
   *  which is how the overlay can tell you that you are talking while muted. */
  const speakingOf = React.useCallback(
    (key) => (levels[String(key)] || 0) >= SPEAKING_AT,
    [levels],
  )

  const value = {
    call, phase, convo, peerParticipant,
    localStream, remotes,
    micOn, camOn, screenOn, startedAt, minimized, setMinimized,
    levels, speakingOf, peerStates, quality,
    devices, refreshDevices, switchInput,
    inCall: phase !== 'idle',
    startCall, acceptCall, declineCall, hangUp, toggleMic, toggleCam, toggleScreen,
  }
  return <CallCtx.Provider value={value}>{children}</CallCtx.Provider>
}

/** Access the call layer. Safe outside the provider (returns a null-object)
 *  so a page can render a "Call" button without depending on mount order. */
export function useCall() {
  return React.useContext(CallCtx) || {
    call: null, phase: 'idle', inCall: false, remotes: [], localStream: null,
    startCall: async () => null, acceptCall: () => {}, declineCall: () => {},
    hangUp: () => {}, toggleMic: () => {}, toggleCam: () => {}, toggleScreen: () => {},
    micOn: true, camOn: true, screenOn: false, minimized: false, setMinimized: () => {},
    levels: {}, speakingOf: () => false, peerStates: {}, quality: 'good',
    devices: { audio: [], video: [] }, refreshDevices: () => {}, switchInput: () => {},
  }
}
