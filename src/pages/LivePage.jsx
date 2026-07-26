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
import { useNavigate, useParams } from 'react-router-dom'
import { Icon, Avatar, showToast } from '../components/ui.jsx'
import { Loader, EmptyState, ErrorState } from '../components/states.jsx'
import { openShare } from '../components/ShareSheet.jsx'
import { uiConfirm } from '../components/Dialog.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { useChat } from '../context/ChatContext.jsx'
import { api } from '../api/index.js'
import { chatError } from '../components/chat/chatErrors.js'

/** Native HLS is Safari-only; everywhere else a bare <video> can't play .m3u8. */
function canPlayHls(el) {
  if (!el) return false
  return !!el.canPlayType?.('application/vnd.apple.mpegurl')
}

const clockOf = (iso) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/* ---------- go live ---------- */

function GoLive({ onClose, onStarted }) {
  const [title, setTitle] = React.useState('')
  const [description, setDescription] = React.useState('')
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
      const s = await api.chat.streams.start({ title: title.trim(), description: description.trim() || undefined })
      onStarted?.(s)
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
          <p className="lv-note">
            <Icon name="info" className="xs"/>
            Starting a stream gives you a private ingest URL. Point your
            broadcasting software at it — the video never passes through IKA.
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

function StreamRoom({ streamId, onExit }) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { subscribe, watchUsers, userOf } = useChat()
  const myId = user?.id || null

  const [stream, setStream] = React.useState(null)
  const [state, setState] = React.useState('loading')      // loading | ready | error
  const [lines, setLines] = React.useState([])
  const [draft, setDraft] = React.useState('')
  const [showIngest, setShowIngest] = React.useState(false)
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
  // Registered-viewer flag. The host is implicitly allowed and never joins.
  const [joined, setJoined] = React.useState(false)
  const videoRef = React.useRef(null)
  const logRef = React.useRef(null)
  const joinedRef = React.useRef(false)

  const isHost = !!stream && String(stream.hostId) === String(myId)

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

  /* Attach playback. Safari plays HLS natively; every other engine gets
     hls.js over MediaSource — imported on demand, so no route that never
     watches a stream pays for the chunk. Failure stays HONEST: a fatal,
     unrecoverable error surfaces the open-in-a-player link rather than a
     silent black rectangle. */
  React.useEffect(() => {
    const el = videoRef.current
    const url = stream?.playbackUrl
    if (!el || !url) return undefined

    if (!/\.m3u8($|\?)/i.test(url) || canPlayHls(el)) {
      setPlayback('native')
      el.src = url
      el.play?.().catch(() => { /* autoplay policy — the controls are there */ })
      return undefined
    }

    let dead = false
    let hls = null
    let netRetries = 0
    setPlayback('probing')
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
    return () => { dead = true; hls?.destroy() }
  }, [stream?.playbackUrl])

  React.useEffect(() => subscribe((evt) => {
    if (!evt?.type?.startsWith('stream.')) return
    if (evt.streamId && String(evt.streamId) !== String(streamId)) return

    if (evt.type === 'stream.viewer') {
      if (evt.stream) setStream(evt.stream)
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

    if (evt.type === 'stream.ended') {
      if (evt.stream) setStream(evt.stream)
      joinedRef.current = false
      setJoined(false)
      showToast('The stream has ended')
    }
    if (evt.type === 'stream.chat' && evt.streamChat) {
      // Ephemeral and unbounded on the wire — keep the tail so a long stream
      // can't grow the DOM without limit.
      setLines(prev => [...prev, { kind: 'chat', ...evt.streamChat }].slice(-200))
    }
  }), [subscribe, streamId, myId])

  React.useEffect(() => {
    const ids = lines.map(l => l.userId).filter(Boolean)   // chat AND presence lines
    if (ids.length) watchUsers(ids.slice(-30))
  }, [lines, watchUsers])

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
      message: 'Viewers will be disconnected and the stream closes for everyone.',
      danger: true,
      confirmLabel: 'End stream',
    })
    if (!ok) return
    try { await api.chat.streams.end(streamId); showToast('Stream ended'); onExit?.() }
    catch (e) { showToast(chatError(e, 'Could not end the stream')) }
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
              <video ref={videoRef} className="lv-video" controls playsInline autoPlay/>
              {playbackStuck && (
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
            </>
          ) : (
            <div className="lv-ended">
              <Icon name="broadcast" className="lg"/>
              <h3>This stream has ended</h3>
              <p>Live chat isn’t recorded, so there’s nothing to replay here.</p>
            </div>
          )}
        </div>

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
            {stream.shareUrl && (
              /* The key-safe watch link ({base}/live/{id}) — carries no
                 stream key, safe for anyone; the route joins on arrival. */
              <button className="btn" onClick={() => openShare({ kind: 'stream', url: stream.shareUrl, title: stream.title })}>
                <Icon name="share" className="xs"/>Share
              </button>
            )}
            {isHost && stream.isLive && (
              <button className="btn btn-danger" onClick={endStream}>End stream</button>
            )}
          </div>
        </header>

        {isHost && stream.ingestUrl && (
          <section className="lv-ingest">
            <div className="lv-ingest-t">
              <Icon name="lock" className="sm"/>
              <b>Your ingest URL</b>
              <span className="lv-ingest-warn">Never share this — it carries your stream key.</span>
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

        <div className="lv-chat-log" ref={logRef}>
          {lines.length === 0 ? (
            <p className="lv-chat-empty">
              Live chat isn’t saved — messages appear only for people watching
              right now. Say salam.
            </p>
          ) : lines.map((l, i) => {
            const card = userOf(l.userId)
            const who = card?.full || l.username || 'Someone'
            if (l.kind === 'presence') {
              return (
                <div className="lv-line lv-line-presence" key={`p-${l.userId}-${i}`}>
                  <Icon name={l.left ? 'logout' : 'follow'} className="xs"/>
                  <span dir="auto">{who} {l.left ? 'left' : 'joined'}</span>
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
    </div>
  )
}

/* ---------- discovery ---------- */

export function LivePage() {
  const navigate = useNavigate()
  const { id } = useParams()
  const { user } = useAuth()
  const { subscribe } = useChat()

  const [rows, setRows] = React.useState([])
  const [state, setState] = React.useState('loading')
  const [going, setGoing] = React.useState(false)

  const load = React.useCallback(() => {
    setState(s => (s === 'ready' ? s : 'loading'))
    api.chat.streams.live()
      .then(res => { setRows(res); setState('ready') })
      .catch(() => setState('error'))
  }, [])

  React.useEffect(() => { if (!id) load() }, [id, load])

  /* Keep the directory honest without polling: a stream ending or gaining a
     viewer already arrives on the socket. */
  React.useEffect(() => subscribe((evt) => {
    if (!evt?.type?.startsWith('stream.') || id) return
    if (evt.type === 'stream.ended') setRows(prev => prev.filter(s => String(s.id) !== String(evt.streamId)))
    if (evt.type === 'stream.viewer' && evt.stream) {
      setRows(prev => prev.map(s => (String(s.id) === String(evt.stream.id) ? evt.stream : s)))
    }
    if (evt.type === 'stream.started' && evt.stream) {
      setRows(prev => [evt.stream, ...prev.filter(s => String(s.id) !== String(evt.stream.id))])
    }
  }), [subscribe, id])

  if (id) return (
    <div className="main wide lv-page">
      <StreamRoom streamId={id} onExit={() => navigate('/live')}/>
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
          <button className="btn btn-primary" onClick={() => setGoing(true)}>
            <Icon name="broadcast" className="xs"/>Go live
          </button>
        </header>

        {state === 'loading' && <Loader label="Looking for live streams…"/>}
        {state === 'error' && <ErrorState message="Live streams are unavailable right now." onRetry={load}/>}
        {state === 'ready' && rows.length === 0 && (
          <EmptyState icon="broadcast" title="Nobody is live" sub="Be the first — start a stream above."/>
        )}

        <div className="lv-grid">
          {rows.map(s => (
            <button key={s.id} className="lv-card" onClick={() => navigate(`/live/${s.id}`)}>
              <div className="lv-card-thumb">
                <Icon name="broadcast"/>
                <span className="lv-badge sm"><span className="lv-dot" aria-hidden="true"/>LIVE</span>
              </div>
              <div className="lv-card-body">
                <h3 dir="auto">{s.title}</h3>
                {s.description && <p dir="auto">{s.description}</p>}
                <div className="lv-card-meta">
                  <Icon name="eye" className="xs"/>
                  {s.viewerCount.toLocaleString()} watching
                  {String(s.hostId) === String(user?.id) && <span className="pill">You</span>}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {going && (
        <GoLive
          onClose={() => setGoing(false)}
          onStarted={(s) => { setGoing(false); if (s?.id) navigate(`/live/${s.id}`) }}
        />
      )}
    </div>
  )
}

export default LivePage
