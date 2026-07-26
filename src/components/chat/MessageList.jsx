/* =========================================================
   MessageList — the scrolling thread.
   ---------------------------------------------------------
   Owns four bits of choreography that a plain list can't do:

   1. STICK TO BOTTOM. New messages scroll into view only when
      the reader is already at the bottom (or sent it themselves).
      Otherwise they stack silently and the jump pill counts them,
      so reading history is never yanked away mid-sentence.
   2. ANCHOR ON PREPEND. Loading older messages inserts content
      ABOVE the viewport, which would shove everything down. We
      capture scrollHeight before the paint and restore the delta
      in useLayoutEffect — the view stays visually frozen.
   3. RUN GROUPING. Consecutive messages from one sender within
      5 minutes render as a run: one avatar, one name, and the
      tail only on the last bubble.
   4. DAY + UNREAD RULES. Date separators are derived from the
      message stream; the unread rule is pinned to the marker the
      thread had when it was OPENED (a live-moving rule would
      jump around as receipts land).
   ========================================================= */
import React from 'react'
import { Icon, Avatar } from '../ui.jsx'
import { Loader } from '../states.jsx'
import { MessageBubble } from './MessageBubble.jsx'
import { usePostViews } from './usePostViews.js'
import { typingSentence, dominantActivity, activityIcon } from './activity.js'
import { describeCall } from './callLog.js'
import { gtId } from '../../api/ids.js'

/** Messages this far apart start a new visual run even from one sender. */
const RUN_GAP_MS = 5 * 60 * 1000
/** How close to the bottom still counts as "reading the newest". */
const BOTTOM_SLACK = 90

/** ISO → "Today" / "Yesterday" / "12 March 2026". */
function dayLabel(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const today = new Date()
  const isSame = (a, b) => a.toDateString() === b.toDateString()
  if (isSame(d, today)) return 'Today'
  const y = new Date(today)
  y.setDate(y.getDate() - 1)
  if (isSame(d, y)) return 'Yesterday'
  const sameYear = d.getFullYear() === today.getFullYear()
  return d.toLocaleDateString(undefined, {
    day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }),
  })
}

const dayKey = (iso) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toDateString()
}

/* ---------------------------------------------------------
   Call card — an ended call, in the timeline, at the minute it
   happened.
   ---------------------------------------------------------
   The server writes no message for a call, so without this the
   most significant thing two people did all day leaves no trace
   in the conversation. The record is local (see callLog.js), so
   the card is deliberately quieter than a message: it is chrome
   that describes the thread, not something anyone said in it.
   Clicking it calls back, which is the only action a call record
   has ever needed.
   --------------------------------------------------------- */
function CallCard({ entry, onCallBack }) {
  const d = describeCall(entry)
  const at = new Date(entry.endedAt)
  const time = Number.isNaN(at.getTime())
    ? ''
    : at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return (
    <div className={'ch-callcard tone-' + d.tone}>
      <button
        type="button"
        className="ch-callcard-btn"
        onClick={() => onCallBack?.(entry.video)}
        title={entry.video ? 'Start a video call' : 'Start a voice call'}
      >
        <span className="ch-callcard-ico"><Icon name={d.icon}/></span>
        <span className="ch-callcard-body">
          <span className="ch-callcard-t">{d.title}</span>
          <span className="ch-callcard-sub">
            {time}
            {d.detail && <><span className="ch-callcard-dot">·</span>{d.detail}</>}
          </span>
        </span>
        <span className="ch-callcard-again">
          <Icon name={entry.video ? 'video' : 'phone'} className="sm"/>
          <span className="sr-only">Call back</span>
        </span>
      </button>
    </div>
  )
}

export function MessageList({
  conversationId,
  messages,
  loading,
  loadingOlder,
  hasMore,
  error,
  onLoadOlder,
  myId,
  isGroup,
  isChannel,           // channel posts carry view/forward/comment counters
  canModerate,
  canPin,
  pinnedIds,
  peerDelivered,
  peerRead,
  receiptsOff,         // read receipts are off on one side — the ladder can't advance
  unreadFrom,          // first unread message id when the thread was opened
  typers,              // [{ userId, activity, name, avatar, initials, avc }]
  callEvents,          // local call log for this conversation, OLDEST first
  onCallBack,          // (video:boolean) => start a call — the card's only action
  flashId,
  onReply,
  onEdit,
  onDelete,
  onForward,
  onPin,
  onUnpin,
  onReact,
  onStar,
  onSeenBy,
  onHydrateReactions,
  onRetry,
  onJumpTo,
  onOpenMedia,
  onOpenProfile,
  onReachedBottom,
  onPoll,
  onTag,
  onComments,
  reactionsOff,
  allowedReactions,
  protectedContent,
}) {
  const scrollRef = React.useRef(null)
  /* Channel posts count unique viewers. The observer lives here because this
     is the component that owns the scroll viewport — see usePostViews.js for
     why re-reporting is free and every failure is swallowed. */
  const observeView = usePostViews(conversationId, !!isChannel)
  const topRef = React.useRef(null)
  const bottomRef = React.useRef(null)

  const atBottomRef = React.useRef(true)
  const prevHeightRef = React.useRef(0)
  const prevCountRef = React.useRef(0)
  const prevLastIdRef = React.useRef(null)
  const prependingRef = React.useRef(false)
  const flashedRef = React.useRef(null)      // which flashId has already been scrolled to

  const [showJump, setShowJump] = React.useState(false)
  const [newCount, setNewCount] = React.useState(0)
  // Suppresses the per-bubble rise animation while a whole page lands at once
  // (initial paint, or a "load earlier" prepend) — 50 bubbles cascading in is
  // the exact jank the animation exists to avoid.
  const [bulk, setBulk] = React.useState(true)
  const bulkTimerRef = React.useRef(null)
  const quietBulk = React.useCallback(() => {
    setBulk(true)
    clearTimeout(bulkTimerRef.current)
    bulkTimerRef.current = setTimeout(() => setBulk(false), 260)
  }, [])
  React.useEffect(() => () => clearTimeout(bulkTimerRef.current), [])

  /* The jump pill is per-conversation state. Nothing else clears it on a
     switch, so a "New 3" pill from the previous chat could persist over a
     short new thread that has no scrollback at all. */
  React.useEffect(() => {
    setShowJump(false)
    setNewCount(0)
    atBottomRef.current = true
    flashedRef.current = null
  }, [conversationId])

  const scrollToBottom = React.useCallback((smooth) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    atBottomRef.current = true
    setShowJump(false)
    setNewCount(0)
  }, [])

  /* ----- track how far from the bottom we are ----- */
  const onScroll = React.useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const wasBottom = atBottomRef.current
    atBottomRef.current = distance <= BOTTOM_SLACK
    if (atBottomRef.current) {
      setShowJump(false)
      setNewCount(0)
      if (!wasBottom) onReachedBottom?.()
    } else if (distance > BOTTOM_SLACK * 3) {
      setShowJump(true)
    }
  }, [onReachedBottom])

  /* ----- prepend anchoring: freeze the view while older pages land ----- */
  React.useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const count = messages.length
    const lastId = count ? messages[count - 1].id : null
    const grewAtTop = prependingRef.current

    if (grewAtTop) {
      // restore the exact visual position (content was inserted above)
      el.scrollTop += el.scrollHeight - prevHeightRef.current
      prependingRef.current = false
    } else if (lastId !== prevLastIdRef.current && count > prevCountRef.current) {
      const added = messages[count - 1]
      const mine = String(added?.senderId) === String(myId)
      if (atBottomRef.current || mine) {
        el.scrollTo({ top: el.scrollHeight, behavior: prevCountRef.current ? 'smooth' : 'auto' })
        atBottomRef.current = true
      } else {
        setNewCount(n => n + (count - prevCountRef.current))
        setShowJump(true)
      }
    }

    prevHeightRef.current = el.scrollHeight
    prevCountRef.current = count
    prevLastIdRef.current = lastId
  }, [messages, myId])

  /* ----- first paint of a conversation lands at the bottom ----- */
  React.useEffect(() => {
    if (loading) return
    const el = scrollRef.current
    if (!el) return
    // rAF so images/media that just mounted have laid out
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
      prevHeightRef.current = el.scrollHeight
      atBottomRef.current = true
      quietBulk()                       // first page lands silently, then live bubbles animate
    })
    return () => cancelAnimationFrame(id)
  }, [loading, quietBulk])

  /* ----- report which posts were actually seen (channels only) -----
     Deliberately a post-render sweep over `[data-mid]` rather than a ref on
     each row: the bubbles already carry that attribute (the jump-to-message
     lookup uses it), so nothing about the DOM or the CSS has to change to
     support counting. Runs after every render because prepending history and
     arriving messages both add rows; `observeView` ignores anything it has
     already counted, so the repeat is free. */
  React.useEffect(() => {
    if (!isChannel) return
    const root = scrollRef.current
    if (!root) return
    for (const el of root.querySelectorAll('[data-mid]')) {
      observeView(el, el.getAttribute('data-mid'))
    }
  })

  /* ----- infinite scroll upward ----- */
  React.useEffect(() => {
    const sentinel = topRef.current
    const root = scrollRef.current
    if (!sentinel || !root || !hasMore) return undefined
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !loadingOlder) {
        const el = scrollRef.current
        if (el) prevHeightRef.current = el.scrollHeight
        prependingRef.current = true
        quietBulk()
        onLoadOlder?.()
      }
    }, { root, rootMargin: '160px 0px 0px 0px', threshold: 0 })
    io.observe(sentinel)
    return () => io.disconnect()
  }, [hasMore, loadingOlder, onLoadOlder, quietBulk])

  /* ----- scroll a flashed (jumped-to) message into view -----
     Keyed on the flash id ALONE, not on `messages`. Depending on the message
     array re-ran this on every arriving message and yanked the viewport back
     to the flashed bubble — a scroll hijack that made the thread unusable
     while someone was typing to you. The ref makes each id scroll exactly
     once; `attempts` covers the case where the row hasn't rendered yet
     because jumpTo is still paging history in. */
  React.useEffect(() => {
    // Clearing the marker when the id goes null is what lets the SAME message
    // be jumped to twice (ChatPage sets pendingJump null, then back to the id).
    // Without it the second jump short-circuits here and never scrolls.
    if (!flashId) { flashedRef.current = null; return undefined }
    if (flashedRef.current === flashId) return undefined
    let attempts = 0
    let raf = 0
    const tryScroll = () => {
      const el = scrollRef.current?.querySelector(`[data-mid="${flashId}"]`)
      if (el) {
        flashedRef.current = flashId
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        return
      }
      if (++attempts < 40) raf = requestAnimationFrame(tryScroll)   // ~⅔s of retries
    }
    raf = requestAnimationFrame(tryScroll)
    return () => cancelAnimationFrame(raf)
  }, [flashId])

  /* ----- the typing indicator mounts BELOW the last message -----
     If the reader is at the bottom, grow the scroll with it; otherwise it
     would sit half-clipped under the fold and the "…is typing" moment — the
     most alive thing in the thread — would be invisible. Keyed on a VALUE
     signature: the parent rebuilds the `typers` array every render, and a
     reference dep would re-fire this on unrelated renders. */
  const typersKey = (typers || []).map(t => `${t.userId}:${t.activity}`).join(',')
  React.useEffect(() => {
    if (!typersKey) return
    const el = scrollRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [typersKey])

  /* ----- build the render plan (separators + run flags) in one pass -----
     Call cards are interleaved by TIME, not by id: they have no message id to
     sort against (they never touched the server's timeline). A card lands
     immediately before the first message that is newer than it, and anything
     still pending at the end is appended — which is the common case, since
     the call you just finished is newer than every message loaded.

     Calls older than the oldest LOADED message are dropped while `hasMore` is
     true: they belong above the window, and pinning them to the top of a
     partial page would put yesterday's call above this morning's messages. */
  const rows = React.useMemo(() => {
    const out = []
    let lastDay = null
    let unreadPlaced = false

    const calls = (callEvents || []).slice()
    const firstMsgAt = messages.length ? Date.parse(messages[0].createdAt || 0) || 0 : 0
    let callAt = 0
    while (hasMore && callAt < calls.length && firstMsgAt && calls[callAt].endedAt < firstMsgAt) callAt++

    const emitDay = (ms) => {
      const dk = dayKey(new Date(ms).toISOString())
      if (dk && dk !== lastDay) {
        out.push({ kind: 'day', key: `d-${dk}`, label: dayLabel(new Date(ms).toISOString()) })
        lastDay = dk
      }
    }

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      const prev = messages[i - 1]
      const next = messages[i + 1]

      // Any call that finished before this message belongs above it.
      const mAt = Date.parse(m.createdAt || 0) || 0
      while (callAt < calls.length && mAt && calls[callAt].endedAt <= mAt) {
        const c = calls[callAt++]
        emitDay(c.endedAt)
        out.push({ kind: 'call', key: `c-${c.id}`, entry: c })
      }

      const dk = dayKey(m.createdAt)
      if (dk && dk !== lastDay) {
        out.push({ kind: 'day', key: `d-${dk}`, label: dayLabel(m.createdAt) })
        lastDay = dk
      }

      /* `unreadFrom` is the LAST READ id, so the rule belongs above the first
         message STRICTLY after it — `>=` put it above a message you had
         already read. Ids are Snowflake strings; compare with cmpId, never
         `>=` (which is lexicographic and only accidentally right). */
      if (!unreadPlaced && unreadFrom && gtId(m.id, unreadFrom) && String(m.senderId) !== String(myId)) {
        out.push({ kind: 'unread', key: `u-${m.id}` })
        unreadPlaced = true
      }

      const t = m.createdAt ? Date.parse(m.createdAt) : 0
      const tPrev = prev?.createdAt ? Date.parse(prev.createdAt) : 0
      const tNext = next?.createdAt ? Date.parse(next.createdAt) : 0

      const sameAsPrev = !!prev && !prev.isSystem && !m.isSystem &&
        String(prev.senderId) === String(m.senderId) && Math.abs(t - tPrev) < RUN_GAP_MS
      const sameAsNext = !!next && !next.isSystem && !m.isSystem &&
        String(next.senderId) === String(m.senderId) && Math.abs(tNext - t) < RUN_GAP_MS

      out.push({
        kind: 'msg',
        key: `m-${m.id}`,
        msg: m,
        runStart: !sameAsPrev,
        runEnd: !sameAsNext,
        showAvatar: !sameAsNext,     // avatar sits with the LAST bubble of a run
        showSender: !sameAsPrev,
      })
    }

    // Calls newer than every loaded message — including the one that just ended.
    while (callAt < calls.length) {
      const c = calls[callAt++]
      emitDay(c.endedAt)
      out.push({ kind: 'call', key: `c-${c.id}`, entry: c })
    }
    return out
  }, [messages, unreadFrom, myId, callEvents, hasMore])

  const pinnedSet = React.useMemo(() => new Set(pinnedIds || []), [pinnedIds])

  /* What the live region announces: only the newest message from someone
     ELSE, and only once it is real (a pending optimistic bubble is my own). */
  const liveSay = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.isSystem || m.deleted) continue
      if (String(m.senderId) === String(myId)) return ''
      const who = m.sender?.full || m.sender?.handle || 'Someone'
      const what = m.body
        || { IMAGE: 'a photo', VIDEO: 'a video', VOICE: 'a voice message', FILE: 'a file' }[m.media?.[0]?.kind]
        || 'a message'
      return `${who}: ${what}`
    }
    return ''
  }, [messages, myId])

  if (loading) {
    return (
      <div className="ch-scrollwrap">
        <div className="ch-scroll"><Loader label="Loading messages…"/></div>
      </div>
    )
  }

  return (
    <div className="ch-scrollwrap">
    <div className={'ch-scroll' + (bulk ? ' no-anim' : '')} ref={scrollRef} onScroll={onScroll}>
      {error && (
        <div className="ch-start" style={{ color: 'var(--danger)' }}>{error}</div>
      )}

      <div ref={topRef}/>

      {hasMore && (
        <div className="ch-older">
          {loadingOlder
            ? <span className="ch-start">Loading earlier messages…</span>
            : (
              <button type="button" className="ch-older-btn" onClick={() => {
                const el = scrollRef.current
                if (el) prevHeightRef.current = el.scrollHeight
                prependingRef.current = true
                quietBulk()
                onLoadOlder?.()
              }}>
                Load earlier messages
              </button>
            )}
        </div>
      )}

      {!hasMore && !!messages.length && (
        <div className="ch-start">This is the beginning of the conversation.</div>
      )}

      <div className="ch-msgs">
        {rows.map(row => {
          if (row.kind === 'day') {
            return <div className="ch-day" key={row.key}><span>{row.label}</span></div>
          }
          if (row.kind === 'unread') {
            return <div className="ch-day ch-unread-rule" key={row.key}><span>Unread messages</span></div>
          }
          if (row.kind === 'call') {
            return <CallCard key={row.key} entry={row.entry} onCallBack={onCallBack}/>
          }
          const m = row.msg
          return (
            <MessageBubble
              key={row.key}
              msg={m}
              mine={String(m.senderId) === String(myId)}
              isGroup={isGroup}
              showAvatar={row.showAvatar}
              showSender={row.showSender}
              runStart={row.runStart}
              runEnd={row.runEnd}
              canModerate={canModerate}
              canPin={canPin}
              isPinned={pinnedSet.has(m.id)}
              peerDelivered={peerDelivered}
              peerRead={peerRead}
              receiptsOff={receiptsOff}
              flash={flashId === m.id}
              onReply={onReply}
              onEdit={onEdit}
              onDelete={onDelete}
              onForward={onForward}
              onPin={onPin}
              onUnpin={onUnpin}
              onReact={onReact}
              onStar={onStar}
              onSeenBy={onSeenBy}
              onHydrateReactions={onHydrateReactions}
              onRetry={onRetry}
              onJumpTo={onJumpTo}
              onOpenMedia={onOpenMedia}
              onOpenProfile={onOpenProfile}
              onPoll={onPoll}
              onTag={onTag}
              onComments={onComments}
              reactionsOff={reactionsOff}
              allowedReactions={allowedReactions}
              protectedContent={protectedContent}
            />
          )
        })}

        {!!(typers || []).length && (() => {
          const act = dominantActivity(typers)
          const icon = activityIcon(act)                       // null → classic dots
          const first = typers[0]
          const say = typingSentence(typers, { isGroup, names: typers.map(t => t.name) })
          return (
            <div className={'ch-typing' + (icon ? ' act-' + act.toLowerCase() : '')}>
              {/* groups show WHO is live; DMs keep the spacer (identity is obvious) */}
              <div className="ch-row-av">
                {isGroup && (
                  <Avatar
                    size={26}
                    src={first?.avatar || null}
                    initials={first?.initials || '·'}
                    color={first?.avc}
                  />
                )}
              </div>
              <div className={'ch-typing-bubble' + (icon ? ' with-ico' : '')} aria-hidden="true">
                {icon && <Icon name={icon} className="ch-typing-ico"/>}
                {icon === 'mic'
                  ? (
                    <span className="ch-typing-eq">
                      <i/><i/><i/><i/><i/>
                    </span>
                  )
                  : (
                    <>
                      <span className="ch-typing-dot"/>
                      <span className="ch-typing-dot"/>
                      <span className="ch-typing-dot"/>
                    </>
                  )}
              </div>
              <span className="ch-typing-label" dir="auto">{say}<span className="ch-ell" aria-hidden="true"/></span>
            </div>
          )
        })()}
      </div>

      <div ref={bottomRef}/>
    </div>

    {/* Screen readers get the newest incoming message announced. Kept OUT of
        the scroller and limited to the latest foreign message, because a live
        region over the whole list would re-announce history on every paint. */}
    <div className="sr-only" aria-live="polite" aria-atomic="true">{liveSay}</div>

    {/* Sibling of the scroller, not a child: an absolutely-positioned child of
        a scroll container is laid out against its CONTENT box, so the pill
        scrolled away with the messages instead of floating over them. */}
    {showJump && (
      <button type="button" className="ch-jump" onClick={() => scrollToBottom(true)}>
        <Icon name="chevdown"/>
        {newCount > 0
          ? <>New <span className="ch-jump-n">{newCount}</span></>
          : 'Latest'}
      </button>
    )}
    </div>
  )
}

export default MessageList
