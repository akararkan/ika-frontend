/* =========================================================
   MessageBubble — one message in the thread.
   ---------------------------------------------------------
   Renders every message shape the backend can send: TEXT,
   IMAGE/VIDEO albums, VOICE notes with a scrubable waveform,
   FILE attachments, and centred SYSTEM notices. On top of the
   payload it layers the reply quote, the forwarded marker,
   reactions, the receipt/edited/time meta, and the hover tool
   rail (react · reply · more).

   Non-obvious decisions:
   - `mine` bubbles are navy and sit on the end side; the tail is
     a squared corner via LOGICAL radius props, so RTL flips for
     free with no mirrored assets.
   - The meta line (time + ticks) is a `float:inline-end` inside
     the text flow. That is deliberate: it lets short messages sit
     on ONE line with the timestamp, and long ones wrap the text
     around it — the classic messenger shape — without measuring
     anything in JS.
   - Receipts are derived from two high-water marks passed down
     (`peerDelivered` / `peerRead`) rather than per-message state,
     because the wire only ever tells us "read UP TO id".
   - Touch has no hover, so a long-press opens the same menu the
     hover rail exposes (the rail itself is hidden under 720px).
   ========================================================= */
import React from 'react'
import { Icon, Avatar, Verify, linkify, showToast } from '../ui.jsx'
import { useChat } from '../../context/ChatContext.jsx'
import { Popover } from './Popover.jsx'
import { systemNoticeOf } from './systemEvents.js'
import { VoiceNote } from './VoiceNote.jsx'
import { durationOf } from './mediaPrefs.js'
import { gteId } from '../../api/ids.js'
import { PollCard, LocationCard, ContactCard, PostRail, CommentsBar, VideoNote } from './PostExtras.jsx'
import { nfmt } from '../channels/channelArt.js'

/* Reaction strip offered on hover — mirrors the platform's reaction set. */
const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🤲']

/* ---------------------------------------------------------
   Receipt ticks — sent ✓ · delivered ✓✓ · seen ✓✓ (lit).
   A dedicated SVG rather than the icon font: the two checks
   need WhatsApp's overlapping geometry, the second check
   draws itself in when the delivery receipt lands, and the
   pair pops to the "seen" colour on the read receipt — all
   of which keys off classes on paths the font can't expose.
   --------------------------------------------------------- */
function Ticks({ state }) {
  const double = state === 'delivered' || state === 'read'
  return (
    <svg
      className={'ch-tick' + (state === 'read' ? ' seen' : '')}
      viewBox="0 0 20 12"
      aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round"
    >
      {/* single tick sits centred; in a pair it shifts to the start */}
      <path className="ch-tick-1" d={double ? 'M1.6 6.9l3.3 3.3 6.8-7.6' : 'M4.6 6.9l3.3 3.3 6.8-7.6'}/>
      {double && <path className="ch-tick-2" d="M8.5 8.7l1.7 1.5 6.9-7.6"/>}
    </svg>
  )
}

/** ISO → "14:07" in the viewer's locale. */
function clockOf(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** bytes → "1.4 MB". */
function sizeOf(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

/* URLs first, then the platform's #tag/@mention linkifier on what's left —
   composing this way keeps chat consistent with posts while still making a
   pasted link clickable (linkify alone doesn't touch bare URLs). */
const URL_RE = /(https?:\/\/[^\s<]+)/g
function renderText(text) {
  if (!text) return null
  return text.split(URL_RE).map((part, i) => {
    if (URL_RE.test(part)) {
      URL_RE.lastIndex = 0
      return (
        <a key={i} href={part} target="_blank" rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}>{part}</a>
      )
    }
    return <React.Fragment key={i}>{linkify(part)}</React.Fragment>
  })
}

/* ---------------------------------------------------------
   Media block — images/videos as an album, files as rows
   --------------------------------------------------------- */

/* A video tile that previews itself under the cursor.
   Muted, loop-free, first seconds only: it is the cheapest way to answer "what
   is this clip?" without opening the viewer, and it is what every modern
   messenger now does. Deliberately gated:
     · fine pointers only — there is no hover on touch, and a tap must open the
       viewer rather than start a silent preview under the finger;
     · `prefers-reduced-motion` — an autoplaying tile is exactly the motion that
       setting exists to stop;
     · Save-Data — a preview is a second download of a file the reader never
       asked for.
   The element is REWOUND on leave, so the poster comes back and the next hover
   starts from the top instead of resuming mid-shot. */
function VideoTile({ m, onOpen, label }) {
  const vidRef = React.useRef(null)
  const canPreview = React.useRef(null)
  if (canPreview.current === null) {
    canPreview.current = (window.matchMedia?.('(hover: hover) and (pointer: fine)')?.matches ?? false)
      && !(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false)
      && !navigator.connection?.saveData
  }

  const preview = (on) => {
    const v = vidRef.current
    if (!v || !canPreview.current) return
    if (on) { v.play?.().catch(() => {}) }
    else { v.pause?.(); try { v.currentTime = 0 } catch { /* not seekable yet */ } }
  }

  return (
    <button
      type="button"
      className="ch-asset ch-asset-video"
      onClick={(e) => { e.stopPropagation(); onOpen() }}
      onPointerEnter={() => preview(true)}
      onPointerLeave={() => preview(false)}
      aria-label={label}
    >
      <video
        ref={vidRef}
        src={m.url || undefined}
        poster={m.thumbnailUrl || undefined}
        preload="metadata"
        width={m.width || undefined}
        height={m.height || undefined}
        muted
        playsInline
      />
      <span className="ch-asset-play"><Icon name="play"/></span>
      {!!m.durationMs && <span className="ch-asset-dur">{durationOf(m.durationMs)}</span>}
    </button>
  )
}

function MediaBlock({ media, messageId, mine, senderName, onOpenMedia }) {
  /* VIDEO_NOTE is a video on the wire but never in the album grid — it is the
     round one, and dropping it into the grid would square it off. It is pulled
     out FIRST so the three filters below stay mutually exclusive. */
  const notes = media.filter(m => m.kind === 'VIDEO_NOTE')
  const rest = media.filter(m => m.kind !== 'VIDEO_NOTE')
  const visuals = rest.filter(m => m.kind === 'IMAGE' || m.kind === 'VIDEO')
  const voices = rest.filter(m => m.kind === 'VOICE')
  const files = rest.filter(m => m.kind !== 'IMAGE' && m.kind !== 'VIDEO' && m.kind !== 'VOICE')

  // At most 4 tiles; the 4th carries a "+n" veil rather than growing the grid.
  const shown = visuals.slice(0, 4)
  const overflow = visuals.length - shown.length

  return (
    <>
      {notes.map((m, i) => <VideoNote key={m.storageKey || i} media={m}/>)}

      {!!shown.length && (
        <div className={`ch-media n-${shown.length}`}>
          {shown.map((m, i) => (
            m.kind === 'VIDEO' ? (
              <VideoTile
                key={m.storageKey || m.url || i}
                m={m}
                label={m.altText || 'Open video'}
                onOpen={() => onOpenMedia?.(visuals, i)}
              />
            ) : (
              <button
                key={m.storageKey || m.url || i}
                type="button"
                className="ch-asset"
                onClick={(e) => { e.stopPropagation(); onOpenMedia?.(visuals, i) }}
                aria-label={m.altText || 'Open image'}
              >
                {/* `width`/`height` come back on every IMAGE and VIDEO and were
                    being dropped. Without them the tile has no intrinsic size,
                    so the row grows the moment the bytes land. That is not just
                    a flicker here: MessageList anchors "load earlier" by
                    measuring `scrollHeight` in a layout effect, and a row that
                    resizes after the measurement restores the scroll to the
                    wrong place — the exact failure the content-visibility ban
                    exists to prevent. */}
                <img src={m.thumbnailUrl || m.url || undefined} alt={m.altText || ''} loading="lazy"
                  width={m.width || undefined} height={m.height || undefined}/>
                {i === shown.length - 1 && overflow > 0 && (
                  <span className="ch-asset-more">+{overflow}</span>
                )}
              </button>
            )
          ))}
        </div>
      )}

      {voices.map((m, i) => (
        <VoiceNote key={m.storageKey || i} media={m} messageId={messageId} mine={mine} senderName={senderName}/>
      ))}

      {files.map((m, i) => (
        <a
          key={m.storageKey || i}
          className="ch-file"
          href={m.url || undefined}
          target="_blank"
          rel="noopener noreferrer"
          download={m.fileName || undefined}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="ch-file-ico"><Icon name="doc"/></span>
          <span className="ch-file-body">
            <span className="ch-file-name">{m.fileName || 'Attachment'}</span>
            <span className="ch-file-size">{sizeOf(m.bytes)}</span>
          </span>
          <Icon name="download" className="sm"/>
        </a>
      ))}
    </>
  )
}

/* ---------------------------------------------------------
   The bubble
   --------------------------------------------------------- */

export function MessageBubble({
  msg,
  mine,
  isGroup,
  showAvatar,
  showSender,
  runStart,
  runEnd,
  canModerate,
  canPin,
  isPinned,
  peerDelivered = 0,
  peerRead = 0,
  receiptsOff = false,
  flash,
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
  onPoll,
  onTag,
  onComments,
  /* Channel policy, resolved by ChatPage from `ChannelSettings`. Both are
     ABSENCES rather than disabled states: a control that can only ever answer
     403 is worse than no control, and both of these are the channel's policy
     rather than a role the reader could be granted. */
  reactionsOff = false,
  allowedReactions = null,   // non-empty → only these emoji are accepted
  protectedContent = false,  // forwarding refused channel-wide
}) {
  const { enrichAuthor, watchUsers, myId } = useChat()
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [reactOpen, setReactOpen] = React.useState(false)
  const [sheetOpen, setSheetOpen] = React.useState(false)   // touch: long-press action sheet
  const wrapRef = React.useRef(null)
  const pressRef = React.useRef(null)
  const reactBtnRef = React.useRef(null)
  const menuBtnRef = React.useRef(null)

  // The wire has no avatar for a sender — ask the directory for the rest of
  // the card. Only the bubble that actually renders an avatar needs to.
  React.useEffect(() => {
    if (showAvatar && msg.senderId && !msg.isSystem) watchUsers([msg.senderId])
  }, [showAvatar, msg.senderId, msg.isSystem, watchUsers])

  /* A moderator who deleted someone else's message is usually NOT in this
     thread's visible cast, so their card has to be fetched like any other
     stranger's. Same batching as the sender lookup above. */
  React.useEffect(() => {
    if (msg.deletedBy && String(msg.deletedBy) !== String(msg.senderId)) watchUsers([msg.deletedBy])
  }, [msg.deletedBy, msg.senderId, watchUsers])

  const sender = enrichAuthor(msg.sender, msg.senderId)
  const senderName = sender?.full || sender?.handle || 'Unknown'

  /* The reply strip signs its QUOTED author. The wire gives replyTo only a
     senderId, so the name comes from the directory — fetched with the same
     batcher as every other stranger's card, and the generic "In reply to"
     caption holds the line until it resolves. */
  const quotedId = !msg.deleted && msg.replyTo && !msg.replyTo.deleted
    ? msg.replyTo.senderId
    : null
  React.useEffect(() => {
    if (quotedId) watchUsers([quotedId])
  }, [quotedId, watchUsers])
  const quotedWho = quotedId ? enrichAuthor(null, quotedId) : null
  const quotedName = quotedId && String(quotedId) === String(myId)
    ? 'You'
    : quotedWho?.full || null

  /* The quick strip, narrowed to what this channel actually accepts. An emoji
     outside a non-empty `allowedReactions` is refused server-side, so offering
     it would be offering a 403. If the whitelist and the house set don't
     overlap at all, the channel's own list wins — it is the authoritative
     answer to "what can I react with here". */
  const quick = React.useMemo(() => {
    if (!allowedReactions?.length) return QUICK
    const kept = QUICK.filter(e => allowedReactions.includes(e))
    return kept.length ? kept : allowedReactions.slice(0, 6)
  }, [allowedReactions])

  const closeAll = React.useCallback(() => { setMenuOpen(false); setReactOpen(false) }, [])

  /* The timeline hard-codes `reactedByMe: false` on every row (the counts come
     from Redis, the per-viewer flag only from Cassandra), so after a reload
     your own reaction is unhighlighted and un-toggling it costs two taps.
     Pull the exact buckets the moment the reader shows intent — hovering or
     focusing the chips, or opening the quick-react strip — which is free on
     load and always lands before the click. `useThread` caches the answer, so
     repeated hovers cost one request. */
  const hydrate = React.useCallback(() => { onHydrateReactions?.(msg.id) }, [onHydrateReactions, msg.id])

  /* NB: there is deliberately no outside-click handler here. Both menus now
     render through <Popover>, which portals to <body> — an ancestor-based
     `wrapRef.contains(e.target)` test would treat every click INSIDE the menu
     as an outside click and dismiss it before the item fired. Popover owns
     its own outside-pointer and Escape handling. */

  // Long-press (touch) opens a bottom sheet rather than the hover rail — the
  // rail is display:none under 720px, so reusing it here would open nothing.
  const startPress = () => {
    clearTimeout(pressRef.current)
    pressRef.current = setTimeout(() => {
      hydrate()                                   // the sheet carries the react strip
      setSheetOpen(true)
      if (navigator.vibrate) { try { navigator.vibrate(8) } catch { /* unsupported */ } }
    }, 460)
  }
  const endPress = () => clearTimeout(pressRef.current)
  React.useEffect(() => () => clearTimeout(pressRef.current), [])

  const sheetRef = React.useRef(null)
  React.useEffect(() => {
    if (!sheetOpen) return undefined
    const opener = document.activeElement
    const onKey = (e) => {
      if (e.key === 'Escape') { setSheetOpen(false); return }
      if (e.key !== 'Tab') return
      const nodes = sheetRef.current?.querySelectorAll('button')
      if (!nodes?.length) return
      const list = [...nodes].filter(n => !n.disabled)
      const first = list[0]
      const last = list[list.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey, true)
    // The sheet is modal — lock the page and take focus, restoring both after.
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    sheetRef.current?.querySelector('button')?.focus()
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = prevOverflow
      if (opener instanceof HTMLElement) opener.focus()
    }
  }, [sheetOpen])

  /* ----- SYSTEM messages are centred notices, not bubbles -----
     The server's composed text wins (it is the only thing that knows the
     names); `systemEvent` supplies both the icon and a specific fallback when
     the body is empty, instead of flattening an ownership transfer and a title
     tweak into the same "Conversation updated". */
  if (msg.isSystem) {
    const notice = systemNoticeOf(msg)
    return (
      <div className="ch-system">
        {/* The pill is `.ch-system span` (chat.css §5) — the glyph belongs
            INSIDE it, or the flex parent lays it out as a separate centred
            item floating next to the pill. */}
        <span dir="auto">
          <Icon name={notice.icon} className="ch-system-ico" aria-hidden="true"/>
          {notice.text}
        </span>
      </div>
    )
  }

  const media = msg.media || []
  const hasText = !!(msg.body || '').trim()
  const onlyMedia = !hasText && media.length > 0 && !msg.deleted
  const isVisualOnly = onlyMedia && media.every(m => m.kind === 'IMAGE' || m.kind === 'VIDEO')

  /* ----- who removed it -----
     A tombstone that says only "This message was deleted" leaves the room
     guessing whether the author changed their mind or a moderator stepped in —
     a real difference in a group. `deletedBy` is stamped from the actor on the
     `message.deleted` frame (and locally on my own delete); when it is absent
     — history loaded from the REST page carries no actor — the copy stays
     deliberately impersonal rather than guessing that the sender did it. */
  const deleterId = msg.deletedBy || null
  // `enrichAuthor(null, id)` is a synchronous directory read that returns null
  // until the profile lands, so the name arrives a beat after the tombstone.
  // The interim copy is the impersonal one — never the sender's name, which
  // would be a guess in exactly the case this exists to disambiguate.
  const deleterCard = deleterId ? enrichAuthor(null, deleterId) : null
  const deleterName = String(deleterId) === String(msg.senderId)
    ? senderName
    : (deleterCard?.full || deleterCard?.handle || null)
  const deletedNote = !msg.deleted ? null
    : !deleterId ? 'This message was deleted'
      : String(deleterId) === String(myId) ? 'You deleted this message'
        : deleterName ? `${deleterName} deleted this message`
          : 'This message was deleted'

  /* Receipt ladder: pending → sent → delivered → read. Only for my own
     messages, and only once the server has assigned a real id. */
  /* The tick is an <svg> with no accessible name, so each state carries an
     sr-only word alongside it — otherwise "sent" vs "read" is invisible to a
     screen-reader user, which is the entire point of a receipt. */
  let receipt = null
  if (mine && !msg.deleted && !msg.failed) {
    /* With read receipts off (mine or the peer's — the gate is symmetric) the
       server sends no `receipt.*` frames and nulls the peer markers, so the
       ladder can never advance past "sent". Showing a permanently-single tick
       reads as "undelivered"; show the plain sent mark with honest wording
       instead of a promise the privacy setting has already broken. */
    const state = msg.pending ? 'pending'
      : receiptsOff ? 'sent'
      : gteId(peerRead, msg.id) ? 'read'
      : gteId(peerDelivered, msg.id) ? 'delivered'
      : 'sent'
    const label = state === 'sent' && receiptsOff
      ? 'Sent · read receipts are off'
      : { pending: 'Sending', sent: 'Sent', delivered: 'Delivered', read: 'Seen' }[state]
    receipt = (
      <span className="ch-receipt" title={label}>
        {state === 'pending'
          ? <Icon name="clock" className="sm" aria-hidden="true"/>
          : <Ticks state={state}/>}
        <span className="sr-only">{label}</span>
      </span>
    )
  }

  const menuItems = []
  if (!msg.deleted && !msg.pending) {
    menuItems.push({ key: 'reply', label: 'Reply', icon: 'reply', run: () => onReply?.(msg) })
    /* `protectedContent` asks clients to disable copy and save alongside the
       forward the server actually enforces. Honoured here — the server cannot
       stop a clipboard write, so the only place this promise can be kept is
       the client, and quietly ignoring it would make the channel's setting a
       lie to the admin who switched it on. */
    if (hasText && !protectedContent) {
      menuItems.push({
        key: 'copy',
        label: 'Copy text',
        icon: 'copy',
        run: async () => {
          try { await navigator.clipboard.writeText(msg.body); showToast('Copied') }
          catch { showToast('Could not copy') }
        },
      })
    }
    // `protectedContent` refuses every forward out of this channel (403), so
    // the row is absent rather than present-and-failing.
    if (!protectedContent) {
      menuItems.push({ key: 'forward', label: 'Forward', icon: 'forward', run: () => onForward?.(msg) })
    }
    /* VoiceNote surfaces no anchor, and since every audio row renders as the
       player (mediaFrom normalises AUDIO→VOICE) this menu is the only place a
       received recording — a lecture, a nasheed — can be SAVED. Honoured
       against protectedContent for the same reason Copy is. */
    if (!protectedContent) {
      const audio = (msg.media || []).filter(m => m.kind === 'VOICE' && m.url)
      if (audio.length) {
        menuItems.push({
          key: 'saveaudio',
          label: audio.length === 1 ? 'Save audio' : `Save audio (${audio.length})`,
          icon: 'download',
          run: () => {
            for (const m of audio) {
              const a = document.createElement('a')
              a.href = m.url
              a.download = m.fileName || 'audio'
              document.body.appendChild(a)
              a.click()
              a.remove()
            }
          },
        })
      }
    }
    // A star is PRIVATE — nobody else can see it, so it is offered on every
    // readable message, mine or not.
    menuItems.push(msg.starred
      ? { key: 'unstar', label: 'Remove star', icon: 'staroff', run: () => onStar?.(msg) }
      : { key: 'star', label: 'Star message', icon: 'star', run: () => onStar?.(msg) })
    if (canPin) {
      menuItems.push(isPinned
        ? { key: 'unpin', label: 'Unpin', icon: 'pinoff', run: () => onUnpin?.(msg) }
        : { key: 'pin', label: 'Pin', icon: 'pin', run: () => onPin?.(msg) })
    }
    // "Seen by" is a group affordance for your OWN messages; in a DM the tick
    // ladder already says it, and the endpoint excludes the sender anyway.
    if (isGroup && mine) {
      menuItems.push({ key: 'seen', label: 'Seen by', icon: 'checks', run: () => onSeenBy?.(msg) })
    }
    if (mine && hasText) menuItems.push({ key: 'edit', label: 'Edit', icon: 'edit', run: () => onEdit?.(msg) })
    /* Two genuinely different deletes, so they are two rows rather than one
       ambiguous "Delete". "for me" is available on ANY readable message and
       hides it only from this account; "for everyone" tombstones it for the
       whole room and is the sender's / an admin's call. */
    menuItems.push({ key: 'delete-me', label: 'Delete for me', icon: 'eyeoff', run: () => onDelete?.(msg, 'me') })
    if (mine || canModerate) {
      menuItems.push({
        key: 'delete', label: 'Delete for everyone', icon: 'trash', danger: true,
        run: () => onDelete?.(msg, 'everyone'),
      })
    }
  }

  return (
    <div
      ref={wrapRef}
      className={
        'ch-row' +
        (mine ? ' mine' : '') +
        /* A broadcast POST, not a chat message. Its reactions are a public
           tally rather than a private aside between two people, so they are
           given real weight — see `.ch-row.is-post .ch-react`. */
        (msg.isPost ? ' is-post' : '') +
        (runStart ? ' run-start' : '') +
        (runEnd ? ' run-end' : '')
      }
      data-mid={msg.id}
    >
      {/* avatar column — always occupies space so bubbles in a run stay
          aligned. The spacer class is `ghost`, NOT `hidden`: styles.css ships
          a global `.hidden{display:none!important}` utility that collapses
          the column entirely, which made every non-tail bubble slide left
          into the gutter and jump right again on the avatar row. */}
      {!mine && (
        <div className={'ch-row-av' + (showAvatar ? '' : ' ghost')}>
          {showAvatar && (
            <button
              type="button"
              className="ch-av-btn"
              onClick={() => onOpenProfile?.(msg.senderId)}
              aria-label={`View ${senderName}'s profile`}
            >
              <Avatar
                size={30}
                src={sender?.profileImage || null}
                initials={sender?.initials || '·'}
                color={sender?.avc}
              />
            </button>
          )}
        </div>
      )}

      <div className="ch-stack">
        {showSender && isGroup && !mine && (
          <div className="ch-sender">
            {senderName}
            {sender?.verified && <Verify scholar={sender.role === 'SCHOLAR'}/>}
          </div>
        )}

        <div
          className={
            'ch-bubble' +
            (msg.pending ? ' pending' : '') +
            (msg.failed ? ' failed' : '') +
            (msg.deleted ? ' deleted' : '') +
            (isVisualOnly ? ' media-only' : '') +
            (flash ? ' flash' : '')
          }
          onTouchStart={startPress}
          onTouchEnd={endPress}
          onTouchMove={endPress}
          onContextMenu={(e) => { e.preventDefault(); setMenuOpen(true) }}
        >
          {msg.deleted ? (
            <span className="ch-text ch-deleted-note">
              <Icon name="eyeoff" className="ch-deleted-ico" aria-hidden="true"/>
              <span dir="auto">{deletedNote}</span>
            </span>
          ) : (
            <>
              {msg.forwardedFrom && (
                <div className="ch-fwdmark"><Icon name="forward"/>Forwarded</div>
              )}

              {msg.replyTo && (
                <button
                  type="button"
                  className="ch-quote"
                  /* A tombstoned target is knowable here, so don't send the
                     reader on a jump that walks the whole history and fails.
                     A target hidden by the server's floor is NOT knowable —
                     that case is handled by the toast in ChatPage.onJump. */
                  disabled={msg.replyTo.deleted}
                  onClick={(e) => { e.stopPropagation(); onJumpTo?.(msg.replyTo.messageId) }}
                  aria-label={msg.replyTo.deleted
                    ? 'The replied message was deleted'
                    : `Go to the replied message${quotedName ? ` from ${quotedName === 'You' ? 'you' : quotedName}` : ''}`}
                >
                  {/* The caption IS the attribution — the quoted author's
                      name once the directory resolves it, the old generic
                      labels until then. */}
                  <span className="ch-quote-who" dir="auto">
                    {quotedName
                      || (msg.replyTo.senderId === msg.senderId ? 'Reply' : 'In reply to')}
                  </span>
                  <span className={'ch-quote-txt' + (msg.replyTo.deleted ? ' gone' : '')} dir="auto">
                    {msg.replyTo.deleted
                      ? 'Original message deleted'
                      : (msg.replyTo.snippet || {
                          IMAGE: 'Photo', VIDEO: 'Video', VOICE: 'Voice message', FILE: 'File',
                        }[msg.replyTo.type] || 'Message')}
                  </span>
                </button>
              )}

              {!!media.length && (
                <MediaBlock media={media} messageId={msg.id} mine={mine}
                  senderName={senderName} onOpenMedia={onOpenMedia}/>
              )}

              {/* Typed payloads. Each is keyed on its OWN field rather than on
                  `msg.type`, so a row whose type and payload disagree renders
                  what it actually has instead of an empty card. */}
              {msg.poll && (
                <PollCard msg={msg} poll={msg.poll} canClose={canModerate || mine} onPoll={onPoll}/>
              )}
              {msg.location && <LocationCard location={msg.location}/>}
              {msg.contact && <ContactCard contact={msg.contact} onOpenProfile={onOpenProfile}/>}

              {hasText && (
                <span className="ch-text" dir="auto">{renderText(msg.body)}</span>
              )}
            </>
          )}

          <span className="ch-meta">
            {/* A broadcast post's view count belongs BESIDE the clock, the way
                every channel reader already expects to find it — not in a
                separate counter row. `!= null`, so a post with zero views
                still shows its counter. */}
            {msg.views != null && !msg.deleted && (
              <span className="ch-meta-views" title={`${msg.views} unique viewers`}>
                <Icon name="eye" aria-hidden="true"/>
                {nfmt(msg.views)}
                <span className="sr-only"> views</span>
              </span>
            )}
            {msg.starred && !msg.deleted && (
              <span className="ch-meta-star" title="Starred">
                <Icon name="star" aria-hidden="true"/>
                <span className="sr-only">Starred</span>
              </span>
            )}
            {msg.editedAt && !msg.deleted && <span className="ch-meta-edited">edited</span>}
            {msg.failed
              ? <span style={{ color: 'inherit', fontWeight: 600 }}>failed</span>
              : <span>{clockOf(msg.createdAt)}</span>}
            {receipt}
          </span>
        </div>

        {/* Tags, signature and the view/forward counters. Outside the bubble,
            because on a broadcast post they belong to the POST rather than to
            the utterance — and because the bubble's meta line already floats
            inside the text flow. */}
        {!msg.deleted && <PostRail msg={msg} onTag={onTag}/>}

        {msg.failed && (
          <button type="button" className="ch-retry" onClick={() => onRetry?.(msg)}>
            <Icon name="repost" className="sm"/> Tap to retry
          </button>
        )}

        {!!(msg.reactions || []).length && !msg.deleted && (
          <div
            className="ch-reacts"
            onPointerEnter={hydrate}
            onTouchStart={hydrate}
            onFocusCapture={hydrate}
          >
            {msg.reactions.map(r => (
              <button
                key={r.emoji}
                type="button"
                className={'ch-react' + (r.reactedByMe ? ' mine' : '')}
                onClick={() => onReact?.(msg.id, r.emoji)}
                aria-pressed={!!r.reactedByMe}
                aria-label={`${r.emoji} ${r.count}`}
              >
                <span aria-hidden="true">{r.emoji}</span>
                {r.count > 1 && <span className="ch-react-n">{r.count}</span>}
              </button>
            ))}
          </div>
        )}

        {/* The comments bar closes the post, BELOW the reactions — reacting is
            a one-tap response to what you just read, commenting is leaving the
            post for a thread, so they run in that order. It is a full-width
            row rather than a chip in the counter rail: on a broadcast channel
            it is the reader's only way to reply, so it gets a button's weight.
            `!= null` is the test — a post with zero comments still offers the
            affordance; a post in a channel with no discussion group linked
            has none at all. */}
        {!msg.deleted && msg.comments != null && (
          <CommentsBar msg={msg} channelId={msg.conversationId} onOpen={onComments}/>
        )}
      </div>

      {/* hover rail — hidden on touch by CSS, replaced by long-press */}
      {!msg.deleted && !msg.pending && (
        <div className={'ch-tools' + (menuOpen || reactOpen ? ' open' : '')}>
          {/* Reacting is refused channel-wide (403 REACTIONS_DISABLED) when the
              admins turn it off — so the opener goes, not just the strip. */}
          <div className="ch-tool-wrap" hidden={reactionsOff}>
            <button
              type="button"
              ref={reactBtnRef}
              className="ch-tool"
              onClick={() => { setMenuOpen(false); hydrate(); setReactOpen(v => !v) }}
              aria-label="React to message"
              aria-expanded={reactOpen}
              title="React"
            >
              <Icon name="smile"/>
            </button>
            <Popover
              anchorRef={reactBtnRef}
              open={reactOpen}
              onClose={() => setReactOpen(false)}
              className="ch-quickreact"
              ariaLabel="Quick reactions"
              align={mine ? 'end' : 'start'}
              prefer="top"
            >
              {quick.map(e => (
                <button
                  key={e}
                  type="button"
                  className="ch-qr"
                  role="menuitem"
                  onClick={() => { setReactOpen(false); onReact?.(msg.id, e) }}
                  aria-label={`React ${e}`}
                >
                  {e}
                </button>
              ))}
            </Popover>
          </div>

          <button
            type="button"
            className="ch-tool"
            onClick={() => onReply?.(msg)}
            aria-label="Reply to message"
            title="Reply"
          >
            <Icon name="reply"/>
          </button>

          <div className="ch-tool-wrap">
            <button
              type="button"
              ref={menuBtnRef}
              className="ch-tool"
              onClick={() => { setReactOpen(false); setMenuOpen(v => !v) }}
              aria-label="Message actions"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              title="More"
            >
              <Icon name="more"/>
            </button>
            <Popover
              anchorRef={menuBtnRef}
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              className="ch-tool-menu"
              ariaLabel="Message actions"
              align={mine ? 'end' : 'start'}
              prefer="bottom"
            >
              {menuItems.map(it => (
                <button
                  key={it.key}
                  type="button"
                  role="menuitem"
                  className={'ch-menu-item' + (it.danger ? ' danger' : '')}
                  onClick={() => { closeAll(); it.run() }}
                >
                  <Icon name={it.icon} className="sm"/>
                  <span>{it.label}</span>
                </button>
              ))}
            </Popover>
          </div>
        </div>
      )}

      {/* touch: long-press action sheet (the hover rail is hidden under 720px) */}
      {sheetOpen && (
        <div
          className="ch-sheet-scrim"
          role="presentation"
          onClick={() => setSheetOpen(false)}
        >
          <div
            className="ch-sheet"
            role="menu"
            aria-label="Message actions"
            ref={sheetRef}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Same gate as the hover rail — the touch path must not offer
                what the pointer path correctly hides. */}
            <div className="ch-sheet-reacts" hidden={reactionsOff}>
              {quick.map(e => (
                <button
                  key={e}
                  type="button"
                  className="ch-qr"
                  role="menuitem"
                  onClick={() => { setSheetOpen(false); onReact?.(msg.id, e) }}
                  aria-label={`React ${e}`}
                >
                  {e}
                </button>
              ))}
            </div>
            {menuItems.map(it => (
              <button
                key={it.key}
                type="button"
                role="menuitem"
                className={'ch-menu-item' + (it.danger ? ' danger' : '')}
                onClick={() => { setSheetOpen(false); it.run() }}
              >
                <Icon name={it.icon} className="sm"/>
                <span>{it.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default MessageBubble
