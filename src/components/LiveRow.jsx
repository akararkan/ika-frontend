/* =========================================================
   LiveRow — the "following is live" rail
   ---------------------------------------------------------
   A horizontal rail of the people you follow who are live RIGHT NOW,
   newest-live-first: avatar ring, `@handle`, viewers. Tap a cell to
   open `/live/{id}`.

   Everything a cell renders arrives in the ONE list response —
   `followingLive()` already carries `hostAvatarUrl` / `hostHandle` /
   `hostDisplayName` — so the rail never fans out a user fetch per cell
   and never touches the `watchUsers` directory.

   `followingLive()`, `live()` and the home feed's own `liveNow()`
   return the identical card shape, so ONE cell renders all three
   rows:

     source="following" → people you follow, newest-live-first
     source="live"      → everyone live, most-watched-first
     source="feed"      → the HOME FEED rail (FEED_API §1.3):
                          followed hosts first, topped up to 10 with
                          the most-watched public streams, blocked
                          hosts removed — one server-composed list
                          rather than two client-merged ones.

   The feed rail arrives ALREADY LOADED: `/feed/home` returns
   `liveNow` beside the items, so passing it as `seed` renders the
   first paint with no second request. Everything after that — the
   socket fold and the reconcile beat — is identical, and the
   reconcile re-reads the cheap dedicated `/feed/live-now`.

   Host-only secrets (`whipUrl`, `ingestUrl`) are null for viewers and
   are never read here — the rail must never be able to leak a stream
   key, so it does not know one exists.

   Staying honest: the rail folds `stream.started` / `.ended` /
   `.viewer` off the same per-user socket chat already holds.
   `stream.started` IS fanned out to followers server-side, so a
   follower's rail gains a card the instant a followed user goes live —
   verified against the backend, no reload, no extra call.

   BUT — measured on the real socket (2026-07-27), a follower who never
   joined the stream receives `stream.started` and NOTHING ELSE. No
   `stream.ended`, no `stream.viewer`: those two are fanned to the
   stream's own participants, not to the host's followers. Pushed
   alone, the rail therefore only ever GROWS — dead streams sit in it
   until a reload, and tapping one opens an ended room.

   So the push path is the update path, and a slow reconcile is the
   safety net under it: one small list request a minute, skipped while
   the tab is hidden. Delete it the day the backend fans `stream.ended`
   to followers — the fold below already handles the frame.
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, Avatar } from './ui.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { useChat } from '../context/ChatContext.jsx'
import { api } from '../api/index.js'
import { authorFrom, timeAgo } from '../api/adapters.js'
import { applyStreamEvent } from '../lib/liveRows.js'

/* The reconcile beat. Long on purpose: this is the net under the socket, not
   the way the rail learns things — an arrival is still instant. */
const RECONCILE_MS = 60000

/* "1.2K watching" — a cell is ~84px wide, so 12,481 has to compact. */
let NF = null
try { NF = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }) }
catch { NF = null }
const compact = (n) => {
  const v = Number(n) || 0
  return NF ? NF.format(v) : v.toLocaleString()
}

/* The card's `time` is stamped when the payload is mapped and then frozen — a
   rail left mounted would still say "2m" an hour later. Re-render on a slow
   tick so the label ages, and only while there is something to age. */
function useAgeTick(active, ms = 30000) {
  const [, bump] = React.useReducer(n => n + 1, 0)
  React.useEffect(() => {
    if (!active) return undefined
    const t = setInterval(bump, ms)
    return () => clearInterval(t)
  }, [active, ms])
}

/* ---------- one cell ---------- */

export function LiveCell({ stream: s, onOpen }) {
  /* `authorFrom` is the app's one place that derives initials + the stable
     avatar gradient and runs the image through `assetUrl` — reusing it keeps
     the host's plate identical to the one the same person gets everywhere
     else, instead of a second look grown just for this rail. */
  const u = React.useMemo(() => authorFrom({
    id: s.hostId,
    username: s.hostUsername,
    fullName: s.hostDisplayName,
    profileImage: s.hostAvatarUrl,
  }, s.hostId), [s.hostId, s.hostUsername, s.hostDisplayName, s.hostAvatarUrl])

  // `hostHandle` is BARE ("alice") — the @ is ours to render, as everywhere else.
  const handle = s.hostHandle || u.handle
  const age = timeAgo(s.startedAt) || s.time || ''
  const viewers = Number(s.viewerCount) || 0

  return (
    <button
      type="button"
      className="lv-cell"
      onClick={() => onOpen?.(s)}
      title={`${s.title} — ${u.full}`}
      aria-label={`Watch ${u.full} live: ${s.title}. ${viewers.toLocaleString()} watching.`}
    >
      <span className="lv-cell-ring">
        <span className="lv-cell-plate">
          <Avatar size={62} src={u.profileImage || null} initials={u.initials} color={u.avc}/>
        </span>
        <span className="lv-cell-tag" aria-hidden="true">LIVE</span>
      </span>
      <span className="lv-cell-nm" dir="auto">@{handle}</span>
      <span className="lv-cell-meta">
        <Icon name="eye" className="xs"/>{compact(viewers)}
        {age && <span className="lv-cell-age">{age}</span>}
      </span>
    </button>
  )
}

/* ---------- the rail ---------- */

export function LiveRow({
  source = 'following',
  title = 'Live now',
  sub = '',
  onCount,
  seed = null,
}) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { subscribe } = useChat()
  const myId = user?.id || null
  const following = source === 'following'

  const [cards, setCards] = React.useState(() => seed || [])
  /* Nothing renders until the first response lands. A rail that flashes a
     skeleton and then collapses to nothing (the common case — most people
     follow nobody who is live) is worse than one that simply arrives. */
  const [ready, setReady] = React.useState(!!seed)
  // Re-seed trigger: bumped on socket (re)connect and on the reconcile beat.
  const [epoch, setEpoch] = React.useState(0)

  /* A rail that was handed its first page (the feed's `liveNow`) must not also
     fetch it. Consumed once: every LATER epoch — reconnect, reconcile — still
     re-reads from the server, because a seed ages exactly like a response. */
  const seededRef = React.useRef(!!seed)

  // A fresh seed (the feed reloaded) replaces the rail wholesale — it is a
  // newer answer to the same question, not a patch.
  React.useEffect(() => { if (seed) { setCards(seed); setReady(true) } }, [seed])

  React.useEffect(() => {
    if (seededRef.current) { seededRef.current = false; return undefined }
    let alive = true
    const req = source === 'feed' ? api.posts.liveNow()
      : following ? api.chat.streams.followingLive()
      : api.chat.streams.live()
    req
      .then(rows => {
        if (!alive) return
        /* You cannot follow yourself, so a self-hosted card in this row would
           be a backend slip — but it reads as a lie to the one person who can
           tell, so drop it rather than trust it. The feed rail is NOT filtered:
           it is topped up from the public most-watched list, where your own
           broadcast legitimately belongs. */
        setCards(following && myId
          ? (rows || []).filter(r => String(r.hostId) !== String(myId))
          : (rows || []))
        setReady(true)
      })
      /* An empty rail is a STATE, not a failure — nobody you follow is live is
         the ordinary case. A secondary rail has no business raising an error
         banner over the page it garnishes, so a dead call renders as nothing. */
      .catch(() => { if (alive) { setCards([]); setReady(true) } })
    return () => { alive = false }
  }, [source, following, myId, epoch])

  React.useEffect(() => subscribe((evt) => {
    if (!evt?.type) return
    /* The socket dropped and came back (chat.js's 60s watchdog re-dials): every
       frame during the gap is gone, so re-seed rather than stay confidently
       wrong. Cheap — a reconnect is rare. */
    if (evt.type === 'connected') { setEpoch(n => n + 1); return }
    if (!evt.type.startsWith('stream.')) return
    setCards(prev => applyStreamEvent(prev, evt, { skipHostId: following ? myId : null }))
  }), [subscribe, following, myId])

  /* The reconcile: re-seed on a slow beat so streams the socket never told us
     ended stop lingering, and viewer counts stop drifting. Paused while the
     tab is hidden — a backgrounded rail nobody is looking at has no business
     holding a request open — and caught up the moment it comes back, which is
     also exactly when a stale rail would be seen. */
  React.useEffect(() => {
    const tick = () => { if (!document.hidden) setEpoch(n => n + 1) }
    const t = setInterval(tick, RECONCILE_MS)
    document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', tick) }
  }, [])

  useAgeTick(ready && cards.length > 0)

  /* Reported through a ref, not a dependency: a parent that passes an inline
     arrow (the natural way to write it) would otherwise re-fire this on every
     one of its own renders — and since the callback exists to SET parent
     state, that is a render loop. */
  const onCountRef = React.useRef(onCount)
  React.useEffect(() => { onCountRef.current = onCount })
  React.useEffect(() => { onCountRef.current?.(cards.length) }, [cards.length])

  if (!ready || !cards.length) return null

  return (
    <section className="lv-rail" aria-label={title}>
      <header className="lv-rail-head">
        <h2>{title}</h2>
        {sub && <span>{sub}</span>}
      </header>
      <div className="lv-row" role="list">
        {cards.map(s => (
          <div className="lv-row-item" role="listitem" key={s.id}>
            <LiveCell stream={s} onOpen={(x) => navigate(`/live/${x.id}`)}/>
          </div>
        ))}
      </div>
    </section>
  )
}

export default LiveRow
