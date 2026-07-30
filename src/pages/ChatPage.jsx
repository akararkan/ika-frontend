/* =========================================================
   Chat page — /chat · /chat/requests · /chat/:id
   ---------------------------------------------------------
   The shell that orchestrates the two panes. It owns nothing
   about messages: `useThread` is instantiated ONCE here and the
   same object is handed to both the timeline and the composer,
   so an optimistic send appears in the thread without a second
   copy of the state.

   Desktop is list + thread side by side; ≤900px shows exactly
   one pane (the thread when a :id is present). The root carries
   `ch-thread-open` on mobile so the stylesheet can retire the
   fixed .botnav and give the composer the bottom edge.
   ========================================================= */
import React from 'react'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import { Icon, showToast } from '../components/ui.jsx'
import { Loader, ErrorState } from '../components/states.jsx'
import { uiConfirm } from '../components/Dialog.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { useChat } from '../context/ChatContext.jsx'
import { useThread } from '../components/chat/useThread.js'
import { ConversationList } from '../components/chat/ConversationList.jsx'
import NewFollowers from '../components/chat/NewFollowers.jsx'
import { ConversationHeader } from '../components/chat/ConversationHeader.jsx'
import { MessageList } from '../components/chat/MessageList.jsx'
import { Composer } from '../components/chat/Composer.jsx'
import { ConversationInfo } from '../components/chat/ConversationInfo.jsx'
import { NewChatModal } from '../components/chat/NewChatModal.jsx'
import { ChatSearchPanel } from '../components/chat/ChatSearchPanel.jsx'
import { RequestsPanel } from '../components/chat/RequestsPanel.jsx'
import { StarredPanel } from '../components/chat/StarredPanel.jsx'
import { ScheduledPanel } from '../components/chat/ScheduledPanel.jsx'
import { ChatPrefsPanel } from '../components/chat/ChatPrefsPanel.jsx'
import { SeenBySheet } from '../components/chat/SeenBySheet.jsx'
import { CommentsPanel, TagPanel } from '../components/chat/ChannelPanels.jsx'
import { useServerDraft } from '../components/chat/useServerDraft.js'
import { PostComposer } from '../components/chat/PostComposer.jsx'
import { VideoPlayer } from '../components/chat/VideoPlayer.jsx'
import { deleteIntentOf, sendBlockReason, canSendIn } from '../components/chat/conversationActions.js'
import { typingSentence, dominantActivity } from '../components/chat/activity.js'
import { useConversationCalls } from '../components/chat/callLog.js'
import { useCall } from '../context/CallContext.jsx'
import { api } from '../api/index.js'
import { maxId } from '../api/ids.js'
import { chatError } from '../components/chat/chatErrors.js'

const LIST_TABS = [['inbox', 'Inbox'], ['requests', 'Requests'], ['archived', 'Archived']]

/* The chat shell can host exactly ONE end-edge panel at a time: on desktop
   they all occupy the same third column, and on mobile they are all
   full-bleed sheets. Modelling that as one state instead of five booleans is
   what makes the exclusivity structural rather than something every toggle
   has to remember to enforce. */
const PANELS = { INFO: 'info', SEARCH: 'search', STARRED: 'starred', SCHEDULED: 'scheduled', PREFS: 'prefs' }

/** "last seen 3h ago" from a presence record, or null while online/unknown. */
function lastSeenLabel(p) {
  if (!p || p.status === 'online') return null
  const ms = p.lastSeenEpochMs
  if (!ms) return 'offline'
  const mins = Math.floor((Date.now() - ms) / 60000)
  if (mins < 1) return 'last seen just now'
  if (mins < 60) return `last seen ${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `last seen ${hrs}h ago`
  return `last seen ${Math.floor(hrs / 24)}d ago`
}

/* Full-screen viewer for a message's images/videos. Local to the page because
   the thread is the only place chat media is opened from, and it must sit
   above every pane (info panel, search slide-over) rather than inside one. */
function MediaLightbox({ items, index, onClose }) {
  const [i, setI] = React.useState(index || 0)
  const many = items.length > 1
  const boxRef = React.useRef(null)

  React.useEffect(() => {
    // Remember what had focus so it can be restored on close — otherwise
    // dismissing the viewer drops the caret back to <body> and a keyboard
    // user loses their place in the thread.
    const opener = document.activeElement
    const onKey = (e) => {
      if (e.key === 'Escape') { onClose(); return }
      /* This listener is on `window` with capture, so it runs BEFORE the
         focused element's own handler and `stopPropagation` down there cannot
         reach it. The video player owns the arrow keys (seek, volume) while
         the focus is inside it, so the slide navigation stands down —
         otherwise nudging the playhead skips to the next photo. */
      const inPlayer = e.target instanceof Element && e.target.closest('.vp')
      if (many && !inPlayer && e.key === 'ArrowRight') setI(v => (v + 1) % items.length)
      if (many && !inPlayer && e.key === 'ArrowLeft') setI(v => (v - 1 + items.length) % items.length)
      if (e.key !== 'Tab') return
      // Trap Tab inside the viewer.
      const nodes = boxRef.current?.querySelectorAll('button,[href]')
      if (!nodes?.length) return
      const list = [...nodes].filter(n => !n.disabled && n.offsetParent !== null)
      if (!list.length) return
      const first = list[0]
      const last = list[list.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey, true)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    boxRef.current?.querySelector('button')?.focus()
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = prev
      if (opener instanceof HTMLElement) opener.focus()
    }
  }, [items.length, many, onClose])

  const m = items[i]
  if (!m) return null

  return (
    <div className="ch-lightbox" role="dialog" aria-modal="true" aria-label="Media viewer"
      ref={boxRef}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <a className="ch-lightbox-dl" href={m.url || undefined} target="_blank" rel="noopener noreferrer"
        download={m.fileName || undefined} onClick={(e) => e.stopPropagation()}>
        <Icon name="download" className="sm"/>Download
      </a>
      <button className="ch-lightbox-x" onClick={onClose} aria-label="Close viewer" title="Close">
        <Icon name="close"/>
      </button>
      {m.kind === 'VIDEO'
        /* The project's own player, not `controls`: the native bar cannot be
           themed, swallows Space and the arrow keys this dialog needs for
           Escape/next/previous, and on iOS it throws playback out to the
           system player — out of the viewer and out of the conversation.
           Keyed on the item so switching slides resets transport state
           instead of carrying the previous clip's position into the next. */
        ? <VideoPlayer key={m.storageKey || m.url || i} className="vp-lightbox"
            src={m.url || undefined} poster={m.thumbnailUrl || undefined}
            fileName={m.fileName || m.altText || ''} autoPlay/>
        : <img src={m.url || m.thumbnailUrl || undefined} alt={m.altText || ''}/>}
      {many && (
        <>
          <button className="ch-lightbox-nav prev" aria-label="Previous"
            onClick={(e) => { e.stopPropagation(); setI(v => (v - 1 + items.length) % items.length) }}>
            <Icon name="chevleft"/>
          </button>
          <button className="ch-lightbox-nav next" aria-label="Next"
            onClick={(e) => { e.stopPropagation(); setI(v => (v + 1) % items.length) }}>
            <Icon name="chevright"/>
          </button>
          <div className="ch-lightbox-n">{i + 1} / {items.length}</div>
        </>
      )}
    </div>
  )
}

/* Forward target picker — a small sheet listing the conversations you can post
   into. Kept local to the page because it is the only place a forward starts. */
function ForwardPicker({ msg, onClose, onPick }) {
  const { conversations } = useChat()
  const [q, setQ] = React.useState('')
  const boxRef = React.useRef(null)

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const needle = q.trim().toLowerCase()
  /* Forward re-evaluates FULL send permission against the target, so filtering
     on "am I a member?" alone offered broadcast channels and admins-only groups
     that bounce with 403 after the user has already picked one. Same predicate
     as the composer, from one place. */
  const rows = conversations.filter(c => (
    canSendIn(c)
    && (!needle || (c.displayTitle || '').toLowerCase().includes(needle))
  ))

  return (
    <div className="ch-fwd-overlay" role="dialog" aria-modal="true" aria-label="Forward message"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="ch-fwd" ref={boxRef}>
        <div className="ch-fwd-head">
          <h3>Forward to…</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close">
            <Icon name="close" className="sm"/>
          </button>
        </div>
        {msg?.body && <p className="ch-fwd-snip" dir="auto">{msg.body.slice(0, 140)}</p>}
        <input className="field ch-fwd-q" value={q} autoFocus
          onChange={e => setQ(e.target.value)} placeholder="Search conversations…"/>
        <div className="ch-fwd-list">
          {rows.length === 0 && <p className="ch-fwd-empty">No conversations to forward to.</p>}
          {rows.map(c => (
            <button key={c.id} className="ch-fwd-row" onClick={() => onPick(c.id)}>
              <span className="ch-fwd-nm" dir="auto">{c.displayTitle}</span>
              {c.isGroup && <span className="pill">Group</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export function ChatPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { id } = useParams()
  const { user } = useAuth()
  const myId = user?.id || null
  const {
    getConvo, setActiveConversation, typingIn, presenceOf, watchPresence, upsertConvo, patchConvo, subscribe,
    sendTyping, conversations, archived, loading, requestCount, loadArchived,
    removeConvo, deleteConvo, userOf, watchUsers, chatSettings, connected,
    inboxHasMore, archivedHasMore, inboxLoadingMore, loadMoreInbox, loadMoreArchived,
  } = useChat()
  const { startCall, inCall } = useCall()
  const [query, setQuery] = React.useState('')

  const isRequests = location.pathname.endsWith('/requests')
  const [listView, setListView] = React.useState('inbox')          // 'inbox' | 'archived'
  const view = isRequests ? 'requests' : listView

  const [replyTo, setReplyTo] = React.useState(null)
  const [editing, setEditing] = React.useState(null)
  const [panel, setPanel] = React.useState(null)             // one of PANELS, or null
  const [newChatOpen, setNewChatOpen] = React.useState(false)
  const [pendingJump, setPendingJump] = React.useState(null)
  const [forwarding, setForwarding] = React.useState(null)   // message awaiting a target
  const [seenFor, setSeenFor] = React.useState(null)         // message whose readers we're showing
  const [viewer, setViewer] = React.useState(null)           // { items, index } for the lightbox
  const [addingPeople, setAddingPeople] = React.useState(false)
  const [pinBarOpen, setPinBarOpen] = React.useState(true)
  /* Channel-only sheets. They are NOT part of `panel`: both are opened from a
     post rather than from the header rail, and either may sit over an already
     open panel without evicting it. */
  const [commentsFor, setCommentsFor] = React.useState(null)  // post whose comments are open
  const [tagQuery, setTagQuery] = React.useState(null)        // hashtag being looked up
  const [extrasOpen, setExtrasOpen] = React.useState(false)   // poll / location / contact composer

  const infoOpen = panel === PANELS.INFO

  // Deep links land before the inbox has loaded, so fall back to a direct fetch.
  const known = getConvo(id)
  const [fetched, setFetched] = React.useState(null)
  const [loadErr, setLoadErr] = React.useState(null)
  const convo = known || (fetched && fetched.id === id ? fetched : null)

  /* Read inside the resolve handler, so a row that arrived (or a receipt that
     landed) while the request was in flight is what we merge against. */
  const knownRef = React.useRef(false)
  const convoRef = React.useRef(null)
  React.useEffect(() => { knownRef.current = !!known; convoRef.current = convo })

  /* ONE authoritative GET per opened conversation, for two reasons:
     (1) a deep link lands before the inbox has loaded, so the row may not
         exist here at all;
     (2) even when it does, the conversation LIST response omits
         `peerLastReadMessageId` / `peerLastDeliveredMessageId` — only
         GET /conversations/{id} carries them. Without this the receipt
         ladder opened with no seed and every one of my bubbles showed a lone
         "Sent" tick until the peer happened to emit a fresh receipt.
     A known row is PATCHED with just those two marks (through maxId, so a
     slower response can't regress a live receipt) and never replaced: the
     DTO's `unreadCount` would resurrect a badge the read marker has already
     cleared. `hydratedRef` keeps it to one fetch per conversation. */
  const hydratedRef = React.useRef(null)
  React.useEffect(() => {
    if (!id) { setLoadErr(null); return undefined }
    if (hydratedRef.current === id) return undefined
    hydratedRef.current = id
    let alive = true
    setLoadErr(null)
    api.chat.conversations.get(id)
      .then(c => {
        if (!alive || !c) return
        setFetched(c)
        if (!knownRef.current) { upsertConvo(c); return }
        const cur = convoRef.current
        patchConvo(id, {
          peerLastReadMessageId: maxId(cur?.peerLastReadMessageId, c.peerLastReadMessageId),
          peerLastDeliveredMessageId: maxId(cur?.peerLastDeliveredMessageId, c.peerLastDeliveredMessageId),
        })
      })
      // A failure with the row already in hand is not fatal — we can render it.
      .catch(e => { if (alive && !knownRef.current) { hydratedRef.current = null; setLoadErr(e) } })
    return () => { alive = false }
  }, [id, upsertConvo, patchConvo])

  // Tell the badge model which thread is open so it never self-counts.
  React.useEffect(() => {
    setActiveConversation(id || null)
    return () => setActiveConversation(null)
  }, [id, setActiveConversation])

  // Reply/edit drafts belong to one conversation — drop them when it changes.
  React.useEffect(() => {
    setReplyTo(null); setEditing(null); setPanel(null)
    setViewer(null); setAddingPeople(false); setPinBarOpen(true); setSeenFor(null)
  }, [id])

  // One thread store, shared by the timeline and the composer.
  const thread = useThread(id || null)

  const peerId = convo?.peer?.id || null
  React.useEffect(() => { if (peerId) watchPresence([peerId]) }, [peerId, watchPresence])

  /* Live typers: [{ userId, activity }] — activity distinguishes typing from
     recording a voice note or sending files, exactly like Telegram/WhatsApp.
     Group typers get their real first name (and avatar, for the in-thread
     indicator) from the user directory. Deliberately NOT memoised: `userOf`
     is a sync ref read that resolves a beat after `watchUsers`, and a memo
     keyed on stable inputs would keep serving "Someone" after the name lands. */
  const typers = typingIn(id || '')
  const isGroupConvo = !!convo?.isGroup
  React.useEffect(() => {
    if (isGroupConvo && typers.length) watchUsers(typers.map(t => t.userId))
  }, [isGroupConvo, typers, watchUsers])
  const typerViews = typers.map(t => {
    const card = userOf(t.userId)
    return {
      ...t,
      name: isGroupConvo
        ? (card?.full?.split(' ')[0] || card?.handle || null)
        : (convo?.peer?.full?.split(' ')[0] || null),
      avatar: card?.profileImage || null,
      initials: card?.initials || null,
      avc: card?.avc || null,
    }
  })
  const typingLabel = typingSentence(typerViews, {
    isGroup: isGroupConvo, names: typerViews.map(t => t.name),
  })
  const typingActivity = typers.length ? dominantActivity(typers) : null

  const presenceLabel = React.useMemo(() => {
    if (!convo || convo.isGroup) return convo?.isGroup ? `${convo.memberCount || 0} members` : null
    const p = presenceOf(peerId)
    return p?.status === 'online' ? 'online' : lastSeenLabel(p)
  }, [convo, peerId, presenceOf])

  /* Receipt high-water marks for the OTHER party, so my own bubbles can show a
     delivered / read tick. Events carry no counts — we just keep the max id. */
  const [peerDelivered, setPeerDelivered] = React.useState(null)
  const [peerRead, setPeerRead] = React.useState(null)
  React.useEffect(() => { setPeerDelivered(null); setPeerRead(null) }, [id])

  /* SEED from the conversation DTO. Without this the marks start at 0 and
     re-opening a thread showed a single "Sent" tick on your whole history
     until the peer happened to emit a fresh receipt — the ladder had the
     right shape and no starting point. `peerLastRead/DeliveredMessageId` are
     DIRECT-only and come back `null` when either side has read receipts off,
     which stays `null` here — "nothing known", exactly the honest answer.
     Still a MAX, never assignment: a slow DTO must not regress a live receipt
     that already landed. `maxId`, not `Math.max`: these are Snowflake strings
     (api/ids.js), and Math.max would coerce them to lossy doubles. */
  const peerReadSeed = convo?.peerLastReadMessageId || null
  const peerDeliveredSeed = convo?.peerLastDeliveredMessageId || null
  React.useEffect(() => {
    if (peerReadSeed) setPeerRead(v => maxId(v, peerReadSeed))
    if (peerDeliveredSeed) setPeerDelivered(v => maxId(v, peerDeliveredSeed))
  }, [peerReadSeed, peerDeliveredSeed])

  React.useEffect(() => subscribe((evt) => {
    if (!id || evt.conversationId !== id) return
    if (String(evt.userId) === String(myId)) return          // my own receipts prove nothing
    if (evt.type === 'receipt.delivered') setPeerDelivered(v => maxId(v, evt.messageId || null))
    if (evt.type === 'receipt.read') setPeerRead(v => maxId(v, evt.lastReadMessageId || null))
  }), [subscribe, id, myId])

  /* My own switch is knowable; the peer's is not (their "off" is
     indistinguishable from "no messages yet" on the wire), so the tick copy
     only softens on the half we can state truthfully. */
  const receiptsOff = chatSettings?.readReceiptsEnabled === false

  /* "Drop the conversation from the inbox AND tear down its view" — the
     context does the first half; this is the second. Without it, losing access
     to the thread you are reading (the owner deleted the group, or you were
     removed) leaves you staring at a live-looking transcript you can no longer
     post to. Worse, the context's `removeConvo` makes `getConvo(id)` miss, so
     ChatPage's deep-link effect immediately re-fetches — and only the 404
     stops it, via an error pane that says nothing about what happened. */
  React.useEffect(() => subscribe((evt) => {
    if (!id || String(evt.conversationId) !== String(id)) return
    const gone = (evt.type === 'conversation.updated' && evt.memberChange === 'DELETED')
      || (evt.type === 'member.changed'
          && String(evt.userId) === String(myId)
          && (evt.memberChange === 'REMOVED' || evt.memberChange === 'LEFT'))
    if (!gone) return
    showToast(evt.type === 'conversation.updated'
      ? 'This conversation was deleted'
      : 'You are no longer a member of this conversation')
    navigate('/chat', { replace: true })
  }), [subscribe, id, myId, navigate])

  // The unread rule is pinned to the marker as it was when the thread opened —
  // a live-moving rule would slide down the screen as receipts land.
  const [unreadFrom, setUnreadFrom] = React.useState(null)
  const unreadPinnedFor = React.useRef(null)
  React.useEffect(() => {
    if (!convo || unreadPinnedFor.current === convo.id) return
    unreadPinnedFor.current = convo.id
    /* '0' — a STRING sentinel — for "unread and never read anything here", so
       the rule still renders above the very first message. The old numeric 0
       was falsy, and MessageList's `unreadFrom &&` guard silently dropped the
       rule in exactly that case. */
    setUnreadFrom(convo.unreadCount > 0 ? (convo.lastReadMessageId || '0') : null)
  }, [convo])

  // Composer draft lives here so it survives the info/search panels toggling.
  const [draft, setDraft] = React.useState('')
  React.useEffect(() => { setDraft('') }, [id])
  React.useEffect(() => { if (editing) setDraft(editing.body || '') }, [editing])

  /* …and it is mirrored to the server, so a half-written message follows the
     account across devices. Disabled while EDITING: the box then holds an
     existing message's text, and saving that as a draft would resurrect it
     as a new message the next time this thread is opened. */
  const draftSent = useServerDraft(convo?.id, {
    value: draft,
    enabled: !editing,
    onRestore: setDraft,
  })

  /* Why you can't post, in the backend's own precedence order. `null` = you can. */
  /* Why you can't post, in the backend's own precedence order. `null` = you
     can. Shared with the forward picker so the two can never disagree. */
  const lockedReason = React.useMemo(() => sendBlockReason(convo), [convo])

  /* Channel policy, fetched once per channel. The INBOX row
     (`ConversationResponse`) does not carry `ChannelSettings` — only
     `GET /channels/{id}` does — so reactions/protected-content gating would
     silently default to "allowed" if it were read off `convo`. Fetching it is
     what makes the suppression honest rather than decorative. */
  const [channelPolicy, setChannelPolicy] = React.useState(null)
  React.useEffect(() => {
    if (!convo?.isChannel) { setChannelPolicy(null); return undefined }
    let alive = true
    api.channels.get(convo.id)
      .then(ch => { if (alive) setChannelPolicy(ch?.settings || null) })
      .catch(() => { /* leave everything permitted; the server still refuses */ })
    return () => { alive = false }
  }, [convo?.isChannel, convo?.id])

  const isStaff = convo?.myRole === 'OWNER' || convo?.myRole === 'ADMIN'
  const canModerate = !!convo?.isGroup && isStaff
  const canPin = !convo?.isGroup || isStaff || convo?.settings?.whoCanPin === 'ALL_MEMBERS'
  const pinnedIds = React.useMemo(
    () => new Set((thread.pinned || []).map(m => m.id)),
    [thread.pinned],
  )

  React.useEffect(() => {
    if (!convo) return
    const prev = document.title
    document.title = `${convo.displayTitle || 'Chat'} · IKA`
    return () => { document.title = prev }
  }, [convo])

  const onSelect = React.useCallback((cid) => navigate(`/chat/${cid}`), [navigate])
  const onBack = React.useCallback(() => navigate('/chat'), [navigate])

  /* A tapped new-follower row opens the DM directly — createDirect is
     get-or-create on the backend, so an existing thread is reused. */
  const openDmWithFollower = React.useCallback(async (user) => {
    if (!user?.id) return
    try {
      const convo = await api.chat.conversations.createDirect(user.id)
      if (convo?.id) navigate(`/chat/${convo.id}`)
    } catch {
      showToast('Could not open a chat with @' + (user.handle || 'them'))
    }
  }, [navigate])

  /* Pop the messenger out into its own tab/window. Sized rather than a bare
     tab so it lands as a usable side-by-side pane; a blocked popup falls back
     to a normal tab rather than doing nothing. */
  const openInNewTab = React.useCallback(() => {
    const url = `${window.location.origin}/chat${id ? `/${id}` : ''}`
    const win = window.open(url, 'ika-messages', 'noopener,noreferrer,width=1100,height=820')
    if (!win) window.open(url, '_blank', 'noopener,noreferrer')
  }, [id])

  const onViewChange = React.useCallback((v) => {
    if (v === 'requests') { navigate('/chat/requests'); return }
    setListView(v)
    if (v === 'archived') loadArchived()
    if (isRequests) navigate('/chat')
  }, [navigate, isRequests, loadArchived])

  /* Jumping to a message that is older than the loaded window has to PAGE
     HISTORY IN first — setting a flash id alone would highlight a row that
     isn't mounted. `thread.jumpTo` walks the cursor back until the id lands
     (bounded), then the flash effect scrolls to it. A jump into a different
     conversation routes first and defers the id to the freshly-mounted
     thread via `deferredJump`, because this page's `thread` still points at
     the old conversation for one more render. */
  const [deferredJump, setDeferredJump] = React.useState(null)

  const onJump = React.useCallback((messageId, conversationId) => {
    // Any panel that can produce a jump (search, starred, pinned) has done its
    // job the moment one is taken — close whatever is open so the reader lands
    // on the message, not behind a slide-over.
    setPanel(null)
    if (!messageId) return
    if (conversationId && conversationId !== id) {
      setDeferredJump({ conversationId, messageId })
      navigate(`/chat/${conversationId}`)
      return
    }
    setPendingJump(null)                       // re-jumping to the same id must re-flash
    thread.jumpTo(messageId)
      .then(found => {
        if (found !== false) { setPendingJump(messageId); return }
        // The read path now floors every read at the caller's clear point AND
        // the hidden-history join point, so a VISIBLE message can legitimately
        // quote a target the server will never serve us. jumpTo walks back to
        // the start of history and comes back empty — say so instead of
        // leaving a dead click.
        showToast('That message isn’t available to you.')
      })
      .catch(() => setPendingJump(messageId))
  }, [id, navigate, thread])

  /* Which conversation the thread store has actually FINISHED loading.
     `thread.loading` alone is not enough: on the first render after
     navigate() it still holds the previous conversation's settled `false`,
     so the consume effect below fired against the old store — jumpTo saw a
     reset cursor, returned false, and the jump was dropped with no retry.
     This ref only turns to the new id once its load has really completed. */
  const loadedForRef = React.useRef(null)
  React.useEffect(() => {
    if (!thread.loading) loadedForRef.current = id
  }, [thread.loading, id])

  // The routed-to conversation has mounted AND loaded its own thread — consume.
  React.useEffect(() => {
    if (!deferredJump || deferredJump.conversationId !== id) return
    if (thread.loading || loadedForRef.current !== id) return
    const { messageId } = deferredJump
    thread.jumpTo(messageId)
      .then(found => {
        if (found !== false) setPendingJump(messageId)
        else showToast('That message isn’t available to you.')
      })
      .catch(() => setPendingJump(messageId))
      // Cleared only AFTER the attempt, so a jump can never be swallowed by a
      // render that happened to run before the thread was ready.
      .finally(() => setDeferredJump(null))
  }, [deferredJump, id, thread])

  const onCreated = React.useCallback((c) => {
    setNewChatOpen(false)
    if (c?.id) navigate(`/chat/${c.id}`)
  }, [navigate])

  /* Leave a group / delete a DM from the info panel. The header owns its own
     copy of this for its overflow menu; both confirm before acting because
     neither is reversible from the client. */
  /* The info panel's danger action. A NON-owner in a group leaves; everyone
     else hits DELETE, whose meaning depends on the role — see
     conversationActions.deleteIntentOf. */
  const onLeaveOrDelete = React.useCallback(async () => {
    if (!convo) return
    const leaving = convo.isGroup && convo.myRole !== 'OWNER'
    const intent = deleteIntentOf(convo)
    const ok = await uiConfirm({
      title: leaving ? 'Leave group' : intent.title,
      message: leaving
        ? `Leave “${convo.displayTitle}”? You will stop receiving its messages.`
        : intent.message,
      danger: true,
      confirmLabel: leaving ? 'Leave' : intent.confirmLabel,
    })
    if (!ok) return
    try {
      if (leaving) {
        await api.chat.members.leave(convo.id)
        removeConvo(convo.id)            // the member.changed frame may lag — drop it now
        showToast('You left the group')
      } else {
        await deleteConvo(convo.id)      // the context rolls itself back and toasts on failure
        showToast(intent.destroysForEveryone ? 'Group deleted' : 'Conversation cleared')
      }
      setPanel(null)
      navigate('/chat')
    } catch (e) {
      showToast(chatError(e, leaving ? 'Could not leave the group' : 'Could not delete'))
    }
  }, [convo, removeConvo, deleteConvo, navigate])

  /* Every slide-over overlays the END edge of the shell — exactly where the
     info column sits on desktop — so they are mutually exclusive by
     construction: one `panel` value, toggled. Re-clicking the open one
     closes it. */
  const togglePanel = React.useCallback((next) => {
    setPanel(p => (p === next ? null : next))
  }, [])
  const toggleInfo = React.useCallback(() => togglePanel(PANELS.INFO), [togglePanel])
  const toggleSearch = React.useCallback(() => togglePanel(PANELS.SEARCH), [togglePanel])
  const toggleStarred = React.useCallback(() => togglePanel(PANELS.STARRED), [togglePanel])
  const toggleScheduled = React.useCallback(() => togglePanel(PANELS.SCHEDULED), [togglePanel])
  const togglePrefs = React.useCallback(() => togglePanel(PANELS.PREFS), [togglePanel])

  /* "Delete for everyone" is irreversible for the whole room, so it confirms;
     "delete for me" only hides a row on this account and is undone by nothing
     more dramatic than scrolling, so it does not. Same verb on the wire, two
     very different blast radii — see conversationActions for the conversation
     -level twin of this distinction. */
  const onDeleteMessage = React.useCallback(async (m, scope = 'everyone') => {
    const mid = m?.id ?? m
    if (scope === 'me') { thread.deleteMessage(mid, 'me'); return }
    const ok = await uiConfirm({
      title: 'Delete for everyone?',
      message: 'This removes the message for every member of the conversation. A “message deleted” note stays in its place.',
      danger: true,
      confirmLabel: 'Delete for everyone',
    })
    if (ok) thread.deleteMessage(mid, 'everyone')
  }, [thread])

  /* Queue a send-later message. The composer keeps its draft until the row is
     accepted, so a rejected schedule (a past time, a lost connection) never
     eats what you typed. */
  const onSchedule = React.useCallback(async ({ body, scheduledAt }) => {
    if (!body?.trim() || !scheduledAt) return
    try {
      await thread.scheduleMessage({ body, scheduledAt, replyToId: replyTo?.id ?? null })
      setReplyTo(null); setDraft('')
      showToast('Message scheduled')
    } catch { /* the thread store toasts the reason */ }
  }, [thread, replyTo])

  /* ----- live connection state -----
     The thread looks identical whether the socket is alive or dead: messages
     you send while offline queue as optimistic bubbles and receipts simply
     stop arriving, which reads as "nobody is answering me" rather than "you
     are not connected". Three states, and each one is a different sentence:

       offline      the device has no network at all (navigator.onLine)
       reconnecting the socket dropped and ChatContext is healing it
       restored     it came back — shown briefly, then it gets out of the way

     The banner is deliberately delayed: `connected` flickers false for a beat
     on the initial dial and during a token refresh, and a bar that strobes on
     every routine reconnect trains people to ignore it. */
  const [online, setOnline] = React.useState(() => navigator.onLine !== false)
  React.useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down) }
  }, [])

  const [netState, setNetState] = React.useState(null)   // null | 'offline' | 'reconnecting' | 'restored'
  const wasDownRef = React.useRef(false)
  React.useEffect(() => {
    if (!online) { wasDownRef.current = true; setNetState('offline'); return undefined }
    if (!connected) {
      const t = setTimeout(() => { wasDownRef.current = true; setNetState('reconnecting') }, 1200)
      return () => clearTimeout(t)
    }
    if (!wasDownRef.current) { setNetState(null); return undefined }
    // Back up: say so once, then disappear.
    wasDownRef.current = false
    setNetState('restored')
    const t = setTimeout(() => setNetState(null), 2400)
    return () => clearTimeout(t)
  }, [online, connected])

  const netBanner = netState && {
    offline: { icon: 'wifioff', text: 'You are offline — messages will send when you reconnect.', cls: 'off' },
    reconnecting: { icon: 'refresh', text: 'Reconnecting…', cls: 'wait' },
    restored: { icon: 'check', text: 'Back online', cls: 'ok' },
  }[netState]

  /* The call log for this thread, merged into the timeline by MessageList.
     Local to this device — see callLog.js for why that is the only place the
     history can live today. */
  const callEvents = useConversationCalls(id || null)
  const onCallBack = React.useCallback((video) => {
    if (!convo?.id) return
    if (inCall) { showToast('You are already in a call'); return }
    startCall(convo.id, video ? 'VIDEO' : 'VOICE')
  }, [convo, inCall, startCall])

  const threadOpen = !!id && !isRequests

  /* The bottom nav is fixed OUTSIDE <main>, so no selector rooted at this
     page can reach it. The stylesheet uses `body:has(.ch-thread-open)`, and
     this body class is the fallback for engines without :has() — without one
     of the two the nav sits on top of the composer. */
  React.useEffect(() => {
    document.body.classList.toggle('chat-thread-open', threadOpen)
    return () => document.body.classList.remove('chat-thread-open')
  }, [threadOpen])
  const rootCls = 'main wide ch-main'
    + (threadOpen ? ' ch-thread-open' : '')
    + (infoOpen ? ' ch-info-open' : '')

  return (
    <div className={rootCls}>
      <aside className="ch-pane ch-pane-list">
        <header className="ch-list-head">
          <div className="ch-list-title">
            <h1>Mes<em>sages</em></h1>
            <div className="ch-list-tools">
              <button className="icon-btn" onClick={toggleStarred}
                aria-label="Starred messages" title="Starred messages"
                aria-pressed={panel === PANELS.STARRED}>
                <Icon name="star"/>
              </button>
              <button className="icon-btn" onClick={() => navigate('/channels')}
                aria-label="Browse channels" title="Channels">
                <Icon name="broadcast"/>
              </button>
              <button className="icon-btn" onClick={togglePrefs}
                aria-label="Chat privacy" title="Chat privacy"
                aria-pressed={panel === PANELS.PREFS}>
                <Icon name="lock"/>
              </button>
              {/* Messages as a standalone window. `noopener` is not optional:
                  without it the popup keeps a live `window.opener` handle back
                  into this document. */}
              <button className="icon-btn ch-popout" onClick={openInNewTab}
                aria-label="Open messages in a new tab" title="Open in a new tab">
                <Icon name="external"/>
              </button>
              <button className="icon-btn tint" onClick={() => setNewChatOpen(true)}
                aria-label="New message" title="New message">
                <Icon name="compose"/>
              </button>
            </div>
          </div>
          <div className="ch-list-search">
            <Icon name="search" className="sm"/>
            <input className="field" value={query} onChange={e => setQuery(e.target.value)}
              placeholder="Search conversations…" aria-label="Search conversations"/>
          </div>
          <div className="tabs ch-list-tabs" role="tablist">
            {LIST_TABS.map(([key, label]) => (
              <button key={key} role="tab" aria-selected={view === key}
                className={'tab' + (view === key ? ' on' : '')}
                onClick={() => onViewChange(key)}>
                {label}
                {key === 'requests' && requestCount > 0 && <span className="badge">{requestCount}</span>}
              </button>
            ))}
          </div>
        </header>

        {/* New followers ride above the inbox only — a follow is an invitation
            to talk, so the rail answers it with a one-tap DM. */}
        {view === 'inbox' && <NewFollowers onMessage={openDmWithFollower}/>}

        {view === 'requests' ? (
          <RequestsPanel onOpen={(c) => {
            const cid = typeof c === 'string' ? c : c?.id ?? c?.conversationId
            if (cid) navigate(`/chat/${cid}`)
          }}/>
        ) : (
          <ConversationList
            conversations={view === 'archived' ? archived : conversations}
            loading={loading}
            activeId={id || null}
            query={query}
            onOpen={onSelect}
            hasMore={view === 'archived' ? archivedHasMore : inboxHasMore}
            loadingMore={inboxLoadingMore}
            onLoadMore={view === 'archived' ? loadMoreArchived : loadMoreInbox}
            emptyHint={view === 'archived'
              ? 'Nothing archived yet.'
              : 'No conversations yet — start one with the pencil above.'}
          />
        )}
      </aside>

      <section className="ch-pane ch-pane-thread">
        {!threadOpen ? (
          <div className="ch-blank">
            <div className="ch-blank-mark"><Icon name="chat" className="lg"/></div>
            <h2 className="ch-blank-title">Your <em>conversations</em></h2>
            <p className="ch-blank-sub">Pick a conversation to read it, or start a new one.</p>
            <button className="btn btn-primary" onClick={() => setNewChatOpen(true)}>
              <Icon name="compose" className="xs"/>New message
            </button>
          </div>
        ) : loadErr ? (
          <ErrorState
            message={loadErr?.code === 'NOT_A_MEMBER'
              ? 'You are not a member of this conversation.'
              : 'This conversation could not be opened.'}
            onRetry={onBack}
          />
        ) : !convo ? (
          <Loader label="Opening conversation…"/>
        ) : (
          <>
            <ConversationHeader
              convo={convo}
              onBack={onBack}
              onToggleInfo={toggleInfo}
              onToggleSearch={toggleSearch}
              onToggleStarred={toggleStarred}
              onToggleScheduled={toggleScheduled}
              onTogglePrefs={togglePrefs}
              typingLabel={typingLabel}
              typingActivity={typingActivity}
              presenceLabel={presenceLabel}
              infoOpen={infoOpen}
            />
            {/* Connection state, between the identity bar and the transcript —
                the one place a reader is already looking when a thread stops
                behaving. `role="status"` so it is announced once, not on
                every re-render. */}
            {netBanner && (
              <div className={'ch-netbar ' + netBanner.cls} role="status">
                <Icon name={netBanner.icon} className="sm"/>
                <span>{netBanner.text}</span>
              </div>
            )}
            {/* Two SIBLING buttons, not a button nested in a div[role=button]:
                the ARIA button role has presentational children, so a nested
                control is pruned from the accessibility tree entirely. */}
            {!!thread.pinned?.length && pinBarOpen && (
              <div className="ch-pinbar">
                <button
                  type="button"
                  className="ch-pinbar-main"
                  onClick={() => onJump(thread.pinned[0].id, convo.id)}
                >
                  <Icon name="pin" className="pin-ico"/>
                  <span className="ch-pinbar-body">
                    <span className="ch-pinbar-label">Pinned</span>
                    <span className="ch-pinbar-text" dir="auto">
                      {thread.pinned[0].body
                        || { IMAGE:'Photo', VIDEO:'Video', VOICE:'Voice message', FILE:'File' }[thread.pinned[0].media?.[0]?.kind]
                        || 'Message'}
                    </span>
                  </span>
                  {thread.pinned.length > 1 && (
                    <span className="ch-pinbar-count">+{thread.pinned.length - 1}</span>
                  )}
                </button>
                <button
                  type="button"
                  className="ch-pinbar-x"
                  onClick={() => setPinBarOpen(false)}
                  aria-label="Hide the pinned bar"
                  title="Hide"
                >
                  <Icon name="close" className="sm"/>
                </button>
              </div>
            )}
            <MessageList
              conversationId={convo.id}
              messages={thread.messages}
              loading={thread.loading}
              loadingOlder={thread.loadingOlder}
              hasMore={thread.hasMore}
              error={thread.error}
              onLoadOlder={thread.loadOlder}
              myId={myId}
              isGroup={!!convo.isGroup}
              isChannel={!!convo.isChannel}
              canModerate={canModerate}
              canPin={canPin}
              pinnedIds={pinnedIds}
              peerDelivered={peerDelivered}
              peerRead={peerRead}
              receiptsOff={receiptsOff}
              unreadFrom={unreadFrom}
              typers={typerViews}
              callEvents={callEvents}
              onCallBack={onCallBack}
              flashId={pendingJump}
              onReply={(m) => { setEditing(null); setReplyTo(m) }}
              onEdit={(m) => { setReplyTo(null); setEditing(m) }}
              onDelete={onDeleteMessage}
              onForward={(m) => setForwarding(m)}
              onPin={(m) => thread.pinMessage(m.id ?? m)}
              onUnpin={(m) => thread.unpinMessage(m.id ?? m)}
              onReact={(m, emoji) => thread.toggleReaction(m.id ?? m, emoji)}
              onStar={(m) => thread.toggleStar(m.id ?? m)}
              onSeenBy={(m) => setSeenFor(m)}
              onHydrateReactions={thread.refreshReactions}
              onRetry={(m) => thread.retry(m)}
              onJumpTo={(mid) => onJump(mid, id)}
              onOpenProfile={(uid) => uid && navigate(`/u/${uid}`)}
              onOpenMedia={(items, index) => setViewer({ items, index })}
              onPoll={thread.applyPoll}
              onTag={(tag) => setTagQuery(tag)}
              onComments={(m) => { thread.seeComments(m.id); setCommentsFor(m) }}
              reactionsOff={channelPolicy?.reactionsEnabled === false}
              allowedReactions={channelPolicy?.allowedReactions || null}
              protectedContent={!!channelPolicy?.protectedContent}
            />
            <Composer
              conversationId={convo.id}
              disabled={!!lockedReason}
              lockedReason={lockedReason}
              replyTo={replyTo}
              editing={editing}
              draft={draft}
              onDraftChange={setDraft}
              /* The promise is RETURNED, not fired and forgotten: the composer
                 awaits it to arm the slow-mode countdown, and a throttle
                 rejection has to reach it to be reconciled with the server's
                 Retry-After. */
              onSendText={({ body }) => {
                const p = thread.sendText({ body, replyToId: replyTo?.id ?? null })
                // Sending clears the server-side draft; tell the mirror so it
                // does not write the text back in behind the send.
                draftSent()
                setReplyTo(null); setDraft('')
                return p
              }}
              onSendFiles={({ files, body, durationMs, waveform }) => {
                thread.sendFiles({ files, body, durationMs, waveform, replyToId: replyTo?.id ?? null })
                draftSent()
                setReplyTo(null); setDraft('')
              }}
              onCommitEdit={(body) => {
                if (editing) thread.editMessage(editing.id, body)
                setEditing(null); setDraft('')
              }}
              onCancelReply={() => setReplyTo(null)}
              onCancelEdit={() => { setEditing(null); setDraft('') }}
              onTyping={(isTyping) => sendTyping(convo.id, isTyping)}
              onSchedule={onSchedule}
              onOpenScheduled={toggleScheduled}
              onExtras={() => setExtrasOpen(true)}
              scheduledCount={(thread.scheduled || []).length}
              disappearingSeconds={convo.disappearingSeconds || 0}
              /* Slow mode throttles NON-admins only; the owner and admins are
                 exempt server-side, so an exempt caller is given 0 and never
                 sees a countdown they are not subject to. */
              slowModeSeconds={isStaff ? 0 : (convo.slowModeSeconds || 0)}
              /* Silent posting only means something on a broadcast, where a
                 post reaches every subscriber's lock screen. In a DM or group
                 the server ignores the flag, so the control is absent rather
                 than present-and-inert. */
              allowSilent={!!convo.isChannel && !lockedReason}
            />
          </>
        )}
      </section>

      {infoOpen && convo && (
        <ConversationInfo
          convo={convo}
          myId={myId}
          pinned={thread.pinned}
          onClose={() => setPanel(null)}
          onJumpTo={(mid) => { setPanel(null); onJump(mid, convo.id) }}
          onAddMembers={() => setAddingPeople(true)}
          onOpenMedia={(items, index) => setViewer({ items, index })}
          onLeave={onLeaveOrDelete}
        />
      )}

      {panel === PANELS.SEARCH && (
        <ChatSearchPanel
          convo={convo}
          onClose={() => setPanel(null)}
          onJump={onJump}
        />
      )}

      {panel === PANELS.STARRED && (
        <StarredPanel
          onClose={() => setPanel(null)}
          onJump={(mid, cid) => { setPanel(null); onJump(mid, cid) }}
        />
      )}

      {panel === PANELS.SCHEDULED && (
        <ScheduledPanel
          rows={thread.scheduled || []}
          onClose={() => setPanel(null)}
          onCancel={(sid) => thread.cancelScheduled(sid)}
        />
      )}

      {panel === PANELS.PREFS && <ChatPrefsPanel onClose={() => setPanel(null)}/>}

      {commentsFor && convo?.isChannel && (
        <CommentsPanel
          channelId={convo.id}
          post={commentsFor}
          linkedGroupId={convo.linkedGroupId}
          onClose={() => setCommentsFor(null)}
          onCountChange={(postId, delta) => thread.bumpComments(postId, delta)}
          onOpenProfile={(uid) => { setCommentsFor(null); if (uid) navigate(`/u/${uid}`) }}
        />
      )}

      {extrasOpen && convo && (
        <PostComposer
          conversationId={convo.id}
          replyToId={replyTo?.id ?? null}
          onClose={() => setExtrasOpen(false)}
          /* The send already happened inside the modal, so the thread is
             brought level by the same `message.new` echo every other send
             uses — there is no optimistic bubble to reconcile. */
          onSent={() => { setReplyTo(null); setExtrasOpen(false) }}
        />
      )}

      {tagQuery && (
        <TagPanel
          conversationId={convo?.id}
          tag={tagQuery}
          onClose={() => setTagQuery(null)}
          onJumpTo={(mid) => { setTagQuery(null); onJump(mid, id) }}
        />
      )}

      {seenFor && (
        <SeenBySheet
          msg={seenFor}
          onClose={() => setSeenFor(null)}
          onOpenProfile={(uid) => { setSeenFor(null); if (uid) navigate(`/u/${uid}`) }}
        />
      )}

      {newChatOpen && (
        <NewChatModal onClose={() => setNewChatOpen(false)} onCreated={onCreated}/>
      )}

      {addingPeople && convo?.isGroup && (
        <NewChatModal
          mode="add"
          conversation={convo}
          onClose={() => setAddingPeople(false)}
          onCreated={() => setAddingPeople(false)}
        />
      )}

      {viewer && (
        <MediaLightbox
          items={viewer.items}
          index={viewer.index}
          onClose={() => setViewer(null)}
        />
      )}

      {forwarding && (
        <ForwardPicker
          msg={forwarding}
          onClose={() => setForwarding(null)}
          onPick={async (targetId) => {
            setForwarding(null)
            try { await thread.forwardMessage(forwarding.id, targetId) }
            catch { /* the thread store toasts its own failures */ }
          }}
        />
      )}
    </div>
  )
}

export default ChatPage
