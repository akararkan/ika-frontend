/* =========================================================
   Mock handlers — chat & channels (/api/v1/conversations,
   /messages, /messaging, /message-requests, /channels)
   ---------------------------------------------------------
   These return the JAVA DTO shapes, not view shapes: every
   response still travels src/api/chat.js (`convoFrom`, `msgFrom`,
   `channelFrom`, …) exactly as a real one does. Read the header of
   src/api/chat.js before changing anything here — in particular:

   · conversations / members / requests page as a Spring `Page`;
     MESSAGES page by CURSOR ({ items, nextCursor, hasMore }),
     newest → older.
   · `messageId` is a Snowflake long. It does not survive a JS
     double, so every id in the fixture is an exact decimal STRING
     and stays one all the way out. Never Number() one.
   · counters that are `null` OUTSIDE a channel (views / forwards /
     comments) must stay null, not 0 — the renderers test `!= null`.

   Writes mutate the fixture in memory: sending, reacting, starring,
   pinning, voting, subscribing, approving a join request all stick
   until the page is reloaded.
   ========================================================= */
import { page, paging, mockError, agoIso, seeded, NO_CONTENT } from '../util.js'

/* The viewer the fixture was written around. If another slice of the
   fixture names a different signed-in user, the two ids are swapped
   throughout this domain on first use, so "my" bubbles stay mine. */
const SEED_SELF = 'u-amina'
let SELF = SEED_SELF
let started = false

/* ---------------------------------------------------------
   Fixture plumbing
   --------------------------------------------------------- */

/** Swap two user ids everywhere in this domain's slices (values only). */
function swapIds(node, a, b) {
  if (!node || typeof node !== 'object') return
  for (const k of Object.keys(node)) {
    const v = node[k]
    if (typeof v === 'string') node[k] = v === a ? b : v === b ? a : v
    else swapIds(v, a, b)
  }
}

function init(db) {
  if (started) return db
  started = true
  const me = db.me?.id || db.currentUser?.id || db.viewer?.id || db.session?.user?.id || null
  if (me && me !== SEED_SELF) {
    SELF = me
    for (const key of ['conversations', 'messages', 'channels', 'channelPosts', 'chatSettings']) {
      if (db[key]) swapIds(db[key], SEED_SELF, me)
    }
    const ppl = db.chatSettings?._people
    if (ppl && (ppl[SEED_SELF] || ppl[me])) {
      const mine = ppl[SEED_SELF]
      const theirs = ppl[me]
      if (theirs) ppl[SEED_SELF] = theirs; else delete ppl[SEED_SELF]
      if (mine) ppl[me] = mine; else delete ppl[me]
    }
  }
  db._chat = db._chat || { seq: 0, viewed: {} }
  return db
}

/** A new Snowflake, above every id in the fixture and still exact. */
const nextId = (db) => String(355460000000090000n + BigInt(++db._chat.seq))

const convo = (db, id) => (db.conversations || []).find(c => c.id === id) || null
const channel = (db, id) => (db.channels || []).find(c => c.id === id) || null

/** The message log of a conversation. A CHANNEL's log is its posts. */
function thread(db, id) {
  if (db.messages?.[id]) return db.messages[id]
  if (db.channelPosts?.[id]) return db.channelPosts[id]
  db.messages = db.messages || {}
  db.messages[id] = []
  return db.messages[id]
}

/** Every message row in the fixture, paired with the conversation it lives in —
 *  channel posts included, since account-wide reads (starred, search) span
 *  every conversation the viewer can read, and a channel is one of those. */
function everyThread(db) {
  const out = []
  for (const store of [db.messages, db.channelPosts]) {
    for (const [convId, list] of Object.entries(store || {})) {
      for (const m of list) out.push({ m, convId })
    }
  }
  return out
}

/** Every message row in the fixture, with the conversation it lives in. */
function findMessage(db, messageId) {
  const id = String(messageId)
  for (const [convId, list] of Object.entries(db.messages || {})) {
    const m = list.find(x => String(x.messageId) === id)
    if (m) return { m, list, convId }
  }
  for (const [convId, list] of Object.entries(db.channelPosts || {})) {
    const m = list.find(x => String(x.messageId) === id)
    if (m) return { m, list, convId }
  }
  return null
}

/** Identity for an embedded username/fullName pair.
 *
 *  The USERS slice owns profiles, so it is asked FIRST: a chat bubble that said
 *  "Amina Rashid" while her profile page said "Amina Tahir" would be a fixture
 *  bug you only notice in a screenshot. `chatSettings._people` is the fallback
 *  for a build where the users slice was not merged (and for anyone this domain
 *  references who has no account row). */
function person(db, userId) {
  const u = (db.users || []).find(x => x?.id === userId)
  if (u) {
    const full = u.profile?.displayName
      || [u.fname, u.lname].filter(Boolean).join(' ').trim()
      || u.fullName || u.name || u.username || String(userId || '')
    return { username: u.username || String(userId || '').replace(/^u-/, ''), fullName: full }
  }
  const p = db.chatSettings?._people?.[userId]
  if (p) return { username: p.username, fullName: p.fullName }
  return {
    username: String(userId || '').replace(/^u-/, ''),
    fullName: String(userId || ''),
  }
}

/** "Sign messages" is composed SERVER-SIDE as `"@" + username` (MessageService)
 *  — never a human label, and never localised. Computing it here instead of
 *  storing it keeps it in step with whatever the users slice calls the poster. */
function signatureOf(db, m, convId) {
  const ch = channel(db, convId)
  if (!ch?.settings?.signMessages) return null
  if ((m.type || 'TEXT') === 'SYSTEM') return null
  return '@' + person(db, m.senderId).username
}

/** MediaRefResponse. `_clip` swaps in a bundled, offline-playable data URI so a
 *  mocked voice note really plays; the key itself never reaches the wire. */
function mediaDto(db, x) {
  if (!x || !x._clip) return x
  const { _clip, ...rest } = x
  return { ...rest, url: db.chatSettings?._clips?.[_clip] || rest.url || null }
}

/** ParticipantSummary. */
function participant(db, userId) {
  if (!userId) return null
  const p = person(db, userId)
  return { userId, username: p.username, fullName: p.fullName }
}

/** `_lastReadIdx` convention: >= 0 an index, -1 "read to the end",
 *  anything lower "nothing read yet" (the backend's 0). */
function marker(list, idx) {
  if (!list.length) return 0
  if (idx == null || idx === -1) return list[list.length - 1].messageId
  if (idx < -1) return 0
  return list[Math.min(idx, list.length - 1)].messageId
}

/* ---------------------------------------------------------
   DTO builders
   --------------------------------------------------------- */

/** What the server writes into `lastMessagePreview` for a non-text row. */
const TYPE_PREVIEW = {
  IMAGE: { en: 'Photo', ar: 'صورة', ku: 'وێنە', tr: 'Fotoğraf' },
  VIDEO: { en: 'Video', ar: 'فيديو', ku: 'ڤیدیۆ', tr: 'Video' },
  VOICE: { en: 'Voice message', ar: 'رسالة صوتية', ku: 'پەیامی دەنگی', tr: 'Sesli mesaj' },
  AUDIO: { en: 'Audio', ar: 'ملف صوتي', ku: 'دەنگ', tr: 'Ses' },
  FILE: { en: 'File', ar: 'ملف', ku: 'فایل', tr: 'Dosya' },
  POLL: { en: 'Poll', ar: 'استطلاع', ku: 'ڕاپرسی', tr: 'Anket' },
  LOCATION: { en: 'Location', ar: 'موقع', ku: 'شوێن', tr: 'Konum' },
  CONTACT: { en: 'Contact', ar: 'جهة اتصال', ku: 'پەیوەندی', tr: 'Kişi' },
  DELETED: { en: 'This message was deleted', ar: 'حُذفت هذه الرسالة', ku: 'ئەم پەیامە سڕایەوە', tr: 'Bu mesaj silindi' },
}
const t = (key, lang) => TYPE_PREVIEW[key]?.[lang] || TYPE_PREVIEW[key]?.en || ''

function preview(m, lang) {
  if (!m) return ''
  if (m.deleted) return t('DELETED', lang)
  if (m.body) return String(m.body).slice(0, 120)
  return t(m.type, lang)
}

/** PollResponse. Quiz answers stay hidden until the viewer votes or it closes. */
function pollDto(p) {
  if (!p) return null
  const revealed = !!p.closed || (p.myVotes || []).length > 0
  return {
    question: p.question || '',
    options: (p.options || []).map((o, i) => ({
      index: o.index ?? i, text: o.text || '', voterCount: o.voterCount ?? 0,
    })),
    allowsMultipleAnswers: !!p.allowsMultipleAnswers,
    anonymous: p.anonymous !== false,
    quiz: !!p.quiz,
    correctOptionIndex: p.quiz && !revealed ? null : (p.correctOptionIndex ?? null),
    explanation: p.quiz && !revealed ? null : (p.explanation || null),
    closed: !!p.closed,
    totalVoters: p.totalVoters ?? 0,
    myVotes: p.myVotes || [],
  }
}

/** ReplyPreview, built from the quoted row so it follows edits and deletes. */
function replyDto(db, convId, replyToId) {
  if (!replyToId) return null
  const hit = thread(db, convId).find(x => String(x.messageId) === String(replyToId))
  if (!hit) return null
  return {
    messageId: hit.messageId,
    senderId: hit.senderId,
    type: hit.type || 'TEXT',
    snippet: hit.deleted ? '' : String(hit.body || '').slice(0, 90),
    deleted: !!hit.deleted,
  }
}

/** MessageResponse. */
function msgDto(db, m, convId) {
  const cid = convId || m.conversationId
  const p = person(db, m.senderId)
  return {
    messageId: m.messageId,
    conversationId: cid,
    senderId: m.senderId,
    senderUsername: p.username,
    senderFullName: p.fullName,
    type: m.type || 'TEXT',
    body: m.deleted ? '' : (m.body || ''),
    media: m.deleted ? [] : (m.media || []).map(x => mediaDto(db, x)),
    replyToId: m.replyToId ?? null,
    replyTo: replyDto(db, cid, m.replyToId),
    forwardedFrom: m.forwardedFrom ?? null,
    mentions: m.mentions || [],
    reactions: m.deleted ? [] : (m.reactions || []),
    editedAt: m._editedAgo == null ? null : agoIso(m._editedAgo),
    deleted: !!m.deleted,
    systemEvent: m.systemEvent || null,
    createdAt: agoIso(m._ago ?? 0),
    starred: !!m.starred,
    /* Hashtags are re-extracted on every write and every edit, in EVERY
       conversation type — not only in channels (Hashtags.extract in
       MessageService). Derived here so a fixture body and its tags can't drift. */
    tags: m.tags || hashtagsOf(m.deleted ? '' : m.body),
    authorSignature: signatureOf(db, m, cid),
    /* null OUTSIDE a channel — "this counter does not exist here". */
    views: m.views ?? null,
    forwards: m.forwards ?? null,
    comments: m.comments ?? null,
    poll: pollDto(m.poll),
    location: m.location || null,
    contact: m.contact || null,
  }
}

/** ConversationResponse. */
function convoDto(db, c, lang) {
  const list = thread(db, c.id)
  const last = list[list.length - 1] || null
  return {
    id: c.id,
    type: c.type || 'DIRECT',
    title: c.title || null,
    description: c.description || null,
    avatarKey: c.avatarKey || null,
    avatarUrl: c.avatarUrl || null,
    ownerId: c.ownerId || null,
    memberCount: c.memberCount ?? 2,
    lastMessageId: last ? last.messageId : 0,
    lastMessageAt: agoIso(last ? (last._ago ?? 0) : (c._createdAgo ?? 0)),
    lastMessagePreview: preview(last, lang),
    groupSettings: c.groupSettings || null,
    disappearingSeconds: c.disappearingSeconds ?? 0,
    myRole: c.myRole || 'MEMBER',
    myStatus: c.myStatus || 'ACTIVE',
    lastReadMessageId: marker(list, c._lastReadIdx),
    lastDeliveredMessageId: last ? last.messageId : 0,
    unreadCount: c.unreadCount ?? 0,
    hasUnread: !!c.hasUnread,
    markedUnread: !!c.markedUnread,
    /* An instant, not a flag — a past value is a mute that has lapsed. */
    mutedUntil: c._mutedForMinutes ? agoIso(-c._mutedForMinutes) : null,
    pinned: !!c.pinned,
    archived: !!c.archived,
    peer: c._peerId ? participant(db, c._peerId) : null,
    peerLastReadMessageId: c._peerId ? marker(list, c._peerReadIdx) : null,
    peerLastDeliveredMessageId: c._peerId && last ? last.messageId : null,
    createdAt: agoIso(c._createdAgo ?? 0),
  }
}

/** MemberResponse rows for a conversation (a DIRECT pair has no roster row). */
function membersOf(c) {
  if (c._members) return c._members
  return [
    { userId: SELF, role: 'MEMBER', status: 'ACTIVE', _joinedAgo: c._createdAgo },
    { userId: c._peerId, role: 'MEMBER', status: 'ACTIVE', _joinedAgo: c._createdAgo },
  ].filter(m => m.userId)
}

function memberDto(db, m) {
  const p = person(db, m.userId)
  return {
    userId: m.userId,
    username: p.username,
    fullName: p.fullName,
    role: m.role || 'MEMBER',
    status: m.status || 'ACTIVE',
    joinedAt: agoIso(m._joinedAgo ?? 0),
  }
}

/** ChannelResponse. */
function channelDto(db, ch) {
  const posts = db.channelPosts?.[ch.id] || []
  return {
    id: ch.id,
    handle: ch.handle || '',
    title: ch.title || '',
    description: ch.description || '',
    category: ch.category || '',
    publicChannel: ch.publicChannel !== false,
    verified: !!ch.verified,
    subscriberCount: ch.subscriberCount ?? 0,
    postCount: posts.length || ch.postCount || 0,
    ownerId: ch.ownerId || null,
    subscribed: !!ch.subscribed,
    pendingJoinRequest: !!ch.pendingJoinRequest,
    myRole: ch.myRole || null,
    avatarUrl: ch.avatarUrl || null,
    coverUrl: ch.coverUrl || null,
    settings: ch.settings || null,
    linkedGroupId: ch.linkedGroupId || null,
    createdAt: agoIso(ch._createdAgo ?? 0),
    shareUrl: ch.publicChannel === false ? null : (ch.shareUrl || null),
  }
}

/** MessageRequestResponse — a stranger's pre-acceptance thread. */
function requestDto(db, c) {
  const r = c._messageRequest
  const list = thread(db, c.id)
  const p = person(db, r.requesterId)
  return {
    id: r.id,
    conversationId: c.id,
    requesterId: r.requesterId,
    requesterUsername: p.username,
    requesterFullName: p.fullName,
    status: r.status || 'PENDING',
    firstMessageId: list[0]?.messageId ?? 0,
    messageCount: list.length,
    createdAt: agoIso(r._createdAgo ?? 0),
  }
}

/* ---------------------------------------------------------
   Shared list helpers
   --------------------------------------------------------- */

/** The inbox: pinned first, then newest activity. Pending message requests and
 *  archived threads are not part of it. */
function inbox(db, { archived = false } = {}) {
  return (db.conversations || [])
    .filter(c => !!c.archived === archived)
    .filter(c => c._messageRequest?.status !== 'PENDING')
    .sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1
      return lastAgo(db, a) - lastAgo(db, b)
    })
}

function lastAgo(db, c) {
  const list = thread(db, c.id)
  const last = list[list.length - 1]
  return last ? (last._ago ?? 0) : (c._createdAgo ?? 0)
}

/** Cursor page over a message log, newest → older (Cassandra shape). */
function messagePage(list, query = {}) {
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 40))
  const desc = list.slice().reverse()
  let from = 0
  if (query.cursor) {
    const i = desc.findIndex(m => String(m.messageId) === String(query.cursor))
    from = i >= 0 ? i + 1 : 0
  }
  const slice = desc.slice(from, from + limit)
  const hasMore = from + slice.length < desc.length
  return {
    items: slice,
    nextCursor: hasMore ? slice[slice.length - 1]?.messageId ?? null : null,
    hasMore,
  }
}

/** Search and pinned drop tombstoned and SYSTEM rows server-side. */
const searchable = (m) => !m.deleted && m.type !== 'SYSTEM'

const matches = (m, q) => String(m.body || '').toLowerCase().includes(String(q || '').toLowerCase())

/** Append a row and refresh the conversation's own counters. */
function appendMessage(db, convId, row) {
  const list = thread(db, convId)
  list.push(row)
  const c = convo(db, convId)
  if (c && row.senderId === SELF) {
    c._lastReadIdx = -1
    c.unreadCount = 0
    c.hasUnread = false
    c.markedUnread = false
  }
  return row
}

/** Build the row a send/upload/forward writes into the log. */
function newRow(db, convId, patch) {
  return {
    messageId: nextId(db),
    conversationId: convId,
    senderId: SELF,
    type: 'TEXT',
    body: '',
    _ago: 0,
    reactions: [],
    ...patch,
  }
}

/* ---------------------------------------------------------
   Routes
   --------------------------------------------------------- */

const P = '\\/api\\/v1'
const re = (s) => new RegExp(`^${P}${s}$`)

export const routes = [
  /* ===== conversations ================================================= */

  {
    m: 'GET', p: re('\\/conversations'),
    fn: (db, { query, lang }) => {
      init(db)
      return page(inbox(db).map(c => convoDto(db, c, lang)), paging(query))
    },
  },
  {
    m: 'GET', p: re('\\/conversations\\/archived'),
    fn: (db, { query, lang }) => {
      init(db)
      return page(inbox(db, { archived: true }).map(c => convoDto(db, c, lang)), paging(query))
    },
  },

  /* Redeem an invite token. `PENDING_APPROVAL` is a SUCCESS arm and carries a
     null conversation — ChatJoinPage renders "Request sent" for it. */
  {
    m: 'POST', p: re('\\/conversations\\/join'),
    fn: (db, { body, lang }) => {
      init(db)
      const token = String(body?.token || '')
      if (!token) throw mockError(400, 'INVALID_TOKEN', 'This invite link is not valid.')
      /* Resolve the token back to the link that minted it, so redeeming the
         invite you just created joins THAT thread rather than a fixed one. A
         token from outside the fixture still lands somewhere joinable, which is
         what a pasted demo link needs. */
      const found = redeemable(db, token)
      const row = found?.row || null
      if (row?.revoked) throw mockError(410, 'INVITE_REVOKED', 'This invite link has been revoked.')
      if (row && row.maxUses != null && (row.useCount ?? 0) >= row.maxUses) {
        throw mockError(410, 'INVITE_EXHAUSTED', 'This invite link has reached its limit.')
      }
      if (row) row.useCount = (row.useCount ?? 0) + 1
      /* PENDING_APPROVAL is a SUCCESS arm: the use is consumed and a join
         request is filed, so `conversation` is null and the caller must branch
         on `status`. */
      if (row?.requiresApproval || (!row && /req|approve/i.test(token))) {
        return { status: 'PENDING_APPROVAL', conversation: null }
      }
      const c = convo(db, found?.holder?.id) || convo(db, 'c-grp-kurdology')
      if (!c) throw mockError(404, 'INVITE_NOT_FOUND', 'This invite link has expired.')
      c.archived = false
      const ch = channel(db, c.id)
      if (ch && !ch.subscribed) { ch.subscribed = true; ch.myRole = ch.myRole || 'MEMBER' }
      return { status: 'JOINED', conversation: convoDto(db, c, lang) }
    },
  },

  /* DIRECT is get-or-create; GROUP creates a fresh row. */
  {
    m: 'POST', p: re('\\/conversations'),
    fn: (db, { body, lang }) => {
      init(db)
      if (body?.type === 'GROUP') {
        const id = `c-grp-new-${++db._chat.seq}`
        const members = [SELF, ...(body.memberIds || [])].filter((v, i, a) => a.indexOf(v) === i)
        const c = {
          id, type: 'GROUP', title: body.title || 'Group', description: body.description || '',
          ownerId: SELF, memberCount: members.length, myRole: 'OWNER', myStatus: 'ACTIVE',
          unreadCount: 0, hasUnread: false, pinned: false, archived: false,
          disappearingSeconds: 0, _createdAgo: 0, _lastReadIdx: -1,
          _members: members.map(u => ({ userId: u, role: u === SELF ? 'OWNER' : 'MEMBER', status: 'ACTIVE', _joinedAgo: 0 })),
        }
        db.conversations.unshift(c)
        thread(db, id)
        return convoDto(db, c, lang)
      }
      const peer = body?.recipientId
      if (!peer) throw mockError(400, 'BAD_REQUEST', 'recipientId is required for a DIRECT conversation.')
      const existing = (db.conversations || []).find(c => c.type === 'DIRECT' && c._peerId === peer)
      if (existing) return convoDto(db, existing, lang)
      const c = {
        id: `c-dm-new-${peer}`, type: 'DIRECT', _peerId: peer, memberCount: 2,
        myRole: 'MEMBER', myStatus: 'ACTIVE', unreadCount: 0, hasUnread: false,
        pinned: false, archived: false, disappearingSeconds: 0,
        _createdAgo: 0, _lastReadIdx: -1, _peerReadIdx: -2,
      }
      db.conversations.unshift(c)
      thread(db, c.id)
      return convoDto(db, c, lang)
    },
  },

  /* ---- messages (cursor paged) ---- */
  {
    m: 'GET', p: re('\\/conversations\\/([^/]+)\\/messages'),
    fn: (db, { params, query }) => {
      init(db)
      if (!convo(db, params[0]) && !db.channelPosts?.[params[0]]) throw mockError(404, 'CONVERSATION_NOT_FOUND')
      const res = messagePage(thread(db, params[0]), query)
      return { ...res, items: res.items.map(m => msgDto(db, m, params[0])) }
    },
  },
  {
    m: 'GET', p: re('\\/conversations\\/([^/]+)\\/messages\\/sync'),
    fn: (db, { params, query }) => {
      init(db)
      const list = thread(db, params[0])
      const after = query.after ? String(query.after) : null
      const i = after ? list.findIndex(m => String(m.messageId) === after) : -1
      const limit = Math.min(100, Math.max(1, Number(query.limit) || 100))
      return list.slice(i + 1, i + 1 + limit).map(m => msgDto(db, m, params[0]))
    },
  },
  {
    m: 'GET', p: re('\\/conversations\\/([^/]+)\\/messages\\/search'),
    fn: (db, { params, query }) => {
      init(db)
      return thread(db, params[0])
        .filter(m => searchable(m) && matches(m, query.q))
        .reverse()
        .slice(0, Math.min(100, Number(query.limit) || 30))
        .map(m => msgDto(db, m, params[0]))
    },
  },
  /* EXACT tag match — a lookup, not a search. */
  {
    m: 'GET', p: re('\\/conversations\\/([^/]+)\\/messages\\/by-tag'),
    fn: (db, { params, query }) => {
      init(db)
      const tag = String(query.tag || '').replace(/^#/, '').toLowerCase()
      return thread(db, params[0])
        .filter(m => (m.tags || []).some(x => String(x).toLowerCase() === tag))
        .reverse()
        .map(m => msgDto(db, m, params[0]))
    },
  },
  {
    m: 'POST', p: re('\\/conversations\\/([^/]+)\\/messages\\/schedule'),
    fn: (db, { params, body }) => {
      init(db)
      const c = convo(db, params[0])
      if (!c) throw mockError(404, 'CONVERSATION_NOT_FOUND')
      c._scheduled = c._scheduled || []
      const row = {
        id: `sch-${++db._chat.seq}`, type: body?.type || 'TEXT', body: body?.body || '',
        status: 'PENDING', replyToId: body?.replyToId ?? null,
        _scheduledAt: body?.scheduledAt || null, _createdAgo: 0,
      }
      c._scheduled.push(row)
      return scheduledDto(c.id, row)
    },
  },
  {
    m: 'GET', p: re('\\/conversations\\/([^/]+)\\/scheduled'),
    fn: (db, { params }) => {
      init(db)
      const c = convo(db, params[0])
      return (c?._scheduled || []).filter(s => s.status === 'PENDING').map(s => scheduledDto(c.id, s))
    },
  },
  /* Multipart send. The picked File is turned into an object URL so the
     attachment the demo just sent actually renders. */
  {
    m: 'POST', p: re('\\/conversations\\/([^/]+)\\/messages\\/upload'),
    fn: (db, { params, body }) => {
      init(db)
      const files = typeof body?.getAll === 'function' ? body.getAll('files') : []
      const text = typeof body?.get === 'function' ? body.get('body') : ''
      const replyToId = typeof body?.get === 'function' ? body.get('replyToId') : null
      const durationMs = typeof body?.get === 'function' ? body.get('durationMs') : null
      const media = files.map(f => {
        const mime = f?.type || ''
        const kind = /^image\//.test(mime) ? 'IMAGE' : /^video\//.test(mime) ? 'VIDEO' : /^audio\//.test(mime) ? 'VOICE' : 'FILE'
        return {
          kind, storageKey: `chat/mock/${f?.name || 'file'}`,
          url: typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(f) : null,
          mime, bytes: f?.size ?? 0, fileName: f?.name || 'file',
          durationMs: kind === 'VOICE' && durationMs ? Number(durationMs) : null,
        }
      })
      const first = media[0]?.kind || 'FILE'
      const row = newRow(db, params[0], {
        type: first === 'IMAGE' ? 'IMAGE' : first === 'VIDEO' ? 'VIDEO' : first === 'VOICE' ? 'VOICE' : 'FILE',
        body: text || '', media, replyToId: replyToId || null,
      })
      return msgDto(db, appendMessage(db, params[0], row), params[0])
    },
  },
  {
    m: 'POST', p: re('\\/conversations\\/([^/]+)\\/messages'),
    fn: (db, { params, body }) => {
      init(db)
      const c = convo(db, params[0])
      const ch = channel(db, params[0])
      /* A channel is admins-only: the composer is locked for subscribers, and
         the server answers the same way if one gets past it. */
      if (ch && !(ch.myRole === 'OWNER' || ch.myRole === 'ADMIN')) {
        throw mockError(403, 'SEND_NOT_ALLOWED', 'Only channel admins can post here.')
      }
      if (c?.groupSettings?.sendMode === 'ADMINS_ONLY' && c.myRole === 'MEMBER') {
        throw mockError(403, 'SEND_NOT_ALLOWED', 'Only admins can post in this group.')
      }
      const type = body?.type || 'TEXT'
      const row = newRow(db, params[0], {
        type,
        body: body?.body || '',
        replyToId: body?.replyToId ?? null,
        media: body?.media || [],
        poll: type === 'POLL' && body?.poll
          ? {
              question: body.poll.question || '',
              options: (body.poll.options || []).map((o, i) => ({ index: i, text: typeof o === 'string' ? o : o?.text || '', voterCount: 0 })),
              allowsMultipleAnswers: !!body.poll.allowsMultipleAnswers,
              anonymous: body.poll.anonymous !== false,
              quiz: !!body.poll.quiz,
              correctOptionIndex: body.poll.correctOptionIndex ?? null,
              explanation: body.poll.explanation || '',
              closed: false, totalVoters: 0, myVotes: [],
            }
          : undefined,
        location: type === 'LOCATION' ? body?.location : undefined,
        contact: type === 'CONTACT' ? body?.contact : undefined,
        /* The three counters only exist inside a channel — outside one they
           stay ABSENT so msgDto can emit null (never 0). Tags and the author
           signature are derived in msgDto, for every conversation type. */
        ...(ch ? { views: 1, forwards: 0, comments: ch.linkedGroupId ? 0 : null } : {}),
      })
      return msgDto(db, appendMessage(db, params[0], row), params[0])
    },
  },
  {
    m: 'GET', p: re('\\/conversations\\/([^/]+)\\/pinned'),
    fn: (db, { params }) => {
      init(db)
      const c = convo(db, params[0])
      const ids = (c?._pinnedIds || []).map(String)
      return thread(db, params[0])
        .filter(m => ids.includes(String(m.messageId)) && searchable(m))
        .map(m => msgDto(db, m, params[0]))
    },
  },
  /* The shared-media gallery: one row per attachment-carrying message. */
  {
    m: 'GET', p: re('\\/conversations\\/([^/]+)\\/media'),
    fn: (db, { params, query }) => {
      init(db)
      const kind = query.kind ? String(query.kind).toUpperCase() : null
      return thread(db, params[0])
        .filter(m => (m.media || []).length && !m.deleted)
        .filter(m => !kind || (m.media || []).some(x => x.kind === kind))
        .reverse()
        .slice(0, Math.min(100, Number(query.limit) || 40))
        .map(m => msgDto(db, m, params[0]))
    },
  },

  /* ---- drafts (per conversation, per user) ---- */
  {
    m: 'GET', p: re('\\/conversations\\/([^/]+)\\/draft'),
    fn: (db, { params }) => {
      init(db)
      const c = convo(db, params[0])
      if (!c?._draft) throw mockError(404, 'DRAFT_NOT_FOUND', 'No draft saved.')
      return draftDto(c.id, c._draft)
    },
  },
  {
    m: 'PUT', p: re('\\/conversations\\/([^/]+)\\/draft'),
    fn: (db, { params, body }) => {
      init(db)
      const c = convo(db, params[0])
      if (!c) throw mockError(404, 'CONVERSATION_NOT_FOUND')
      c._draft = { body: body?.body || '', media: body?.media || [], replyToId: body?.replyToId ?? null, _updatedAgo: 0 }
      return draftDto(c.id, c._draft)
    },
  },
  {
    m: 'DELETE', p: re('\\/conversations\\/([^/]+)\\/draft'),
    fn: (db, { params }) => {
      init(db)
      const c = convo(db, params[0])
      if (c) delete c._draft
      return NO_CONTENT
    },
  },

  /* ---- members ---- */
  {
    m: 'GET', p: re('\\/conversations\\/([^/]+)\\/members'),
    fn: (db, { params, query }) => {
      init(db)
      const c = convo(db, params[0])
      if (!c) throw mockError(404, 'CONVERSATION_NOT_FOUND')
      const ch = channel(db, params[0])
      /* `hiddenSubscribers` is enforced, not decorative — the roster 403s for a
         non-admin and ConversationInfo renders that as a quiet note. */
      if (ch?.settings?.hiddenSubscribers && !(ch.myRole === 'OWNER' || ch.myRole === 'ADMIN')) {
        throw mockError(403, 'SUBSCRIBERS_HIDDEN', 'This channel hides its subscriber list.')
      }
      return page(membersOf(c).map(m => memberDto(db, m)), paging({ size: 30, ...query }))
    },
  },
  {
    m: 'POST', p: re('\\/conversations\\/([^/]+)\\/members'),
    fn: (db, { params, body }) => {
      init(db)
      const c = convo(db, params[0])
      if (!c) throw mockError(404, 'CONVERSATION_NOT_FOUND')
      c._members = c._members || membersOf(c)
      for (const id of body?.userIds || []) {
        if (!c._members.some(m => m.userId === id)) {
          c._members.push({ userId: id, role: 'MEMBER', status: 'ACTIVE', _joinedAgo: 0 })
          c.memberCount = (c.memberCount ?? 0) + 1
        }
      }
      return NO_CONTENT
    },
  },
  {
    m: 'DELETE', p: re('\\/conversations\\/([^/]+)\\/members\\/([^/]+)'),
    fn: (db, { params }) => {
      init(db)
      const c = convo(db, params[0])
      if (!c?._members) return NO_CONTENT
      const i = c._members.findIndex(m => m.userId === params[1])
      if (i >= 0) { c._members.splice(i, 1); c.memberCount = Math.max(0, (c.memberCount ?? 1) - 1) }
      return NO_CONTENT
    },
  },
  {
    m: 'POST', p: re('\\/conversations\\/([^/]+)\\/members\\/([^/]+)\\/role'),
    fn: (db, { params, body }) => {
      init(db)
      const m = (convo(db, params[0])?._members || []).find(x => x.userId === params[1])
      if (m) m.role = body?.role === 'ADMIN' ? 'ADMIN' : 'MEMBER'
      return NO_CONTENT
    },
  },
  {
    m: 'POST', p: re('\\/conversations\\/([^/]+)\\/members\\/([^/]+)\\/restrict'),
    fn: (db, { params, body }) => {
      init(db)
      const m = (convo(db, params[0])?._members || []).find(x => x.userId === params[1])
      if (m) m.status = body?.restricted ? 'RESTRICTED' : 'ACTIVE'
      return NO_CONTENT
    },
  },
  {
    m: 'POST', p: re('\\/conversations\\/([^/]+)\\/leave'),
    fn: (db, { params }) => {
      init(db)
      const i = (db.conversations || []).findIndex(c => c.id === params[0])
      if (i >= 0) db.conversations.splice(i, 1)
      return NO_CONTENT
    },
  },
  {
    m: 'POST', p: re('\\/conversations\\/([^/]+)\\/transfer-owner'),
    fn: (db, { params, body }) => {
      init(db)
      const c = convo(db, params[0])
      if (!c) throw mockError(404, 'CONVERSATION_NOT_FOUND')
      c.ownerId = body?.newOwnerId || c.ownerId
      c.myRole = 'ADMIN'
      const mine = (c._members || []).find(m => m.userId === SELF)
      if (mine) mine.role = 'ADMIN'
      const them = (c._members || []).find(m => m.userId === c.ownerId)
      if (them) them.role = 'OWNER'
      return NO_CONTENT
    },
  },

  /* ---- invite links ---- */
  {
    m: 'POST', p: re('\\/conversations\\/([^/]+)\\/invite-links'),
    fn: (db, { params, body }) => {
      init(db)
      const c = inviteHolder(db, params[0])
      if (!c) throw mockError(404, 'CONVERSATION_NOT_FOUND')
      c._invites = c._invites || []
      const row = {
        id: `inv-${++db._chat.seq}`, createdBy: SELF, _createdAgo: 0,
        _expiresInMinutes: body?.expiresInHours ? body.expiresInHours * 60 : null,
        maxUses: body?.maxUses ?? null, useCount: 0, revoked: false,
        requiresApproval: !!body?.requiresApproval,
        permanent: !body?.expiresInHours && body?.maxUses == null,
      }
      c._invites.unshift(row)
      /* The plaintext token comes back EXACTLY ONCE — only a hash is stored. */
      const token = `ika-${row.id}${row.requiresApproval ? '-req' : ''}`
      return { ...inviteDto(c.id, row), token, shareUrl: `https://ika.example/join/${token}` }
    },
  },
  {
    m: 'GET', p: re('\\/conversations\\/([^/]+)\\/invite-links'),
    fn: (db, { params }) => {
      init(db)
      const c = inviteHolder(db, params[0])
      return (c?._invites || []).map(r => inviteDto(c.id, r))
    },
  },
  {
    m: 'DELETE', p: re('\\/conversations\\/([^/]+)\\/invite-links\\/([^/]+)'),
    fn: (db, { params }) => {
      init(db)
      const row = (inviteHolder(db, params[0])?._invites || []).find(r => r.id === params[1])
      if (row) row.revoked = true
      return NO_CONTENT
    },
  },
  {
    m: 'POST', p: re('\\/conversations\\/([^/]+)\\/invite-link'),
    fn: (db, { params, body }) => {
      init(db)
      const token = `ika-legacy-${params[0]}`
      return {
        conversationId: params[0], token,
        expiresAt: body?.expiresInHours ? agoIso(-body.expiresInHours * 60) : null,
        maxUses: body?.maxUses ?? null, useCount: 0,
        shareUrl: `https://ika.example/join/${token}`,
      }
    },
  },
  { m: 'DELETE', p: re('\\/conversations\\/([^/]+)\\/invite-link'), fn: () => NO_CONTENT },

  /* ---- per-conversation switches ---- */
  {
    m: 'POST', p: re('\\/conversations\\/([^/]+)\\/read'),
    fn: (db, { params, body }) => {
      init(db)
      const c = convo(db, params[0])
      if (!c) return NO_CONTENT
      const list = thread(db, params[0])
      const i = body?.lastReadMessageId
        ? list.findIndex(m => String(m.messageId) === String(body.lastReadMessageId))
        : -1
      c._lastReadIdx = i >= 0 ? i : -1
      c.unreadCount = i >= 0 ? Math.max(0, list.length - 1 - i) : 0
      c.hasUnread = c.unreadCount > 0
      c.markedUnread = false
      return NO_CONTENT
    },
  },
  {
    m: 'POST', p: re('\\/conversations\\/([^/]+)\\/unread'),
    fn: (db, { params }) => {
      init(db)
      const c = convo(db, params[0])
      /* Purely personal: the count stays 0, only the dot changes. */
      if (c) { c.markedUnread = true; c.hasUnread = true }
      return NO_CONTENT
    },
  },
  {
    m: 'POST', p: re('\\/conversations\\/([^/]+)\\/mute'),
    fn: (db, { params, body }) => {
      init(db)
      const c = convo(db, params[0])
      if (!c) return NO_CONTENT
      if (body?.mutedUntil == null) delete c._mutedForMinutes
      else c._mutedForMinutes = Math.max(1, Math.round((new Date(body.mutedUntil).getTime() - Date.now()) / 60000)) || 1440
      return NO_CONTENT
    },
  },
  {
    m: 'POST', p: re('\\/conversations\\/([^/]+)\\/pin'),
    fn: (db, { params, body }) => {
      init(db)
      const c = convo(db, params[0])
      if (c) c.pinned = !!body?.pinned
      return NO_CONTENT
    },
  },
  {
    m: 'POST', p: re('\\/conversations\\/([^/]+)\\/archive'),
    fn: (db, { params, body }) => {
      init(db)
      const c = convo(db, params[0])
      if (c) c.archived = !!body?.archived
      return NO_CONTENT
    },
  },
  {
    m: 'POST', p: re('\\/conversations\\/([^/]+)\\/disappearing'),
    fn: (db, { params, body }) => {
      init(db)
      const c = convo(db, params[0])
      if (c) c.disappearingSeconds = Math.max(0, Number(body?.seconds) || 0)
      return NO_CONTENT
    },
  },
  { m: 'POST', p: re('\\/conversations\\/([^/]+)\\/typing'), fn: () => NO_CONTENT },

  /* ---- pin / unpin a message ---- */
  {
    m: 'POST', p: re('\\/conversations\\/([^/]+)\\/messages\\/([^/]+)\\/pin'),
    fn: (db, { params }) => {
      init(db)
      const c = convo(db, params[0])
      if (!c) return NO_CONTENT
      c._pinnedIds = c._pinnedIds || []
      if (!c._pinnedIds.map(String).includes(String(params[1]))) c._pinnedIds.push(params[1])
      return NO_CONTENT
    },
  },
  {
    m: 'DELETE', p: re('\\/conversations\\/([^/]+)\\/messages\\/([^/]+)\\/pin'),
    fn: (db, { params }) => {
      init(db)
      const c = convo(db, params[0])
      if (c?._pinnedIds) c._pinnedIds = c._pinnedIds.filter(id => String(id) !== String(params[1]))
      return NO_CONTENT
    },
  },

  /* ---- one conversation ---- */
  {
    m: 'GET', p: re('\\/conversations\\/([^/]+)'),
    fn: (db, { params, lang }) => {
      init(db)
      const c = convo(db, params[0])
      if (!c) throw mockError(404, 'CONVERSATION_NOT_FOUND', 'That conversation is not available to you.')
      return convoDto(db, c, lang)
    },
  },
  {
    m: 'PATCH', p: re('\\/conversations\\/([^/]+)'),
    fn: (db, { params, body, lang }) => {
      init(db)
      const c = convo(db, params[0])
      if (!c) throw mockError(404, 'CONVERSATION_NOT_FOUND')
      if (body?.title != null) c.title = body.title
      if (body?.description != null) c.description = body.description
      if (body?.settings) c.groupSettings = { ...(c.groupSettings || {}), ...body.settings }
      return convoDto(db, c, lang)
    },
  },
  /* One call, two blast radii — the server picks from your role. Either way
     the row leaves both lists here. */
  {
    m: 'DELETE', p: re('\\/conversations\\/([^/]+)'),
    fn: (db, { params }) => {
      init(db)
      const i = (db.conversations || []).findIndex(c => c.id === params[0])
      if (i >= 0) db.conversations.splice(i, 1)
      return NO_CONTENT
    },
  },

  /* ===== messages ====================================================== */

  {
    m: 'GET', p: re('\\/messages\\/([^/]+)\\/reactions'),
    fn: (db, { params }) => {
      init(db)
      const hit = findMessage(db, params[0])
      if (!hit) throw mockError(404, 'MESSAGE_NOT_FOUND')
      return hit.m.reactions || []
    },
  },
  /* Group "Seen by" — the sender is excluded, and so is anyone with read
     receipts off. An empty array is a normal answer. */
  {
    m: 'GET', p: re('\\/messages\\/([^/]+)\\/seen-by'),
    fn: (db, { params }) => {
      init(db)
      const hit = findMessage(db, params[0])
      if (!hit) throw mockError(404, 'MESSAGE_NOT_FOUND')
      const c = convo(db, hit.convId)
      if (!c || c.type === 'DIRECT') return []
      return membersOf(c)
        .filter(m => m.userId !== hit.m.senderId && m.status === 'ACTIVE')
        .filter(m => seeded(`${params[0]}:${m.userId}`) > 0.35)
        .map(m => participant(db, m.userId))
    },
  },
  {
    m: 'GET', p: re('\\/messages\\/([^/]+)'),
    fn: (db, { params }) => {
      init(db)
      const hit = findMessage(db, params[0])
      if (!hit) throw mockError(404, 'MESSAGE_NOT_FOUND')
      return msgDto(db, hit.m, hit.convId)
    },
  },
  {
    m: 'PATCH', p: re('\\/messages\\/([^/]+)'),
    fn: (db, { params, body }) => {
      init(db)
      const hit = findMessage(db, params[0])
      if (!hit) throw mockError(404, 'MESSAGE_NOT_FOUND')
      hit.m.body = body?.body || ''
      hit.m._editedAgo = 0
      hit.m.tags = hashtagsOf(hit.m.body)      // hashtags follow the body on an edit
      return msgDto(db, hit.m, hit.convId)
    },
  },
  {
    m: 'DELETE', p: re('\\/messages\\/([^/]+)'),
    fn: (db, { params, query }) => {
      init(db)
      const hit = findMessage(db, params[0])
      if (!hit) return NO_CONTENT
      if (query.scope === 'me') {
        hit.list.splice(hit.list.indexOf(hit.m), 1)
      } else {
        hit.m.deleted = true
        hit.m.body = ''
        hit.m.media = []
        hit.m.reactions = []
        hit.m.starred = false
      }
      return NO_CONTENT
    },
  },
  /* One reaction per user per message: a new emoji replaces the old one. */
  {
    m: 'POST', p: re('\\/messages\\/([^/]+)\\/react'),
    fn: (db, { params, body }) => {
      init(db)
      const hit = findMessage(db, params[0])
      if (!hit) throw mockError(404, 'MESSAGE_NOT_FOUND')
      const rows = (hit.m.reactions = hit.m.reactions || [])
      dropMine(rows)
      const emoji = body?.emoji || '👍'
      const bucket = rows.find(r => r.emoji === emoji)
      if (bucket) { bucket.count += 1; bucket.reactedByMe = true }
      else rows.push({ emoji, count: 1, reactedByMe: true })
      return rows
    },
  },
  {
    m: 'DELETE', p: re('\\/messages\\/([^/]+)\\/react'),
    fn: (db, { params }) => {
      init(db)
      const hit = findMessage(db, params[0])
      if (!hit) throw mockError(404, 'MESSAGE_NOT_FOUND')
      hit.m.reactions = hit.m.reactions || []
      dropMine(hit.m.reactions)
      return hit.m.reactions
    },
  },
  {
    m: 'POST', p: re('\\/messages\\/([^/]+)\\/forward'),
    fn: (db, { params, body }) => {
      init(db)
      const hit = findMessage(db, params[0])
      if (!hit) throw mockError(404, 'MESSAGE_NOT_FOUND')
      const target = body?.targetConversationId
      if (!convo(db, target)) throw mockError(404, 'CONVERSATION_NOT_FOUND')
      if (hit.m.views != null) hit.m.forwards = (hit.m.forwards ?? 0) + 1
      const row = newRow(db, target, {
        type: hit.m.type, body: hit.m.body, media: hit.m.media || [],
        forwardedFrom: hit.m.senderId, poll: hit.m.poll, location: hit.m.location, contact: hit.m.contact,
      })
      return msgDto(db, appendMessage(db, target, row), target)
    },
  },
  { m: 'POST', p: re('\\/messages\\/([^/]+)\\/delivered'), fn: () => NO_CONTENT },
  {
    m: 'POST', p: re('\\/messages\\/([^/]+)\\/star'),
    fn: (db, { params }) => {
      init(db)
      const hit = findMessage(db, params[0])
      if (hit) hit.m.starred = true
      return NO_CONTENT
    },
  },
  {
    m: 'DELETE', p: re('\\/messages\\/([^/]+)\\/star'),
    fn: (db, { params }) => {
      init(db)
      const hit = findMessage(db, params[0])
      if (hit) hit.m.starred = false
      return NO_CONTENT
    },
  },

  /* ---- in-post polls ---- */
  {
    m: 'POST', p: re('\\/messages\\/([^/]+)\\/poll\\/votes'),
    fn: (db, { params, body }) => {
      init(db)
      const p = pollOf(db, params[0])
      if (p.closed) throw mockError(400, 'POLL_CLOSED', 'This poll is closed.')
      const idx = (body?.optionIndexes || []).map(Number)
      const had = (p.myVotes || []).length > 0
      for (const i of p.myVotes || []) {
        const o = p.options[i]
        if (o) o.voterCount = Math.max(0, (o.voterCount || 0) - 1)
      }
      p.myVotes = p.allowsMultipleAnswers ? idx : idx.slice(0, 1)
      for (const i of p.myVotes) {
        const o = p.options[i]
        if (o) o.voterCount = (o.voterCount || 0) + 1
      }
      if (!had) p.totalVoters = (p.totalVoters || 0) + 1
      return pollDto(p)
    },
  },
  {
    m: 'DELETE', p: re('\\/messages\\/([^/]+)\\/poll\\/votes'),
    fn: (db, { params }) => {
      init(db)
      const p = pollOf(db, params[0])
      /* Quiz answers are final by design. */
      if (p.quiz) throw mockError(400, 'QUIZ_VOTE_FINAL', 'A quiz answer cannot be retracted.')
      for (const i of p.myVotes || []) {
        const o = p.options[i]
        if (o) o.voterCount = Math.max(0, (o.voterCount || 0) - 1)
      }
      if ((p.myVotes || []).length) p.totalVoters = Math.max(0, (p.totalVoters || 0) - 1)
      p.myVotes = []
      return pollDto(p)
    },
  },
  {
    m: 'POST', p: re('\\/messages\\/([^/]+)\\/poll\\/close'),
    fn: (db, { params }) => {
      init(db)
      const p = pollOf(db, params[0])
      p.closed = true
      return pollDto(p)
    },
  },

  /* ===== messaging (account-wide) ====================================== */

  {
    m: 'GET', p: re('\\/messaging\\/unread-count'),
    fn: (db) => {
      init(db)
      const count = (db.conversations || [])
        .filter(c => !c.archived && c._messageRequest?.status !== 'PENDING')
        .reduce((n, c) => n + (c.unreadCount || 0), 0)
      return { count }
    },
  },
  {
    m: 'GET', p: re('\\/messaging\\/starred'),
    fn: (db, { query }) => {
      init(db)
      /* Across ALL conversations — a channel post is a message like any other,
         so starring one has to show up here too. */
      const rows = everyThread(db)
        .filter(({ m }) => m.starred && !m.deleted)
        .sort((a, b) => (a.m._ago ?? 0) - (b.m._ago ?? 0))     // most recent first
        .map(({ m, convId }) => msgDto(db, m, convId))
      const { page: p, size } = paging({ size: 30, ...query })
      return rows.slice(p * size, p * size + size)
    },
  },
  {
    m: 'GET', p: re('\\/messaging\\/search'),
    fn: (db, { query }) => {
      init(db)
      return everyThread(db)
        .filter(({ m }) => searchable(m) && matches(m, query.q))
        .sort((a, b) => (a.m._ago ?? 0) - (b.m._ago ?? 0))
        .slice(0, Math.min(100, Number(query.limit) || 30))
        .map(({ m, convId }) => msgDto(db, m, convId))
    },
  },
  {
    m: 'GET', p: re('\\/messaging\\/settings'),
    fn: (db) => {
      init(db)
      const s = db.chatSettings || {}
      return {
        readReceiptsEnabled: s.readReceiptsEnabled !== false,
        lastSeenVisible: s.lastSeenVisible !== false,
        typingIndicatorsEnabled: s.typingIndicatorsEnabled !== false,
      }
    },
  },
  {
    m: 'PUT', p: re('\\/messaging\\/settings'),
    fn: (db, { body }) => {
      init(db)
      const s = (db.chatSettings = db.chatSettings || {})
      for (const k of ['readReceiptsEnabled', 'lastSeenVisible', 'typingIndicatorsEnabled']) {
        if (body?.[k] != null) s[k] = !!body[k]
      }
      return {
        readReceiptsEnabled: s.readReceiptsEnabled !== false,
        lastSeenVisible: s.lastSeenVisible !== false,
        typingIndicatorsEnabled: s.typingIndicatorsEnabled !== false,
      }
    },
  },
  {
    m: 'DELETE', p: re('\\/messaging\\/scheduled\\/([^/]+)'),
    fn: (db, { params }) => {
      init(db)
      for (const c of db.conversations || []) {
        const i = (c._scheduled || []).findIndex(s => s.id === params[0])
        if (i >= 0) { c._scheduled.splice(i, 1); break }
      }
      return NO_CONTENT
    },
  },
  {
    m: 'GET', p: re('\\/presence'),
    fn: (db, { query }) => {
      init(db)
      return String(query.userIds || '').split(',').filter(Boolean).map(id => {
        const online = seeded(`presence:${id}`) > 0.45
        return {
          userId: id,
          status: online ? 'online' : 'offline',
          lastSeenEpochMs: online ? Date.now() : Date.now() - Math.round(seeded(id) * 6 * 3600_000),
        }
      })
    },
  },

  /* ===== message requests ============================================== */

  {
    m: 'GET', p: re('\\/message-requests\\/count'),
    fn: (db) => {
      init(db)
      return { count: pendingRequests(db).length }
    },
  },
  {
    m: 'GET', p: re('\\/message-requests'),
    fn: (db, { query }) => {
      init(db)
      const status = query.status || 'PENDING'
      const rows = (db.conversations || [])
        .filter(c => c._messageRequest && c._messageRequest.status === status)
        .map(c => requestDto(db, c))
      return page(rows, paging(query))
    },
  },
  {
    m: 'POST', p: re('\\/message-requests\\/([^/]+)\\/(accept|decline|block)'),
    fn: (db, { params }) => {
      init(db)
      const c = (db.conversations || []).find(x => x._messageRequest?.id === params[0])
      if (!c) throw mockError(404, 'REQUEST_NOT_FOUND')
      if (params[1] === 'accept') {
        c._messageRequest.status = 'ACCEPTED'
      } else {
        c._messageRequest.status = params[1] === 'block' ? 'BLOCKED' : 'DECLINED'
        const i = db.conversations.indexOf(c)
        if (i >= 0) db.conversations.splice(i, 1)
      }
      return NO_CONTENT
    },
  },

  /* ===== channels ====================================================== */

  {
    m: 'GET', p: re('\\/channels\\/discover'),
    fn: (db, { query }) => {
      init(db)
      const q = String(query.q || '').toLowerCase()
      return (db.channels || [])
        .filter(c => c.publicChannel !== false)
        .filter(c => !query.category || c.category === query.category)
        .filter(c => !q || `${c.title} ${c.description} ${c.handle}`.toLowerCase().includes(q))
        .sort((a, b) => (b.subscriberCount || 0) - (a.subscriberCount || 0))
        .map(c => channelDto(db, c))
    },
  },
  {
    m: 'GET', p: re('\\/channels\\/by-handle\\/([^/]+)'),
    fn: (db, { params }) => {
      init(db)
      const bare = String(params[0]).replace(/^@/, '').toLowerCase()
      const ch = (db.channels || []).find(c => String(c.handle).toLowerCase() === bare)
      if (!ch) throw mockError(404, 'CHANNEL_NOT_FOUND', 'No channel at that address.')
      return channelDto(db, ch)
    },
  },
  {
    m: 'POST', p: re('\\/channels'),
    fn: (db, { body }) => {
      init(db)
      const id = `ch-new-${++db._chat.seq}`
      const ch = {
        id,
        handle: String(body?.handle || id).replace(/^@/, ''),
        title: body?.title || 'Channel',
        description: body?.description || '',
        category: body?.category || '',
        publicChannel: body?.publicChannel !== false,
        verified: false, subscriberCount: 1, postCount: 0, ownerId: SELF,
        subscribed: true, pendingJoinRequest: false, myRole: 'OWNER',
        linkedGroupId: null, _createdAgo: 0,
        settings: body?.settings || { reactionsEnabled: true, signMessages: false, joinByRequest: false },
        shareUrl: body?.publicChannel === false ? null : `https://ika.example/c/${body?.handle || id}`,
        _admins: [{ userId: SELF, role: 'OWNER', _sinceAgo: 0, rights: null }],
      }
      db.channels.unshift(ch)
      db.channelPosts[id] = []
      db.conversations.unshift({
        id, type: 'CHANNEL', title: ch.title, description: ch.description, ownerId: SELF,
        memberCount: 1, myRole: 'OWNER', myStatus: 'ACTIVE', unreadCount: 0, hasUnread: false,
        pinned: false, archived: false, disappearingSeconds: 0, _createdAgo: 0, _lastReadIdx: -1,
      })
      return channelDto(db, ch)
    },
  },
  /* ---- identity: photo, cover, verified ----
     The picked File becomes an object URL, so a photo chosen during the demo
     really appears on the channel header instead of a broken plate. */
  {
    m: 'POST', p: re('\\/channels\\/([^/]+)\\/(photo|cover)'),
    fn: (db, { params, body }) => {
      init(db)
      const ch = channel(db, params[0])
      if (!ch) throw mockError(404, 'CHANNEL_NOT_FOUND')
      const file = typeof body?.get === 'function' ? body.get('file') : null
      const url = file && typeof URL !== 'undefined' && URL.createObjectURL
        ? URL.createObjectURL(file)
        : `/uploads/channels/${ch.id}-${params[1]}.jpg`
      ch[params[1] === 'photo' ? 'avatarUrl' : 'coverUrl'] = url
      return channelDto(db, ch)
    },
  },
  {
    m: 'DELETE', p: re('\\/channels\\/([^/]+)\\/(photo|cover)'),
    fn: (db, { params }) => {
      init(db)
      const ch = channel(db, params[0])
      if (ch) ch[params[1] === 'photo' ? 'avatarUrl' : 'coverUrl'] = null
      return NO_CONTENT
    },
  },
  /* PLATFORM ROLE_ADMIN only — not the channel owner. */
  {
    m: 'PUT', p: re('\\/channels\\/([^/]+)\\/verified'),
    fn: (db, { params, query }) => {
      init(db)
      const ch = channel(db, params[0])
      if (!ch) throw mockError(404, 'CHANNEL_NOT_FOUND')
      if (db.me?.role !== 'ADMIN' && db.me?.role !== 'ROLE_ADMIN') {
        throw mockError(403, 'FORBIDDEN', 'Only platform administrators can verify a channel.')
      }
      ch.verified = String(query.verified) === 'true'
      return channelDto(db, ch)
    },
  },

  {
    m: 'GET', p: re('\\/channels\\/([^/]+)\\/admins'),
    fn: (db, { params }) => {
      init(db)
      const ch = channel(db, params[0])
      if (!ch) throw mockError(404, 'CHANNEL_NOT_FOUND')
      return (ch._admins || []).map(a => {
        const p = person(db, a.userId)
        return {
          userId: a.userId, username: p.username, fullName: p.fullName,
          role: a.role || 'ADMIN',
          /* A null rights OBJECT (owner, legacy admins) means FULL rights. */
          rights: a.rights || null,
          since: agoIso(a._sinceAgo ?? 0),
        }
      })
    },
  },
  {
    m: 'PUT', p: re('\\/channels\\/([^/]+)\\/admins\\/([^/]+)'),
    fn: (db, { params, body }) => {
      init(db)
      const ch = channel(db, params[0])
      if (!ch) throw mockError(404, 'CHANNEL_NOT_FOUND')
      ch._admins = ch._admins || []
      let row = ch._admins.find(a => a.userId === params[1])
      if (!row) { row = { userId: params[1], role: 'ADMIN', _sinceAgo: 0 }; ch._admins.push(row) }
      /* On the request side every flag is nullable and NULL MEANS TRUE, so a
         bare PUT grants full rights. */
      row.rights = body && Object.keys(body).length ? { ...body } : null
      const p = person(db, row.userId)
      return {
        userId: row.userId, username: p.username, fullName: p.fullName,
        role: row.role, rights: row.rights, since: agoIso(row._sinceAgo ?? 0),
      }
    },
  },
  {
    m: 'DELETE', p: re('\\/channels\\/([^/]+)\\/admins\\/([^/]+)'),
    fn: (db, { params }) => {
      init(db)
      const ch = channel(db, params[0])
      if (ch?._admins) ch._admins = ch._admins.filter(a => a.userId !== params[1] || a.role === 'OWNER')
      return NO_CONTENT
    },
  },
  {
    m: 'GET', p: re('\\/channels\\/([^/]+)\\/join-requests'),
    fn: (db, { params, query }) => {
      init(db)
      const ch = channel(db, params[0])
      if (!ch) throw mockError(404, 'CHANNEL_NOT_FOUND')
      const status = query.status || 'PENDING'
      const rows = (ch._joinRequests || [])
        .filter(r => !status || r.status === status)
        .map(r => joinRequestDto(db, ch, r))
      return page(rows, paging({ size: 50, ...query }))
    },
  },
  {
    m: 'POST', p: re('\\/channels\\/([^/]+)\\/join-requests\\/([^/]+)\\/(approve|reject)'),
    fn: (db, { params }) => {
      init(db)
      const ch = channel(db, params[0])
      const row = (ch?._joinRequests || []).find(r => r.userId === params[1])
      if (!row) throw mockError(404, 'JOIN_REQUEST_NOT_FOUND')
      row.status = params[2] === 'approve' ? 'APPROVED' : 'REJECTED'
      row._decidedAgo = 0
      row.decidedBy = SELF
      if (params[2] === 'approve') ch.subscriberCount = (ch.subscriberCount || 0) + 1
      return joinRequestDto(db, ch, row)
    },
  },
  /* Views are REPORTED, not counted: each (post, viewer) pair is deduped
     server-side, so re-reporting is free. */
  {
    m: 'POST', p: re('\\/channels\\/([^/]+)\\/posts\\/views'),
    fn: (db, { params, body }) => {
      init(db)
      const seen = (db._chat.viewed[params[0]] = db._chat.viewed[params[0]] || {})
      const counted = []
      for (const id of body?.messageIds || []) {
        if (seen[id]) continue
        seen[id] = true
        const hit = findMessage(db, id)
        if (hit?.m?.views != null) hit.m.views += 1
        counted.push(String(id))
      }
      return { counted }
    },
  },
  {
    m: 'GET', p: re('\\/channels\\/([^/]+)\\/posts\\/([^/]+)\\/comments'),
    fn: (db, { params, query }) => {
      init(db)
      const ch = channel(db, params[0])
      if (!ch?.linkedGroupId) return []
      const list = thread(db, ch.linkedGroupId)
        .filter(m => String(m._postId) === String(params[1]))
        .reverse()
      let from = 0
      if (query.before) {
        const i = list.findIndex(m => String(m.messageId) === String(query.before))
        from = i >= 0 ? i + 1 : 0
      }
      return list.slice(from, from + Math.min(100, Number(query.limit) || 30))
        .map(m => msgDto(db, m, ch.linkedGroupId))
    },
  },
  /* The comment belongs to the discussion GROUP, not the channel — never merge
     it into the channel timeline. */
  {
    m: 'POST', p: re('\\/channels\\/([^/]+)\\/posts\\/([^/]+)\\/comments'),
    fn: (db, { params, body }) => {
      init(db)
      const ch = channel(db, params[0])
      if (!ch?.linkedGroupId) throw mockError(400, 'DISCUSSION_DISABLED', 'This channel has no discussion group.')
      const post = findMessage(db, params[1])
      if (post?.m?.comments != null) post.m.comments += 1
      const row = newRow(db, ch.linkedGroupId, {
        type: body?.type || 'TEXT', body: body?.body || '', media: body?.media || [],
        replyToId: params[1], _postId: params[1],
      })
      return msgDto(db, appendMessage(db, ch.linkedGroupId, row), ch.linkedGroupId)
    },
  },
  {
    m: 'GET', p: re('\\/channels\\/([^/]+)\\/stats'),
    fn: (db, { params }) => {
      init(db)
      const ch = channel(db, params[0])
      if (!ch) throw mockError(404, 'CHANNEL_NOT_FOUND')
      const s = ch._stats || {}
      const posts = db.channelPosts?.[ch.id] || []
      const joinsByDay = {}
      for (let d = 29; d >= 0; d--) {
        const day = new Date(Date.now() - d * 86400_000).toISOString().slice(0, 10)
        joinsByDay[day] = Math.round(seeded(`${ch.id}:${day}`) * 24)
      }
      return {
        subscriberCount: ch.subscriberCount ?? 0,
        onlineSubscribers: s.onlineSubscribers ?? 0,
        joinedLast7Days: s.joinedLast7Days ?? 0,
        joinedLast30Days: s.joinedLast30Days ?? 0,
        leftLast30Days: s.leftLast30Days ?? 0,
        mutedCount: s.mutedCount ?? 0,
        notificationsEnabledCount: Math.max(0, (ch.subscriberCount ?? 0) - (s.mutedCount ?? 0)),
        postCount: posts.length,
        postsByType: s.postsByType || {},
        totalViews: s.totalViews ?? 0,
        totalForwards: s.totalForwards ?? 0,
        joinsByDay,
        joinsBySource: s.joinsBySource || {},
        topPosts: posts.slice().sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 3).map(m => msgDto(db, m, ch.id)),
      }
    },
  },
  /* Three viewer states, not two: a joinByRequest channel FILES A REQUEST and
     answers with a non-member. */
  {
    m: 'POST', p: re('\\/channels\\/([^/]+)\\/subscribe'),
    fn: (db, { params }) => {
      init(db)
      const ch = channel(db, params[0])
      if (!ch) throw mockError(404, 'CHANNEL_NOT_FOUND')
      if (ch.publicChannel === false) throw mockError(403, 'CHANNEL_PRIVATE', 'This channel is invite only.')
      if (ch.settings?.joinByRequest && !ch.subscribed) {
        ch.pendingJoinRequest = true
        ch._joinRequests = ch._joinRequests || []
        if (!ch._joinRequests.some(r => r.userId === SELF)) {
          ch._joinRequests.unshift({ id: `jr-${++db._chat.seq}`, userId: SELF, status: 'PENDING', _requestedAgo: 0 })
        }
        return channelDto(db, ch)
      }
      if (!ch.subscribed) {
        ch.subscribed = true
        ch.myRole = ch.myRole || 'MEMBER'
        ch.subscriberCount = (ch.subscriberCount || 0) + 1
        if (!convo(db, ch.id)) {
          db.conversations.unshift({
            id: ch.id, type: 'CHANNEL', title: ch.title, description: ch.description,
            ownerId: ch.ownerId, memberCount: ch.subscriberCount, myRole: 'MEMBER', myStatus: 'ACTIVE',
            unreadCount: 0, hasUnread: false, pinned: false, archived: false,
            disappearingSeconds: 0, _createdAgo: ch._createdAgo ?? 0, _lastReadIdx: -1,
          })
        }
      }
      return channelDto(db, ch)
    },
  },
  {
    m: 'DELETE', p: re('\\/channels\\/([^/]+)\\/subscribe'),
    fn: (db, { params }) => {
      init(db)
      const ch = channel(db, params[0])
      if (!ch) return NO_CONTENT
      if (ch.myRole === 'OWNER') throw mockError(400, 'OWNER_CANNOT_LEAVE', 'The owner cannot unsubscribe from their own channel.')
      ch.subscribed = false
      ch.pendingJoinRequest = false
      ch.myRole = null
      ch.subscriberCount = Math.max(0, (ch.subscriberCount || 1) - 1)
      const i = (db.conversations || []).findIndex(c => c.id === ch.id)
      if (i >= 0) db.conversations.splice(i, 1)
      return NO_CONTENT
    },
  },
  {
    m: 'PUT', p: re('\\/channels\\/([^/]+)\\/discussion-group\\/([^/]+)'),
    fn: (db, { params }) => {
      init(db)
      const ch = channel(db, params[0])
      if (ch) ch.linkedGroupId = params[1]
      return NO_CONTENT
    },
  },
  {
    m: 'DELETE', p: re('\\/channels\\/([^/]+)\\/discussion-group'),
    fn: (db, { params }) => {
      init(db)
      const ch = channel(db, params[0])
      if (ch) ch.linkedGroupId = null
      return NO_CONTENT
    },
  },
  {
    m: 'GET', p: re('\\/channels\\/([^/]+)'),
    fn: (db, { params }) => {
      init(db)
      const ch = channel(db, params[0])
      if (!ch) throw mockError(404, 'CHANNEL_NOT_FOUND', 'That channel does not exist.')
      return channelDto(db, ch)
    },
  },
  /* `settings` is a WHOLE-OBJECT replacement — every knob omitted is reset. */
  {
    m: 'PATCH', p: re('\\/channels\\/([^/]+)'),
    fn: (db, { params, body }) => {
      init(db)
      const ch = channel(db, params[0])
      if (!ch) throw mockError(404, 'CHANNEL_NOT_FOUND')
      for (const k of ['title', 'description', 'category', 'handle']) {
        if (body?.[k] != null) ch[k] = body[k]
      }
      if (body?.publicChannel != null) ch.publicChannel = !!body.publicChannel
      if (body?.settings) ch.settings = { ...body.settings }
      const c = convo(db, ch.id)
      if (c) { c.title = ch.title; c.description = ch.description }
      return channelDto(db, ch)
    },
  },
]

/* ---------------------------------------------------------
   Small builders used above (hoisted declarations)
   --------------------------------------------------------- */

/** The server's own extractor: lower-cased #hashtags off the body. */
function hashtagsOf(body) {
  const out = []
  for (const m of String(body || '').matchAll(/#([\p{L}\p{N}_]{2,32})/gu)) {
    const tag = m[1].toLowerCase()
    if (!out.includes(tag)) out.push(tag)
  }
  return out
}

/** Invite links hang off the CHANNEL record for a channel and off the
 *  conversation for a group — one endpoint, two holders. */
function inviteHolder(db, id) {
  return channel(db, id) || convo(db, id)
}

/** The link a plaintext token belongs to — `{ holder, row }`, or null when the
 *  token was not minted by this fixture. Mirrors `POST …/invite-links`, which
 *  is the only place the plaintext is ever produced. */
function redeemable(db, token) {
  for (const holder of [...(db.channels || []), ...(db.conversations || [])]) {
    for (const row of holder._invites || []) {
      if (token === `ika-${row.id}${row.requiresApproval ? '-req' : ''}`) return { holder, row }
    }
  }
  return null
}

function dropMine(rows) {
  const i = rows.findIndex(r => r.reactedByMe)
  if (i < 0) return
  rows[i].count = Math.max(0, rows[i].count - 1)
  rows[i].reactedByMe = false
  if (rows[i].count === 0) rows.splice(i, 1)
}

function pollOf(db, messageId) {
  const hit = findMessage(db, messageId)
  if (!hit?.m?.poll) throw mockError(404, 'POLL_NOT_FOUND', 'That message carries no poll.')
  return hit.m.poll
}

function pendingRequests(db) {
  return (db.conversations || []).filter(c => c._messageRequest?.status === 'PENDING')
}

function scheduledDto(conversationId, s) {
  return {
    id: s.id,
    conversationId,
    type: s.type || 'TEXT',
    body: s.body || '',
    media: s.media || [],
    replyToId: s.replyToId ?? null,
    scheduledAt: s._scheduledAt || agoIso(-(s._scheduledInMinutes ?? 60)),
    status: s.status || 'PENDING',
    sentMessageId: s.sentMessageId ?? null,
    createdAt: agoIso(s._createdAgo ?? 0),
  }
}

function draftDto(conversationId, d) {
  return {
    conversationId,
    body: d.body || '',
    media: d.media || [],
    replyToId: d.replyToId ?? null,
    updatedAt: agoIso(d._updatedAgo ?? 0),
  }
}

/** InviteLinkInfoResponse — never carries the plaintext token. */
function inviteDto(conversationId, r) {
  return {
    id: r.id,
    conversationId,
    createdBy: r.createdBy || null,
    createdAt: agoIso(r._createdAgo ?? 0),
    expiresAt: r._expiresInMinutes ? agoIso(-r._expiresInMinutes) : null,
    maxUses: r.maxUses ?? null,
    useCount: r.useCount ?? 0,
    revoked: !!r.revoked,
    requiresApproval: !!r.requiresApproval,
    permanent: !!r.permanent,
  }
}

function joinRequestDto(db, ch, r) {
  const p = person(db, r.userId)
  return {
    id: r.id,
    conversationId: ch.id,
    userId: r.userId,
    username: p.username,
    fullName: p.fullName,
    status: r.status || 'PENDING',
    requestedAt: agoIso(r._requestedAgo ?? 0),
    decidedBy: r.decidedBy || null,
    decidedAt: r._decidedAgo == null ? null : agoIso(r._decidedAgo),
  }
}
