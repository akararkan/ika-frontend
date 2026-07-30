/* =========================================================
   ConversationList — the inbox rail.
   ---------------------------------------------------------
   One row per conversation: identity, the live preview line,
   the relative time, the unread badge and a hover menu of the
   per-conversation toggles (pin · mute · archive · delete).

   Details that matter:
   - The preview line is a THREE-way priority: someone typing >
     the last message > "No messages yet". Typing wins because it
     is the only one that is happening right now.
   - Pinned conversations are hoisted into their own labelled
     group. The backend already sorts pinned-first, but the rail
     re-groups so the boundary is visible rather than implied.
   - Presence is requested in one batch for every DM peer on
     screen (ChatContext coalesces the ids into a single GET).
   - Rows are <div role="button"> rather than <button> because a
     button cannot legally contain the row's own menu button.
   ========================================================= */
import React from 'react'
import { Icon, Avatar, Verify } from '../ui.jsx'
import { EmptyState } from '../states.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { useChat } from '../../context/ChatContext.jsx'
import { Popover } from './Popover.jsx'
import { deleteIntentOf } from './conversationActions.js'
import { typingSentence, dominantActivity, activityIcon } from './activity.js'

/** ISO → "14:07" today, "Yesterday", "Mon", or "12 Mar". */
function stampOf(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  if (now - d < 7 * 86400000) return d.toLocaleDateString(undefined, { weekday: 'short' })
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: '2-digit' }) })
}

function SkeletonRows() {
  return (
    <>
      {[0, 1, 2, 3, 4, 5].map(i => (
        <div className="cv-skel" key={i}>
          <div className="cv-skel-av"/>
          <div className="cv-skel-l">
            <div className="cv-skel-b w1"/>
            <div className="cv-skel-b w2"/>
          </div>
        </div>
      ))}
    </>
  )
}

function ConversationRow({ convo, active, typers, onOpen }) {
  const {
    presenceOf, setPinned, setMuted, setArchived, deleteConvo, markUnread,
    enrichAuthor, userOf, watchUsers,
  } = useChat()
  const [menuOpen, setMenuOpen] = React.useState(false)
  const wrapRef = React.useRef(null)
  const menuBtnRef = React.useRef(null)
  // Dismissal lives in <Popover>: the menu is portalled out of `.chat-list`
  // (overflow-y:auto), so a contains() test against this row would misread
  // every in-menu click as an outside click.

  // `peer` from the wire has no avatar — merge the directory card over it.
  const peer = convo.isGroup ? null : enrichAuthor(convo.peer, convo.peer?.id)
  const online = !convo.isGroup && peer?.id && presenceOf(peer.id)?.status === 'online'
  const unread = convo.unreadCount || 0
  const showBadge = unread > 0
  const showDot = !showBadge && convo.hasUnread

  /* Live preview: someone typing/recording/sending beats the last message —
     it is the only thing happening right now. Group typers are named through
     the user directory (resolves a beat later; 'Someone' until then). */
  const isTyping = !!(typers || []).length
  React.useEffect(() => {
    if (convo.isGroup && typers?.length) watchUsers(typers.map(t => t.userId))
  }, [convo.isGroup, typers, watchUsers])
  const typingLabel = isTyping
    ? typingSentence(typers, {
        isGroup: convo.isGroup,
        names: convo.isGroup ? typers.map(t => userOf(t.userId)?.full?.split(' ')[0] || null) : [],
      })
    : null
  const typingIcon = isTyping ? activityIcon(dominantActivity(typers)) : null

  const preview = typingLabel
    || convo.lastMessagePreview
    || (convo.lastMessageId ? 'Message' : 'No messages yet')

  const deleteIntent = deleteIntentOf(convo)
  const items = [
    /* "Mark as unread" is deliberately hidden while there ARE unread messages:
       the flag only exists to raise a dot on a thread you have already read,
       and the server clears it on your next read anyway. Offering it on an
       already-unread row would look like a no-op. */
    ...(unread === 0 && !convo.markedUnread && convo.lastMessageId
      ? [{ key: 'unread', label: 'Mark as unread', icon: 'dot', run: () => markUnread(convo.id) }]
      : []),
    convo.pinned
      ? { key: 'unpin', label: 'Unpin', icon: 'pinoff', run: () => setPinned(convo.id, false) }
      : { key: 'pin', label: 'Pin', icon: 'pin', run: () => setPinned(convo.id, true) },
    convo.muted
      ? { key: 'unmute', label: 'Unmute', icon: 'bell', run: () => setMuted(convo.id, null) }
      : {
          key: 'mute',
          label: 'Mute',
          icon: 'bell_off',
          run: () => setMuted(convo.id, new Date(Date.now() + 365 * 86400000).toISOString()),
        },
    convo.archived
      ? { key: 'unarchive', label: 'Unarchive', icon: 'unarchive', run: () => setArchived(convo.id, false) }
      : { key: 'archive', label: 'Archive', icon: 'archive', run: () => setArchived(convo.id, true) },
    /* NOT "Hide group": for a group OWNER this endpoint deletes the group for
       every member. The label and the confirmation both come from the shared
       intent so no surface can quietly under-sell it. */
    {
      key: 'delete',
      label: deleteIntent.label,
      icon: 'trash',
      danger: true,
      run: async () => {
        const ok = await uiConfirm({
          title: deleteIntent.title,
          message: deleteIntent.message,
          danger: true,
          confirmLabel: deleteIntent.confirmLabel,
        })
        if (ok) deleteConvo(convo.id)
      },
    },
  ]

  return (
    <div className="cv-menu-host" ref={wrapRef}>
      <div
        role="button"
        tabIndex={0}
        className={
          'cv-row' +
          (active ? ' active' : '') +
          (showBadge || showDot ? ' unread' : '') +
          (convo.muted ? ' muted-row' : '')
        }
        onClick={() => onOpen(convo.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(convo.id) }
        }}
        aria-current={active ? 'true' : undefined}
      >
        <div className="cv-av">
          {convo.isGroup ? (
            <span className="cv-medallion" aria-hidden="true">
              {convo.avatarUrl
                ? <img className="cv-medallion-img" src={convo.avatarUrl} alt=""/>
                : <Icon name={convo.isChannel ? 'broadcast' : 'users'}/>}
            </span>
          ) : (
            <Avatar
              size={44}
              src={peer?.profileImage || null}
              initials={peer?.initials || '·'}
              color={peer?.avc}
            />
          )}
          {!convo.isGroup && <span className={'cv-dot' + (online ? ' on' : '')} aria-hidden="true"/>}
          {/* Type seal: a channel and a group are different rooms with
              different rules, and the rail should say so at a glance. It
              rides the corner the presence dot uses on a DM row — a slot
              that is always free here, since groups have no presence. */}
          {convo.isGroup && (
            <span
              className={'cv-kind' + (convo.isChannel ? ' channel' : '')}
              title={convo.isChannel ? 'Channel' : 'Group'}
              aria-hidden="true"
            >
              <Icon name={convo.isChannel ? 'broadcast' : 'users'}/>
            </span>
          )}
        </div>

        <div className="cv-body">
          <div className="cv-line1">
            <span className="cv-name" dir="auto">{convo.displayTitle}</span>
            {/* The seal is decorative; this is where assistive tech learns
                what kind of room the row opens. */}
            {convo.isGroup && (
              <span className="sr-only">{convo.isChannel ? '(channel)' : '(group)'}</span>
            )}
            {!convo.isGroup && peer?.verified && <Verify scholar={peer.role === 'SCHOLAR'}/>}
            <span className="cv-time">{stampOf(convo.lastMessageAt)}</span>
          </div>
          <div className="cv-line2">
            <span className={'cv-preview' + (isTyping ? ' typing' : '')} dir="auto">
              {typingIcon && <Icon name={typingIcon} className="cv-typing-ico" aria-hidden="true"/>}
              {preview}
              {isTyping && <span className="ch-ell" aria-hidden="true"/>}
            </span>
            {/* <Icon> takes only {name,className,style} — a `title` prop was
                silently dropped, so these state flags had no accessible name. */}
            <span className="cv-flags">
              {convo.pinned && <><Icon name="pin" aria-hidden="true"/><span className="sr-only">Pinned</span></>}
              {convo.muted && <><Icon name="bell_off" aria-hidden="true"/><span className="sr-only">Muted</span></>}
            </span>
            {showBadge && (
              /* keyed on the count: a changed number REMOUNTS the pill, which
                 restarts the pop animation — the badge visibly "beats" as new
                 messages land, with no JS animation code at all */
              <span className="cv-badge" key={unread}>
                <span aria-hidden="true">{unread > 99 ? '99+' : unread}</span>
                <span className="sr-only">{unread} unread message{unread === 1 ? '' : 's'}</span>
              </span>
            )}
            {/* Large groups skip the exact counter server-side and send only
                `hasUnread`, so this case gets a plain dot — not a middot glyph
                stuffed into a count pill. */}
            {showDot && <span className="cv-unread-dot" aria-hidden="true"/>}
            {showDot && <span className="sr-only">Unread messages</span>}
          </div>
        </div>
      </div>

      <button
        type="button"
        className="cv-menu-btn"
        ref={menuBtnRef}
        onClick={(e) => { e.stopPropagation(); setMenuOpen(v => !v) }}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`Actions for ${convo.displayTitle}`}
      >
        <Icon name="more"/>
      </button>

      <Popover
        anchorRef={menuBtnRef}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        className="ch-hd-menu cv-menu"
        ariaLabel="Conversation actions"
        align="end"
      >
        {items.map(it => (
          <button
            key={it.key}
            type="button"
            role="menuitem"
            className={'ch-menu-item' + (it.danger ? ' danger' : '')}
            onClick={(e) => { e.stopPropagation(); setMenuOpen(false); it.run() }}
          >
            <Icon name={it.icon} className="sm"/>
            <span>{it.label}</span>
          </button>
        ))}
      </Popover>
    </div>
  )
}

export function ConversationList({
  conversations, loading, activeId, query, onOpen, emptyHint,
  hasMore, loadingMore, onLoadMore,
}) {
  const { typingIn, watchPresence, watchUsers } = useChat()
  const sentinelRef = React.useRef(null)
  const scrollRef = React.useRef(null)

  /* Page the rail as it scrolls. Without this the inbox was permanently
     capped at the first page and older conversations were unreachable.
     Suspended while a filter is active — filtering is client-side over what
     is already loaded, so paging under it would fight the user's query. */
  React.useEffect(() => {
    const el = sentinelRef.current
    const root = scrollRef.current
    if (!el || !root || !hasMore || query) return undefined
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !loadingMore) onLoadMore?.()
    }, { root, rootMargin: '260px' })
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, loadingMore, onLoadMore, query, conversations.length])

  // One batched presence request AND one batched avatar resolve for every DM
  // peer currently listed — both coalesce inside the context.
  const peerIds = React.useMemo(
    () => conversations.filter(c => !c.isGroup && c.peer?.id).map(c => c.peer.id),
    [conversations],
  )
  React.useEffect(() => { if (peerIds.length) watchPresence(peerIds) }, [peerIds, watchPresence])
  React.useEffect(() => { if (peerIds.length) watchUsers(peerIds) }, [peerIds, watchUsers])

  const filtered = React.useMemo(() => {
    const q = (query || '').trim().toLowerCase()
    if (!q) return conversations
    return conversations.filter(c =>
      (c.displayTitle || '').toLowerCase().includes(q)
      || (c.peer?.handle || '').toLowerCase().includes(q)
      || (c.lastMessagePreview || '').toLowerCase().includes(q))
  }, [conversations, query])

  const pinned = filtered.filter(c => c.pinned)
  const rest = filtered.filter(c => !c.pinned)

  if (loading && !conversations.length) return <div className="chat-list"><SkeletonRows/></div>

  if (!filtered.length) {
    return (
      <div className="chat-list">
        <EmptyState
          icon="chat"
          title={query ? 'No matches' : 'No conversations yet'}
          sub={query ? 'Try a different name or word.' : (emptyHint || 'Start a chat to see it here.')}
        />
      </div>
    )
  }

  const renderRow = (c) => (
    <ConversationRow
      key={c.id}
      convo={c}
      active={c.id === activeId}
      typers={typingIn(c.id)}
      onOpen={onOpen}
    />
  )

  return (
    <div className="chat-list" ref={scrollRef}>
      {!!pinned.length && (
        <>
          <div className="chat-group-label">Pinned</div>
          {pinned.map(renderRow)}
          {!!rest.length && <div className="chat-group-label">All conversations</div>}
        </>
      )}
      {rest.map(renderRow)}

      {hasMore && !query && (
        <div ref={sentinelRef} className="cv-more">
          {loadingMore
            ? <span className="cv-more-txt">Loading more…</span>
            : (
              <button type="button" className="ch-older-btn" onClick={() => onLoadMore?.()}>
                Load more conversations
              </button>
            )}
        </div>
      )}
    </div>
  )
}

export default ConversationList
