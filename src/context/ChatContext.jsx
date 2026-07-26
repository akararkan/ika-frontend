/* =========================================================
   Chat context — owns the ONE per-user /messaging/stream socket
   for the whole app and the inbox/requests/unread state derived
   from it. Mounted ABOVE <Layout/> so the badge and every chat
   surface read one live source of truth.
   ---------------------------------------------------------
   DELTA MODEL (platform contract): SSE events carry NO counters.
   The client applies +1/-1 locally and RE-SEEDS the absolute
   unread total from GET /messaging/unread-count on mount and on
   every stream (re)connect — a delta-only badge drifts across a
   disconnect, so the reseed is the correction.
   ========================================================= */
/* eslint-disable react-refresh/only-export-components */
import React from 'react'
import { api } from '../api/index.js'
import { maxId, cmpId } from '../api/ids.js'
import { showToast } from '../components/ui.jsx'
import { useAuth } from './AuthContext.jsx'
import { chatError } from '../components/chat/chatErrors.js'

const ChatCtx = React.createContext(null)

/** Stable empty array so `typingIn`/`presenceOf` don't churn identities. */
const EMPTY = []

/** Inbox page size. The rail pages on scroll rather than capping at one page. */
const PAGE_SIZE = 30

/** Inbox order: pinned first, then newest (by lastMessageAt, id as tiebreak). */
function byRecency(a, b) {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
  const ta = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0
  const tb = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0
  if (tb !== ta) return (tb || 0) - (ta || 0)
  // Ids are Snowflake strings — subtracting them coerces to lossy doubles and
  // ties (same millisecond) would then order arbitrarily. cmpId is exact.
  return cmpId(b.lastMessageId, a.lastMessageId)
}

/* The server NEVER puts a disappearing message's text in the inbox preview or
   in a push notification — it substitutes this placeholder, deliberately, as
   part of the same guarantee that keeps the body out of Elasticsearch. The
   client derives its own preview from the `message.new` payload, so without
   this it cheerfully wrote the vanishing text back into the rail, where it
   then outlived the message it came from. Match the server's wording. */
const DISAPPEARING_PREVIEW = '👻 Disappearing message'

/** Preview text for a bumped conversation when the event lacks one.
 *  `ephemeral` = the conversation has a disappearing timer set. */
function previewOf(m, ephemeral) {
  if (!m) return ''
  if (ephemeral) return DISAPPEARING_PREVIEW
  if (m.body) return m.body
  const kind = m.media?.[0]?.kind || m.type
  return { IMAGE: 'Photo', VIDEO: 'Video', VOICE: 'Voice message', FILE: 'File' }[kind] || ''
}

export function ChatProvider({ children }) {
  const { user, signedIn } = useAuth()

  const [ready, setReady] = React.useState(false)
  const [connected, setConnected] = React.useState(false)
  const [conversations, setConversations] = React.useState([])
  const [archived, setArchivedList] = React.useState([])
  const [requests, setRequests] = React.useState([])
  const [totalUnread, setTotalUnread] = React.useState(0)
  const [requestCount, setRequestCount] = React.useState(0)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [inboxHasMore, setInboxHasMore] = React.useState(false)
  const [archivedHasMore, setArchivedHasMore] = React.useState(false)
  const [inboxLoadingMore, setInboxLoadingMore] = React.useState(false)
  /* Chat privacy switches. A user with no saved row behaves as ALL-ON, so this
     optimistic default matches the server and needs no write. It is read
     app-wide (the info panel, the receipt ticks, the "seen by" sheet) because
     both signals are SYMMETRIC — with receipts off you neither send nor see
     them, so the UI must stop promising a tick it will never get. */
  const [chatSettings, setChatSettings] = React.useState({
    readReceiptsEnabled: true, lastSeenVisible: true, typingIndicatorsEnabled: true,
  })
  // typing / presence are ref-backed (high churn) + a tick to drive re-render.
  const [, setTypingTick] = React.useState(0)
  const [, setPresenceTick] = React.useState(0)

  // ----- refs: latest values readable inside the stream handlers -----
  const convosRef = React.useRef([])
  const archivedRef = React.useRef([])
  const requestsRef = React.useRef([])
  const requestsLoadedRef = React.useRef(false)
  const inboxPageRef = React.useRef(0)
  const archivedPageRef = React.useRef(0)
  const inboxLoadingRef = React.useRef(false)
  const archivedLoadingRef = React.useRef(false)
  const myIdRef = React.useRef(null)
  const activeIdRef = React.useRef(null)
  const seenRef = React.useRef(new Set())            // recently-seen messageIds (badge dedupe)
  const subscribersRef = React.useRef(new Set())     // firehose subscribers
  const typingRef = React.useRef({})                 // { convId: { userId: { until, activity } } }
  const typingSentRef = React.useRef(new Map())      // { convId: { at, activity } } — send throttle
  /* Mirror of `chatSettings`, so the stable-identity callbacks (sendTyping)
     can consult a switch without taking it as a dependency and churning. */
  const settingsRef = React.useRef({ readReceiptsEnabled: true, lastSeenVisible: true, typingIndicatorsEnabled: true })
  const typingOutRef = React.useRef({})              // last emitted typingIn() per convId (stable identity)
  const presenceRef = React.useRef({})               // { userId: { status, lastSeenEpochMs, fetchedAt } }
  const presencePendingRef = React.useRef(new Set())
  const presenceTimerRef = React.useRef(null)
  // user directory: chat DTOs carry NO avatar, so we resolve them ourselves
  const usersRef = React.useRef(new Map())           // userId -> author card (or null while in flight)
  const usersPendingRef = React.useRef(new Set())
  const usersTimerRef = React.useRef(null)
  const [, setUsersTick] = React.useState(0)

  React.useEffect(() => { convosRef.current = conversations }, [conversations])
  React.useEffect(() => { archivedRef.current = archived }, [archived])
  React.useEffect(() => { requestsRef.current = requests }, [requests])
  React.useEffect(() => { myIdRef.current = user?.id ?? null }, [user])
  React.useEffect(() => { settingsRef.current = chatSettings }, [chatSettings])

  /* A conversation can live in EITHER list. Several call sites only searched
     the inbox, so acting on an archived thread (reading it, receiving a read
     receipt for it, deleting it) silently found nothing and skipped its badge
     bookkeeping. Every lookup goes through here. */
  const findConvo = React.useCallback(
    (id) => convosRef.current.find(x => x.id === id) || archivedRef.current.find(x => x.id === id) || null,
    [],
  )

  const bumpTyping = React.useCallback(() => setTypingTick(x => x + 1), [])
  const bumpPresence = React.useCallback(() => setPresenceTick(x => x + 1), [])
  const bumpUsers = React.useCallback(() => setUsersTick(x => x + 1), [])

  /* ---------------- inbox / requests loaders ---------------- */

  const refreshInbox = React.useCallback(async () => {
    try {
      const res = await api.chat.conversations.list({ page: 0, size: PAGE_SIZE })
      setConversations(res.items)
      inboxPageRef.current = 0
      setInboxHasMore(!!res.hasMore)
      setError(null)
      return res.items
    } catch (e) {
      setError(e?.message || 'Could not load conversations')
      return null
    }
  }, [])

  /** Next page of the inbox, appended. Dedupes by id — a conversation that
   *  was bumped to the top by a live message would otherwise arrive twice. */
  const loadMoreInbox = React.useCallback(async () => {
    if (inboxLoadingRef.current || !inboxHasMore) return
    inboxLoadingRef.current = true
    setInboxLoadingMore(true)
    try {
      const next = inboxPageRef.current + 1
      const res = await api.chat.conversations.list({ page: next, size: PAGE_SIZE })
      inboxPageRef.current = next
      setInboxHasMore(!!res.hasMore)
      setConversations(prev => {
        const seen = new Set(prev.map(c => c.id))
        return [...prev, ...res.items.filter(c => !seen.has(c.id))].sort(byRecency)
      })
    } catch (e) {
      showToast(chatError(e, 'Could not load more conversations'))
    } finally {
      inboxLoadingRef.current = false
      setInboxLoadingMore(false)
    }
  }, [inboxHasMore])

  const loadArchived = React.useCallback(async () => {
    try {
      const res = await api.chat.conversations.archived({ page: 0, size: PAGE_SIZE })
      setArchivedList(res.items)
      archivedPageRef.current = 0
      setArchivedHasMore(!!res.hasMore)
      return res.items
    } catch (e) {
      showToast(chatError(e, 'Could not load archived chats'))
      return null
    }
  }, [])

  const loadMoreArchived = React.useCallback(async () => {
    if (archivedLoadingRef.current || !archivedHasMore) return
    archivedLoadingRef.current = true
    setInboxLoadingMore(true)
    try {
      const next = archivedPageRef.current + 1
      const res = await api.chat.conversations.archived({ page: next, size: PAGE_SIZE })
      archivedPageRef.current = next
      setArchivedHasMore(!!res.hasMore)
      setArchivedList(prev => {
        const seen = new Set(prev.map(c => c.id))
        return [...prev, ...res.items.filter(c => !seen.has(c.id))]
      })
    } catch (e) {
      showToast(chatError(e, 'Could not load more archived chats'))
    } finally {
      archivedLoadingRef.current = false
      setInboxLoadingMore(false)
    }
  }, [archivedHasMore])

  const loadRequests = React.useCallback(async () => {
    try {
      const res = await api.chat.requests.list({ status: 'PENDING', page: 0, size: 20 })
      requestsLoadedRef.current = true
      setRequests(res.items)
      return res.items
    } catch (e) {
      showToast(chatError(e, 'Could not load message requests'))
      return null
    }
  }, [])

  const reseedUnread = React.useCallback(() => {
    api.chat.unreadCount().then(setTotalUnread).catch(() => {})
  }, [])

  /* ---------------- conversation mutators (stable) ---------------- */

  const upsertConvo = React.useCallback((convo) => {
    if (!convo) return
    if (convo.archived) {
      setArchivedList(prev => [convo, ...prev.filter(c => c.id !== convo.id)])
      setConversations(prev => prev.filter(c => c.id !== convo.id))
      return
    }
    setConversations(prev => [convo, ...prev.filter(c => c.id !== convo.id)].sort(byRecency))
  }, [])

  const patchConvo = React.useCallback((id, patch) => {
    setConversations(prev => prev.map(c => (c.id === id ? { ...c, ...patch } : c)).sort(byRecency))
    setArchivedList(prev => prev.map(c => (c.id === id ? { ...c, ...patch } : c)))
  }, [])

  const removeConvo = React.useCallback((id) => {
    const c = findConvo(id)
    const dec = c?.unreadCount || 0
    if (dec) setTotalUnread(t => Math.max(0, t - dec))
    setConversations(prev => prev.filter(x => x.id !== id))
    setArchivedList(prev => prev.filter(x => x.id !== id))
  }, [findConvo])

  const getConvo = React.useCallback(
    (id) => conversations.find(c => c.id === id) || archived.find(c => c.id === id) || null,
    [conversations, archived],
  )

  /* ---------------- incoming message.new → delta + reorder ---------------- */

  const applyMessageNew = React.useCallback((conversationId, message) => {
    if (!message) return
    const id = message.id
    const isNew = id != null && !seenRef.current.has(id)
    if (isNew) {
      seenRef.current.add(id)
      if (seenRef.current.size > 500) {                 // evict oldest (Set keeps insertion order)
        seenRef.current.delete(seenRef.current.values().next().value)
      }
    }
    const mine = String(message.senderId) === String(myIdRef.current)
    /* "Active" means OPEN AND ON SCREEN. The read marker in useThread refuses
       to fire while the tab is hidden (you cannot read what you cannot see),
       so counting a hidden tab as active dropped the message from the badge
       AND left it unread on the server — a message that silently existed
       nowhere until the next reconnect reseed brought it back. */
    const visible = typeof document === 'undefined' || document.visibilityState === 'visible'
    const open = String(conversationId) === String(activeIdRef.current)
    const active = open && visible
    const bump = isNew && !mine && !active              // count toward the badge?

    /* Delivered receipt for a conversation I am NOT looking at. The open
       thread acks its own messages (useThread.markDelivered) — without this,
       everything landing in a closed conversation stayed single-tick for the
       sender until I happened to open it. Receipt = "my device has it",
       exactly like Telegram/WhatsApp. Keyed on `open`, not `active`: the open
       thread acks its own arrivals even while the tab is hidden, and sending
       both would just duplicate the receipt. */
    if (isNew && !mine && !open && id != null) {
      api.chat.messages.delivered(id).catch(() => {})
    }

    /* A real message from someone instantly retires their typing/recording
       indicator — the send IS the end of the activity, and waiting for the
       explicit stop ping (or the 6s TTL) leaves a ghost "typing…" under a
       message that already arrived. */
    if (!mine && typingRef.current[conversationId]?.[message.senderId]) {
      delete typingRef.current[conversationId][message.senderId]
      bumpTyping()
    }

    const known = convosRef.current.some(c => c.id === conversationId)
    if (!known) {
      // A conversation we don't hold yet (someone just messaged us) — pull it in.
      api.chat.conversations.get(conversationId).then(c => { if (c) upsertConvo(c) }).catch(() => {})
      if (bump) setTotalUnread(t => t + 1)
      return
    }
    if (bump) setTotalUnread(t => t + 1)
    setConversations(prev => prev.map(c => (
      c.id === conversationId
        ? {
            ...c,
            lastMessageId: id ?? c.lastMessageId,
            lastMessageAt: message.createdAt || c.lastMessageAt,
            // `c` is the row being rewritten, so its own timer is the right
            // one to read — and reading it INSIDE the updater keeps it
            // correct even if the timer changed in the same tick.
            lastMessagePreview: previewOf(message, (c.disappearingSeconds || 0) > 0),
            unreadCount: bump ? (c.unreadCount || 0) + 1 : c.unreadCount,
            hasUnread: bump ? true : c.hasUnread,
          }
        : c
    )).sort(byRecency))
  }, [upsertConvo, bumpTyping])

  /* ---------------- the ONE stream (guarded self-heal) ---------------- */

  React.useEffect(() => {
    if (!signedIn) { setReady(true); return }

    // Seed: inbox, pending-request count, unread total.
    let alive = true
    setLoading(true)
    // Privacy settings ride alongside but must never fail the seed — a deploy
    // without the settings endpoint should still open the inbox, not error it.
    api.chat.settings.get().then(s => { if (alive) setChatSettings(s) }).catch(() => {})

    Promise.all([
      api.chat.conversations.list({ page: 0, size: PAGE_SIZE }),
      api.chat.requests.count(),
      api.chat.unreadCount(),
    ]).then(([inbox, rc, uc]) => {
      if (!alive) return
      setConversations(inbox.items)
      inboxPageRef.current = 0
      setInboxHasMore(!!inbox.hasMore)
      setRequestCount(rc)
      setTotalUnread(uc)
      setError(null)
    }).catch(e => {
      if (alive) setError(e?.message || 'Could not load chat')
    }).finally(() => {
      if (alive) { setLoading(false); setReady(true) }
    })

    const broadcast = (evt) => {
      for (const h of subscribersRef.current) { try { h(evt) } catch { /* isolate a bad subscriber */ } }
    }

    let unsub = null, closed = false, healing = false
    const open = () => {
      unsub = api.chat.stream({
        onConnected: () => {
          setConnected(true)
          reseedUnread()                       // delta model drifts across a disconnect → re-seed
        },
        onMessage: (evt) => applyMessageNew(evt.conversationId, evt.message),
        // Keep the rail's preview line truthful when the newest message is
        // edited or tombstoned — otherwise the inbox quotes text that no
        // longer exists anywhere in the thread.
        onEdited: (evt) => {
          const c = findConvo(evt.conversationId)
          if (c && c.lastMessageId === evt.messageId) {
            /* Same leak as the send path: an edit re-applies the remaining
               TTL server-side, so the edited body is still ephemeral and
               still must not be written into the rail. */
            patchConvo(evt.conversationId, {
              lastMessagePreview: (c.disappearingSeconds || 0) > 0
                ? DISAPPEARING_PREVIEW
                : (evt.body || ''),
            })
          }
        },
        onDeleted: (evt) => {
          const c = findConvo(evt.conversationId)
          if (c && c.lastMessageId === evt.messageId) {
            patchConvo(evt.conversationId, { lastMessagePreview: 'Message deleted' })
          }
        },
        onRead: (evt) => {
          const c = findConvo(evt.conversationId)
          // My own read on another device zeroes this conversation's badge here too.
          if (String(evt.userId) === String(myIdRef.current)) {
            const dec = c?.unreadCount || 0
            if (dec) setTotalUnread(t => Math.max(0, t - dec))
            patchConvo(evt.conversationId, {
              unreadCount: 0, hasUnread: false, markedUnread: false,
              lastReadMessageId: maxId(c?.lastReadMessageId, evt.lastReadMessageId),
            })
            return
          }
          /* The PEER read my messages. ChatPage keeps a live high-water mark
             for the tick, but it is per-mount and re-seeds from the
             conversation DTO — so without persisting the peer's marker here,
             walking to another thread and back rolled every "Seen" tick back
             to "Delivered" until they happened to read something again. */
          if (c && !c.isGroup) {
            patchConvo(evt.conversationId, {
              peerLastReadMessageId: maxId(c.peerLastReadMessageId, evt.lastReadMessageId),
            })
          }
        },
        // Same argument for the single→double tick: the delivered high-water
        // mark has to outlive the ChatPage mount that observed it.
        onDelivered: (evt) => {
          if (String(evt.userId) === String(myIdRef.current)) return
          const c = findConvo(evt.conversationId)
          if (c && !c.isGroup) {
            patchConvo(evt.conversationId, {
              peerLastDeliveredMessageId: maxId(c.peerLastDeliveredMessageId, evt.messageId),
            })
          }
        },
        onTyping: (evt) => {
          if (String(evt.userId) === String(myIdRef.current)) return   // ignore my own echo
          const map = typingRef.current
          const row = map[evt.conversationId] || (map[evt.conversationId] = {})
          if (evt.isTyping) row[evt.userId] = { until: Date.now() + 6000, activity: evt.activity || 'TYPING' }
          else delete row[evt.userId]
          bumpTyping()
        },
        onPresence: (evt) => {
          presenceRef.current[String(evt.userId)] = {
            status: evt.status, lastSeenEpochMs: evt.lastSeenEpochMs, fetchedAt: Date.now(),
          }
          bumpPresence()
        },
        onConversation: (evt) => {
          const { conversationId, conversation, memberChange } = evt
          if (conversation) upsertConvo(conversation)
          if (memberChange === 'DELETED') removeConvo(conversationId)
          else if (memberChange === 'REQUEST_ACCEPTED') {
            api.chat.conversations.get(conversationId).then(c => { if (c) upsertConvo(c) }).catch(() => {})
          }
          // PINNED / UNPINNED are pin-bar signals — forwarded to subscribers below.
        },
        onMember: (evt) => {
          const mine = String(evt.userId) === String(myIdRef.current)
          // I was removed / I left → drop the conversation from my inbox.
          if (mine && (evt.memberChange === 'REMOVED' || evt.memberChange === 'LEFT')) {
            removeConvo(evt.conversationId)
            return
          }
          // My own role/status changed under me. This drives what the UI lets
          // me do (post vs read-only, the admin-only affordances), so it has
          // to land immediately rather than waiting for the next inbox fetch.
          if (mine) {
            if (evt.memberChange === 'PROMOTED' || evt.memberChange === 'DEMOTED') {
              patchConvo(evt.conversationId, { myRole: evt.role || 'MEMBER' })
            } else if (evt.memberChange === 'RESTRICTED') {
              patchConvo(evt.conversationId, { myStatus: 'RESTRICTED' })
            } else if (evt.memberChange === 'UNRESTRICTED') {
              patchConvo(evt.conversationId, { myStatus: 'ACTIVE' })
            } else if (evt.memberChange === 'ADDED') {
              // I was (re-)added. Nothing local can be patched into shape —
              // role, status, settings and the history floor are all new — so
              // pull the authoritative row. Previously this fell through the
              // `mine` branch and the conversation never appeared.
              api.chat.conversations.get(evt.conversationId)
                .then(c => { if (c) upsertConvo(c) })
                .catch(() => {})
            }
            return
          }
          // Someone else joined or left — keep the member count honest so the
          // header subtitle and the large-group cutoff don't drift. Computed
          // INSIDE the updater: reading convosRef first and writing an absolute
          // value made a burst of joins collapse to a single +1, because every
          // handler in the burst read the same pre-flush snapshot.
          const delta = (evt.memberChange === 'ADDED' || evt.memberChange === 'SUBSCRIBED') ? 1
            : (evt.memberChange === 'REMOVED' || evt.memberChange === 'LEFT' || evt.memberChange === 'UNSUBSCRIBED') ? -1 : 0
          if (delta) {
            const bump = (list) => list.map(c => (
              c.id === evt.conversationId
                ? { ...c, memberCount: Math.max(0, (c.memberCount || 0) + delta) }
                : c
            ))
            setConversations(bump)
            setArchivedList(bump)
          }
        },
        onRequest: (evt) => {
          setRequestCount(n => n + 1)
          if (requestsLoadedRef.current && evt.request) {
            setRequests(prev => [evt.request, ...prev.filter(r => r.id !== evt.request.id)])
          }
        },
        onAny: broadcast,                        // firehose → subscribe() consumers (useThread etc.)
        onError: async (readyState) => {
          setConnected(false)
          if (closed || readyState !== 2 || healing) return   // 2 = CLOSED (hard); 0/CONNECTING self-retries
          healing = true
          try { await api.auth.refresh() } catch { /* dead session → RequireAuth handles the 401s */ }
          unsub?.(); open()
          setTimeout(() => { healing = false }, 8000)
        },
      })
    }
    open()

    return () => { alive = false; closed = true; unsub?.() }
  }, [signedIn, applyMessageNew, upsertConvo, patchConvo, removeConvo, reseedUnread,
      bumpTyping, bumpPresence, findConvo])

  /* ---------------- typing expiry sweep (single shared timer) ---------------- */

  React.useEffect(() => {
    const iv = setInterval(() => {
      const now = Date.now()
      let changed = false
      const map = typingRef.current
      for (const cid of Object.keys(map)) {
        for (const uid of Object.keys(map[cid])) {
          if (map[cid][uid].until <= now) { delete map[cid][uid]; changed = true }
        }
        if (!Object.keys(map[cid]).length) delete map[cid]
      }
      if (changed) bumpTyping()
    }, 2000)
    return () => clearInterval(iv)
  }, [bumpTyping])

  /* ---------------- public actions ---------------- */

  const openDirect = React.useCallback(async (userId) => {
    const convo = await api.chat.conversations.createDirect(userId)   // get-or-create on the backend
    if (convo) upsertConvo(convo)
    return convo
  }, [upsertConvo])

  const createGroup = React.useCallback(async (opts) => {
    const convo = await api.chat.conversations.createGroup(opts)
    if (convo) upsertConvo(convo)
    return convo
  }, [upsertConvo])

  const markRead = React.useCallback((convId, lastReadMessageId) => {
    const c = findConvo(convId)
    const dec = c?.unreadCount || 0
    if (dec) setTotalUnread(t => Math.max(0, t - dec))
    /* Large groups (> 256 members) do not maintain `unreadCount` — it stays 0
       while `hasUnread` carries the signal. `applyMessageNew` still added +1 to
       the badge for each arrival, so there is nothing local to subtract here
       and the badge would climb and never come down until the next reconnect
       reseed. Guessing a number would be worse; ask the server for the real
       total instead. This is the one read path where a REST round trip beats a
       delta, and it fires only for the large-group case. */
    else if (c?.hasUnread) reseedUnread()
    patchConvo(convId, {
      // The server clears `markedUnread` on every read, so mirror it here or a
      // manually-flagged thread keeps its dot after you have opened it.
      unreadCount: 0, hasUnread: false, markedUnread: false,
      lastReadMessageId: maxId(c?.lastReadMessageId, lastReadMessageId),
    })
    api.chat.conversations.read(convId, lastReadMessageId).catch(() => {})
  }, [patchConvo, findConvo, reseedUnread])

  /** "Mark as unread" — a personal flag, not a counter. It does NOT touch
   *  `totalUnread`: the badge counts real unread messages, and the server
   *  keeps `unreadCount` at 0 here. Only the row's dot changes. */
  const markUnread = React.useCallback(async (convId) => {
    const before = findConvo(convId)
    patchConvo(convId, { markedUnread: true, hasUnread: true })
    try { await api.chat.conversations.unread(convId) }
    catch (e) {
      patchConvo(convId, {
        markedUnread: !!before?.markedUnread,
        hasUnread: !!before?.hasUnread,
      })
      showToast(chatError(e, 'Could not mark as unread'))
    }
  }, [patchConvo, findConvo])

  /** Conversation-wide disappearing timer (0 = off). Group needs
   *  CHANGE_SETTINGS; either party may set it in a DM. */
  const setDisappearing = React.useCallback(async (convId, seconds) => {
    const before = findConvo(convId)?.disappearingSeconds ?? 0
    const next = Math.max(0, Number(seconds) || 0)
    patchConvo(convId, { disappearingSeconds: next })
    try { await api.chat.conversations.disappearing(convId, next) }
    catch (e) {
      patchConvo(convId, { disappearingSeconds: before })
      showToast(chatError(e, 'Could not update the disappearing timer'))
      throw e
    }
  }, [patchConvo, findConvo])

  /** Partial update of the privacy switches; the response is authoritative. */
  const updateChatSettings = React.useCallback(async (patch) => {
    const before = chatSettings
    setChatSettings(s => ({ ...s, ...patch }))
    try {
      const fresh = await api.chat.settings.update(patch)
      setChatSettings(fresh)
      return fresh
    } catch (e) {
      setChatSettings(before)
      showToast(chatError(e, 'Could not update chat privacy'))
      throw e
    }
  }, [chatSettings])

  const setPinned = React.useCallback(async (convId, pinned) => {
    const prev = findConvo(convId)?.pinned ?? false
    patchConvo(convId, { pinned })
    try { await api.chat.conversations.pin(convId, pinned) }
    catch (e) { patchConvo(convId, { pinned: prev }); showToast(chatError(e, 'Could not update pin')) }
  }, [patchConvo, findConvo])

  const setMuted = React.useCallback(async (convId, mutedUntil) => {
    const before = findConvo(convId)
    const muted = !!mutedUntil && Date.parse(mutedUntil) > Date.now()
    patchConvo(convId, { mutedUntil: mutedUntil ?? null, muted })
    try { await api.chat.conversations.mute(convId, mutedUntil ?? null) }
    catch (e) {
      patchConvo(convId, { mutedUntil: before?.mutedUntil ?? null, muted: !!before?.muted })
      showToast(chatError(e, 'Could not update mute'))
    }
  }, [patchConvo, findConvo])

  const setArchived = React.useCallback(async (convId, archive) => {
    const c = findConvo(convId)
    // optimistic move between the two lists
    if (archive) {
      setConversations(prev => prev.filter(x => x.id !== convId))
      if (c) setArchivedList(prev => [{ ...c, archived: true }, ...prev.filter(x => x.id !== convId)])
    } else {
      setArchivedList(prev => prev.filter(x => x.id !== convId))
      if (c) setConversations(prev => [{ ...c, archived: false }, ...prev.filter(x => x.id !== convId)].sort(byRecency))
    }
    try { await api.chat.conversations.archive(convId, archive) }
    catch (e) {
      showToast(chatError(e, 'Could not archive conversation'))
      refreshInbox(); if (archivedRef.current.length) loadArchived()   // resync both lists
    }
  }, [refreshInbox, loadArchived, findConvo])

  const deleteConvo = React.useCallback(async (convId) => {
    const snapshot = findConvo(convId)
    removeConvo(convId)
    try { await api.chat.conversations.remove(convId) }
    catch (e) { if (snapshot) upsertConvo(snapshot); showToast(chatError(e, 'Could not delete conversation')) }
  }, [removeConvo, upsertConvo, findConvo])

  const acceptRequest = React.useCallback(async (id) => {
    const req = requestsRef.current.find(r => r.id === id)
    setRequests(prev => prev.filter(r => r.id !== id))
    setRequestCount(n => Math.max(0, n - 1))
    try {
      await api.chat.requests.accept(id)
      if (req?.conversationId) {
        try { const c = await api.chat.conversations.get(req.conversationId); if (c) upsertConvo(c) }
        catch { /* it'll surface on the next inbox load */ }
      }
    } catch (e) {
      if (req) { setRequests(prev => [req, ...prev]); setRequestCount(n => n + 1) }
      showToast(chatError(e, 'Could not accept request'))
      throw e
    }
  }, [upsertConvo])

  const rejectRequest = React.useCallback(async (id, kind) => {
    const req = requestsRef.current.find(r => r.id === id)
    setRequests(prev => prev.filter(r => r.id !== id))
    setRequestCount(n => Math.max(0, n - 1))
    try { await (kind === 'block' ? api.chat.requests.block(id) : api.chat.requests.decline(id)) }
    catch (e) {
      if (req) { setRequests(prev => [req, ...prev]); setRequestCount(n => n + 1) }
      showToast(chatError(e, 'Could not update request'))
      throw e
    }
  }, [])

  const declineRequest = React.useCallback((id) => rejectRequest(id, 'decline'), [rejectRequest])
  const blockRequest = React.useCallback((id) => rejectRequest(id, 'block'), [rejectRequest])

  /* ---------------- typing / presence / subscribe ---------------- */

  const sendTyping = React.useCallback((convId, isTyping, activity = 'TYPING') => {
    if (!isTyping) {
      /* Only send a stop for a start we actually sent. Without that check,
         suppressing starts below would still leave every keystroke burst
         emitting a stop — and it also covers the mid-composition case: turn
         typing off while composing and the already-broadcast "typing…" is
         retired properly instead of waiting out its 6s TTL. */
      const had = typingSentRef.current.delete(convId)
      if (had) api.chat.typing(convId, false).catch(() => {})   // stop pings are never throttled
      return
    }
    /* The server discards typing events from a user who has the indicator
       switched off — so sending them is a request every 3 seconds of
       composing, per conversation, guaranteed to do nothing. The client knows
       its own setting; read it from a ref so this callback stays referentially
       stable (the Composer's teardown depends on `onTyping` identity). */
    if (settingsRef.current.typingIndicatorsEnabled === false) return

    const now = Date.now()
    const last = typingSentRef.current.get(convId)
    // <=1 start-ping / 3s / conversation — but a CHANGED activity goes out
    // immediately, or "typing…" would linger for 3s after the mic went live.
    if (last && now - last.at < 3000 && last.activity === activity) return
    typingSentRef.current.set(convId, { at: now, activity })
    api.chat.typing(convId, true, activity).catch(() => {})
  }, [])

  /** Live typers for a conversation: [{ userId, activity }]. Identity is
   *  stable between changes so render memos don't churn on every call. */
  const typingIn = React.useCallback((convId) => {
    const row = typingRef.current[convId]
    const now = Date.now()
    const list = row
      ? Object.keys(row).filter(uid => row[uid].until > now)
          .map(uid => ({ userId: uid, activity: row[uid].activity || 'TYPING' }))
      : []
    if (!list.length) { delete typingOutRef.current[convId]; return EMPTY }
    const prev = typingOutRef.current[convId]
    const same = prev && prev.length === list.length
      && prev.every((p, i) => p.userId === list[i].userId && p.activity === list[i].activity)
    if (same) return prev
    typingOutRef.current[convId] = list
    return list
  }, [])

  const presenceOf = React.useCallback((userId) => {
    const p = presenceRef.current[String(userId)]
    return p ? { status: p.status, lastSeenEpochMs: p.lastSeenEpochMs } : null
  }, [])

  const flushPresence = React.useCallback(() => {
    const ids = [...presencePendingRef.current]
    presencePendingRef.current.clear()
    if (!ids.length) return
    api.chat.presence(ids).then(rows => {
      const now = Date.now()
      for (const r of rows) {
        presenceRef.current[String(r.userId)] = { status: r.status, lastSeenEpochMs: r.lastSeenEpochMs, fetchedAt: now }
      }
      bumpPresence()
    }).catch(() => {})
  }, [bumpPresence])

  const watchPresence = React.useCallback((userIds) => {
    const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean)
    if (!ids.length) return
    const now = Date.now()
    let added = false
    for (const raw of ids) {
      const id = String(raw)
      const cached = presenceRef.current[id]
      if (cached && now - cached.fetchedAt < 60000) continue     // fresh enough — skip
      presenceRef.current[id] = { ...(cached || { status: 'offline', lastSeenEpochMs: null }), fetchedAt: now }  // reserve
      presencePendingRef.current.add(id)
      added = true
    }
    if (added) {
      clearTimeout(presenceTimerRef.current)
      presenceTimerRef.current = setTimeout(flushPresence, 60)   // coalesce bursts into one GET
    }
  }, [flushPresence])

  /* ---------------- user directory (avatars) ----------------
     The chat DTOs deliberately carry only id/username/fullName — no avatar,
     no verified flag (see 09-api-reference: MessageResponse, `peer`,
     MemberResponse). Rendering initials everywhere would be a visible
     regression against the rest of the app, so chat resolves the missing
     half itself: one profile GET per unknown user, deduped, coalesced into
     a burst, and cached for the session. `userOf` is a pure sync read, so a
     bubble can enrich its author during render with no effect and no
     waterfall. */

  const inFlightUsersRef = React.useRef(new Set())

  const flushUsers = React.useCallback(() => {
    const ids = [...usersPendingRef.current]
    usersPendingRef.current.clear()
    if (!ids.length) return
    // Between clearing `pending` and the responses landing, an id sits in
    // NEITHER map — so watchUsers would happily queue it again on the next
    // render and refetch the same profile several times. Hold it here for the
    // duration of the round trip.
    ids.forEach(id => inFlightUsersRef.current.add(id))
    // There is no batch-by-ids endpoint; keep the fan-out small and let the
    // cache absorb the rest. A failure caches `null` so we never re-ask in a
    // loop for a deleted account.
    Promise.allSettled(ids.map(id => api.users.profile(id)))
      .then(rows => {
        let changed = false
        rows.forEach((r, i) => {
          const id = ids[i]
          const u = r.status === 'fulfilled' ? r.value : null
          usersRef.current.set(id, u
            ? {
                id,
                profileImage: u.profileImage || null,
                verified: !!u.verified,
                role: u.role || 'MEMBER',
                full: u.full || null,
                handle: u.handle || null,
                avc: u.avc || null,
                initials: u.initials || null,
              }
            : null)
          changed = true
        })
        if (changed) bumpUsers()
      })
      .catch(() => {})
      .finally(() => { ids.forEach(id => inFlightUsersRef.current.delete(id)) })
  }, [bumpUsers])

  const watchUsers = React.useCallback((userIds) => {
    const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean)
    if (!ids.length) return
    let added = false
    for (const raw of ids) {
      const id = String(raw)
      if (usersRef.current.has(id)
        || usersPendingRef.current.has(id)
        || inFlightUsersRef.current.has(id)) continue        // known, queued, or in flight
      usersPendingRef.current.add(id)
      added = true
    }
    if (added) {
      clearTimeout(usersTimerRef.current)
      usersTimerRef.current = setTimeout(flushUsers, 40)     // coalesce a page's senders
    }
  }, [flushUsers])

  /** Sync read of the directory. Returns null when unknown/unresolved. */
  const userOf = React.useCallback((id) => (id ? usersRef.current.get(String(id)) || null : null), [])

  /** Merge a chat-DTO author with the resolved directory card. */
  const enrichAuthor = React.useCallback((author, userId) => {
    const id = userId || author?.id
    if (!id) return author
    const card = usersRef.current.get(String(id))
    if (!card) return author
    if (!author) return card
    return {
      ...author,
      profileImage: author.profileImage || card.profileImage || null,
      verified: author.verified || card.verified,
      role: author.role && author.role !== 'MEMBER' ? author.role : card.role,
    }
  }, [])

  React.useEffect(() => () => clearTimeout(usersTimerRef.current), [])

  const subscribe = React.useCallback((handler) => {
    subscribersRef.current.add(handler)
    return () => subscribersRef.current.delete(handler)
  }, [])

  const setActiveConversation = React.useCallback((id) => { activeIdRef.current = id }, [])

  React.useEffect(() => () => clearTimeout(presenceTimerRef.current), [])

  const value = {
    ready, connected, conversations, archived, requests, totalUnread, requestCount, loading, error,
    myId: user?.id ?? null,
    refreshInbox, loadArchived, loadRequests,
    inboxHasMore, archivedHasMore, inboxLoadingMore, loadMoreInbox, loadMoreArchived,
    getConvo, upsertConvo, patchConvo, removeConvo,
    openDirect, createGroup,
    markRead, markUnread, setPinned, setMuted, setArchived, setDisappearing, deleteConvo,
    chatSettings, updateChatSettings,
    acceptRequest, declineRequest, blockRequest,
    sendTyping, typingIn, presenceOf, watchPresence,
    watchUsers, userOf, enrichAuthor,
    subscribe, setActiveConversation,
  }
  return <ChatCtx.Provider value={value}>{children}</ChatCtx.Provider>
}

/** Access the chat state layer. Throws if used outside <ChatProvider>. */
export function useChat() {
  const ctx = React.useContext(ChatCtx)
  if (!ctx) throw new Error('useChat() must be used inside <ChatProvider>')
  return ctx
}
