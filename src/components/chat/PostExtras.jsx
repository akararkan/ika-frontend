/* =========================================================
   Post extras — the typed payloads and the channel-post rail
   ---------------------------------------------------------
   Four message types carry a structured payload instead of (or
   alongside) text — POLL, LOCATION, CONTACT and VIDEO_NOTE —
   and a channel post carries three counters plus its tags and
   the signature of the admin who published it. All of that is
   here so MessageBubble stays a bubble.

   The counters are the delicate part. `views`, `forwards` and
   `comments` are **null outside a channel**, and that null is
   meaningful: it says "this counter does not exist here", not
   "zero". `comments` is additionally null when no discussion
   group is linked. So every test is `!= null`, never truthiness
   — with `&&` a post with zero views would silently lose its
   counter row the moment it was published, which is exactly
   when an author looks at it.
   ========================================================= */
import React from 'react'
import { Icon, Avatar, showToast } from '../ui.jsx'
import { nfmt } from '../channels/channelArt.js'
import { api } from '../../api/index.js'
import { useChat } from '../../context/ChatContext.jsx'
import { chatError } from './chatErrors.js'

/* ---------------------------------------------------------
   POLL — including quiz mode.
   --------------------------------------------------------- */
export function PollCard({ msg, poll, canClose, onPoll }) {
  const [busy, setBusy] = React.useState(false)
  if (!poll) return null

  const multi = poll.allowsMultipleAnswers
  const locked = poll.closed || (poll.quiz && poll.voted)

  /* Quiz answers are FINAL — the API refuses a change or a retract — so the
     options stop being buttons the moment one is picked, rather than staying
     clickable and 400ing. An ordinary poll can always be changed. */
  const vote = async (index) => {
    if (locked || busy) return
    setBusy(true)
    try {
      const next = multi
        ? await api.chat.messages.vote(msg.id, toggleIndex(poll.myVotes, index))
        : await api.chat.messages.vote(msg.id, [index])
      onPoll?.(msg.id, next)
    } catch (e) {
      showToast(chatError(e, 'Could not record your vote'))
    } finally { setBusy(false) }
  }

  const retract = async () => {
    if (busy) return
    setBusy(true)
    try { onPoll?.(msg.id, await api.chat.messages.retractVote(msg.id)) }
    catch (e) { showToast(chatError(e, 'Could not retract your vote')) }
    finally { setBusy(false) }
  }

  const close = async () => {
    if (busy) return
    setBusy(true)
    try { onPoll?.(msg.id, await api.chat.messages.closePoll(msg.id)); showToast('Poll closed') }
    catch (e) { showToast(chatError(e, 'Could not close the poll')) }
    finally { setBusy(false) }
  }

  return (
    <div className={'ch-poll' + (poll.quiz ? ' quiz' : '') + (poll.closed ? ' closed' : '')}>
      <div className="ch-poll-head">
        <span className="ch-poll-kind">
          <Icon name={poll.quiz ? 'award' : 'qna'} className="xs"/>
          {poll.quiz ? 'Quiz' : poll.anonymous ? 'Anonymous poll' : 'Poll'}
          {multi && ' · pick several'}
        </span>
        {poll.closed && <span className="ch-poll-closed">Closed</span>}
      </div>

      <div className="ch-poll-q" dir="auto">{poll.question}</div>

      <div className="ch-poll-opts" role={poll.quiz ? 'radiogroup' : 'group'} aria-label={poll.question}>
        {poll.options.map(o => {
          /* Correctness is only knowable once the server has revealed it —
             before that `correctOptionIndex` is withheld, so no option may be
             marked either way or the quiz answers itself. */
          const right = poll.quiz && poll.revealed && poll.correctOptionIndex === o.index
          const wrong = poll.quiz && poll.revealed && o.mine && !right
          return (
            <button
              key={o.index}
              type="button"
              className={'ch-poll-opt' + (o.mine ? ' mine' : '') + (right ? ' right' : '') + (wrong ? ' wrong' : '')}
              style={{ '--pct': `${poll.revealed || poll.closed ? o.pct : 0}%` }}
              disabled={locked || busy}
              aria-pressed={o.mine}
              onClick={() => vote(o.index)}
            >
              <span className="ch-poll-fill" aria-hidden="true"/>
              <span className="ch-poll-mark" aria-hidden="true">
                {right ? <Icon name="check" className="xs"/>
                  : wrong ? <Icon name="close" className="xs"/>
                  : o.mine ? <Icon name="check" className="xs"/> : null}
              </span>
              <span className="ch-poll-text" dir="auto">{o.text}</span>
              {/* The split stays hidden until the viewer has answered — seeing
                  it first is what biases a poll. A closed poll shows it to
                  everyone, voted or not. */}
              {(poll.voted || poll.closed) && <span className="ch-poll-pct">{o.pct}%</span>}
            </button>
          )
        })}
      </div>

      {poll.quiz && poll.revealed && poll.explanation && (
        <p className="ch-poll-why" dir="auto">{poll.explanation}</p>
      )}

      <div className="ch-poll-foot">
        <span>{nfmt(poll.totalVoters)} {poll.totalVoters === 1 ? 'vote' : 'votes'}</span>
        {!poll.closed && poll.voted && !poll.quiz && (
          <button className="ch-poll-act" disabled={busy} onClick={retract}>Retract</button>
        )}
        {!poll.closed && canClose && (
          <button className="ch-poll-act" disabled={busy} onClick={close}>Close poll</button>
        )}
      </div>
    </div>
  )
}

/** Multi-answer toggle: add the index, or drop it if it was already picked. */
function toggleIndex(mine = [], index) {
  const set = new Set(mine)
  if (set.has(index)) set.delete(index); else set.add(index)
  // The API needs at least one index — un-picking the last one is a retract,
  // and sending an empty array would 400. Keep it selected instead.
  return set.size ? [...set] : [index]
}

/* ---------------------------------------------------------
   LOCATION — a static map is out of scope (no tile key), so the
   card is honest about being a link rather than faking a map
   image that would never load.
   --------------------------------------------------------- */
export function LocationCard({ location }) {
  if (!location) return null
  const { latitude, longitude, name, address, live } = location
  const href = `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`
  return (
    <a className={'ch-loc' + (live ? ' live' : '')} href={href} target="_blank" rel="noopener noreferrer">
      <span className="ch-loc-pin" aria-hidden="true"><Icon name="pin"/></span>
      <span className="ch-loc-body">
        <span className="ch-loc-name" dir="auto">{name || 'Shared location'}</span>
        {address && <span className="ch-loc-addr" dir="auto">{address}</span>}
        <span className="ch-loc-co">
          {Number(latitude).toFixed(4)}, {Number(longitude).toFixed(4)}
        </span>
      </span>
      {live && <span className="ch-loc-live">Live</span>}
      <Icon name="external" className="xs ch-loc-out"/>
    </a>
  )
}

/* ---------------------------------------------------------
   CONTACT — `userId` is set when the contact is someone on the
   platform, which is the only case where "View profile" leads
   anywhere, so it is the only case that offers it.
   --------------------------------------------------------- */
export function ContactCard({ contact, onOpenProfile }) {
  if (!contact) return null
  return (
    <div className="ch-contact">
      <span className="ch-contact-av" aria-hidden="true"><Icon name="user"/></span>
      <span className="ch-contact-body">
        <span className="ch-contact-name" dir="auto">{contact.fullName}</span>
        {contact.phone && <a className="ch-contact-tel" href={`tel:${contact.phone}`}>{contact.phone}</a>}
      </span>
      {contact.userId && (
        <button className="ch-contact-act" onClick={() => onOpenProfile?.(contact.userId)}>
          Profile
        </button>
      )}
    </div>
  )
}

/* ---------------------------------------------------------
   The channel-post rail: tags, signature, counters.
   --------------------------------------------------------- */
export function PostRail({ msg, onTag }) {
  /* Views deliberately do NOT live here — they sit beside the clock inside the
     bubble, where a channel reader already looks for them (MessageBubble's
     `.ch-meta`). What is left is what has no other home: the tags, the
     forward count (only once it has happened — "forwarded 0 times" is noise),
     and the posting admin's signature. */
  const hasForwards = msg.forwards != null && msg.forwards > 0
  if (!msg.tags?.length && !msg.authorSignature && !hasForwards) return null

  return (
    <div className="ch-postrail">
      {!!msg.tags?.length && (
        <div className="ch-tags">
          {msg.tags.map(t => (
            <button key={t} className="ch-tag" onClick={() => onTag?.(t)}>#{t}</button>
          ))}
        </div>
      )}

      {(hasForwards || msg.authorSignature) && (
        <div className="ch-counters">
          {hasForwards && (
            <span className="ch-counter" title={`Forwarded ${msg.forwards} times`}>
              <Icon name="forward" className="xs"/>{nfmt(msg.forwards)}
            </span>
          )}
          {msg.authorSignature && (
            <span className="ch-sig" title="Posted by">{msg.authorSignature}</span>
          )}
        </div>
      )}
    </div>
  )
}

/* =========================================================
   The comments bar — the full-width row under a channel post
   ---------------------------------------------------------
   Telegram's shape: a stack of the most recent commenters'
   faces, the count, an unread dot, and a chevron. Three things
   about it are load-bearing rather than decorative:

   · The FACES are fetched, not free. The post row carries only a
     `comments` NUMBER, so the avatars cost one request per post.
     That request is therefore made only when the bar is actually
     on screen (an IntersectionObserver, not on mount — every
     loaded message is in the DOM, so mounting would fire one
     request per post in the page), memoised per (post, count),
     and de-duplicated while in flight. A failure leaves the bar
     rendering perfectly well without faces.

   · The DOT is real. There is no per-post comment read state on
     the wire, so it is NOT "unread comments" — inventing that
     would be a lie the moment you reloaded. It means exactly
     "the count went up while you were looking at this post and
     you have not opened the thread since", which useThread can
     actually observe (`commentsUnseen`).

   · A post with NO comments still gets the bar, reading "Leave a
     comment" — that is the affordance's whole job on a broadcast
     channel, where a reader has no other way to reply.
   ========================================================= */

/* (postId → { count, faces }) for the session. Keyed with the count so a post
   that gains a comment re-fetches its faces instead of showing a stale set. */
const FACE_CACHE = new Map()
const FACE_INFLIGHT = new Map()

async function loadFaces(channelId, postId, count) {
  const hit = FACE_CACHE.get(postId)
  if (hit && hit.count === count) return hit.faces
  if (FACE_INFLIGHT.has(postId)) return FACE_INFLIGHT.get(postId)

  const p = api.channels.discussion.list(channelId, postId, { limit: 3 })
    .then(rows => {
      // Newest first off the wire. One face per PERSON — three comments from
      // the same reader is one avatar, not the same picture three times.
      const seen = new Set()
      const faces = []
      for (const m of rows) {
        const id = String(m.senderId || '')
        if (!id || seen.has(id)) continue
        seen.add(id)
        faces.push({ userId: m.senderId, sender: m.sender })
        if (faces.length === 3) break
      }
      FACE_CACHE.set(postId, { count, faces })
      return faces
    })
    .catch(() => [])
    .finally(() => FACE_INFLIGHT.delete(postId))

  FACE_INFLIGHT.set(postId, p)
  return p
}

export function CommentsBar({ msg, channelId, onOpen }) {
  const { enrichAuthor, watchUsers } = useChat()
  const [faces, setFaces] = React.useState(() => FACE_CACHE.get(msg.id)?.faces || [])
  const ref = React.useRef(null)
  const count = msg.comments ?? 0

  /* Fetch the faces only once the bar is genuinely visible. `rootMargin` gives
     it a screen of warning so the avatars are there before the row is read,
     rather than popping in under the eye. */
  React.useEffect(() => {
    const el = ref.current
    if (!el || !channelId || count === 0) return undefined
    const cached = FACE_CACHE.get(msg.id)
    if (cached?.count === count) { setFaces(cached.faces); return undefined }

    let alive = true
    const io = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) return
      io.disconnect()
      loadFaces(channelId, msg.id, count).then(f => {
        if (!alive) return
        setFaces(f)
        const ids = f.map(x => x.userId).filter(Boolean)
        if (ids.length) watchUsers(ids)
      })
    }, { rootMargin: '400px 0px' })
    io.observe(el)
    return () => { alive = false; io.disconnect() }
  }, [msg.id, channelId, count, watchUsers])

  const label = count === 0
    ? 'Leave a comment'
    : `${nfmt(count)} ${count === 1 ? 'comment' : 'comments'}`

  return (
    <button
      ref={ref}
      type="button"
      className={'ch-cbar' + (count === 0 ? ' empty' : '')}
      onClick={() => onOpen?.(msg)}
      aria-label={count === 0 ? 'Leave a comment on this post' : `Open ${count} comments`}
    >
      {!!faces.length && (
        <span className="ch-cbar-faces" aria-hidden="true">
          {faces.map((f, i) => {
            const who = enrichAuthor(f.sender, f.userId)
            return (
              <span className="ch-cbar-face" key={f.userId || i} style={{ zIndex: faces.length - i }}>
                <Avatar size={28} src={who?.profileImage} initials={who?.initials || '·'} color={who?.avc}/>
              </span>
            )
          })}
        </span>
      )}
      {!faces.length && <Icon name="comment" className="sm ch-cbar-ico"/>}

      <span className="ch-cbar-label">{label}</span>
      {/* Not "unread comments" — see the header. This dot means the count moved
          under your eyes and you have not opened the thread since. */}
      {msg.commentsUnseen && <span className="ch-cbar-dot" aria-label="New since you looked"/>}

      <Icon name="chevright" className="sm ch-cbar-go"/>
    </button>
  )
}

/* ---------------------------------------------------------
   VIDEO_NOTE — a circular video. Same media row as everything
   else on the wire (`kind: "VIDEO_NOTE"`); the difference is
   entirely presentational, so it gets its own small player
   rather than a flag threaded through the album grid.
   --------------------------------------------------------- */
export function VideoNote({ media }) {
  const ref = React.useRef(null)
  const [playing, setPlaying] = React.useState(false)

  const toggle = () => {
    const el = ref.current
    if (!el) return
    if (el.paused) { el.play().catch(() => {}); setPlaying(true) }
    else { el.pause(); setPlaying(false) }
  }

  return (
    <button type="button" className={'ch-vnote' + (playing ? ' playing' : '')} onClick={toggle}
      aria-label={playing ? 'Pause the video note' : 'Play the video note'}>
      <video ref={ref} src={media.url} poster={media.thumbnailUrl || undefined}
        playsInline preload="metadata" onEnded={() => setPlaying(false)}/>
      {!playing && <span className="ch-vnote-play" aria-hidden="true"><Icon name="play"/></span>}
    </button>
  )
}
