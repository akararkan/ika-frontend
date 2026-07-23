/* =========================================================
   Chat service — /api/v1 messaging (conversations, messages,
   members, requests, presence + the single per-user SSE stream)
   ---------------------------------------------------------
   Two storage engines sit behind this one module, and they page
   differently — the shapes below are NOT interchangeable:
     - conversations / members / requests → Postgres, Spring `Page`
       (page/size) → normalised to { items, total, hasMore, page }
     - messages → Cassandra, CURSOR paging (limit clamped 1..100)
       → { items, nextCursor, hasMore }, newest → older

   Wire ids: conversations/users are UUIDs; `messageId` is a 64-bit
   Snowflake — an 18-digit long that does NOT fit in a JS number
   (355456387759665152 comes back out of a double as …150, and the
   backend 404s that). So message ids stay EXACT DECIMAL STRINGS:
   http.js quotes them at parse time, `mid()` normalises them, and
   ordering/dedupe/gap-sync go through cmpId/maxId/gteId (./ids.js).
   Never `-`, `>=` or Math.max on a message id.

   Counters (unread, reaction counts) are deliberately ABSENT from
   SSE payloads — consumers apply +1/-1 deltas locally, exactly like
   the posts/research realtime model in realtime.js.
   ========================================================= */
import { http, parseJson } from './http.js'
import { API_BASE, assetUrl, session } from './config.js'
import { authorFrom, handleOf, timeAgo } from './adapters.js'
import { mid } from './ids.js'

/* ---------- small shared helpers ---------- */

/** Spring `Page` → the list shape the rest of the app uses (same as users.js). */
const pageOf = (res, map) => ({
  items: (res?.content || res || []).map(map),
  total: res?.totalElements ?? null,
  hasMore: res ? !res.last : false,
  page: res?.number ?? 0,
})

/* Message ids are Snowflakes — 18-digit longs that do NOT fit in a JS number.
   `mid()` (./ids.js) keeps them as their exact decimal string; ordering and
   high-water comparisons go through cmpId/maxId/gteId, never `-`/`>=`. */

/** The backend clamps message page size to 1..100 — clamp here too so a caller
 *  typo becomes a sane request instead of a 400. */
const clampLimit = (n, dflt = 40) => Math.min(100, Math.max(1, Number(n) || dflt))

/* =========================================================
   Adapters — DTO → view shape. Every adapter attaches a resolved
   `_author`-style object so <Avatar>/<Verify> render unchanged.
   ========================================================= */

/** MessageMedia → view media. Backend media URLs are RELATIVE → assetUrl them
 *  or <img>/<video>/<audio> would resolve them against the frontend origin. */
function mediaFrom(m) {
  return {
    kind: m?.kind || 'FILE',                    // IMAGE | VIDEO | VOICE | FILE
    storageKey: m?.storageKey || null,
    url: assetUrl(m?.url || null),
    thumbnailKey: m?.thumbnailKey || null,
    thumbnailUrl: assetUrl(m?.thumbnailUrl || null),
    mime: m?.mime || '',
    bytes: m?.bytes ?? 0,
    width: m?.width ?? null,
    height: m?.height ?? null,
    durationMs: m?.durationMs ?? null,
    waveform: m?.waveform || null,              // VOICE: sampled amplitudes for the scrubber
    fileName: m?.fileName || '',
    altText: m?.altText || '',
  }
}

/** MessageResponse → view message. */
export function msgFrom(dto) {
  if (!dto) return null
  const sender = authorFrom({ id: dto.senderId, username: dto.senderUsername, fullName: dto.senderFullName })
  const type = dto.type || 'TEXT'
  return {
    id: mid(dto.messageId),
    conversationId: dto.conversationId || null,
    senderId: dto.senderId || null,
    sender,
    type,
    body: dto.body || '',
    media: (dto.media || []).map(mediaFrom),
    replyToId: mid(dto.replyToId),
    replyTo: dto.replyTo
      ? {
          messageId: mid(dto.replyTo.messageId),
          senderId: dto.replyTo.senderId || null,
          type: dto.replyTo.type || 'TEXT',
          snippet: dto.replyTo.snippet || '',
          deleted: !!dto.replyTo.deleted,
        }
      : null,
    forwardedFrom: dto.forwardedFrom || null,
    mentions: dto.mentions || [],
    reactions: (dto.reactions || []).map(r => ({
      emoji: r?.emoji || '',
      count: r?.count ?? 0,
      reactedByMe: !!r?.reactedByMe,
    })),
    editedAt: dto.editedAt || null,
    deleted: !!dto.deleted,
    /* Who tombstoned it, when the server says so. The REST page does not
       carry it today (the field is read opportunistically under three
       plausible names), so the bubble's copy has to stay impersonal when it
       is null rather than assuming the sender removed their own message —
       in a group an admin very often did. The live `message.deleted` frame
       DOES carry an actor, and useThread stamps it from there. */
    deletedBy: dto.deletedBy || dto.deletedByUserId || dto.deletedByUser?.userId || null,
    // Per-VIEWER bookmark: the same row is `true` for me and `false` for
    // everyone else. Computed server-side at read time via a bulk lookup.
    starred: !!dto.starred,
    systemEvent: dto.systemEvent || null,
    createdAt: dto.createdAt || null,
    isSystem: type === 'SYSTEM' || !!dto.systemEvent,
    time: timeAgo(dto.createdAt),               // convenience label; bubbles may format their own
  }
}

/** ConversationResponse → view conversation. */
export function convoFrom(dto) {
  if (!dto) return null
  const type = dto.type || 'DIRECT'
  const isChannel = type === 'CHANNEL'
  // A CHANNEL is a group-shaped conversation with an admins-only send mode —
  // it reuses the entire message log / roster / realtime path, so everything
  // that keys on `isGroup` (roster, permissions, medallion) must include it.
  const isGroup = type === 'GROUP' || isChannel
  // DMs render as a person (avatar + verify); groups render as a title + group art.
  const peer = dto.peer
    ? authorFrom({ id: dto.peer.userId, username: dto.peer.username, fullName: dto.peer.fullName })
    : null
  const mutedUntil = dto.mutedUntil || null
  const at = dto.lastMessageAt || dto.createdAt || null
  const markedUnread = !!dto.markedUnread
  return {
    id: dto.id,
    type,
    isGroup,
    isChannel,
    title: dto.title || '',
    description: dto.description || '',
    avatarUrl: assetUrl(dto.avatarUrl || null),
    avatarKey: dto.avatarKey || null,
    ownerId: dto.ownerId || null,
    memberCount: dto.memberCount ?? (isGroup ? 0 : 2),
    lastMessageId: mid(dto.lastMessageId),
    lastMessageAt: dto.lastMessageAt || null,
    lastMessagePreview: dto.lastMessagePreview || '',
    settings: dto.groupSettings || null,
    // 0 = off. Anything above is the per-message Cassandra TTL applied to
    // messages sent AFTER the timer was set (existing rows are untouched).
    disappearingSeconds: dto.disappearingSeconds ?? 0,
    myRole: dto.myRole || 'MEMBER',
    myStatus: dto.myStatus || 'ACTIVE',
    lastReadMessageId: mid(dto.lastReadMessageId),
    lastDeliveredMessageId: mid(dto.lastDeliveredMessageId),
    unreadCount: dto.unreadCount ?? 0,
    // `markedUnread` forces the dot on even with a zero count (POST …/unread).
    hasUnread: dto.hasUnread ?? ((dto.unreadCount ?? 0) > 0 || markedUnread),
    markedUnread,
    /* The peer's own markers, so re-opening a DM paints the right tick on my
       history immediately instead of showing a lone "Sent" until the peer
       happens to emit a fresh receipt. `null` when either side has read
       receipts off — that is a privacy answer, not a missing value. */
    peerLastReadMessageId: mid(dto.peerLastReadMessageId),
    peerLastDeliveredMessageId: mid(dto.peerLastDeliveredMessageId),
    mutedUntil,
    // `mutedUntil` is an instant, not a flag — a past value means the mute lapsed.
    muted: !!mutedUntil && new Date(mutedUntil).getTime() > Date.now(),
    pinned: !!dto.pinned,
    archived: !!dto.archived,
    peer,
    createdAt: dto.createdAt || null,
    time: timeAgo(at),
    displayTitle: isGroup ? (dto.title || (isChannel ? 'Channel' : 'Group')) : (peer?.full || dto.title || 'Conversation'),
    _author: isGroup ? null : peer,
  }
}

/** MemberResponse → view member row. */
export function memberFrom(dto) {
  if (!dto) return null
  const _author = authorFrom({ id: dto.userId, username: dto.username, fullName: dto.fullName })
  return {
    userId: dto.userId,
    username: dto.username || '',
    handle: handleOf(dto.username),
    fullName: dto.fullName || _author.full,
    role: dto.role || 'MEMBER',
    status: dto.status || 'ACTIVE',
    joinedAt: dto.joinedAt || null,
    _author,
  }
}

/** MessageRequestResponse → view request row (stranger's first messages). */
export function requestFrom(dto) {
  if (!dto) return null
  const requester = authorFrom({ id: dto.requesterId, username: dto.requesterUsername, fullName: dto.requesterFullName })
  return {
    id: dto.id,
    conversationId: dto.conversationId || null,
    requesterId: dto.requesterId || null,
    requester,
    status: dto.status || 'PENDING',
    firstMessageId: mid(dto.firstMessageId),
    messageCount: dto.messageCount ?? 0,
    createdAt: dto.createdAt || null,
    time: timeAgo(dto.createdAt),
  }
}

/** ReactionSummary[] → view reactions (used by react/unreact/reactions). */
const reactionsFrom = (rows) => (rows || []).map(r => ({
  emoji: r?.emoji || '', count: r?.count ?? 0, reactedByMe: !!r?.reactedByMe,
}))

/** PresenceResponse[] → normalised rows ('online' | 'offline' lowercase). */
const presenceFrom = (rows) => (rows || []).map(p => ({
  userId: p?.userId,
  status: String(p?.status || p?.presenceStatus || 'offline').toLowerCase(),
  lastSeenEpochMs: p?.lastSeenEpochMs ?? null,
}))

/** ParticipantSummary → author card (seen-by lists, call rosters). */
export function participantFrom(dto) {
  if (!dto) return null
  const _author = authorFrom({ id: dto.userId, username: dto.username, fullName: dto.fullName })
  return {
    userId: dto.userId,
    username: dto.username || '',
    handle: handleOf(dto.username),
    fullName: dto.fullName || _author.full,
    _author,
  }
}

/** ChatSettingsResponse → view settings. Absent row = every switch ON. */
export function settingsFrom(dto) {
  return {
    readReceiptsEnabled: dto?.readReceiptsEnabled ?? true,
    lastSeenVisible: dto?.lastSeenVisible ?? true,
    typingIndicatorsEnabled: dto?.typingIndicatorsEnabled ?? true,
  }
}

/** ScheduledMessageResponse → view row (send-later queue). */
export function scheduledFrom(dto) {
  if (!dto) return null
  const status = dto.status || 'PENDING'
  return {
    id: dto.id,
    conversationId: dto.conversationId || null,
    type: dto.type || 'TEXT',
    body: dto.body || '',
    media: (dto.media || []).map(mediaFrom),
    replyToId: mid(dto.replyToId),
    scheduledAt: dto.scheduledAt || null,
    status,                                     // PENDING | SENT | CANCELLED | FAILED
    pending: status === 'PENDING',
    sentMessageId: mid(dto.sentMessageId),
    createdAt: dto.createdAt || null,
  }
}

/** ChannelResponse → view channel (a CHANNEL-typed conversation + its counts). */
export function channelFrom(dto) {
  if (!dto) return null
  return {
    id: dto.id,                                 // ALSO the conversationId — post/read use it
    handle: dto.handle ? String(dto.handle).replace(/^@/, '') : '',
    title: dto.title || 'Channel',
    description: dto.description || '',
    publicChannel: dto.publicChannel !== false,
    subscriberCount: dto.subscriberCount ?? 0,
    ownerId: dto.ownerId || null,
    subscribed: !!dto.subscribed,
    createdAt: dto.createdAt || null,
    time: timeAgo(dto.createdAt),
  }
}

/** CallResponse → view call. `live` is the single "should the UI be up?" flag. */
export function callFrom(dto) {
  if (!dto) return null
  const status = dto.status || 'RINGING'        // RINGING|ONGOING|ENDED|DECLINED|CANCELLED|MISSED
  const type = dto.type || 'VOICE'
  return {
    id: dto.id,
    conversationId: dto.conversationId || null,
    initiatorId: dto.initiatorId || null,
    type,
    video: type === 'VIDEO',
    status,
    ringing: status === 'RINGING',
    ongoing: status === 'ONGOING',
    live: status === 'RINGING' || status === 'ONGOING',
    participants: (dto.participants || []).map(p => ({
      userId: p?.userId || null,
      state: p?.state || 'RINGING',              // RINGING | JOINED | LEFT | DECLINED
      joinedAt: p?.joinedAt || null,
      leftAt: p?.leftAt || null,
    })),
    startedAt: dto.startedAt || null,
    answeredAt: dto.answeredAt || null,
    endedAt: dto.endedAt || null,
  }
}

/** CallSignalMessage → view frame. `payload` is opaque SDP/ICE JSON — the
 *  server never parses it and neither do we; WebRTC gets it verbatim. */
export function callSignalFrom(dto) {
  if (!dto) return null
  return {
    callId: dto.callId || null,
    fromUserId: dto.fromUserId || null,
    kind: dto.kind || 'ICE',                    // OFFER | ANSWER | ICE
    payload: dto.payload ?? null,
  }
}

/** LiveStreamResponse → view stream. `ingestUrl` is HOST-ONLY (secret key). */
export function liveStreamFrom(dto) {
  if (!dto) return null
  const status = dto.status || 'LIVE'
  return {
    id: dto.id,
    hostId: dto.hostId || null,
    title: dto.title || 'Live',
    description: dto.description || '',
    status,
    isLive: status === 'LIVE',
    playbackUrl: dto.playbackUrl || null,       // HLS/WebRTC out — an external media origin
    ingestUrl: dto.ingestUrl || null,           // null for viewers
    viewerCount: dto.viewerCount ?? 0,
    startedAt: dto.startedAt || null,
    endedAt: dto.endedAt || null,
    time: timeAgo(dto.startedAt),
  }
}

/** LiveChatMessage → view row. Ephemeral: never persisted, never replayed. */
export function liveChatFrom(dto) {
  if (!dto) return null
  return {
    streamId: dto.streamId || null,
    userId: dto.userId || null,
    username: dto.username || '',
    handle: handleOf(dto.username),
    text: dto.text || '',
    sentAt: dto.sentAt || null,
  }
}

/* =========================================================
   SSE — the ONE per-user chat stream, /api/v1/messaging/stream
   ========================================================= */

const STREAM_PATH = '/api/v1/messaging/stream'

/* Wire event name → handler key. These are the documented `event:` names. */
const EVENT_HANDLER = {
  'connected':            'onConnected',
  'message.new':          'onMessage',
  'message.edited':       'onEdited',
  'message.deleted':      'onDeleted',
  'message.reaction':     'onReaction',
  'receipt.read':         'onRead',
  'receipt.delivered':    'onDelivered',
  'typing':               'onTyping',
  'presence':             'onPresence',
  'conversation.updated': 'onConversation',
  'member.changed':       'onMember',
  'request.new':          'onRequest',
  /* Calls and live streams are MULTIPLEXED onto this same per-user stream —
     there is no second socket. Every call.*/ /* name maps to one handler key
     (`onCall`) and every stream.* to `onStream`; consumers switch on
     `evt.type`. A name absent from this map is never addEventListener'd, so
     it would be dropped silently — that is why they are all listed. */
  'call.incoming':        'onCall',
  'call.accepted':        'onCall',
  'call.declined':        'onCall',
  'call.participant':     'onCall',
  'call.ended':           'onCall',
  'call.signal':          'onCall',
  'stream.started':       'onStream',
  'stream.viewer':        'onStream',
  'stream.chat':          'onStream',
  'stream.ended':         'onStream',
}

/* An unnamed `message` frame (or a server that switched casing) carries its own
   discriminator — MESSAGE_NEW / message.new / RECEIPT_READ … Normalise both
   spellings onto the dotted lower-case name so routing can never silently die. */
function normalizeEventName(name) {
  return String(name || '').trim().toLowerCase().replace(/_/g, '.')
}

/** Adapt a raw SSE payload into VIEW shapes — consumers never see DTOs.
 *  `type` is always the dotted wire name so a generic subscriber can switch on it. */
function adaptEvent(type, d = {}) {
  switch (type) {
    case 'message.new':
      return { type, conversationId: d.conversationId, message: msgFrom(d.message) }
    case 'message.edited':
      return { type, conversationId: d.conversationId, messageId: mid(d.messageId), body: d.body || '', editedAt: d.editedAt || null }
    case 'message.deleted':
      /* The actor rides under whichever name the server uses; all three are
         read because this is the ONLY place the deleter is ever knowable —
         the message row itself comes back without one. */
      return {
        type, conversationId: d.conversationId, messageId: mid(d.messageId),
        userId: d.userId || d.deletedBy || d.actorId || null,
      }
    case 'message.reaction':
      return { type, conversationId: d.conversationId, messageId: mid(d.messageId), userId: d.userId, emoji: d.emoji || '', added: !!d.added }
    case 'receipt.read':
      return { type, conversationId: d.conversationId, userId: d.userId, lastReadMessageId: mid(d.lastReadMessageId) }
    case 'receipt.delivered':
      return { type, conversationId: d.conversationId, userId: d.userId, messageId: mid(d.messageId) }
    case 'typing':
      return {
        type, conversationId: d.conversationId, userId: d.userId, isTyping: !!d.isTyping,
        // Optional richer state ("recording a voice note", "sending a photo").
        // The documented request only carries `isTyping`; we send `activity`
        // best-effort and read it back from any server that echoes it. A
        // backend that drops the field degrades to a plain "typing…".
        activity: d.activity || d.typingActivity || null,
      }
    case 'presence':
      return {
        type, userId: d.userId,
        presenceStatus: d.presenceStatus || null,
        status: String(d.presenceStatus || 'offline').toLowerCase(),
        lastSeenEpochMs: d.lastSeenEpochMs ?? null,
      }
    case 'conversation.updated':
      return { type, conversationId: d.conversationId, conversation: d.conversation ? convoFrom(d.conversation) : null, memberChange: d.memberChange || null }
    case 'member.changed':
      return { type, conversationId: d.conversationId, userId: d.userId, memberChange: d.memberChange || null, role: d.role || null }
    case 'request.new':
      return { type, conversationId: d.conversationId, request: requestFrom(d.request) }

    /* ---- calls (voice / video) ---- */
    case 'call.incoming':
    case 'call.accepted':
    case 'call.declined':
    case 'call.participant':
    case 'call.ended': {
      const call = callFrom(d.call)
      return { type, call, callId: call?.id || d.callId || null, conversationId: call?.conversationId || d.conversationId || null, userId: d.userId || null }
    }
    case 'call.signal': {
      const signal = callSignalFrom(d.signal || d)
      return { type, signal, callId: signal?.callId || null, userId: signal?.fromUserId || null }
    }

    /* ---- live streaming ---- */
    case 'stream.started':
    case 'stream.viewer':
    case 'stream.ended': {
      const stream_ = liveStreamFrom(d.stream)
      return { type, stream: stream_, streamId: stream_?.id || d.streamId || null, userId: d.userId || null, memberChange: d.memberChange || null }
    }
    case 'stream.chat': {
      const chatLine = liveChatFrom(d.streamChat || d.chat)
      return { type, streamChat: chatLine, streamId: chatLine?.streamId || d.streamId || null, userId: chatLine?.userId || null }
    }

    default:
      return { type, ...d }
  }
}

/**
 * Open the per-user chat stream. Returns an unsubscribe fn.
 *
 * Hardening (mirrors realtime.js / stories.js):
 *  - the JWT is read INSIDE connect() on every attempt — the access token rotates
 *    ~hourly via the 401 refresh, and a long-lived tab will reconnect after that;
 *    capturing it once would re-dial forever with a dead token.
 *  - both the dotted lower-case event names AND the unnamed `message` frame are
 *    handled (EventSource delivers each frame to exactly one listener, so nothing
 *    double-fires and a server-side casing change can't kill live updates).
 *  - a 60s-silence watchdog closes BEFORE reconnecting, so we never hold two
 *    sockets and trip the per-user SSE cap.
 *  - `onError(readyState)` — readyState 2 (CLOSED) is a hard close (usually an
 *    expired token) the browser will NOT retry; the caller should re-subscribe.
 */
function stream(handlers = {}) {
  let es = null
  let closed = false
  let lastBeat = Date.now()

  /* `parseJson`, not `JSON.parse`: a live frame carries the same 18-digit
     Snowflakes as the REST payloads, and a rounded id here would not match
     the one already in the message map. */
  const parse = (e) => { try { return parseJson(e.data) } catch { return {} } }

  const dispatch = (rawName, data) => {
    lastBeat = Date.now()
    const type = normalizeEventName(rawName || data?.eventType || data?.type)
    if (type === 'heartbeat' || !type) return
    const key = EVENT_HANDLER[type]
    const evt = adaptEvent(type, data)
    handlers[key]?.(evt)
    handlers.onAny?.(evt)          // optional firehose (ChatContext re-broadcasts to subscribers)
  }

  const connect = () => {
    if (closed) return
    const token = session.getToken()
    const url = `${API_BASE}${STREAM_PATH}` + (token ? `?token=${encodeURIComponent(token)}` : '')
    es = new EventSource(url, { withCredentials: true })

    for (const name of Object.keys(EVENT_HANDLER)) {
      es.addEventListener(name, (e) => dispatch(name, parse(e)))
      // defensive: some deploys emit the raw enum (MESSAGE_NEW) as the event name
      const upper = name.toUpperCase().replace(/\./g, '_')
      if (upper !== name) es.addEventListener(upper, (e) => dispatch(name, parse(e)))
    }
    es.addEventListener('heartbeat', () => { lastBeat = Date.now() })
    es.addEventListener('HEARTBEAT', () => { lastBeat = Date.now() })
    es.onmessage = (e) => dispatch(null, parse(e))     // unnamed frames → route by payload
    es.onerror = () => handlers.onError?.(es?.readyState ?? 2)
  }
  connect()

  const watchdog = setInterval(() => {
    if (closed) return
    if (Date.now() - lastBeat > 60000) {
      try { es?.close() } catch { /* noop */ }
      lastBeat = Date.now()
      connect()
    }
  }, 15000)

  return () => {
    closed = true
    clearInterval(watchdog)
    try { es?.close() } catch { /* noop */ }
    es = null
  }
}

/* =========================================================
   The service object
   ========================================================= */

export const chat = {
  /* ---------- conversations (Postgres, page/size) ---------- */
  conversations: {
    async list({ page = 0, size = 30 } = {}) {
      return pageOf(await http.get('/api/v1/conversations', { page, size }), convoFrom)
    },
    async archived({ page = 0, size = 30 } = {}) {
      return pageOf(await http.get('/api/v1/conversations/archived', { page, size }), convoFrom)
    },
    async create(body) { return convoFrom(await http.post('/api/v1/conversations', body)) },
    createDirect(recipientId) { return chat.conversations.create({ type: 'DIRECT', recipientId }) },
    createGroup({ title, description, memberIds = [], avatarKey } = {}) {
      return chat.conversations.create({
        type: 'GROUP', title, memberIds,
        description: description || undefined,
        avatarKey: avatarKey || undefined,
      })
    },
    async get(id)            { return convoFrom(await http.get(`/api/v1/conversations/${id}`)) },
    // { title?, description?, avatarKey?, settings? } — null fields are left unchanged.
    async update(id, body)   { return convoFrom(await http.patch(`/api/v1/conversations/${id}`, body)) },
    remove(id)               { return http.del(`/api/v1/conversations/${id}`) },                           // 204
    read(id, lastReadMessageId) { return http.post(`/api/v1/conversations/${id}/read`, { lastReadMessageId }) },
    /** Flag the thread unread in MY inbox until I next open it. Purely
     *  personal: no receipt, nothing broadcast, cleared by the next …/read. */
    unread(id)               { return http.post(`/api/v1/conversations/${id}/unread`, {}) },
    mute(id, mutedUntil)     { return http.post(`/api/v1/conversations/${id}/mute`, { mutedUntil: mutedUntil ?? null }) },  // null = unmute
    pin(id, pinned)          { return http.post(`/api/v1/conversations/${id}/pin`, { pinned: !!pinned }) },
    archive(id, archived)    { return http.post(`/api/v1/conversations/${id}/archive`, { archived: !!archived }) },
    /** Conversation-wide auto-delete. `0` turns it off. Applies a Cassandra
     *  TTL to messages sent AFTER this call — existing rows never expire. */
    disappearing(id, seconds) { return http.post(`/api/v1/conversations/${id}/disappearing`, { seconds: Math.max(0, Number(seconds) || 0) }) },
  },

  /* ---------- messages (Cassandra, cursor paging) ---------- */
  messages: {
    /** Newest → older. Pass the previous `nextCursor` to walk back. */
    async page(convId, { cursor, limit = 40 } = {}) {
      const res = await http.get(`/api/v1/conversations/${convId}/messages`, { cursor, limit: clampLimit(limit) })
      return {
        items: (res?.items || []).map(msgFrom),
        nextCursor: res?.nextCursor ?? null,
        hasMore: !!res?.hasMore,
      }
    },
    /** Gap-sync after a reconnect: everything ASCENDING after `afterId`. */
    async sync(convId, afterId, limit = 100) {
      const rows = await http.get(`/api/v1/conversations/${convId}/messages/sync`, { after: afterId ?? undefined, limit: clampLimit(limit, 100) })
      return (rows || []).map(msgFrom)
    },
    /** `opts` forwards an AbortSignal — ChatSearchPanel cancels in-flight
     *  queries as you type so a slow earlier response can't land after a
     *  newer one and clobber the results. */
    async search(convId, q, limit = 30, opts) {
      const rows = await http.get(`/api/v1/conversations/${convId}/messages/search`, { q, limit: clampLimit(limit, 30) }, opts)
      return (rows || []).map(msgFrom)
    },
    /** `clientNonce` makes the send idempotent AND lets the sender reconcile its
     *  own optimistic bubble when the echo arrives on the stream. */
    async send(convId, { clientNonce, type = 'TEXT', body, replyToId, media } = {}) {
      return msgFrom(await http.post(`/api/v1/conversations/${convId}/messages`, {
        clientNonce, type, body, replyToId: replyToId ?? undefined, media: media || undefined,
      }))
    },
    /** Multipart send. `replyToId` is sent best-effort: the documented parts
     *  are clientNonce/body/files, so a backend that ignores it simply posts
     *  an unthreaded attachment rather than failing the upload. */
    async sendFiles(convId, { clientNonce, body, files = [], replyToId } = {}) {
      const fd = new FormData()
      fd.append('clientNonce', clientNonce)
      if (body) fd.append('body', body)
      if (replyToId != null) fd.append('replyToId', String(replyToId))
      for (const f of files) fd.append('files', f)          // repeatable part name
      return msgFrom(await http.upload(`/api/v1/conversations/${convId}/messages/upload`, fd))
    },
    async get(messageId)          { return msgFrom(await http.get(`/api/v1/messages/${messageId}`)) },   // full reaction detail
    async edit(messageId, body)   { return msgFrom(await http.patch(`/api/v1/messages/${messageId}`, { body })) },
    /** Two WhatsApp-style deletes behind one verb, selected by `scope`:
     *   'everyone' (default) — tombstone for ALL members (sender or a group
     *                          admin only); the stub stays in the timeline.
     *   'me'                 — hide from MY page/sync/search/starred only;
     *                          works on ANY readable message, no broadcast. */
    remove(messageId, scope = 'everyone') {
      return http.del(`/api/v1/messages/${messageId}`, { query: { scope } })                             // 204
    },
    async forward(messageId, targetConversationId, clientNonce) {
      return msgFrom(await http.post(`/api/v1/messages/${messageId}/forward`, { targetConversationId, clientNonce }))
    },
    delivered(messageId)          { return http.post(`/api/v1/messages/${messageId}/delivered`, {}) },
    async react(messageId, emoji) { return reactionsFrom(await http.post(`/api/v1/messages/${messageId}/react`, { emoji })) },
    async unreact(messageId)      { return reactionsFrom(await http.del(`/api/v1/messages/${messageId}/react`)) },
    async reactions(messageId)    { return reactionsFrom(await http.get(`/api/v1/messages/${messageId}/reactions`)) },
    pin(convId, messageId)        { return http.post(`/api/v1/conversations/${convId}/messages/${messageId}/pin`, {}) },
    unpin(convId, messageId)      { return http.del(`/api/v1/conversations/${convId}/messages/${messageId}/pin`) },
    async pinned(convId)          { return ((await http.get(`/api/v1/conversations/${convId}/pinned`)) || []).map(msgFrom) },

    /* ---- starred (private bookmarks) ----
       A star is per-viewer, invisible to everyone else, survives edits, and is
       dropped when the message is deleted for everyone. Both writes are
       idempotent; the flag rides back on `MessageResponse.starred`. */
    star(messageId)               { return http.post(`/api/v1/messages/${messageId}/star`, {}) },        // 200
    unstar(messageId)             { return http.del(`/api/v1/messages/${messageId}/star`) },             // 204
    /** My starred messages across ALL conversations, most-recently-starred
     *  first. Postgres-paged but returns a bare List, not a Spring Page. */
    async starred({ page = 0, size = 30 } = {}) {
      const rows = await http.get('/api/v1/messaging/starred', { page, size })
      return (rows || []).map(msgFrom)
    },

    /** Group "Seen by". Symmetrically gated: EMPTY if I turned read receipts
     *  off, and readers who turned theirs off are omitted. Excludes the
     *  sender. An empty array is a normal answer, not an error. */
    async seenBy(messageId) {
      const rows = await http.get(`/api/v1/messages/${messageId}/seen-by`)
      return (rows || []).map(participantFrom).filter(Boolean)
    },
  },

  /* ---------- scheduled (send-later) messages ----------
     The row lives in Postgres; a poller fires it through the NORMAL send path
     ~every 15s, so permission, idempotency, fan-out and realtime are identical
     to a live send. Permission is re-checked at fire time: a message queued
     before you were blocked/removed lands FAILED, never delivered. */
  scheduled: {
    async create(convId, { scheduledAt, clientNonce, type = 'TEXT', body, replyToId, media } = {}) {
      return scheduledFrom(await http.post(`/api/v1/conversations/${convId}/messages/schedule`, {
        scheduledAt, clientNonce, type, body,
        replyToId: replyToId ?? undefined, media: media || undefined,
      }))
    },
    /** My still-PENDING queue for this conversation, soonest first. */
    async list(convId) {
      const rows = await http.get(`/api/v1/conversations/${convId}/scheduled`)
      return (rows || []).map(scheduledFrom).filter(Boolean)
    },
    cancel(scheduledId) { return http.del(`/api/v1/messaging/scheduled/${scheduledId}`) },               // 204
  },

  /* ---------- chat privacy settings (the symmetric gates) ----------
     Read receipts and last-seen are RECIPROCAL — turning yours off stops you
     sending AND receiving that signal. Typing is one-way (off = you emit
     none, you still see others'). A user with no row behaves as all-on. */
  settings: {
    async get()          { return settingsFrom(await http.get('/api/v1/messaging/settings')) },
    /** Partial: omit a field to leave it unchanged. Returns the full state. */
    async update(patch)  { return settingsFrom(await http.put('/api/v1/messaging/settings', patch || {})) },
  },

  /* ---------- channels (Telegram-style broadcast) ----------
     A channel IS a conversation (`id` is the conversationId) with an
     admins-only send mode, so posting and reading go through the normal
     conversation/message endpoints. Only creation, discovery and the
     subscribe toggle live here. */
  channels: {
    async create({ title, description, handle, publicChannel = true } = {}) {
      return channelFrom(await http.post('/api/v1/channels', {
        title,
        description: description || undefined,
        handle: handle ? String(handle).replace(/^@/, '') : undefined,
        publicChannel: !!publicChannel,
      }))
    },
    /** Public channels matching `q` (or all), most-subscribed first. */
    async discover(q, opts) {
      const rows = await http.get('/api/v1/channels/discover', { q: q || undefined }, opts)
      return (rows || []).map(channelFrom).filter(Boolean)
    },
    async byHandle(handle) {
      const h = String(handle || '').replace(/^@/, '')
      return channelFrom(await http.get(`/api/v1/channels/by-handle/${encodeURIComponent(h)}`))
    },
    async subscribe(id)   { return channelFrom(await http.post(`/api/v1/channels/${id}/subscribe`, {})) },  // idempotent
    unsubscribe(id)       { return http.del(`/api/v1/channels/${id}/subscribe`) },                          // 204
  },

  /* ---------- calls (voice / video) ----------
     The server owns the lifecycle (ring → answer → end) and is a BLIND RELAY
     for WebRTC signalling. Media never touches it — audio/video is
     peer-to-peer, so a TURN/SFU in front is deployment config, not this API.
     One live call per conversation; starting one rings every other member. */
  calls: {
    /** Start, or join the in-progress call. → 201 CallResponse */
    async start(convId, type = 'VOICE') {
      return callFrom(await http.post(`/api/v1/conversations/${convId}/calls`, { type }))
    },
    async get(callId)      { return callFrom(await http.get(`/api/v1/calls/${callId}`)) },
    async accept(callId)   { return callFrom(await http.post(`/api/v1/calls/${callId}/accept`, {})) },
    decline(callId)        { return http.post(`/api/v1/calls/${callId}/decline`, {}) },                   // 200
    end(callId)            { return http.post(`/api/v1/calls/${callId}/end`, {}) },                       // 204
    /** Relay ONE WebRTC frame to a peer. `payload` is opaque — stringify SDP
     *  / ICE yourself; the server passes it through verbatim. */
    signal(callId, { toUserId, kind, payload } = {}) {
      return http.post(`/api/v1/calls/${callId}/signal`, { toUserId, kind, payload })
    },
  },

  /* ---------- live streaming ----------
     This app owns the lifecycle, the viewer registry, discovery and live chat.
     The A/V itself is ingested to and served from an EXTERNAL media server
     (RTMP/WebRTC in, HLS/WebRTC out) addressed by the per-stream secret in
     `ingestUrl` — which is host-only and null for viewers. */
  streams: {
    async start({ title, description } = {}) {
      return liveStreamFrom(await http.post('/api/v1/streams', { title, description: description || undefined }))
    },
    /** Currently-live streams, most-watched first. */
    async live(opts) {
      const rows = await http.get('/api/v1/streams/live', undefined, opts)
      return (rows || []).map(liveStreamFrom).filter(Boolean)
    },
    async get(id)          { return liveStreamFrom(await http.get(`/api/v1/streams/${id}`)) },
    end(id)                { return http.post(`/api/v1/streams/${id}/end`, {}) },                         // 204, host only
    /** Registers presence (drives viewerCount) and returns `playbackUrl`. */
    async join(id)         { return liveStreamFrom(await http.post(`/api/v1/streams/${id}/join`, {})) },
    /** `beacon: true` survives the document being torn down (`pagehide`) —
     *  a closed tab otherwise leaves a phantom viewer inflating `viewerCount`
     *  until the server's own expiry sweep catches it. */
    leave(id, { beacon = false } = {}) {
      return http.post(`/api/v1/streams/${id}/leave`, {}, { keepalive: beacon })                          // 204
    },
    /** Ephemeral — broadcast only, never persisted, so late joiners see none
     *  of it. Rate-limited to 20 / 10s; you must join (or host) first. */
    chat(id, text)         { return http.post(`/api/v1/streams/${id}/chat`, { text }) },
  },

  /* ---------- group membership ---------- */
  members: {
    /** Default size 30 — the documented server default for this list, kept in
     *  sync so an argument-less call and a bare GET agree. Every real call
     *  site passes an explicit size anyway (the info panel asks for 256, the
     *  whole-roster cutoff). */
    async list(convId, { page = 0, size = 30 } = {}) {
      return pageOf(await http.get(`/api/v1/conversations/${convId}/members`, { page, size }), memberFrom)
    },
    add(convId, userIds)                { return http.post(`/api/v1/conversations/${convId}/members`, { userIds }) },
    remove(convId, userId)              { return http.del(`/api/v1/conversations/${convId}/members/${userId}`) },
    setRole(convId, userId, role)       { return http.post(`/api/v1/conversations/${convId}/members/${userId}/role`, { role }) },        // ADMIN | MEMBER
    restrict(convId, userId, restricted){ return http.post(`/api/v1/conversations/${convId}/members/${userId}/restrict`, { restricted: !!restricted }) },
    leave(convId)                       { return http.post(`/api/v1/conversations/${convId}/leave`, {}) },
    transferOwner(convId, newOwnerId)   { return http.post(`/api/v1/conversations/${convId}/transfer-owner`, { newOwnerId }) },
    /** → { conversationId, token, expiresAt, maxUses, useCount } — kept raw (no view shape needed). */
    createInvite(convId, { expiresInHours, maxUses } = {}) {
      return http.post(`/api/v1/conversations/${convId}/invite-link`, {
        expiresInHours: expiresInHours ?? undefined, maxUses: maxUses ?? undefined,
      })
    },
    revokeInvite(convId)                { return http.del(`/api/v1/conversations/${convId}/invite-link`) },
    async join(token)                   { return convoFrom(await http.post('/api/v1/conversations/join', { token })) },
  },

  /* ---------- message requests (strangers get 3 pre-acceptance messages) ---------- */
  requests: {
    async list({ status = 'PENDING', page = 0, size = 20 } = {}) {
      return pageOf(await http.get('/api/v1/message-requests', { status, page, size }), requestFrom)
    },
    async count()   { const r = await http.get('/api/v1/message-requests/count'); return r?.count ?? 0 },
    accept(id)      { return http.post(`/api/v1/message-requests/${id}/accept`, {}) },
    decline(id)     { return http.post(`/api/v1/message-requests/${id}/decline`, {}) },
    block(id)       { return http.post(`/api/v1/message-requests/${id}/block`, {}) },
  },

  /* ---------- realtime + misc ---------- */
  /** Batch presence lookup. Empty input short-circuits (never send `userIds=`). */
  async presence(userIds) {
    const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean)
    if (!ids.length) return []
    return presenceFrom(await http.get('/api/v1/presence', { userIds: ids.join(',') }))
  },
  /** `activity` (TYPING | RECORDING_VOICE | SENDING_PHOTO | SENDING_VIDEO |
   *  SENDING_VOICE | SENDING_FILE) is an optional extra the receiver renders
   *  Telegram-style; servers that only know `isTyping` simply ignore it. */
  typing(convId, isTyping, activity) {
    return http.post(`/api/v1/conversations/${convId}/typing`, {
      isTyping: !!isTyping, ...(isTyping && activity ? { activity } : {}),
    })
  },
  async unreadCount()      { const r = await http.get('/api/v1/messaging/unread-count'); return r?.count ?? 0 },
  async searchAll(q, limit = 30, opts) {
    const rows = await http.get('/api/v1/messaging/search', { q, limit: clampLimit(limit, 30) }, opts)
    return (rows || []).map(msgFrom)
  },

  /** Idempotency key for a send. randomUUID is unavailable on older Safari and
   *  in non-secure contexts, so fall back to time + randomness. */
  newNonce() {
    const uuid = globalThis.crypto?.randomUUID?.()
    if (uuid) return uuid
    return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  },

  stream,
}
