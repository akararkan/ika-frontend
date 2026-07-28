/* =========================================================
   LivePage — /live · /live/:id
   ---------------------------------------------------------
   Going live and watching, over the same per-user SSE stream
   chat already holds.

   The split that governs everything here: this app owns the
   stream LIFECYCLE, the viewer registry, discovery and live
   chat — but the audio/video itself is ingested to and served
   from an EXTERNAL media server. So:

   · the host publishes to `ingestUrl` with real broadcasting
     software (OBS and friends). That URL carries the stream's
     secret key, is returned only to the host, and is `null` for
     every viewer — which is why it is shown behind a reveal
     rather than printed on the page.
   · viewers play `playbackUrl`, an HLS manifest. Safari plays
     HLS natively; other engines need an MSE player, so a plain
     <video> is the honest floor and the page says so instead of
     silently showing a dead frame.

   Live chat is EPHEMERAL: broadcast only, never persisted, so a
   late joiner sees an empty room. That is by design, and the
   empty state says it rather than looking broken.
   ========================================================= */
import React from 'react'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import { Icon, Avatar, showToast } from '../components/ui.jsx'
import { Loader, EmptyState, ErrorState } from '../components/states.jsx'
import { openShare } from '../components/ShareSheet.jsx'
import { uiConfirm } from '../components/Dialog.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { useChat } from '../context/ChatContext.jsx'
import { api } from '../api/index.js'
import { authorFrom } from '../api/adapters.js'
import { chatError } from '../components/chat/chatErrors.js'
import { publishCamera, playWhep } from '../lib/liveWebrtc.js'
import { applyStreamEvent, patchStream } from '../lib/liveRows.js'
import { LiveRow } from '../components/LiveRow.jsx'
import {
  REACTIONS, emojiOfReaction, emojiOfGift, useStageVideos,
  StageTiles, FloaterLayer, GiftSplash, GiftPicker, SupportersPanel,
  RequestQueue, InviteBanner,
} from '../components/liveStage.jsx'

/** Native HLS is Safari-only; everywhere else a bare <video> can't play .m3u8. */
function canPlayHls(el) {
  if (!el) return false
  return !!el.canPlayType?.('application/vnd.apple.mpegurl')
}

const clockOf = (iso) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/* Recording lifecycle → what the owner is actually told. `null` is "the backend
   didn't say" (an older deploy), which renders as nothing rather than a guess.

   DISABLED deliberately does NOT say "you chose not to save this one". Enabling
   a recording is a best-effort call from the backend out to the MediaMTX
   control API, and when it fails the stream still goes live — just unrecorded.
   So DISABLED means "this is not being saved", which is all we can honestly
   claim; it does not mean the host asked for that. `RecordingPanel` takes the
   host's actual intent separately and says the true thing when the two differ. */
const RECORDING_LABEL = {
  RECORDING: ['Recording', 'Being saved while you’re live.'],
  PAUSED:    ['Recording paused', 'You’re still live — nothing is being saved right now.'],
  PROCESSING:['Preparing your video', 'Your takes are being joined into one file. The parts below still work.'],
  AVAILABLE: ['Recording ready', 'Download it, or delete it to free the space.'],
  EMPTY:     ['Nothing recorded', 'The stream ended without anything being published.'],
  DISABLED:  ['Not recorded', 'This broadcast isn’t being saved.'],
  DELETED:   ['Recording deleted', 'The video is gone; the stream stays in your list.'],
}

/** 48210432 → "46.0 MB". Recordings are big enough that bytes are noise. */
function sizeOf(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024, i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1 }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/* ---------- edit a stream's metadata (owner) ---------- */

function EditStream({ stream, onClose, onSaved }) {
  const [title, setTitle] = React.useState(stream?.title || '')
  const [description, setDescription] = React.useState(stream?.description || '')
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async () => {
    if (!title.trim() || busy) return
    setBusy(true)
    try {
      const s = await api.chat.streams.update(stream.id, {
        title: title.trim(),
        description: description.trim(),
      })
      onSaved?.(s)
    } catch (e) {
      showToast(chatError(e, 'Could not save the changes'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ch-modal-overlay" role="dialog" aria-modal="true" aria-label="Edit stream"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="ch-modal">
        <div className="ch-modal-head">
          <h3>Edit stream</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close">
            <Icon name="close" className="sm"/>
          </button>
        </div>
        <div className="ch-modal-body">
          <label className="cn-field">
            <span>Title</span>
            <input className="field" autoFocus value={title} maxLength={140}
              onChange={e => setTitle(e.target.value)}/>
          </label>
          <label className="cn-field">
            <span>Description <small>optional</small></span>
            <textarea className="field" rows={3} value={description} maxLength={500}
              onChange={e => setDescription(e.target.value)}/>
          </label>
          {stream?.isLive && (
            <p className="lv-note">
              <Icon name="info" className="xs"/>
              You’re live — everyone watching sees the new title straight away.
            </p>
          )}
        </div>
        <div className="ch-modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!title.trim() || busy} onClick={submit}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---------- the recording panel (owner-only) ---------- */

function RecordingPanel({ stream, requested, onChanged }) {
  const [info, setInfo] = React.useState(null)
  const [busy, setBusy] = React.useState('')
  const status = stream?.recordingStatus || null

  /* The manifest is only worth fetching once there could be parts to list.
     While RECORDING/PAUSED it is always empty (nothing is flushed until the
     end), and DISABLED/DELETED have nothing to say. PROCESSING is included
     because the individual takes ARE downloadable while the join runs — a host
     in a hurry should not have to wait for the re-encode. */
  const wants = status === 'AVAILABLE' || status === 'EMPTY' || status === 'PROCESSING'
  React.useEffect(() => {
    if (!wants || !stream?.id) { setInfo(null); return undefined }
    let alive = true
    const load = () => api.chat.streams.recording(stream.id)
      .then(r => { if (alive) setInfo(r) })
      .catch(() => { if (alive) setInfo(null) })
    load()
    /* The join finishes on the server with nothing to announce it — there is no
       SSE event for "your file is ready" — so poll, but only while it is
       actually running. */
    if (status !== 'PROCESSING') return () => { alive = false }
    const t = setInterval(async () => {
      if (!alive) return
      try {
        const fresh = await api.chat.streams.get(stream.id)
        if (!alive) return
        if (fresh?.recordingStatus && fresh.recordingStatus !== 'PROCESSING') onChanged?.(fresh)
        else load()
      } catch { /* transient — the next tick tries again */ }
    }, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [wants, status, stream?.id, onChanged])

  /* EVERY early return lives below the hooks — rules of hooks. */
  if (!status) return null

  /* The host ticked "Record this stream" and it is not recording. Turning
     recording on is a best-effort call from the backend out to the MediaMTX
     control API; when that call fails the stream still goes live, silently
     unrecorded. Saying nothing means the host broadcasts for an hour believing
     it is being saved and finds out only when they go looking for the file —
     the worst possible moment. `requested` carries the host's actual intent
     across the go-live navigation, so this lands while it is still cheap to act
     on: end and start again. */
  /* PAUSED and PROCESSING are deliberate states, not failures — the host paused
     the recording themselves, or the server is joining their takes. Warning
     "recording couldn't be turned on" in either case would be a lie. */
  if (requested && !['RECORDING', 'PAUSED', 'PROCESSING', 'AVAILABLE'].includes(status)) {
    return (
      <section className="lv-rec warn">
        <div className="lv-rec-t">
          <span className="lv-rec-chip failed"><Icon name="info" className="xs"/>Not being recorded</span>
        </div>
        <p className="lv-rec-warn">
          You asked for this stream to be saved, but recording couldn’t be turned
          on — the media server didn’t take the request. The broadcast itself is
          live and fine; there just won’t be a file at the end. End and start
          again to retry.
        </p>
      </section>
    )
  }

  const [label, hint] = RECORDING_LABEL[status] || ['Recording', '']

  /* `part` given → that one file. `part` omitted → the WHOLE recording, which
     walks the parts when there is more than one; the part-less route 400s on a
     multi-part recording, and multi-part is routine here (see
     saveWholeRecording). */
  const save = async (part) => {
    setBusy('save')
    try {
      if (part) await api.chat.streams.saveRecording(stream.id, { part })
      else {
        const n = await api.chat.streams.saveWholeRecording(stream.id)
        if (n > 1) showToast(`Saved ${n} files — the broadcast is split into parts`)
      }
    } catch (e) {
      showToast(chatError(e, 'Could not download the recording'))
    } finally { setBusy('') }
  }

  const drop = async () => {
    const ok = await uiConfirm({
      title: 'Delete this recording?',
      message: 'The video file is removed for good. The stream itself stays in your list.',
      danger: true,
      confirmLabel: 'Delete recording',
    })
    if (!ok) return
    setBusy('drop')
    try {
      await api.chat.streams.removeRecording(stream.id)
      showToast('Recording deleted')
      onChanged?.({ recordingStatus: 'DELETED', recordingAvailable: false, recordingDownloadUrl: null })
    } catch (e) {
      showToast(chatError(e, 'Could not delete the recording'))
    } finally { setBusy('') }
  }

  const multi = (info?.parts?.length || 0) > 1

  return (
    <section className="lv-rec">
      <div className="lv-rec-t">
        <span className={'lv-rec-chip ' + status.toLowerCase()}>
          {status === 'RECORDING' && <span className="lv-dot" aria-hidden="true"/>}
          {label}
        </span>
        <span className="lv-rec-hint">{hint}</span>
      </div>

      {info?.available && (
        <div className="lv-rec-row">
          <span className="lv-rec-size">
            {info.partCount} {info.partCount === 1 ? 'file' : 'files'} · {sizeOf(info.totalBytes)}
          </span>
          <span className="lv-rec-acts">
            {/* No <a download> anywhere here: the route is Bearer-authed, so a
                plain link answers 401. It is fetched as a Blob and handed to
                the browser's downloader. */}
            <button className="rq-btn primary" disabled={!!busy} onClick={() => save(null)}>
              {busy === 'save' ? 'Preparing…' : multi ? `Download all (${info.parts.length})` : 'Download'}
            </button>
            <button className="rq-btn" disabled={!!busy} onClick={drop}>
              {busy === 'drop' ? 'Deleting…' : 'Delete'}
            </button>
          </span>
        </div>
      )}

      {multi && (
        <ul className="lv-rec-parts">
          {info.parts.map(p => (
            <li key={p.file}>
              <span className="lv-rec-file" dir="auto">{p.file}</span>
              <span className="lv-rec-size">{sizeOf(p.sizeBytes)}</span>
              <button className="rq-btn" disabled={!!busy} onClick={() => save(p.file)}>Download</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/* ---------- go live ---------- */

function GoLive({ onClose, onStarted }) {
  const [title, setTitle] = React.useState('')
  const [description, setDescription] = React.useState('')
  /* Recording is OPT-IN and the default is the server's (`record` omitted, not
     `false`) — the box starts unticked because "this is being written to disk"
     is the answer that has to be chosen, never the one that happens quietly. */
  const [record, setRecord] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async () => {
    if (!title.trim() || busy) return
    setBusy(true)
    try {
      const s = await api.chat.streams.start({
        title: title.trim(),
        description: description.trim() || undefined,
        record,
      })
      /* The request is echoed back with the result: `recordingStatus` alone
         cannot tell "the host didn't want a recording" from "the host wanted one
         and the media server refused", and those need different words. */
      onStarted?.(s, record)
    } catch (e) {
      showToast(chatError(e, 'Could not start the stream'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ch-modal-overlay" role="dialog" aria-modal="true" aria-label="Go live"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="ch-modal">
        <div className="ch-modal-head">
          <h3>Go live</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close">
            <Icon name="close" className="sm"/>
          </button>
        </div>
        <div className="ch-modal-body">
          <label className="cn-field">
            <span>Title</span>
            <input className="field" autoFocus value={title} maxLength={140}
              onChange={e => setTitle(e.target.value)} placeholder="Friday halaqa — live"/>
          </label>
          <label className="cn-field">
            <span>Description <small>optional</small></span>
            <textarea className="field" rows={3} value={description} maxLength={500}
              onChange={e => setDescription(e.target.value)} placeholder="What you'll cover…"/>
          </label>
          <label className="lv-check">
            <input type="checkbox" checked={record} onChange={e => setRecord(e.target.checked)}/>
            <span>
              <b>Record this stream</b>
              <small>
                Saves the broadcast so you can download it after you end — only you
                can reach it. Leave this off and nothing is written to disk.
              </small>
            </span>
          </label>
          <p className="lv-note">
            <Icon name="info" className="xs"/>
            Next you’ll go live straight from your camera — just allow access when
            asked. Prefer OBS or other software? A private ingest URL is there too.
          </p>
        </div>
        <div className="ch-modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!title.trim() || busy} onClick={submit}>
            {busy ? 'Starting…' : 'Go live'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---------- the watch / host view ---------- */

function StreamRoom({ streamId, recordRequested, onExit }) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { subscribe, watchUsers, userOf } = useChat()
  const myId = user?.id || null

  const [stream, setStream] = React.useState(null)
  const [state, setState] = React.useState('loading')      // loading | ready | error
  const [lines, setLines] = React.useState([])
  const [draft, setDraft] = React.useState('')
  const [showIngest, setShowIngest] = React.useState(false)
  const [editing, setEditing] = React.useState(false)
  const [sending, setSending] = React.useState(false)
  /* How the manifest is being played. Resolved in the attach effect and held
     in state (probing the <video> during render would read a ref before it is
     attached):
       probing     → still deciding / hls.js chunk loading
       native      → Safari's built-in HLS (or a non-HLS source)
       mse         → hls.js over MediaSource (Chrome/Firefox/Edge)
       unsupported → no engine can play it here
       failed      → an engine exists but the stream can't be reached */
  const [playback, setPlayback] = React.useState('probing')
  /* Host broadcast (camera → WebRTC/WHIP): idle → connecting → live | error.
     Only the host ever leaves 'idle'; viewers never publish. */
  const [cast, setCast] = React.useState('idle')
  const [castErr, setCastErr] = React.useState('')
  const [micOn, setMicOn] = React.useState(true)
  const [camOn, setCamOn] = React.useState(true)
  /* The PICTURE's health, which is not the same thing as `cast`. A broadcast
     can stay `live` — connection up, audio flowing, viewers counted — while the
     camera has quietly stopped producing frames. Left unsaid, the host finds
     out afterwards, from a recording that freezes halfway. */
  const [camHealth, setCamHealth] = React.useState({ state: 'ok', detail: '' })
  // Registered-viewer flag. The host is implicitly allowed and never joins.
  const [joined, setJoined] = React.useState(false)
  const videoRef = React.useRef(null)
  const logRef = React.useRef(null)
  const joinedRef = React.useRef(false)
  const castRef = React.useRef(null)   // { pc, media, stop } while broadcasting
  const whepRef = React.useRef(null)   // { pc, stop } while WHEP-watching

  /* ---- multi-guest stage / reactions / gifts state ----
     The roster (`stage`) is server-truth, replaced wholesale by every
     `stream.stage` frame. Everything else is what the wire cannot know:
     my pending hand-raise, the invite awaiting my answer, the animation
     queues, and the host's request list. */
  const [stage, setStage] = React.useState(null)          // StageState | null
  const [requests, setRequests] = React.useState([])      // host's hand-raise queue
  const [invite, setInvite] = React.useState(null)        // the HOST member who invited me
  const [handRaised, setHandRaised] = React.useState(false)
  const [stageBusy, setStageBusy] = React.useState(false) // my own up/down transitions
  const [stageBusyId, setStageBusyId] = React.useState(null) // host acting on ONE guest
  const [floaters, setFloaters] = React.useState([])      // drifting reaction emojis
  const [giftSplash, setGiftSplash] = React.useState(null) // the one showing now
  const [giftQueue, setGiftQueue] = React.useState([])     // the ones waiting
  const [giftsOpen, setGiftsOpen] = React.useState(false)
  const [catalog, setCatalog] = React.useState(null)      // null = not fetched yet
  const [giftBusy, setGiftBusy] = React.useState(false)
  const [board, setBoard] = React.useState([])            // top supporters
  const guestCastRef = React.useRef(null)  // { pc, media, stop } while I'm ON the stage
  const myTileRef = React.useRef(null)     // my guest tile's <video>
  const lastTapRef = React.useRef(0)       // reaction send throttle

  const isHost = !!stream && String(stream.hostId) === String(myId)
  const myStageMember = stage?.members?.find(m => String(m.userId) === String(myId)) || null
  const meOnStage = !!myStageMember && !myStageMember.isHost && myStageMember.status === 'ACTIVE'
  const stageFull = !!stage?.isFull
  /* Remote guests only: my tile is my local camera, and the HOST's media is the
     main <video> — a second WHEP to the host's path would double their audio. */
  const remoteGuests = React.useMemo(
    () => (stream?.isLive && stage ? stage.members.filter(m => !m.isHost && String(m.userId) !== String(myId)) : []),
    [stage, myId, stream?.isLive],
  )
  const connsRef = useStageVideos(remoteGuests)

  /* Join registers presence (it is what drives `viewerCount`) and is what
     returns `playbackUrl`. The host must NOT join — they are already counted,
     and joining their own stream would inflate the audience by one.

     `joining` guards StrictMode's double-invoke; `joinedRef` records only a
     join that actually SUCCEEDED. Those have to be two different flags: the
     old code set the success flag before awaiting, so a failed join still
     unlocked the chat box (every line then 403ing, since you must join before
     you can chat) and still fired a `leave` for a stream we were never in. */
  React.useEffect(() => {
    if (!streamId) return undefined
    let alive = true
    let joining = false
    setState('loading')
    api.chat.streams.get(streamId)
      .then(async (s) => {
        if (!alive || !s) return
        setStream(s)
        setState('ready')
        if (String(s.hostId) !== String(myId) && s.isLive && !joinedRef.current && !joining) {
          joining = true
          try {
            const fresh = await api.chat.streams.join(streamId)
            if (!alive) return
            joinedRef.current = true
            setJoined(true)
            if (fresh) setStream(fresh)
          } catch {
            // Playback may still work from the detail payload, but we are not
            // a registered viewer — so the composer stays locked.
            if (alive) setJoined(false)
          }
        }
      })
      .catch(() => { if (alive) setState('error') })
    return () => { alive = false }
  }, [streamId, myId])

  /* Leave on unmount AND on `pagehide`. Unmount alone misses the case that
     actually matters — closing the tab — which would leave a phantom viewer
     inflating `viewerCount` for everyone until the server's expiry sweep. The
     pagehide call goes out with `keepalive` so it survives the teardown.
     `pagehide` rather than `beforeunload`: it is the one that fires on mobile
     Safari's bfcache path, where `beforeunload` frequently does not. */
  React.useEffect(() => {
    if (!streamId) return undefined
    const bail = (beacon) => {
      if (!joinedRef.current) return
      joinedRef.current = false
      api.chat.streams.leave(streamId, { beacon }).catch(() => {})
    }
    const onHide = () => bail(true)
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      bail(false)
    }
  }, [streamId])

  /* ---- HOST: broadcast the camera over WebRTC/WHIP ----
     Browsers can't publish RTMP, so this is the in-app "go live". Publishing
     is gated behind an explicit button press (a user gesture keeps the
     camera-permission prompt reliable and never surprises the host). */
  const stopCast = React.useCallback(() => {
    castRef.current?.stop?.()
    castRef.current = null
  }, [])

  const startCast = React.useCallback(async () => {
    if (!stream?.whipUrl || castRef.current) return
    setCast('connecting'); setCastErr(''); setCamHealth({ state: 'ok', detail: '' })
    try {
      const handle = await publishCamera(stream.whipUrl, {
        /* Attach the preview at CAPTURE time, not after the handshake. The host
           sees themselves immediately, and a preview that is already painting
           keeps the capture pipeline awake through the SDP exchange — which is
           the race `firstVideoFrame` exists to win (lose it and MediaMTX
           registers the session as audio-only and the recording has no video). */
        onLocalStream: (media) => {
          const el = videoRef.current
          if (!el) return
          /* Detach first: this fires again after a camera repair swaps the video
             track, and re-assigning the SAME MediaStream is a no-op in some
             engines — the preview would keep showing the dead frame. */
          el.srcObject = null
          el.srcObject = media
          el.muted = true
          el.play?.().catch(() => {})
        },
        onState: (st) => {
          if (st === 'connected') setCast('live')
          else if (st === 'failed') { setCast('error'); setCastErr('The connection to the media server dropped. Try again.') }
        },
        onHealth: (state, detail) => setCamHealth({ state, detail: detail || '' }),
      })
      castRef.current = handle
      const el = videoRef.current
      if (el && el.srcObject !== handle.media) { el.srcObject = handle.media; el.muted = true; el.play?.().catch(() => {}) }
      setMicOn(true); setCamOn(true)
      // Some engines never emit 'connected' — the SDP answer already means we're up.
      setCast(c => (c === 'connecting' ? 'live' : c))
    } catch (e) {
      setCast('error')
      setCastErr(e?.name === 'NotAllowedError'
        ? 'Camera / microphone access was blocked. Allow it in your browser and try again.'
        : (e?.message || 'Could not start the camera.'))
    }
  }, [stream])

  const toggleMic = () => {
    const t = castRef.current?.media?.getAudioTracks?.()[0]
    if (t) { t.enabled = !t.enabled; setMicOn(t.enabled) }
  }
  const toggleCam = () => {
    const t = castRef.current?.media?.getVideoTracks?.()[0]
    if (t) { t.enabled = !t.enabled; setCamOn(t.enabled) }
  }

  /* Recording is the host's to start and stop as often as they like while live.
     Each take is a separate file on the server and they are joined into one
     video when the stream ends, so this is a plain toggle — there is no "take
     1 of 4" for the host to keep track of. */
  const [recBusy, setRecBusy] = React.useState(false)
  const recording = stream?.recordingStatus === 'RECORDING'
  const toggleRecord = async () => {
    if (recBusy || !stream?.id) return
    setRecBusy(true)
    try {
      const next = recording
        ? await api.chat.streams.stopRecording(stream.id)
        : await api.chat.streams.startRecording(stream.id)
      setStream(s => ({ ...s, ...next }))
      showToast(recording ? 'Recording paused — you’re still live' : 'Recording')
    } catch (e) {
      showToast(chatError(e, recording ? 'Could not pause the recording' : 'Could not start recording'))
    } finally { setRecBusy(false) }
  }

  /* ---- GUEST: publish my camera to MY OWN stage path ----
     The same publishCamera the host uses — warm-up, sender tuning, the
     picture-health watchdog, the wake lock — pointed at the whipUrl the server
     handed ME privately (grant frame or the accept response). Viewers never see
     it; other guests never see mine. */
  const stopGuestCast = React.useCallback(() => {
    guestCastRef.current?.stop?.()
    guestCastRef.current = null
  }, [])

  const goUp = React.useCallback(async (member) => {
    if (!member?.whipUrl || guestCastRef.current) return
    try {
      const handle = await publishCamera(member.whipUrl, {
        onLocalStream: (media) => {
          const el = myTileRef.current
          if (!el) return
          el.srcObject = null      // re-fires after a camera repair — see startCast
          el.srcObject = media
          el.muted = true
          el.play?.().catch(() => {})
        },
        onHealth: (st) => {
          if (st === 'lost') showToast('Your stage camera stopped and can’t be reopened — step down and come back up to retry.')
        },
      })
      guestCastRef.current = handle
      showToast('You’re on the stage — everyone can see and hear you')
    } catch (e) {
      /* The seat is mine but the camera isn't — an ACTIVE guest with no media
         is a black tile for everyone. Free the seat rather than squat on it. */
      api.chat.streams.stage.leave(streamId).catch(() => {})
      showToast(e?.name === 'NotAllowedError'
        ? 'Camera / microphone access was blocked. Allow it in your browser and raise your hand again.'
        : chatError(e, 'Could not start your camera'))
    }
  }, [streamId])

  const stepDown = React.useCallback(async (silent) => {
    stopGuestCast()
    try { await api.chat.streams.stage.leave(streamId) } catch { /* seat frees on end anyway */ }
    if (!silent) showToast('You stepped down from the stage')
  }, [streamId, stopGuestCast])

  /* Honor MY OWN host-mute at the source. The tiles silence me on every other
     client; killing the actual mic track means not even a client that ignores
     the flag can hear me — and it is the honest thing to do to the speaker. */
  React.useEffect(() => {
    const t = guestCastRef.current?.media?.getAudioTracks?.()[0]
    if (t) t.enabled = !(myStageMember?.muted) && micOn
  }, [myStageMember?.muted, micOn, meOnStage])

  /* ---- viewer: raise a hand · answer an invite ---- */
  const raiseHand = async () => {
    if (stageBusy) return
    setStageBusy(true)
    try {
      await api.chat.streams.stage.requestUp(streamId)
      setHandRaised(true)
      showToast('Hand raised — the host decides who comes up')
    } catch (e) {
      showToast(chatError(e, 'Could not raise your hand'))
    } finally { setStageBusy(false) }
  }

  const acceptInvite = async () => {
    if (stageBusy) return
    setStageBusy(true)
    try {
      const me = await api.chat.streams.stage.accept(streamId)   // carries MY creds
      setInvite(null)
      await goUp(me)
    } catch (e) {
      showToast(chatError(e, 'Could not join the stage'))
    } finally { setStageBusy(false) }
  }

  const declineInvite = () => {
    api.chat.streams.stage.decline(streamId).catch(() => {})
    setInvite(null)
  }

  /* ---- host: the queue and the per-guest controls ----
     No local roster surgery after a mutation — the `stream.stage` broadcast is
     the acknowledgement, and it arrives for everyone at once. Only the queue
     is patched locally (its removal event doesn't exist). */
  const hostStageAct = async (userId, act, fallbackMsg) => {
    if (stageBusyId) return
    setStageBusyId(userId)
    try { await act() }
    catch (e) { showToast(chatError(e, fallbackMsg)) }
    finally { setStageBusyId(null) }
  }
  const approveReq = (userId) => hostStageAct(userId, async () => {
    await api.chat.streams.stage.approve(streamId, userId)
    setRequests(prev => prev.filter(r => String(r.userId) !== String(userId)))
  }, 'Could not bring them up')
  const denyReq = (userId) => hostStageAct(userId, async () => {
    await api.chat.streams.stage.deny(streamId, userId)
    setRequests(prev => prev.filter(r => String(r.userId) !== String(userId)))
  }, 'Could not decline the request')
  const inviteUp = (userId) => hostStageAct(userId, async () => {
    await api.chat.streams.stage.invite(streamId, userId)
    showToast('Invitation sent')
  }, 'Could not send the invite')
  const muteGuest   = (userId) => hostStageAct(userId, () => api.chat.streams.stage.mute(streamId, userId), 'Could not mute them')
  const unmuteGuest = (userId) => hostStageAct(userId, () => api.chat.streams.stage.unmute(streamId, userId), 'Could not unmute them')
  const removeGuest = async (userId) => {
    const ok = await uiConfirm({
      title: 'Take them off the stage?',
      message: 'Their camera and mic stop for everyone. They can raise their hand again.',
      confirmLabel: 'Take down', danger: true, icon: 'block',
    })
    if (!ok) return
    hostStageAct(userId, () => api.chat.streams.stage.remove(streamId, userId), 'Could not take them down')
  }

  /* ---- reactions: tap → float; throttle the wire, never the animation ----
     The server caps 30/10s; a rapid tapper still sees every one of their own
     hearts (the point of tapping), we just don't send each to the wire. */
  const spawnFloater = React.useCallback((type) => {
    const id = Math.random().toString(36).slice(2)
    setFloaters(prev => [...prev.slice(-40), { id, emoji: emojiOfReaction(type), x: 6 + Math.random() * 78 }])
    setTimeout(() => setFloaters(prev => prev.filter(f => f.id !== id)), 2600)
  }, [])

  const tapReaction = React.useCallback((type = 'LIKE') => {
    spawnFloater(type)                                 // optimistic — mine shows instantly
    const now = Date.now()
    if (now - lastTapRef.current < 180) return
    lastTapRef.current = now
    api.chat.streams.react(streamId, type).catch(() => { /* rate-limited or dropped — the float already played */ })
  }, [spawnFloater, streamId])

  /* ---- gifts: one splash at a time, board kept live off the frames ----
     A plain state queue, drained by effects: when nothing is showing and
     something is waiting, promote the head; every splash hides itself after a
     hold that grows with the gift's coins. Two effects on purpose — a single
     one re-armed by queue growth would cancel the hide timer of whatever is
     mid-splash. */
  const enqueueGift = React.useCallback((g) => setGiftQueue(q => [...q, g]), [])

  React.useEffect(() => {
    if (giftSplash || giftQueue.length === 0) return
    setGiftSplash(giftQueue[0])
    setGiftQueue(q => q.slice(1))
  }, [giftSplash, giftQueue])

  React.useEffect(() => {
    if (!giftSplash) return undefined
    const holdMs = 1800 + Math.min((giftSplash.coins || 1) * 60, 2400)   // bigger gift, longer moment
    const t = setTimeout(() => setGiftSplash(null), holdMs)
    return () => clearTimeout(t)
  }, [giftSplash])

  const upsertSupporter = (prev, g) => {
    const before = prev.find(r => String(r.userId) === String(g.senderId))
    const rows = prev.filter(r => String(r.userId) !== String(g.senderId))
    rows.push({
      userId: g.senderId,
      username: g.senderUsername,
      handle: g.senderHandle,
      displayName: before?.displayName || '',
      avatarUrl: before?.avatarUrl || g.senderAvatarUrl || null,
      coins: g.senderTotalCoins,               // the authoritative running total
      giftCount: (before?.giftCount || 0) + 1,
    })
    return rows.sort((a, b) => b.coins - a.coins).slice(0, 10)
  }

  const openGifts = async () => {
    setGiftsOpen(true)
    if (catalog === null) {
      try { setCatalog(await api.chat.streams.gifts.catalog()) }
      catch { setCatalog([]) }
    }
  }

  const sendGift = async (giftId) => {
    if (giftBusy) return
    setGiftBusy(true)
    try {
      await api.chat.streams.gifts.send(streamId, giftId)
      setGiftsOpen(false)
      // No local splash: the `stream.gift` broadcast echoes to the sender too
      // (measured), so animating here would play it twice.
    } catch (e) {
      showToast(chatError(e, 'Could not send the gift'))
    } finally { setGiftBusy(false) }
  }

  /* Seed the roster + supporters board; the host also seeds the request queue.
     After the seed everything arrives by broadcast. */
  React.useEffect(() => {
    if (!streamId || !stream?.isLive) return undefined
    let alive = true
    api.chat.streams.stage.get(streamId).then(s => { if (alive && s) setStage(s) }).catch(() => {})
    api.chat.streams.gifts.top(streamId, 10).then(b => { if (alive && b?.length) setBoard(b) }).catch(() => {})
    return () => { alive = false }
  }, [streamId, stream?.isLive])

  React.useEffect(() => {
    if (!streamId || !isHost || !stream?.isLive) return undefined
    let alive = true
    api.chat.streams.stage.requests(streamId).then(rs => { if (alive && rs) setRequests(rs) }).catch(() => {})
    return () => { alive = false }
  }, [streamId, isHost, stream?.isLive])

  /* A guest closing the tab must free their seat — same pagehide/beacon
     reasoning as the viewer `leave` above. */
  React.useEffect(() => {
    if (!streamId) return undefined
    const onHide = () => {
      if (guestCastRef.current) api.chat.streams.stage.leave(streamId, { beacon: true }).catch(() => {})
    }
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      if (guestCastRef.current) {
        stopGuestCast()
        api.chat.streams.stage.leave(streamId).catch(() => {})
      }
    }
  }, [streamId, stopGuestCast])

  // Always release the camera + peer connection when leaving the room.
  React.useEffect(() => () => stopCast(), [stopCast])

  // "Your picture is back" is a confirmation, not a state — let it fade.
  React.useEffect(() => {
    if (camHealth.state !== 'recovered') return undefined
    const t = setTimeout(() => setCamHealth({ state: 'ok', detail: '' }), 4000)
    return () => clearTimeout(t)
  }, [camHealth.state])

  /* ---- VIEWER: play the stream. WHEP first (sub-second latency, the "live"
     feel); fall back to HLS — Safari plays it natively, every other engine
     gets hls.js over MediaSource, imported on demand. Failure stays HONEST:
     a fatal error surfaces the open-in-a-player link, not a black rectangle.
     The host never runs this — they see their own camera preview instead. */
  React.useEffect(() => {
    if (isHost) return undefined
    const el = videoRef.current
    if (!el || !stream?.isLive) return undefined

    let dead = false
    let hls = null
    let netRetries = 0
    const stopWhep = () => { whepRef.current?.stop?.(); whepRef.current = null }

    const attachHls = () => {
      const url = stream.playbackUrl
      if (!url) { setPlayback('failed'); return }
      if (!/\.m3u8($|\?)/i.test(url) || canPlayHls(el)) {
        setPlayback('native'); el.src = url
        el.play?.().catch(() => { /* autoplay policy — the controls are there */ })
        return
      }
      import('hls.js')
        .then(({ default: Hls }) => {
          if (dead) return
          if (!Hls.isSupported()) { setPlayback('unsupported'); return }
          hls = new Hls({ enableWorker: true, lowLatencyMode: true })
          hls.on(Hls.Events.ERROR, (_evt, data) => {
            if (dead || !data?.fatal) return
            /* Media errors are usually a decoder hiccup — recoverable in place.
               Network errors get a few retries (a live edge can 404 for a beat
               as segments rotate) before we give up honestly. */
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { hls?.recoverMediaError(); return }
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR && netRetries < 3) {
              netRetries += 1
              setTimeout(() => { if (!dead) hls?.startLoad() }, 1500 * netRetries)
              return
            }
            hls?.destroy(); hls = null
            setPlayback('failed')
          })
          hls.loadSource(url)
          hls.attachMedia(el)
          setPlayback('mse')
          el.play?.().catch(() => { /* autoplay policy */ })
        })
        .catch(() => { if (!dead) setPlayback('unsupported') })
    }

    async function go() {
      setPlayback('probing')
      // 1) WHEP — pure WebRTC, sub-second latency.
      if (stream.whepUrl) {
        try {
          const handle = await playWhep(stream.whepUrl, el, {
            onState: (st) => {
              if (dead) return
              if (st === 'connected') setPlayback('webrtc')
              // If the WebRTC path drops, fall back to HLS mid-stream.
              if ((st === 'failed' || st === 'disconnected') && whepRef.current) {
                stopWhep(); if (!dead) attachHls()
              }
            },
          })
          if (dead) { handle.stop(); return }
          whepRef.current = handle
          el.play?.().catch(() => {})
          return
        } catch { /* WHEP unavailable (no publisher yet, or blocked) — try HLS */ }
      }
      attachHls()
    }
    go()
    return () => { dead = true; stopWhep(); hls?.destroy() }
  }, [isHost, stream?.whepUrl, stream?.playbackUrl, stream?.isLive])

  React.useEffect(() => subscribe((evt) => {
    if (!evt?.type?.startsWith('stream.')) return
    if (evt.streamId && String(evt.streamId) !== String(streamId)) return

    if (evt.type === 'stream.viewer') {
      /* PATCH, never replace. `liveStreamFrom` fills everything the payload
         omits with `null`, and the URLs are not on a viewer frame — they are
         minted on `join`, and `whipUrl` is host-only besides. Assigning the
         frame wholesale blanked `playbackUrl`/`whepUrl`, which are attach-
         effect dependencies: the video tore down and re-dialled every single
         time somebody else walked into the room. */
      if (evt.stream) setStream(prev => patchStream(prev, evt.stream))
      /* The event names WHO joined or left, not just the new total — that is
         the audience feedback a live room runs on, and it was being thrown
         away in favour of a bare number. Fold it into the same log as the
         chat so arrivals read in sequence with what is being said.
         My own join is skipped: "you joined" is not news to you. */
      if (evt.userId && String(evt.userId) !== String(myId)) {
        setLines(prev => [...prev, {
          kind: 'presence',
          userId: evt.userId,
          left: evt.memberChange === 'LEFT',
          sentAt: evt.timestamp || null,
        }].slice(-200))
      }
    }

    /* The host edited the title/description mid-broadcast. Same patch rule —
       the frame omits the host identity, so replacing would blank it. */
    if (evt.type === 'stream.updated' && evt.stream) {
      setStream(prev => patchStream(prev, evt.stream))
    }

    if (evt.type === 'stream.ended') {
      /* The EVENT NAME is the truth here, not the payload: `liveStreamFrom`
         defaults a missing `status` to LIVE, so a thin frame would have left
         the room insisting the stream was still running. */
      setStream(prev => (prev || evt.stream
        ? { ...patchStream(prev, evt.stream), status: 'ENDED', isLive: false }
        : prev))
      joinedRef.current = false
      setJoined(false)
      /* The whole stage dies with the stream — there is no separate "stage
         cleared" frame. Stop my publisher, drop the roster (which closes every
         WHEP tile via useStageVideos), clear anything awaiting an answer. */
      stopGuestCast()
      setStage(null)
      setInvite(null)
      setRequests([])
      setHandRaised(false)
      showToast('The stream has ended')
    }
    if (evt.type === 'stream.chat' && evt.streamChat) {
      // Ephemeral and unbounded on the wire — keep the tail so a long stream
      // can't grow the DOM without limit.
      setLines(prev => [...prev, { kind: 'chat', ...evt.streamChat }].slice(-200))
    }

    /* ---- multi-guest stage ---- */
    if (evt.type === 'stream.stage' && evt.stage) {
      // The whole panel — REPLACE local state, and reconcile what it implies:
      setStage(evt.stage)
      // a queued requester who is now ACTIVE was approved (maybe on another device)
      setRequests(prev => prev.filter(r => !evt.stage.members.some(m => String(m.userId) === String(r.userId))))
      // my own hand-raise resolves the moment the roster carries me
      if (evt.stage.members.some(m => String(m.userId) === String(myId))) setHandRaised(false)
    }
    if (evt.type === 'stream.stage.request' && evt.stageMember) {
      // Host only — a viewer raised their hand. Replace-by-user, then append.
      setRequests(prev => [...prev.filter(r => String(r.userId) !== String(evt.stageMember.userId)), evt.stageMember])
    }
    if (evt.type === 'stream.stage.invite' && evt.stageMember) {
      // Invitee only — the member is the HOST (so the banner can say who asked).
      setInvite(evt.stageMember)
    }
    if (evt.type === 'stream.stage.grant' && evt.stageMember) {
      /* Addressed to ONE guest, but check anyway — trusting the address alone
         would let a mis-fanned frame start someone else's camera. */
      const m = evt.stageMember
      if (String(m.userId) === String(myId)) {
        if (m.status === 'REMOVED') {
          stopGuestCast()
          showToast('The host took you off the stage')
        } else if (m.whipUrl) {
          setHandRaised(false)
          goUp(m)          // the host approved my hand-raise — my creds are here
        }
      }
    }

    /* ---- reactions & gifts ---- */
    if (evt.type === 'stream.reaction' && evt.streamReaction) {
      // Mine already floated at tap time — the echo would double it.
      if (String(evt.streamReaction.userId) !== String(myId)) spawnFloater(evt.streamReaction.type)
    }
    if (evt.type === 'stream.gift' && evt.streamGift) {
      const g = evt.streamGift
      /* Everyone animates from the frame — including the sender (their send
         deliberately doesn't splash locally, so this is their one). */
      enqueueGift(g)
      setBoard(prev => upsertSupporter(prev, g))
      // A gift is a live-room moment — it belongs in the log next to the chat.
      setLines(prev => [...prev, {
        kind: 'gift', userId: g.senderId, username: g.senderUsername, gift: g, sentAt: g.sentAt,
      }].slice(-200))
    }
  }), [subscribe, streamId, myId, goUp, stopGuestCast, spawnFloater, enqueueGift])

  React.useEffect(() => {
    const ids = lines.map(l => l.userId).filter(Boolean)   // chat AND presence lines
    if (ids.length) watchUsers(ids.slice(-30))
  }, [lines, watchUsers])

  /* The stage/queue/board people too: their frames carry no avatar (measured —
     the same backend gap as hostAvatarUrl), so the chat user-card cache is the
     only place a face can come from. */
  React.useEffect(() => {
    const ids = [
      ...(stage?.members || []).map(m => m.userId),
      ...requests.map(r => r.userId),
      ...board.map(s => s.userId),
      invite?.userId,
    ].filter(Boolean)
    if (ids.length) watchUsers(ids.slice(0, 30))
  }, [stage, requests, board, invite, watchUsers])

  // Pin the log to the newest line as it grows.
  React.useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  const send = async () => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      await api.chat.streams.chat(streamId, text)
      setDraft('')
      // No optimistic line: the server echoes our own message back on the
      // stream, and a local copy would render it twice with no id to dedupe on.
    } catch (e) {
      showToast(chatError(e, 'Could not send'))
    } finally {
      setSending(false)
    }
  }

  const endStream = async () => {
    const ok = await uiConfirm({
      title: 'End the stream?',
      message: stream?.recordingStatus === 'RECORDING'
        ? 'Viewers will be disconnected and the stream closes for everyone. Your recording is saved and you can download it here afterwards.'
        : 'Viewers will be disconnected and the stream closes for everyone.',
      danger: true,
      confirmLabel: 'End stream',
    })
    if (!ok) return
    try {
      await api.chat.streams.end(streamId)
      stopCast()
      showToast('Stream ended')
      /* Deliberately NOT exiting to the directory any more. Ending is the exact
         moment `recordingStatus` resolves (RECORDING → AVAILABLE or EMPTY), so
         bouncing the host out was sending them to hunt for a file that had just
         appeared on the page they were thrown off. Re-fetch in place instead —
         the room already renders its own ended state. */
      const fresh = await api.chat.streams.get(streamId).catch(() => null)
      setStream(prev => (fresh ? patchStream(prev, fresh) : { ...prev, status: 'ENDED', isLive: false }))
    } catch (e) {
      showToast(chatError(e, 'Could not end the stream'))
    }
  }

  const deleteStream = async () => {
    const ok = await uiConfirm({
      title: 'Delete this stream?',
      message: stream?.recordingAvailable
        ? 'The stream and its recording are both deleted for good. Download the recording first if you want to keep it.'
        : 'The stream is removed from your list for good.',
      danger: true,
      confirmLabel: 'Delete stream',
    })
    if (!ok) return
    try { await api.chat.streams.remove(streamId); showToast('Stream deleted'); onExit?.() }
    catch (e) { showToast(chatError(e, 'Could not delete the stream')) }
  }

  if (state === 'loading') return <Loader label="Opening the stream…"/>
  if (state === 'error' || !stream) {
    return <ErrorState message="This stream could not be opened." onRetry={onExit}/>
  }

  // Only the truly-stuck states get the banner — 'probing' and 'mse' are
  // healthy, and 'failed' words it differently from 'unsupported'.
  const playbackStuck = !!stream.playbackUrl
    && /\.m3u8($|\?)/i.test(stream.playbackUrl)
    && (playback === 'unsupported' || playback === 'failed')

  return (
    <div className="lv-room">
      <div className="lv-main">
        <div className="lv-stage">
          {stream.isLive ? (
            <>
              <video ref={videoRef} className="lv-video" controls={!isHost} playsInline autoPlay muted={isHost}/>

              {/* Host: broadcast from the browser camera (WebRTC/WHIP). */}
              {isHost && cast !== 'live' && (
                <div className="lv-hls" style={{ textAlign: 'center' }}>
                  {cast === 'connecting' ? (
                    <Loader label="Starting your camera…"/>
                  ) : cast === 'error' ? (
                    <p>
                      <Icon name="info"/> {castErr}{' '}
                      <button className="rq-btn primary" onClick={startCast}>Try again</button>
                    </p>
                  ) : (
                    <p>
                      <Icon name="broadcast"/> You’re set to go live. Start your camera to
                      broadcast — viewers watch instantly.{' '}
                      <button className="rq-btn primary" onClick={startCast}>Start camera</button>
                    </p>
                  )}
                </div>
              )}

              {/* Viewer: playback couldn’t start on this engine. */}
              {!isHost && playbackStuck && (
                <div className="lv-hls">
                  <Icon name="info"/>
                  <p>
                    {playback === 'failed'
                      ? 'The stream can’t be reached right now — the media server may be down or not configured.'
                      : 'This browser can’t play HLS directly.'}{' '}
                    <a href={stream.playbackUrl} target="_blank" rel="noopener noreferrer">
                      Open the stream in a player
                    </a>.
                  </p>
                </div>
              )}

              <span className="lv-badge"><span className="lv-dot" aria-hidden="true"/>LIVE</span>

              {/* Reactions drift up over the picture; a gift takes the center.
                  Both are broadcast moments — everyone sees the same thing. */}
              <FloaterLayer floaters={floaters}/>
              <GiftSplash gift={giftSplash} cardOf={userOf}/>

              {/* Tap rail — hearts and the gift box. Joined viewers and the
                  host only: the server rejects outsiders, so don't offer it. */}
              {(isHost || joined) && (
                <div className="lv-react-rail" role="group" aria-label="Reactions">
                  {REACTIONS.map(r => (
                    <button key={r.type} className="lv-react-btn" onClick={() => tapReaction(r.type)}
                      aria-label={`React ${r.label}`} title={r.label}>
                      <span aria-hidden="true">{r.emoji}</span>
                    </button>
                  ))}
                  <button className="lv-react-btn gift" onClick={openGifts}
                    aria-label="Send a gift" title="Send a gift">
                    <span aria-hidden="true">🎁</span>
                  </button>
                </div>
              )}

              <GiftPicker open={giftsOpen} catalog={catalog} busy={giftBusy}
                onSend={sendGift} onClose={() => setGiftsOpen(false)}/>
            </>
          ) : (
            <div className="lv-ended">
              <Icon name="broadcast" className="lg"/>
              <h3>This stream has ended</h3>
              <p>Live chat isn’t recorded, so there’s nothing to replay here.</p>
            </div>
          )}
        </div>

        {/* The host asked me up — a decision, so it sits where it can't be missed. */}
        {stream.isLive && !meOnStage && (
          <InviteBanner invite={invite} busy={stageBusy} cardOf={userOf}
            onAccept={acceptInvite} onDecline={declineInvite}/>
        )}

        {/* The stage rail — my tile (local camera) + every other guest (WHEP). */}
        {stream.isLive && (
          <StageTiles
            stage={stage} myId={myId} isHost={isHost} meOnStage={meOnStage}
            myTileRef={myTileRef} micOn={micOn} connsRef={connsRef} cardOf={userOf}
            busyId={stageBusyId}
            onMute={muteGuest} onUnmute={unmuteGuest} onRemove={removeGuest}
            onStepDown={() => stepDown(false)}
          />
        )}

        {/* Host broadcast controls — only while actually publishing the camera. */}
        {isHost && stream.isLive && cast === 'live' && (
          <div className="lv-cast-bar" style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '10px 0', flexWrap: 'wrap' }}>
            <span className="lv-badge"><span className="lv-dot" aria-hidden="true"/>You’re live</span>
            <button className="btn" onClick={toggleMic}>
              <Icon name={micOn ? 'mic' : 'micoff'} className="xs"/>{micOn ? 'Mute' : 'Unmute'}
            </button>
            <button className="btn" onClick={toggleCam}>
              <Icon name={camOn ? 'camera' : 'videooff'} className="xs"/>{camOn ? 'Camera off' : 'Camera on'}
            </button>
            <button className={'btn' + (recording ? ' rec-on' : '')} onClick={toggleRecord} disabled={recBusy}
              aria-pressed={recording}
              title={recording ? 'Stop saving — the broadcast continues' : 'Start saving this broadcast'}>
              {recording
                ? <><span className="lv-dot" aria-hidden="true"/>Stop recording</>
                : <><Icon name="broadcast" className="xs"/>Record</>}
            </button>

            {/* The picture died while the connection stayed up. Said plainly and
                at the moment it happens, because the alternative is the host
                discovering it in the recording, when nothing can be done. */}
            {camHealth.state === 'recovered' && (
              <span className="lv-cast-warn ok">
                <Icon name="camera" className="xs"/>Your picture is back.
              </span>
            )}
            {camHealth.state === 'stalled' && (
              <span className="lv-cast-warn">
                <Icon name="info" className="xs"/>
                Your picture stopped{camHealth.detail ? ` — ${camHealth.detail}` : ''}. Restoring the camera…
              </span>
            )}
            {camHealth.state === 'lost' && (
              <span className="lv-cast-warn bad">
                <Icon name="info" className="xs"/>
                Your camera can’t be reopened{camHealth.detail ? ` (${camHealth.detail})` : ''} — viewers and the
                recording have sound but no picture. Close anything else using the camera, then{' '}
                <button className="rq-btn" onClick={() => { stopCast(); startCast() }}>restart the camera</button>.
              </span>
            )}
          </div>
        )}

        {/* Host: viewers asking to come up. Broadcast keeps it fresh; approval
            grants THEM creds via their private stream.stage.grant. */}
        {isHost && stream.isLive && (
          <RequestQueue requests={requests} stageFull={stageFull} busyId={stageBusyId}
            cardOf={userOf} onApprove={approveReq} onDeny={denyReq}/>
        )}

        <header className="lv-meta">
          <div className="lv-meta-main">
            <h1 dir="auto">{stream.title}</h1>
            {stream.description && <p dir="auto">{stream.description}</p>}
            <div className="lv-meta-row">
              <span><Icon name="eye" className="xs"/>{stream.viewerCount.toLocaleString()} watching</span>
              {stream.startedAt && <span><Icon name="clock" className="xs"/>started {clockOf(stream.startedAt)}</span>}
            </div>
          </div>
          <div className="lv-meta-acts">
            <button className="btn" onClick={onExit}><Icon name="chevleft" className="xs"/>All streams</button>
            {/* Ask to come up beside the host. Joined viewers only (the server
                requires membership), and honest about a full stage. */}
            {!isHost && stream.isLive && joined && !meOnStage && (
              <button className="btn" onClick={raiseHand}
                disabled={stageBusy || handRaised || stageFull}
                title={stageFull ? `The stage is full (${stage?.maxGuests ?? 6})` : 'Ask to join the host on stage'}>
                <Icon name="mic" className="xs"/>
                {stageFull ? 'Stage full' : handRaised ? 'Hand raised' : 'Join stage'}
              </button>
            )}
            {stream.shareUrl && (
              /* The key-safe watch link ({base}/live/{id}) — carries no
                 stream key, safe for anyone; the route joins on arrival. */
              <button className="btn" onClick={() => openShare({ kind: 'stream', url: stream.shareUrl, title: stream.title })}>
                <Icon name="share" className="xs"/>Share
              </button>
            )}
            {isHost && (
              <button className="btn" onClick={() => setEditing(true)}>
                <Icon name="edit" className="xs"/>Edit
              </button>
            )}
            {isHost && stream.isLive && (
              <button className="btn btn-danger" onClick={endStream}>End stream</button>
            )}
            {isHost && !stream.isLive && (
              <button className="btn btn-danger" onClick={deleteStream}>Delete</button>
            )}
          </div>
        </header>

        {/* Owner-only, and only once the backend has said something about it. */}
        {isHost && (
          <RecordingPanel
            stream={stream}
            requested={recordRequested}
            onChanged={(patch) => setStream(prev => ({ ...prev, ...patch }))}
          />
        )}

        {isHost && stream.ingestUrl && (
          <section className="lv-ingest">
            <div className="lv-ingest-t">
              <Icon name="lock" className="sm"/>
              <b>Advanced — broadcast with OBS / software</b>
              <span className="lv-ingest-warn">Optional. Never share this — it carries your stream key.</span>
            </div>
            <div className="lv-ingest-row">
              <code>{showIngest ? stream.ingestUrl : '••••••••••••••••••••••••••••'}</code>
              <button className="rq-btn" onClick={() => setShowIngest(v => !v)}>
                {showIngest ? 'Hide' : 'Reveal'}
              </button>
              <button className="rq-btn primary" onClick={async () => {
                try { await navigator.clipboard.writeText(stream.ingestUrl); showToast('Ingest URL copied') }
                catch { showToast('Could not copy') }
              }}>Copy</button>
            </div>
          </section>
        )}
      </div>

      <aside className="lv-chat" aria-label="Live chat">
        <div className="lv-chat-head">
          <h2>Live chat</h2>
          <span className="lv-chat-n">{stream.viewerCount.toLocaleString()}</span>
        </div>

        <SupportersPanel board={board} cardOf={userOf}/>

        <div className="lv-chat-log" ref={logRef}>
          {lines.length === 0 ? (
            <p className="lv-chat-empty">
              Live chat isn’t saved — messages appear only for people watching
              right now. Say salam.
            </p>
          ) : lines.map((l, i) => {
            const card = userOf(l.userId)
            const who = card?.full || l.username || 'Someone'
            /* The host can pull anyone in the room up on stage straight from
               their line — presence and chat rows both carry the userId. */
            const onStageIds = new Set((stage?.members || []).map(m => String(m.userId)))
            const canInvite = isHost && stream.isLive && l.userId
              && !stageFull && !onStageIds.has(String(l.userId))
            const inviteBtn = canInvite ? (
              <button className="lv-line-invite" onClick={() => inviteUp(l.userId)}
                disabled={stageBusyId === l.userId} title={`Invite ${who} up on the stage`}>
                <Icon name="mic" className="xs"/>Invite up
              </button>
            ) : null
            if (l.kind === 'presence') {
              return (
                <div className="lv-line lv-line-presence" key={`p-${l.userId}-${i}`}>
                  <Icon name={l.left ? 'logout' : 'follow'} className="xs"/>
                  <span dir="auto">{who} {l.left ? 'left' : 'joined'}</span>
                  {!l.left && inviteBtn}
                </div>
              )
            }
            if (l.kind === 'gift') {
              return (
                <div className="lv-line lv-line-gift" key={`g-${l.sentAt}-${i}`}>
                  <span className="lv-line-gift-ico" aria-hidden="true">{emojiOfGift(l.gift?.iconKey)}</span>
                  <span dir="auto"><b>{who}</b> sent {/^[aeiou]/i.test(l.gift?.giftName || '') ? 'an' : 'a'} {l.gift?.giftName}</span>
                </div>
              )
            }
            return (
              <div className="lv-line" key={`${l.sentAt}-${i}`}>
                <button className="lv-line-av" onClick={() => l.userId && navigate(`/u/${l.userId}`)}
                  aria-label={`View @${l.username}'s profile`}>
                  <Avatar size={26} src={card?.profileImage || null} initials={card?.initials || '·'} color={card?.avc}/>
                </button>
                <span className="lv-line-body">
                  <b dir="auto">{who}</b>
                  <span dir="auto">{l.text}</span>
                </span>
                {inviteBtn}
              </div>
            )
          })}
        </div>

        {stream.isLive && (isHost || joined) && (
          <div className="lv-chat-send">
            <input className="field" value={draft} maxLength={280}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); send() } }}
              placeholder="Say something…" aria-label="Live chat message"/>
            <button className="ch-send" onClick={send} disabled={!draft.trim() || sending}
              aria-label="Send" title="Send">
              <Icon name="send"/>
            </button>
          </div>
        )}
      </aside>

      {editing && (
        <EditStream
          stream={stream}
          onClose={() => setEditing(false)}
          onSaved={(s) => {
            setEditing(false)
            /* The PATCH response is the full record, but fold it rather than
               assign it — the host's own copy holds `whipUrl`/`ingestUrl`, and
               a response that omitted either would take the broadcast down. */
            setStream(prev => patchStream(prev, s))
            showToast('Stream updated')
          }}
        />
      )}
    </div>
  )
}

/* ---------- your streams (owner catalogue) ----------
   `GET /streams/mine` is the only place an ENDED stream is reachable — it is
   gone from `/streams/live` the moment it stops, so without this the host can
   never get back to a recording. Kept behind a button rather than pinned to
   the page: for most people it is empty, and discovery is what /live is for. */

function MyStreams({ onClose, onOpen }) {
  const [page, setPage] = React.useState(null)     // the Spring page, mapped
  const [state, setState] = React.useState('loading')
  const [editing, setEditing] = React.useState(null)

  const load = React.useCallback(() => {
    setState(s => (s === 'ready' ? s : 'loading'))
    api.chat.streams.mine({ page: 0, size: 30 })
      .then(pg => { setPage(pg); setState('ready') })
      .catch(() => setState('error'))
  }, [])

  React.useEffect(() => { load() }, [load])

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !editing) onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, editing])

  const rows = page?.items || []

  const patchRow = (id, patch) => setPage(pg => (pg ? {
    ...pg,
    items: pg.items.map(r => (String(r.id) === String(id) ? { ...r, ...patch } : r)),
  } : pg))

  const dropStream = async (s) => {
    const ok = await uiConfirm({
      title: 'Delete this stream?',
      message: s.recordingAvailable
        ? 'The stream and its recording are both deleted for good.'
        : 'The stream is removed from your list for good.',
      danger: true,
      confirmLabel: 'Delete',
    })
    if (!ok) return
    try {
      await api.chat.streams.remove(s.id)
      setPage(pg => (pg ? { ...pg, items: pg.items.filter(r => String(r.id) !== String(s.id)) } : pg))
      showToast('Stream deleted')
    } catch (e) { showToast(chatError(e, 'Could not delete the stream')) }
  }

  const download = async (s) => {
    // saveWholeRecording, not saveRecording: the part-less route 400s on a
    // multi-part recording, which a browser broadcast produces routinely.
    try {
      const n = await api.chat.streams.saveWholeRecording(s.id)
      if (n > 1) showToast(`Saved ${n} files — the broadcast is split into parts`)
    } catch (e) { showToast(chatError(e, 'Could not download the recording')) }
  }

  return (
    <div className="ch-modal-overlay" role="dialog" aria-modal="true" aria-label="Your streams"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="ch-modal lv-mine">
        <div className="ch-modal-head">
          <h3>Your streams</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close">
            <Icon name="close" className="sm"/>
          </button>
        </div>

        <div className="ch-modal-body">
          {state === 'loading' && <Loader label="Loading your streams…"/>}
          {state === 'error' && <ErrorState message="Could not load your streams." onRetry={load}/>}
          {state === 'ready' && rows.length === 0 && (
            <EmptyState icon="broadcast" title="You haven’t streamed yet"
              sub="Your past broadcasts and their recordings will live here."/>
          )}

          {rows.map(s => {
            const [recLabel] = RECORDING_LABEL[s.recordingStatus] || []
            return (
              <div className="lv-mine-row" key={s.id}>
                <div className="lv-mine-main">
                  <div className="lv-mine-t">
                    <span className={'lv-mine-state ' + (s.isLive ? 'live' : 'ended')}>
                      {s.isLive && <span className="lv-dot" aria-hidden="true"/>}
                      {s.isLive ? 'LIVE' : 'Ended'}
                    </span>
                    <b dir="auto">{s.title}</b>
                  </div>
                  <div className="lv-mine-sub">
                    {s.startedAt && <span>{new Date(s.startedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</span>}
                    <span><Icon name="eye" className="xs"/>{(Number(s.viewerCount) || 0).toLocaleString()}</span>
                    {recLabel && <span className={'lv-rec-chip sm ' + String(s.recordingStatus).toLowerCase()}>{recLabel}</span>}
                  </div>
                </div>
                <div className="lv-mine-acts">
                  {s.isLive && <button className="rq-btn primary" onClick={() => onOpen?.(s)}>Open</button>}
                  {s.recordingAvailable && (
                    <button className="rq-btn" onClick={() => download(s)}>Download</button>
                  )}
                  <button className="rq-btn" onClick={() => setEditing(s)}>Edit</button>
                  <button className="rq-btn" onClick={() => dropStream(s)}>Delete</button>
                </div>
              </div>
            )
          })}

          {page?.hasMore && (
            <p className="lv-mine-more">
              Showing your {rows.length} most recent streams.
            </p>
          )}
        </div>
      </div>

      {editing && (
        <EditStream
          stream={editing}
          onClose={() => setEditing(null)}
          onSaved={(s) => {
            patchRow(editing.id, { title: s.title, description: s.description })
            setEditing(null)
            showToast('Stream updated')
          }}
        />
      )}
    </div>
  )
}

/* ---------- discovery ---------- */

export function LivePage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { id } = useParams()
  const { user } = useAuth()
  const { subscribe } = useChat()

  const [rows, setRows] = React.useState([])
  const [state, setState] = React.useState('loading')
  const [going, setGoing] = React.useState(false)
  const [mine, setMine] = React.useState(false)
  // How many followed hosts the rail is showing — the "Discover" heading only
  // earns its place once there is a row above it to be distinguished from.
  const [followCount, setFollowCount] = React.useState(0)

  const load = React.useCallback(() => {
    setState(s => (s === 'ready' ? s : 'loading'))
    api.chat.streams.live()
      .then(res => { setRows(res); setState('ready') })
      .catch(() => setState('error'))
  }, [])

  React.useEffect(() => { if (!id) load() }, [id, load])

  /* The same reconcile the rail carries, and for the same measured reason:
     `stream.ended` is fanned to a stream's participants, NOT to everyone
     watching the directory, so a pushed-only grid never loses a card. `load`
     keeps `state` at 'ready', so this never flashes the loader. */
  React.useEffect(() => {
    if (id) return undefined
    const tick = () => { if (!document.hidden) load() }
    const t = setInterval(tick, 60000)
    document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', tick) }
  }, [id, load])

  /* Keep the directory honest without polling: a stream starting, ending or
     gaining a viewer already arrives on the socket. The fold is shared with
     the rail (lib/liveRows.js) — the discovery grid passes no `skipHostId`,
     because your own stream belongs in "everyone live" and is what the "You"
     pill on the card is for. */
  React.useEffect(() => subscribe((evt) => {
    if (!evt?.type?.startsWith('stream.') || id) return
    setRows(prev => applyStreamEvent(prev, evt))
  }), [subscribe, id])

  if (id) return (
    <div className="main wide lv-page">
      <StreamRoom streamId={id} recordRequested={!!location.state?.recordRequested} onExit={() => navigate('/live')}/>
    </div>
  )

  return (
    <div className="main wide lv-page">
      <div className="col-main">
        <header className="cn-head">
          <div>
            <h1 className="cn-title">Live<em>.</em></h1>
            <p className="cn-sub">
              Streams happening right now. Chat is live-only — nothing is recorded.
            </p>
          </div>
          <div className="lv-head-acts">
            <button className="btn" onClick={() => setMine(true)}>
              <Icon name="feed" className="xs"/>Your streams
            </button>
            <button className="btn btn-primary" onClick={() => setGoing(true)}>
              <Icon name="broadcast" className="xs"/>Go live
            </button>
          </div>
        </header>

        {/* The people you follow, newest-live-first. Renders nothing at all
            when none of them is live — an empty rail is a state, not an
            error, and the directory below is the whole page either way. */}
        <LiveRow
          source="following"
          title="Following"
          sub="live right now"
          onCount={setFollowCount}
        />

        {state === 'loading' && <Loader label="Looking for live streams…"/>}
        {state === 'error' && <ErrorState message="Live streams are unavailable right now." onRetry={load}/>}
        {state === 'ready' && rows.length === 0 && (
          <EmptyState icon="broadcast" title="Nobody is live" sub="Be the first — start a stream above."/>
        )}

        {followCount > 0 && rows.length > 0 && (
          <header className="lv-sec"><h2>Discover</h2><span>everyone live, most-watched first</span></header>
        )}

        <div className="lv-grid">
          {rows.map(s => {
            /* Same host fields the rail uses, same derivation — one identity
               for a person, whichever surface they appear on. */
            const u = authorFrom({
              id: s.hostId, username: s.hostUsername,
              fullName: s.hostDisplayName, profileImage: s.hostAvatarUrl,
            }, s.hostId)
            return (
              <button key={s.id} className="lv-card" onClick={() => navigate(`/live/${s.id}`)}>
                <div className="lv-card-thumb">
                  <Icon name="broadcast"/>
                  <span className="lv-badge sm"><span className="lv-dot" aria-hidden="true"/>LIVE</span>
                </div>
                <div className="lv-card-body">
                  <h3 dir="auto">{s.title}</h3>
                  <div className="lv-card-host">
                    <Avatar size={22} src={u.profileImage || null} initials={u.initials} color={u.avc}/>
                    <span dir="auto">{u.full}</span>
                    <small dir="auto">@{s.hostHandle || u.handle}</small>
                  </div>
                  {s.description && <p dir="auto">{s.description}</p>}
                  <div className="lv-card-meta">
                    <Icon name="eye" className="xs"/>
                    {(Number(s.viewerCount) || 0).toLocaleString()} watching
                    {String(s.hostId) === String(user?.id) && <span className="pill">You</span>}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {going && (
        <GoLive
          onClose={() => setGoing(false)}
          onStarted={(s, record) => {
            setGoing(false)
            if (!s?.id) return
            /* Router state, not a query param: the host's INTENT is not part of
               the stream's address, and a reload should not keep re-asserting
               something we only knew at go-live. */
            /* Said once, immediately, as well as shown persistently in the room:
               "I asked for a recording and did not get one" is the kind of thing
               a host must not learn an hour late. */
            if (record && s.recordingStatus && s.recordingStatus !== 'RECORDING') {
              showToast('Going live — but recording could not be turned on')
            }
            navigate(`/live/${s.id}`, { state: { recordRequested: !!record } })
          }}
        />
      )}

      {mine && (
        <MyStreams
          onClose={() => { setMine(false); load() }}
          onOpen={(s) => { setMine(false); navigate(`/live/${s.id}`) }}
        />
      )}
    </div>
  )
}

export default LivePage
