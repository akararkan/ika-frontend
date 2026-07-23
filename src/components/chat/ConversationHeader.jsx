/* =========================================================
   ConversationHeader — the bar above the message thread.
   ---------------------------------------------------------
   Its job: identify who/what you are talking to, surface the
   live status line (typing > presence > member count), and
   expose the per-conversation actions (search, info, mute,
   pin, archive, leave/delete).

   Notes on the non-obvious bits:
   - The back chevron is ALWAYS rendered; CSS hides it on the
     two-pane desktop layout, so the markup stays identical
     between breakpoints and nothing remounts on resize.
   - Presence is pulled through useChat().presenceOf(), which is
     fed by the ONE app socket. We call watchPresence() for the
     DM peer so the first paint has a value even before any
     `presence` frame arrives; a slow 60s tick only re-renders
     the "last seen 3h ago" label as it ages.
   - Mute has no "until" picker here — the API takes an instant,
     so plain "Mute" means "a year from now" and Unmute is null.
   - Leave/Delete are destructive and irreversible for the local
     copy, hence uiConfirm + navigate('/chat') afterwards.
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../api/index.js'
import { Icon, Avatar, Verify, showToast } from '../ui.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { useChat } from '../../context/ChatContext.jsx'
import { useCall } from '../../context/CallContext.jsx'
import { Popover } from './Popover.jsx'
import { activityIcon } from './activity.js'
import { deleteIntentOf } from './conversationActions.js'
import { chatError } from './chatErrors.js'

/** epoch ms → "last seen 3h ago". Null/0 → a plain "offline". */
function lastSeenLabel(epochMs) {
  if (!epochMs) return 'offline'
  const diff = Date.now() - Number(epochMs)
  if (!Number.isFinite(diff) || diff < 0) return 'online'
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'last seen just now'
  if (min < 60) return `last seen ${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `last seen ${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `last seen ${day}d ago`
  const d = new Date(Number(epochMs))
  return `last seen ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

/** One year out — the API wants an instant, the UI wants a boolean. */
const muteUntilIso = () => new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString()

/** seconds → "24h" / "7d" — the disappearing-timer chip. */
function ttlLabel(secs) {
  const n = Number(secs) || 0
  if (n <= 0) return ''
  if (n % 86400 === 0) return `${n / 86400}d`
  if (n % 3600 === 0) return `${n / 3600}h`
  return `${Math.round(n / 60)}m`
}

export function ConversationHeader({
  convo,
  onBack,
  onToggleInfo,
  onToggleSearch,
  onToggleStarred,
  onToggleScheduled,
  onTogglePrefs,
  typingLabel,
  typingActivity,
  presenceLabel,
  infoOpen,
}) {
  const navigate = useNavigate()
  const {
    presenceOf, watchPresence, setPinned, setMuted, setArchived, setDisappearing,
    deleteConvo, removeConvo, markUnread, watchUsers, enrichAuthor, chatSettings,
  } = useChat()
  const { startCall, inCall } = useCall()

  const [open, setOpen] = React.useState(false)
  const [activeIdx, setActiveIdx] = React.useState(0)
  const [busy, setBusy] = React.useState(false)
  const [, setTick] = React.useState(0)          // ages the "last seen" label

  const wrapRef = React.useRef(null)
  const triggerRef = React.useRef(null)
  const itemRefs = React.useRef([])
  const aliveRef = React.useRef(true)

  React.useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  const peerId = convo && !convo.isGroup ? convo.peer?.id : null

  // Seed presence AND the avatar for the DM peer (both batched + cached
  // inside the context; the wire's `peer` carries no profile image).
  React.useEffect(() => {
    if (peerId) { watchPresence([peerId]); watchUsers([peerId]) }
  }, [peerId, watchPresence, watchUsers])

  // Re-render once a minute so a relative "last seen" stays honest.
  React.useEffect(() => {
    if (!peerId) return undefined
    const iv = setInterval(() => setTick(x => x + 1), 60000)
    return () => clearInterval(iv)
  }, [peerId])

  /* ---------------- menu: outside click + Escape ---------------- */

  const closeMenu = React.useCallback((refocus) => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }, [])

  /* Only Escape is handled here (it also restores focus to the trigger).
     Outside-pointer dismissal belongs to <Popover>: the menu is portalled to
     <body>, so a wrapRef.contains() test would read every in-menu click as an
     outside click and close before the item ran. */
  React.useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); closeMenu(true) } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, closeMenu])

  // Roving focus — the open menu always owns the caret.
  React.useEffect(() => {
    if (!open) return
    itemRefs.current[activeIdx]?.focus()
  }, [open, activeIdx])

  /* ---------------- actions ---------------- */

  const guard = React.useCallback(async (fn) => {
    if (busy) return
    setBusy(true)
    try { await fn() }
    finally { if (aliveRef.current) setBusy(false) }
  }, [busy])

  const doLeave = React.useCallback(() => guard(async () => {
    const ok = await uiConfirm({
      title: 'Leave group',
      message: `Leave “${convo.displayTitle}”? You will stop receiving its messages.`,
      danger: true,
      confirmLabel: 'Leave',
    })
    if (!ok) return
    try {
      await api.chat.members.leave(convo.id)
      removeConvo(convo.id)                       // the member.changed frame may lag; drop it now
      showToast('You left the group')
      navigate('/chat')
    } catch (e) {
      showToast(chatError(e, 'Could not leave the group'))
    }
  }), [guard, convo, removeConvo, navigate])

  /* DM only. The group-owner path deliberately does NOT come through here —
     see `doGroupDelete`, which derives its copy instead of hard-coding it. */
  const doDelete = React.useCallback(() => guard(async () => {
    const ok = await uiConfirm({
      title: 'Delete chat',
      message: 'Delete this conversation from your inbox? This cannot be undone.',
      danger: true,
      confirmLabel: 'Delete',
    })
    if (!ok) return
    await deleteConvo(convo.id)                   // context rolls itself back + toasts on failure
    navigate('/chat')
  }), [guard, convo, deleteConvo, navigate])

  /* A group OWNER cannot leave while anyone else remains — the server answers
     `400 BAD_REQUEST` ("Transfer ownership before leaving, or delete the
     group"). Offering them a bare "Leave group" was a button that could only
     fail. Their real options are transfer-then-leave, or retire the group, so
     the menu offers the second one — and takes every word of it from
     `deleteIntentOf`, because for an owner this DELETE destroys the group for
     every member. This is precisely the mislabel that helper exists to
     prevent, which is why the header now imports it. */
  const doGroupDelete = React.useCallback(() => guard(async () => {
    const intent = deleteIntentOf(convo)
    const ok = await uiConfirm({
      title: intent.title,
      message: intent.message,
      danger: true,
      confirmLabel: intent.confirmLabel,
    })
    if (!ok) return
    await deleteConvo(convo.id)
    showToast(intent.destroysForEveryone ? 'Group deleted' : 'Conversation cleared')
    navigate('/chat')
  }), [guard, convo, deleteConvo, navigate])

  /* ---------------- derived labels ---------------- */

  const presence = peerId ? presenceOf(peerId) : null
  const online = presence?.status === 'online'
  const derivedPresence = peerId
    ? (online ? 'online' : lastSeenLabel(presence?.lastSeenEpochMs))
    : ''

  /* Last-seen is SYMMETRIC: hide yours and every `lastSeenEpochMs` comes back
     null, so this line degrades to a bare "offline" for everyone, forever. The
     status is still true — online/offline is never hidden — but the *reason*
     the timestamp vanished is a setting the reader chose and has no way to
     connect from here. Say so on hover rather than leaving them to wonder why
     nobody's last-seen ever loads. */
  const lastSeenHidden = chatSettings?.lastSeenVisible === false
  const subtitleTitle = lastSeenHidden && peerId && !online
    ? 'Last seen is hidden both ways because you turned yours off — see Chat privacy.'
    : undefined

  // The menu is data-driven so keyboard navigation stays generic.
  const items = React.useMemo(() => {
    if (!convo) return []
    const rows = [
      { key: 'info', label: 'View info', icon: 'info', run: () => onToggleInfo?.() },
      { key: 'starred', label: 'Starred messages', icon: 'star', run: () => onToggleStarred?.() },
      { key: 'sched', label: 'Scheduled messages', icon: 'calendar', run: () => onToggleScheduled?.() },
      { key: 'unread', label: 'Mark as unread', icon: 'dot', run: () => { markUnread(convo.id); navigate('/chat') } },
      convo.muted
        ? { key: 'unmute', label: 'Unmute', icon: 'bell', run: () => setMuted(convo.id, null) }
        : { key: 'mute', label: 'Mute', icon: 'bell_off', run: () => setMuted(convo.id, muteUntilIso()) },
      convo.pinned
        ? { key: 'unpin', label: 'Unpin', icon: 'pinoff', run: () => setPinned(convo.id, false) }
        : { key: 'pin', label: 'Pin', icon: 'pin', run: () => setPinned(convo.id, true) },
      convo.archived
        ? { key: 'unarchive', label: 'Unarchive', icon: 'unarchive', run: () => setArchived(convo.id, false) }
        : { key: 'archive', label: 'Archive', icon: 'archive', run: () => setArchived(convo.id, true) },
      { key: 'prefs', label: 'Chat privacy', icon: 'lock', run: () => onTogglePrefs?.() },
    ]
    // A DM party may always set the timer; in a group it needs CHANGE_SETTINGS
    // (admins-only by default), so don't offer a row that would only 403.
    const canTimer = !convo.isGroup || convo.myRole === 'OWNER' || convo.myRole === 'ADMIN'
    if (canTimer) {
      rows.push(convo.disappearingSeconds > 0
        ? {
            key: 'ttl-off',
            label: 'Turn off disappearing',
            icon: 'hourglass',
            run: () => setDisappearing(convo.id, 0).catch(() => {}),
          }
        : {
            key: 'ttl-on',
            label: 'Disappearing messages',
            icon: 'hourglass',
            run: () => onToggleInfo?.(),        // the picker lives in the info panel
          })
    }
    /* Three outcomes, not two. A sole owner CAN leave (the server soft-deletes
       the group in the same transaction), but an owner with company cannot —
       so they get the delete path, labelled by the shared intent. */
    if (!convo.isGroup) {
      rows.push({ key: 'delete', label: 'Delete chat', icon: 'trash', danger: true, run: doDelete })
    } else if (convo.myRole === 'OWNER' && (convo.memberCount || 0) > 1) {
      rows.push({ key: 'delete-group', label: deleteIntentOf(convo).label, icon: 'trash', danger: true, run: doGroupDelete })
    } else {
      rows.push({ key: 'leave', label: 'Leave group', icon: 'logout', danger: true, run: doLeave })
    }
    return rows
  }, [convo, onToggleInfo, onToggleStarred, onToggleScheduled, onTogglePrefs, markUnread,
      navigate, setMuted, setPinned, setArchived, setDisappearing, doLeave, doDelete, doGroupDelete])

  const openMenu = () => { setActiveIdx(0); setOpen(true) }

  const onMenuKeyDown = (e) => {
    const last = items.length - 1
    if (e.key === 'ArrowDown')      { e.preventDefault(); setActiveIdx(i => (i >= last ? 0 : i + 1)) }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIdx(i => (i <= 0 ? last : i - 1)) }
    else if (e.key === 'Home')      { e.preventDefault(); setActiveIdx(0) }
    else if (e.key === 'End')       { e.preventDefault(); setActiveIdx(last) }
    else if (e.key === 'Tab')       { closeMenu(false) }
  }

  if (!convo) return null

  const peer = convo.isGroup ? null : enrichAuthor(convo.peer, peerId)
  const canCall = !convo.isChannel && convo.myStatus === 'ACTIVE'
  const title = convo.displayTitle || (convo.isGroup ? 'Group' : 'Conversation')
  const subtitle = convo.isGroup
    ? (typingLabel || `${convo.memberCount || 0} member${(convo.memberCount || 0) === 1 ? '' : 's'}`)
    : (typingLabel || presenceLabel || derivedPresence)

  return (
    <header className="ch-hd">
      <button
        type="button"
        className="icon-btn ch-hd-back"
        onClick={onBack}
        aria-label="Back to conversations"
        title="Back"
      >
        <Icon name="chevleft"/>
      </button>

      <button
        type="button"
        className="ch-hd-id"
        onClick={onToggleInfo}
        aria-label={convo.isGroup ? 'Group info' : 'Conversation info'}
        title={convo.isGroup ? 'Group info' : 'Conversation info'}
      >
        <span className="ch-hd-avatar">
          {convo.isGroup
            ? (
              <span className="ch-hd-medallion" aria-hidden="true">
                {convo.avatarUrl
                  ? <img className="ch-hd-medallion-img" src={convo.avatarUrl} alt=""/>
                  : <Icon name="users"/>}
              </span>
            )
            : (
              <Avatar
                size={40}
                src={peer?.profileImage || null}
                initials={peer?.initials || '·'}
                color={peer?.avc}
              />
            )}
          {!convo.isGroup && online && <span className="ch-hd-dot on" aria-hidden="true"/>}
        </span>

        <span className="ch-hd-text">
          <span className="ch-hd-title">
            <b className="ch-hd-name" dir="auto">{title}</b>
            {!convo.isGroup && peer?.verified && <Verify scholar={peer.role === 'SCHOLAR'}/>}
            {convo.isChannel && <span className="pill ch-hd-kind">Channel</span>}
            {convo.muted && (
              <span className="ch-hd-muted" title="Notifications muted" aria-label="Notifications muted">
                <Icon name="bell_off" className="sm"/>
              </span>
            )}
            {convo.disappearingSeconds > 0 && (
              <span className="ch-hd-ttl" title={`Messages disappear after ${ttlLabel(convo.disappearingSeconds)}`}>
                <Icon name="hourglass" className="sm"/>
                <span>{ttlLabel(convo.disappearingSeconds)}</span>
              </span>
            )}
          </span>
          {subtitle && (
            <span className={'ch-hd-sub' + (typingLabel ? ' live' : '')} dir="auto"
              title={typingLabel ? undefined : subtitleTitle}>
              {typingLabel && activityIcon(typingActivity) && (
                <Icon name={activityIcon(typingActivity)} className="ch-hd-sub-ico" aria-hidden="true"/>
              )}
              {subtitle}
              {typingLabel && <span className="ch-ell" aria-hidden="true"/>}
            </span>
          )}
        </span>
      </button>

      <div className="ch-hd-actions">
        {/* Calls ring every other ACTIVE member, so a broadcast channel is
            excluded by construction — a "call" there would ring the whole
            subscriber list. A restricted/left member gets no button either. */}
        {canCall && (
          <>
            <button
              type="button"
              className="icon-btn ch-hd-act"
              onClick={() => startCall(convo.id, 'VOICE')}
              disabled={inCall}
              aria-label={convo.isGroup ? 'Start a group voice call' : 'Voice call'}
              title="Voice call"
            >
              <Icon name="phone"/>
            </button>
            <button
              type="button"
              className="icon-btn ch-hd-act"
              onClick={() => startCall(convo.id, 'VIDEO')}
              disabled={inCall}
              aria-label={convo.isGroup ? 'Start a group video call' : 'Video call'}
              title="Video call"
            >
              <Icon name="video"/>
            </button>
          </>
        )}

        <button
          type="button"
          className="icon-btn ch-hd-act"
          onClick={onToggleSearch}
          aria-label="Search in conversation"
          title="Search in conversation"
        >
          <Icon name="search"/>
        </button>

        <button
          type="button"
          className={'icon-btn ch-hd-act' + (infoOpen ? ' active' : '')}
          onClick={onToggleInfo}
          aria-pressed={!!infoOpen}
          aria-label="Conversation details"
          title="Conversation details"
        >
          <Icon name="info"/>
        </button>

        <div className="ch-hd-menu-wrap" ref={wrapRef}>
          <button
            type="button"
            ref={triggerRef}
            className={'icon-btn ch-hd-act' + (open ? ' active' : '')}
            onClick={() => (open ? closeMenu(false) : openMenu())}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && !open) { e.preventDefault(); openMenu() }
            }}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-busy={busy || undefined}
            aria-label="Conversation actions"
            title="More"
          >
            <Icon name="more"/>
          </button>

          {/* Portalled: the header sets backdrop-filter, which creates a
              stacking context that used to seal this menu below the thread's
              positioned bubbles. Rendering on <body> sidesteps stacking and
              overflow entirely. */}
          <Popover
            anchorRef={triggerRef}
            open={open}
            onClose={() => closeMenu(false)}
            className="ch-hd-menu"
            ariaLabel="Conversation actions"
            align="end"
          >
            {/* role="none" keeps the menuitems as direct children of the
                Popover's role="menu" in the accessibility tree. */}
            <div className="ch-hd-menu-items" role="none" onKeyDown={onMenuKeyDown}>
              {items.map((it, i) => (
                <button
                  key={it.key}
                  type="button"
                  role="menuitem"
                  tabIndex={i === activeIdx ? 0 : -1}
                  ref={(el) => { itemRefs.current[i] = el }}
                  className={'ch-menu-item' + (it.danger ? ' danger' : '')}
                  disabled={busy}
                  onClick={() => { closeMenu(false); it.run() }}
                  onMouseEnter={() => setActiveIdx(i)}
                >
                  <Icon name={it.icon} className="sm"/>
                  <span>{it.label}</span>
                </button>
              ))}
            </div>
          </Popover>
        </div>
      </div>
    </header>
  )
}

export default ConversationHeader
