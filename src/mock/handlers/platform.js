/* =========================================================
   Mock handlers — PLATFORM
   notifications · search / explore · activity ·
   settings · security · storage · safety · consent · policies
   ---------------------------------------------------------
   Every function returns the WIRE shape (the Java DTO), never a
   view shape: the value still travels through src/api/adapters.js
   and the per-module parsers exactly as a live response does.

   Two habits worth keeping when editing this file:

   · CROSS-DOMAIN IDS ARE RESOLVED, NOT INVENTED. A notification
     about a post points at a post that actually exists in the
     merged fixture (`refId`), and an actor's name/handle is read
     off the users fragment (`userById`). So deep links open real
     screens and one person has one name everywhere. When the
     collection is missing the fallback is derived from the id
     itself (`u-karwan` → Karwan / @karwan), never from a name
     hard-coded twice.

   · WRITES MUTATE `db`. Marking a notification read, flipping a
     matrix cell, muting someone, arming step-up — all of it edits
     the in-memory fixture and is visible to the next read. A demo
     where the switch snaps back is worse than no demo.
   ========================================================= */
import { page, paging, mockError, seeded, agoIso, NO_CONTENT } from '../util.js'

/* ---------------------------------------------------------
   shared helpers
   --------------------------------------------------------- */

const arr = (v) => (Array.isArray(v) ? v : [])
const ago = (minutes) => (minutes == null ? null : agoIso(minutes))
const ahead = (minutes) => (minutes == null ? null : agoIso(-minutes))
const clone = (v) => JSON.parse(JSON.stringify(v ?? null))
const bool = (v) => v === true || v === 'true'

/** Collections other fragments own, in the order we will accept them. */
const COLLECTIONS = {
  Post: ['posts', 'feed', 'reels'],
  Reel: ['reels', 'posts'],
  Question: ['questions', 'qna'],
  Research: ['researches', 'research', 'publications'],
  User: ['users', 'people'],
  Conversation: ['conversations', 'chats'],
  Channel: ['channels'],
  LiveStream: ['streams', 'live', 'lives'],
  Story: ['stories'],
  Sound: ['sounds'],
}

const idOf = (row) =>
  row && (row.id || row.postId || row.questionId || row.researchId ||
          row.channelId || row.conversationId || row.soundId || row.userId) || null

/** The n-th row of whichever collection holds `type`, or null. */
function refRow(db, type, index = 0) {
  for (const key of COLLECTIONS[type] || []) {
    const list = arr(db[key])
    if (list.length) return list[Math.abs(index) % list.length]
  }
  return null
}
const refId = (db, type, index, fallback = null) => idOf(refRow(db, type, index)) || fallback

/** `u-karwan` → 'karwan' / 'Karwan' — the last-resort identity, derived from
 *  the shared id so it can never disagree with another fragment's spelling. */
const handleFromId = (id) => String(id || '').replace(/^u-/, '') || ''
const nameFromId = (id) => {
  const h = handleFromId(id)
  return h ? h.charAt(0).toUpperCase() + h.slice(1) : ''
}

function userById(db, id) {
  if (!id) return null
  for (const key of ['users', 'people', 'members']) {
    const hit = arr(db[key]).find(u => idOf(u) === id)
    if (hit) return hit
  }
  return null
}

/* The users fragment and the author blocks nested in content rows do not spell
   a person the same way — `fullName`, `profile.displayName`, `fname`+`lname`.
   Read all of them, so one person has one name on every screen. */
const displayNameOf = (u) => (u && (
  u.fullName || u.profile?.displayName || u.name ||
  [u.fname, u.lname].filter(Boolean).join(' ').trim() || null
)) || null
const avatarOf = (u) => (u && (u.profileImage || u.profile?.avatarUrl || u.avatarUrl)) || null

/** UserResponse-ish → the AuthorSummary shape the activity DTO nests. */
function authorSummary(db, id) {
  if (!id) return null
  const u = userById(db, id)
  return {
    id,
    username: u?.username || handleFromId(id),
    fullName: displayNameOf(u) || nameFromId(id),
    avatarUrl: avatarOf(u),
  }
}

/* ---------------------------------------------------------
   NOTIFICATIONS — /api/v1/notifications
   --------------------------------------------------------- */

/* NotificationCategory.of() — the exact server-side derivation. Anything the
   table does not claim falls through to SYSTEM, which is why STORY_*,
   SOUND_APPROVED and RESEARCH_CONTRIBUTOR_ADDED land there too. */
const CATEGORY_OF = {
  USER_MENTIONED: 'MENTIONS', MESSAGE_MENTION: 'MENTIONS',
  POST_NEW: 'POSTS', POST_REACTED: 'POSTS', POST_COMMENTED: 'POSTS',
  POST_COMMENT_REPLIED: 'POSTS', POST_COMMENT_REACTED: 'POSTS',
  POST_SHARED: 'POSTS', POST_MENTIONED: 'POSTS',
  QUESTION_NEW: 'QNA', QUESTION_ANSWERED: 'QNA', ANSWER_REPLIED: 'QNA',
  ANSWER_REACTED: 'QNA', ANSWER_ACCEPTED: 'QNA',
  PUBLICATION_LIKED: 'RESEARCH', PUBLICATION_COMMENTED: 'RESEARCH', PUBLICATION_CITED: 'RESEARCH',
  NEW_MESSAGE: 'CHAT', MESSAGE_REQUEST: 'CHAT', ADDED_TO_GROUP: 'CHAT', CALL_MISSED: 'CHAT',
  CHANNEL_NEW_POST: 'CHAT', CHANNEL_JOIN_REQUEST: 'CHAT', CHANNEL_JOIN_APPROVED: 'CHAT',
  NEW_FOLLOWER: 'SOCIAL', UNFOLLOWED: 'SOCIAL', BLOCKED: 'SOCIAL', UNBLOCKED: 'SOCIAL',
  RESTRICTED: 'SOCIAL', CONNECTION_REQUEST: 'SOCIAL', CONNECTION_ACCEPTED: 'SOCIAL',
  STREAM_STARTED: 'SOCIAL',
  SYSTEM_MESSAGE: 'SYSTEM', SYSTEM_ANNOUNCEMENT: 'SYSTEM',
  ACCOUNT_WARNING: 'SYSTEM', TRENDING_DIGEST: 'SYSTEM',
}
const categoryOf = (type) => CATEGORY_OF[type] || 'SYSTEM'

/* Server-side deep links use API resource paths (/users, /questions,
   /researches) — the client rewrites three of them and refuses two. Emitting
   the server's spelling is the point: it exercises that rewrite. */
const DEEP_LINK = {
  Post: (id) => `/posts/${id}`,
  Reel: (id) => `/posts/${id}`,
  Question: (id) => `/questions/${id}`,
  Research: (id) => `/researches/${id}`,
  User: (id) => `/users/${id}`,
  Conversation: (id) => `/chat/${id}`,
  Channel: (id) => `/channels/${id}`,
  LiveStream: (id) => `/live/${id}`,
  Comment: (id) => `/comments/${id}`,
}

function notifDto(db, n) {
  const actor = userById(db, n.actorId)
  const last = userById(db, n.lastActorId)
  const resourceId = n.resourceId || refId(db, n.resourceType, n.ref || 0)
  const link = n.link === 'none' || !resourceId
    ? null
    : (DEEP_LINK[n.resourceType] ? DEEP_LINK[n.resourceType](resourceId) : null)
  return {
    id: n.id,
    type: n.type,
    category: categoryOf(n.type),
    title: n.title,
    body: n.body,
    actorId: n.actorId || null,
    actorUsername: n.actorId ? (actor?.username || handleFromId(n.actorId)) : null,
    actorFullName: n.actorId ? (displayNameOf(actor) || nameFromId(n.actorId)) : null,
    actorProfileImage: avatarOf(actor),
    aggregateCount: n.aggregateCount || 1,
    lastActorId: n.lastActorId || null,
    lastActorUsername: n.lastActorId ? (last?.username || handleFromId(n.lastActorId)) : null,
    resourceId: resourceId || null,
    resourceType: n.resourceType || null,
    deepLink: link,
    isRead: !!n.isRead,
    readAt: n.isRead ? (n.readAt || ago(Math.round((n.minutesAgo || 0) / 2))) : null,
    createdAt: ago(n.minutesAgo || 0),
  }
}

/** The inbox partition, newest first. */
const notifRows = (db) => arr(db.notifications).slice().sort((a, b) => (a.minutesAgo || 0) - (b.minutesAgo || 0))

/** Filtering, counting and bulk marking all run over the newest 200 rows —
 *  the server's scan window, mirrored here so paging behaves the same. */
const SCAN_WINDOW = 200

function syncUnread(db) {
  db.unreadCount = arr(db.notifications).filter(n => !n.isRead).length
  return db.unreadCount
}

function filterNotifs(db, query = {}) {
  const rows = notifRows(db).slice(0, SCAN_WINDOW)
  const category = query.category || null
  const types = query.type
    ? (Array.isArray(query.type) ? query.type : String(query.type).split(','))
    : null
  let out = rows
  // Filters compose (AND); when both are sent the server lets category win.
  if (category) out = out.filter(n => categoryOf(n.type) === category)
  else if (types) out = out.filter(n => types.includes(n.type))
  if (bool(query.unread)) out = out.filter(n => !n.isRead)
  return out
}

const notifById = (db, id) => arr(db.notifications).find(n => n.id === id) || null

/* ---------------------------------------------------------
   SEARCH — /api/v1/search  (+ the tag surface behind Explore)
   --------------------------------------------------------- */

const SEARCH_TYPES = ['POST', 'REEL', 'QUESTION', 'ANSWER', 'RESEARCH', 'USER', 'CHANNEL', 'SOUND']

/* Content fragments spell their primary text differently (`textContent` on a
   post, `title` on a question/research, `caption` on a reel) and none of them
   spell TIME the same way either — `minutesAgo`, `minsAgo`, `publishedAgoMin`.
   Read every spelling rather than betting on one: a hit with a null createdAt
   renders with an empty relative time, which looks like a bug and is one. */
const textOf = (row) => String(
  row?.titlePreview || row?.title || row?.textContent || row?.content || row?.text ||
  row?.caption || row?.abstract || row?.abstractText || row?.body || row?.description ||
  row?.name || '',
).slice(0, 280)

const AGO_KEYS = ['minutesAgo', 'minsAgo', 'publishedAgoMin', 'createdAgoMin', 'createdMinutesAgo']
function createdOf(row) {
  if (row?.createdAt) return row.createdAt
  for (const k of AGO_KEYS) if (row?.[k] != null) return ago(row[k])
  return null
}

/* Author ids are spelled four ways across the fragments (`authorId` on a post,
   `researcherId` on a paper, `uploaderId` on a sound, a nested `author`/
   `researcher` block). Resolve through the users fragment whenever we can, so
   one person carries one name on every screen. */
function hitAuthor(db, row) {
  const id = row?.authorId || row?.researcherId || row?.userId || row?.uploaderId ||
             row?.author?.id || row?.researcher?.id || null
  const u = userById(db, id) || row?.author || row?.researcher || null
  return {
    authorUsername: u?.username || row?.authorUsername || (id ? handleFromId(id) : ''),
    authorName: displayNameOf(u) || row?.authorName || (id ? nameFromId(id) : ''),
  }
}

function hit(db, contentType, contentId, title, row, { parentId = null, score = 0 } = {}) {
  const { authorUsername, authorName } = hitAuthor(db, row)
  return {
    contentType,
    contentId,
    type: contentType,                 // deprecated aliases, still on the wire
    id: contentId,
    parentId,
    score,
    titlePreview: title,
    authorUsername,
    authorName,
    createdAt: createdOf(row),
  }
}

/** The searchable corpus: real fixture content first, the editorial `explore`
 *  rows only for the types no other fragment supplied. */
function corpusOf(db) {
  const out = []
  const seen = new Set()
  const add = (h) => {
    if (!h.contentId || !h.titlePreview || seen.has(h.contentType + h.contentId)) return
    seen.add(h.contentType + h.contentId)
    out.push(h)
  }
  const scoreFor = (id) => Math.round((5 + 4 * seeded(String(id))) * 100) / 100

  for (const p of arr(db.posts)) {
    const id = idOf(p)
    add(hit(db, p.postType === 'REEL' ? 'REEL' : 'POST', id, textOf(p), p, { score: scoreFor(id) }))
  }
  for (const r of arr(db.reels)) {
    const id = idOf(r)
    add(hit(db, 'REEL', id, textOf(r), r, { score: scoreFor(id) }))
  }
  for (const key of ['questions', 'qna']) {
    for (const q of arr(db[key])) {
      const id = idOf(q)
      add(hit(db, 'QUESTION', id, textOf(q), q, { score: scoreFor(id) }))
    }
  }
  for (const key of ['researches', 'research', 'publications']) {
    for (const r of arr(db[key])) {
      const id = idOf(r)
      add(hit(db, 'RESEARCH', id, textOf(r), r, { score: scoreFor(id) }))
    }
  }
  for (const u of arr(db.users)) {
    const id = idOf(u)
    const line = [displayNameOf(u), u.headline || u.profile?.profileBio || u.bio || u.profile?.academicTitle].filter(Boolean).join(' — ')
    add(hit(db, 'USER', id, line || String(u.username || ''), { ...u, authorId: id }, { score: scoreFor(id) }))
  }
  /* CHANNEL is the one type whose "author" is the channel itself: the DTO says
     authorUsername carries the channel @handle and authorName its display
     name, so it must NOT be resolved to the owner's account. */
  for (const c of arr(db.channels)) {
    const id = idOf(c)
    const line = [c.name || c.title, c.description].filter(Boolean).join(' — ')
    add(hit(db, 'CHANNEL', id, line, {
      ...c, authorUsername: c.handle || c.username || '', authorName: c.title || c.name || '',
      authorId: null, ownerId: null, userId: null,
    }, { score: scoreFor(id) }))
  }
  /* SOUND: authorName is the ARTIST, not the uploader (GlobalSearchHit javadoc).
     The uploader still supplies the handle. */
  for (const s of arr(db.sounds)) {
    const id = idOf(s)
    const uploader = userById(db, s.uploaderId)
    add(hit(db, 'SOUND', id, s.title || textOf(s), {
      ...s, authorUsername: uploader?.username || handleFromId(s.uploaderId), authorName: s.artistName,
      authorId: null, userId: null, uploaderId: null,
    }, { score: scoreFor(id) }))
  }

  // ANSWER hits never exist as a top-level collection — they carry the owning
  // question as `parentId`, which is the only way the client can open one.
  arr(db.search?.answers).forEach((a, i) => {
    add(hit(db, 'ANSWER', a.contentId, a.titlePreview, a, {
      parentId: refId(db, 'Question', a.parentId ?? i, `qx-${i + 1}`),
      score: a.score ?? 7,
    }))
  })

  const covered = new Set(out.map(h => h.contentType))
  for (const d of arr(db.explore?.discover)) {
    if (covered.has(d.contentType)) continue
    add(hit(db, d.contentType, d.contentId, d.titlePreview,
      { ...d, createdAt: ago(d.minutesAgo) }, { score: d.score ?? 6 }))
  }
  return out
}

/** Term-overlap match. A miss really is a miss — an empty result set is a
 *  screen worth seeing, and pretending otherwise hides a broken query. */
function scoreAgainst(h, terms) {
  const hay = `${h.titlePreview} ${h.authorName} ${h.authorUsername} ${h.contentType}`.toLowerCase()
  let matched = 0
  for (const t of terms) if (hay.includes(t)) matched++
  return matched ? h.score + matched * 2 + (hay.startsWith(terms[0]) ? 1 : 0) : 0
}

/* TAGS (/api/v1/tags/trending · /search · /{tag}/usage · /{tag}/content) are
   deliberately NOT handled here. The users/social slice owns the `tags`
   fixture key and builds the per-tag feed out of the real tagged posts,
   questions and papers, so its rows deep-link into content that exists. Two
   handlers for one path is a coin-toss decided by registration order — this
   file yields. */

/* ---------------------------------------------------------
   ACTIVITY — /api/v1/users/me/activity
   --------------------------------------------------------- */

/* A reference resolves to a row that really exists or to NOTHING. Inventing an
   id (`qx-3`) would hand the UI a link straight into a 404 — worse than the
   un-clickable row a null reference produces, which is exactly what the real
   response does when the referenced entity is gone. */
function activityDto(db, a) {
  const isReel = a.activityType === 'REEL_WATCH'
  const postRow = a.postRef == null ? null : refRow(db, isReel ? 'Reel' : 'Post', a.postRef)
  const questionRow = a.questionRef == null ? null : refRow(db, 'Question', a.questionRef)
  const researchRow = a.researchRef == null ? null : refRow(db, 'Research', a.researchRef)
  const postId = idOf(postRow)
  const questionId = idOf(questionRow)
  const researchId = idOf(researchRow)
  const authorOf = (row) => authorSummary(db, row?.authorId || row?.researcherId ||
    row?.author?.id || row?.researcher?.id || null)
  return {
    id: a.id,
    activityType: a.activityType,
    reactionType: a.reactionType || null,
    watchedSeconds: a.watchedSeconds ?? null,
    post: postId ? {
      id: postId,
      postType: a.activityType === 'REEL_WATCH' ? 'REEL' : (postRow?.postType || 'TEXT'),
      textPreview: a.subtitle,
      thumbnailUrl: postRow?.thumbnailUrl || arr(postRow?.mediaUrls)[0] || null,
      author: authorOf(postRow),
    } : null,
    /* `comment` is the POST comment row only — a research comment travels in
       `researchComment`, and the mapper never fills both. */
    comment: /^POST_COMMENT/.test(a.activityType) ? { id: `cmt-${a.id}`, textPreview: a.subtitle } : null,
    query: a.query || null,
    searchScope: a.searchScope || null,
    hitCount: a.hitCount ?? null,
    targetUser: a.targetUserId ? authorSummary(db, a.targetUserId) : null,
    question: questionId ? {
      id: questionId,
      title: questionRow?.title || a.subtitle,
      author: authorOf(questionRow),
    } : null,
    answer: a.activityType.startsWith('QNA_ANSWER') ? {
      id: `ans-${a.id}`, parentAnswerId: null, bodyPreview: a.subtitle,
      accepted: false, author: authorSummary(db, 'u-amina'),
    } : null,
    qnaReactionType: a.qnaReactionType || null,
    research: researchId ? {
      id: researchId,
      ircId: researchRow?.ircId || null,
      title: researchRow?.title || a.subtitle,
      coverImageUrl: researchRow?.coverImageUrl || null,
      author: authorOf(researchRow),
    } : null,
    researchComment: a.activityType === 'RESEARCH_COMMENT' ? { id: `cmt-${a.id}`, textPreview: a.subtitle } : null,
    createdAt: ago(a.minutesAgo),
    /* timeAgo / formattedDate are server-rendered in one language; leaving them
       null lets the client format in the viewer's locale (activityFrom falls
       back to timeAgo(createdAt)). */
    timeAgo: null,
    formattedDate: null,
    label: a.label,
    subtitle: a.subtitle,
  }
}

/* ---------------------------------------------------------
   SETTINGS
   --------------------------------------------------------- */

const COSMETIC = ['appearance', 'accessibility', 'messages', 'media']

const FIELD_KEYS = [
  'BIO', 'BIRTHDAY', 'PROFILE_PICTURE', 'COVER_IMAGE', 'LOCATION', 'WEBSITE',
  'OCCUPATION', 'EDUCATION', 'EMAIL_ADDRESS', 'PHONE_NUMBER', 'FRIENDS_LIST',
  'FOLLOWERS', 'FOLLOWING', 'POSTS', 'STORIES', 'PHOTOS', 'VIDEOS', 'RESEARCH',
  'WHO_CAN_FOLLOW', 'WHO_CAN_MESSAGE', 'WHO_CAN_TAG', 'WHO_CAN_MENTION',
  'WHO_CAN_FRIEND_REQUEST',
]
const VISIBILITY = ['EVERYONE', 'FOLLOWERS', 'FRIENDS', 'CLOSE_FRIENDS', 'CUSTOM', 'ONLY_ME']
const CHANNELS = ['PUSH', 'IN_APP', 'EMAIL', 'SMS', 'DESKTOP']

const settingsOf = (db) => (db.settings ||= {})

function sectionOf(db, name) {
  const s = settingsOf(db)
  if (!COSMETIC.includes(name)) throw mockError(400, 'BAD_SECTION', `Unknown settings section: ${name}`)
  return (s[name] ||= {})
}

const listById = (db, id) => arr(settingsOf(db).lists).find(l => l.id === id) || null

function privacyListDto(l) {
  return { id: l.id, name: l.name, type: l.type, createdAt: ago(l.minutesAgo) }
}

const keywordDto = (k) => ({ id: k.id, keyword: k.keyword, createdAt: ago(k.minutesAgo) })

function dndDto(d) {
  return {
    enabled: !!d.enabled,
    timezone: d.timezone || 'UTC',
    startTime: d.startTime ?? null,
    endTime: d.endTime ?? null,
    daysMask: d.daysMask ?? 0,
    muteUntil: d.muteUntil ?? null,
  }
}

const pushTokenDto = (t) => ({
  id: t.id, provider: t.provider, platform: t.platform || null,
  lastSeenAt: ago(t.lastSeenMinutesAgo ?? 0),
})

const consentDto = (c) => ({
  id: c.id, scope: c.scope, granted: !!c.granted,
  appVersion: c.appVersion || null, occurredAt: ago(c.minutesAgo),
})

function recordConsent(db, scope, granted, appVersion) {
  const row = {
    id: `cn-${Date.now().toString(36)}`,
    scope: String(scope || '').toUpperCase(),
    granted: !!granted,
    appVersion: appVersion || null,
    minutesAgo: 0,
  }
  db.consent = [row, ...arr(db.consent)]
  return consentDto(row)
}

/* Reporter-facing coarse bucket — never the concrete moderator Resolution. */
const COARSE = {
  SUBMITTED: 'UNDER_REVIEW', TRIAGED: 'UNDER_REVIEW',
  ACTIONED: 'ACTION_TAKEN', UPHELD: 'ACTION_TAKEN',
  DISMISSED: 'NO_ACTION', REVERSED: 'NO_ACTION',
  APPEALED: 'APPEAL_UNDER_REVIEW',
}
const reportDto = (r) => ({
  id: r.id, targetType: r.targetType, targetId: r.targetId, reason: r.reason,
  state: r.state, coarseOutcome: COARSE[r.state] || 'UNDER_REVIEW',
  createdAt: ago(r.minutesAgo),
})

const strikeDto = (s) => ({
  id: s.id, reason: s.reason,
  issuedAt: ago(s.issuedMinutesAgo), expiresAt: ahead(s.expiresInMinutes),
})

/** SecurityScoreService's rules engine, run against the fixture — so enabling
 *  2FA in the demo really does move the score. */
const SCORE_WEIGHTS = { two_factor: 40, recovery: 30, email_verified: 20, recent_review: 10 }
function scoreDto(db) {
  const twoFa = !!db.security?.twofa?.enabled
  const items = arr(db.safety?.score?.items).map(i => {
    const passed = i.key === 'two_factor' ? twoFa : !!i.passed
    return { key: i.key, label: i.label, passed, recommendation: passed ? null : (i.recommendation || null) }
  })
  const total = items.reduce((n, i) => n + (SCORE_WEIGHTS[i.key] || 0), 0)
  const earned = items.reduce((n, i) => n + (i.passed ? (SCORE_WEIGHTS[i.key] || 0) : 0), 0)
  const score = total === 0 ? 0 : Math.round((100 * earned) / total)
  const level = score < 40 ? 'LOW' : score < 70 ? 'MEDIUM' : score < 90 ? 'HIGH' : 'EXCELLENT'
  return { score, level, items }
}

const policyDoc = (db, key) => arr(db.policies?.docs).find(d => d.key === key) || null

const exportJobDto = (j) => ({
  jobId: j.jobId, status: j.status,
  createdAt: ago(j.createdMinutesAgo ?? 0),
  expiresAt: j.status === 'READY' ? ahead(j.expiresInMinutes ?? 2880) : null,
  sizeBytes: j.status === 'READY' ? (j.sizeBytes ?? 0) : null,
})

/* ---------------------------------------------------------
   SECURITY
   --------------------------------------------------------- */

const securityOf = (db) => (db.security ||= {})

const sessionDto = (s) => ({
  sid: s.sid ?? null,
  deviceName: s.deviceName ?? null,
  platform: s.platform ?? null,
  ip: s.ip ?? null,
  lastSeenAt: ago(s.lastSeenMinutesAgo),
  createdAt: ago(s.createdMinutesAgo),
  trusted: !!s.trusted,
})

const loginEventDto = (e) => ({
  ip: e.ip, userAgent: e.userAgent, method: e.method,
  outcome: e.outcome, ts: ago(e.minutesAgo),
})

/** The step-up window. Guarded actions answer 403 STEP_UP_REQUIRED until
 *  POST /security/step-up arms it — the exact dance `withStepUp` packages. */
function requireStepUp(db) {
  const until = securityOf(db).stepUpArmedUntil
  if (!until || Date.now() > until) {
    throw mockError(403, 'STEP_UP_REQUIRED', 'Confirm it is you before continuing.')
  }
}

/* =========================================================
   ROUTES — more specific patterns first.
   ========================================================= */

export const routes = [
  /* ---------------- notifications ---------------- */
  {
    m: 'GET', p: /^\/api\/v1\/notifications\/unread\/count$/,
    fn: (db, { query }) => {
      const rows = query.category
        ? filterNotifs(db, { category: query.category, unread: 'true' })
        : arr(db.notifications).filter(n => !n.isRead)
      return { count: rows.length }
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/notifications\/unread$/,
    fn: (db, { query }) => page(filterNotifs(db, { unread: 'true' }).map(n => notifDto(db, n)), paging(query)),
  },
  {
    m: 'GET', p: /^\/api\/v1\/notifications$/,
    fn: (db, { query }) => page(filterNotifs(db, query).map(n => notifDto(db, n)), paging(query)),
  },
  {
    m: 'PATCH', p: /^\/api\/v1\/notifications\/read-all$/,
    fn: (db) => {
      arr(db.notifications).forEach(n => { n.isRead = true })
      syncUnread(db)
      return NO_CONTENT
    },
  },
  {
    m: 'PATCH', p: /^\/api\/v1\/notifications\/read$/,
    fn: (db, { body }) => {
      const ids = arr(body?.ids).slice(0, 200)
      let updated = 0
      for (const id of ids) {
        const row = notifById(db, id)
        if (row && !row.isRead) { row.isRead = true; updated++ }   // foreign/unknown ids skipped
      }
      syncUnread(db)
      return { updated }
    },
  },
  {
    m: 'PATCH', p: /^\/api\/v1\/notifications\/category\/([^/]+)\/read$/,
    fn: (db, { params }) => {
      let updated = 0
      for (const n of filterNotifs(db, { category: params[0] })) {
        if (!n.isRead) { n.isRead = true; updated++ }
      }
      syncUnread(db)
      return { updated }
    },
  },
  {
    m: 'PATCH', p: /^\/api\/v1\/notifications\/([^/]+)\/read$/,
    fn: (db, { params }) => {
      const row = notifById(db, params[0])
      if (!row) throw mockError(404, 'NOT_FOUND', 'Notification not found')
      row.isRead = true
      syncUnread(db)
      return NO_CONTENT
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/notifications\/read$/,
    fn: (db) => {
      const before = arr(db.notifications).length
      db.notifications = arr(db.notifications).filter(n => !n.isRead)   // unread rows are never touched
      syncUnread(db)
      return { deleted: before - db.notifications.length }
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/notifications\/([^/]+)$/,
    fn: (db, { params }) => {
      db.notifications = arr(db.notifications).filter(n => n.id !== params[0])   // unknown id = no-op
      syncUnread(db)
      return NO_CONTENT
    },
  },

  /* ---------------- unified search ---------------- */
  {
    m: 'GET', p: /^\/api\/v1\/search$/,
    fn: (db, { query }) => {
      const q = String(query.q || '').trim()
      const size = Math.max(1, Math.min(100, Number(query.size) || 20))
      const wanted = String(query.types || '').split(',').map(s => s.trim().toUpperCase()).filter(t => SEARCH_TYPES.includes(t))
      const cursorMode = query.cursor != null && String(query.cursor) !== ''
      const pageNo = cursorMode ? 0 : Math.max(0, Number(query.page) || 0)
      const expand = String(query.expand ?? 'true') !== 'false'

      const terms = q.toLowerCase().replace(/^#/, '').split(/\s+/).filter(Boolean)
      let rows = corpusOf(db)
      if (wanted.length) rows = rows.filter(h => wanted.includes(h.contentType))
      rows = rows
        .map(h => ({ h, s: scoreAgainst(h, terms) }))
        .filter(x => x.s > 0)
        .sort((a, b) => b.s - a.s || String(a.h.contentId).localeCompare(String(b.h.contentId)))
        .map(x => ({ ...x.h, score: Math.round(x.s * 100) / 100 }))

      /* Cursor mode is ENTERED with a cursor: without one the server runs
         offset mode and omits nextCursor entirely, at any size. */
      const from = cursorMode ? (Number(query.cursor) || 0) : pageNo * size
      const slice = rows.slice(from, from + size)
      const results = expand ? slice : slice.map(h => ({
        contentType: h.contentType, contentId: h.contentId, type: h.contentType, id: h.contentId, score: h.score,
      }))

      const body = {
        query: q,
        types: wanted.length ? wanted : SEARCH_TYPES,
        page: pageNo,
        size,
        results,
        degraded: !!db.search?.degraded,
      }
      if (cursorMode) body.nextCursor = from + size < rows.length ? String(from + size) : ''
      return body
    },
  },

  /* ---------------- activity ---------------- */
  {
    m: 'GET', p: /^\/api\/v1\/users\/me\/activity$/,
    fn: (db, { query }) => {
      const types = query.types
        ? (Array.isArray(query.types) ? query.types : String(query.types).split(','))
        : (query.type ? [query.type] : null)
      let rows = arr(db.activity).slice().sort((a, b) => (a.minutesAgo || 0) - (b.minutesAgo || 0))
      if (types) rows = rows.filter(a => types.includes(a.activityType))
      return page(rows.map(a => activityDto(db, a)), paging(query))
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/users\/me\/activity\/([^/]+)$/,
    fn: (db, { params }) => {
      db.activity = arr(db.activity).filter(a => a.id !== params[0])
      return NO_CONTENT
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/users\/me\/activity$/,
    fn: (db, { query }) => {
      const before = arr(db.activity).length
      db.activity = query.type ? arr(db.activity).filter(a => a.activityType !== query.type) : []
      return { deleted: before - db.activity.length }
    },
  },

  /* ---------------- settings: privacy ---------------- */
  {
    m: 'GET', p: /^\/api\/v1\/settings\/privacy\/lists$/,
    fn: (db) => arr(settingsOf(db).lists).map(privacyListDto),
  },
  {
    m: 'POST', p: /^\/api\/v1\/settings\/privacy\/lists$/,
    fn: (db, { body }) => {
      const s = settingsOf(db)
      const row = { id: `pl-${arr(s.lists).length + 1}-${Date.now().toString(36)}`, name: body?.name || 'List', type: 'CUSTOM', minutesAgo: 0 }
      s.lists = [...arr(s.lists), row]
      ;(s.listMembers ||= {})[row.id] = []
      return privacyListDto(row)
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/settings\/privacy\/lists\/([^/]+)\/members$/,
    fn: (db, { params }) => {
      if (!listById(db, params[0])) throw mockError(404, 'NOT_FOUND', 'List not found')
      return arr(settingsOf(db).listMembers?.[params[0]])       // bare UUID[]
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/settings\/privacy\/lists\/([^/]+)\/members$/,
    fn: (db, { params, body }) => {
      const s = settingsOf(db)
      if (!listById(db, params[0])) throw mockError(404, 'NOT_FOUND', 'List not found')
      const members = ((s.listMembers ||= {})[params[0]] ||= [])
      if (body?.memberId && !members.includes(body.memberId)) members.push(body.memberId)
      return NO_CONTENT
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/settings\/privacy\/lists\/([^/]+)\/members\/([^/]+)$/,
    fn: (db, { params }) => {
      const s = settingsOf(db)
      const members = arr(s.listMembers?.[params[0]])
      if (s.listMembers) s.listMembers[params[0]] = members.filter(id => id !== params[1])
      return NO_CONTENT
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/settings\/privacy\/lists\/([^/]+)$/,
    fn: (db, { params }) => {
      const s = settingsOf(db)
      s.lists = arr(s.lists).filter(l => l.id !== params[0])
      if (s.listMembers) delete s.listMembers[params[0]]        // cascades members
      return NO_CONTENT
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/settings\/privacy\/muted$/,
    fn: (db) => arr(settingsOf(db).muted),                      // bare UUID[], not user DTOs
  },
  {
    m: 'POST', p: /^\/api\/v1\/settings\/privacy\/muted\/([^/]+)$/,
    fn: (db, { params }) => {
      const s = settingsOf(db)
      s.muted = arr(s.muted)
      if (!s.muted.includes(params[0])) s.muted.push(params[0])  // idempotent
      return NO_CONTENT
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/settings\/privacy\/muted\/([^/]+)$/,
    fn: (db, { params }) => {
      const s = settingsOf(db)
      s.muted = arr(s.muted).filter(id => id !== params[0])
      return NO_CONTENT
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/settings\/privacy\/keywords$/,
    fn: (db) => arr(settingsOf(db).keywords).map(keywordDto),
  },
  {
    m: 'POST', p: /^\/api\/v1\/settings\/privacy\/keywords$/,
    fn: (db, { body }) => {
      const s = settingsOf(db)
      const word = String(body?.keyword || '').trim()
      if (!word) throw mockError(400, 'BAD_REQUEST', 'keyword must not be blank')
      s.keywords = arr(s.keywords)
      const existing = s.keywords.find(k => String(k.keyword).toLowerCase() === word.toLowerCase())
      if (existing) return keywordDto(existing)                  // duplicate → the existing row
      const row = { id: `kw-${Date.now().toString(36)}`, keyword: word, minutesAgo: 0 }
      s.keywords.push(row)
      return keywordDto(row)
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/settings\/privacy\/keywords\/([^/]+)$/,
    fn: (db, { params }) => {
      const s = settingsOf(db)
      s.keywords = arr(s.keywords).filter(k => k.id !== params[0])
      return NO_CONTENT
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/settings\/privacy$/,
    fn: (db) => ({ ...settingsOf(db).privacy }),                 // every FieldKey, always
  },
  {
    m: 'PUT', p: /^\/api\/v1\/settings\/privacy\/([^/]+)$/,
    fn: (db, { params, body }) => {
      const field = String(params[0] || '').toUpperCase()
      const level = String(body?.visibility || '').toUpperCase()
      if (!FIELD_KEYS.includes(field)) throw mockError(400, 'BAD_FIELD', `Unknown field: ${params[0]}`)
      if (!VISIBILITY.includes(level)) throw mockError(400, 'BAD_VISIBILITY', `Unknown visibility: ${body?.visibility}`)
      const s = settingsOf(db)
      s.privacy = { ...s.privacy, [field]: level }
      return { ...s.privacy }                                    // the FULL refreshed map
    },
  },

  /* ---------------- settings: presence & discovery ---------------- */
  {
    m: 'GET', p: /^\/api\/v1\/settings\/presence$/,
    fn: (db) => ({ ...settingsOf(db).presence }),
  },
  {
    m: 'PUT', p: /^\/api\/v1\/settings\/presence$/,
    fn: (db, { body }) => {
      const s = settingsOf(db)
      const p = (s.presence ||= {})
      if (body?.onlineStatusPolicy) p.onlineStatusPolicy = body.onlineStatusPolicy   // null = unchanged
      if (body?.lastSeenPolicy) p.lastSeenPolicy = body.lastSeenPolicy
      return { ...p }
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/settings\/discovery\/qr$/,
    fn: (db) => {
      const qr = (settingsOf(db).qr ||= { opaqueToken: 'qr-mock', rotatedMinutesAgo: 0 })
      return { opaqueToken: qr.opaqueToken, uri: `irc://u/${qr.opaqueToken}`, rotatedAt: ago(qr.rotatedMinutesAgo) }
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/settings\/discovery\/qr\/rotate$/,
    fn: (db) => {
      const qr = (settingsOf(db).qr ||= {})
      qr.opaqueToken = `qr-${Math.random().toString(16).slice(2, 12)}`   // old printed codes stop working
      qr.rotatedMinutesAgo = 0
      return { opaqueToken: qr.opaqueToken, uri: `irc://u/${qr.opaqueToken}`, rotatedAt: ago(0) }
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/settings\/discovery$/,
    fn: (db) => ({ ...settingsOf(db).discovery }),
  },
  {
    m: 'PUT', p: /^\/api\/v1\/settings\/discovery$/,
    fn: (db, { body }) => {
      const d = (settingsOf(db).discovery ||= {})
      for (const k of ['byUsername', 'byPhone', 'byEmail', 'byQr', 'indexable']) {
        if (body?.[k] != null) d[k] = !!body[k]                  // merge-style: null = unchanged
      }
      return { ...d }
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/discovery\/qr\/resolve\/([^/]+)$/,
    fn: (db, { params }) => {
      const qr = settingsOf(db).qr || {}
      if (params[0] !== qr.opaqueToken) throw mockError(404, 'NOT_FOUND', 'User not found for this QR code.')
      const u = userById(db, qr.userId)
      /* QrResolveResponse — a compact profile card, NOT a UserResponse. */
      return {
        userId: qr.userId,
        username: u?.username || handleFromId(qr.userId),
        fullName: displayNameOf(u) || nameFromId(qr.userId),
        avatarUrl: avatarOf(u),
      }
    },
  },

  /* ---------------- settings: consent & contacts ---------------- */
  {
    m: 'POST', p: /^\/api\/v1\/settings\/consent$/,
    fn: (db, { body }) => recordConsent(db, body?.scope, body?.granted, body?.appVersion),
  },
  {
    m: 'GET', p: /^\/api\/v1\/settings\/consent$/,
    fn: (db, { query }) => page(arr(db.consent).slice()
      .sort((a, b) => (a.minutesAgo || 0) - (b.minutesAgo || 0))
      .map(consentDto), paging(query)),
  },
  {
    m: 'GET', p: /^\/api\/v1\/settings\/consent\/([^/]+)$/,
    fn: (db, { params }) => {
      const scope = String(params[0]).toUpperCase()
      const latest = arr(db.consent)
        .filter(c => String(c.scope).toUpperCase() === scope)
        .sort((a, b) => (a.minutesAgo || 0) - (b.minutesAgo || 0))[0]
      return { scope, granted: !!latest?.granted }               // never 404s
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/contacts\/sync$/,
    fn: (db, { body }) => {
      const hashes = arr(body?.hashes)
      const s = settingsOf(db)
      const matched = Math.min(hashes.length, arr(db.users).length)
      s.contacts = { stored: hashes.length, matched }
      recordConsent(db, 'CONTACTS', true, body?.appVersion)
      return { stored: hashes.length, matched }
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/contacts\/sync$/,
    fn: (db) => {
      settingsOf(db).contacts = { stored: 0, matched: 0 }
      recordConsent(db, 'CONTACTS', false, null)                 // clearing revokes the consent
      return NO_CONTENT
    },
  },

  /* ---------------- settings: notification matrix, DND, push ---------------- */
  {
    m: 'GET', p: /^\/api\/v1\/settings\/notifications\/dnd$/,
    fn: (db) => dndDto(settingsOf(db).dnd || {}),
  },
  {
    m: 'PUT', p: /^\/api\/v1\/settings\/notifications\/dnd$/,
    fn: (db, { body }) => {
      const s = settingsOf(db)
      const d = (s.dnd ||= { timezone: 'UTC', daysMask: 0 })
      if (body?.timezone) d.timezone = body.timezone
      if (body?.startTime != null) d.startTime = body.startTime
      if (body?.endTime != null) d.endTime = body.endTime
      if (body?.daysMask != null) d.daysMask = Number(body.daysMask) || 0
      if (body?.muteUntil != null) d.muteUntil = body.muteUntil
      /* The trap: omitting `enabled` re-derives it from the window. */
      d.enabled = body?.enabled != null ? !!body.enabled : !!(d.startTime && d.endTime)
      return dndDto(d)
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/settings\/notifications\/push-tokens$/,
    fn: (db) => arr(settingsOf(db).pushTokens).map(pushTokenDto),
  },
  {
    m: 'POST', p: /^\/api\/v1\/settings\/notifications\/push-tokens$/,
    fn: (db, { body }) => {
      const s = settingsOf(db)
      s.pushTokens = arr(s.pushTokens)
      const row = {
        id: `pt-${Date.now().toString(36)}`,
        provider: body?.provider || 'WEBPUSH',
        platform: body?.platform || null,
        lastSeenMinutesAgo: 0,
      }
      s.pushTokens.push(row)
      return pushTokenDto(row)
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/settings\/notifications\/push-tokens\/([^/]+)$/,
    fn: (db, { params }) => {
      const s = settingsOf(db)
      s.pushTokens = arr(s.pushTokens).filter(t => t.id !== params[0])
      return NO_CONTENT                                          // 204 always
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/settings\/notifications$/,
    fn: (db) => clone(settingsOf(db).notificationMatrix),        // all 42 rows × 5 channels
  },
  {
    m: 'PUT', p: /^\/api\/v1\/settings\/notifications\/([^/]+)\/([^/]+)$/,
    fn: (db, { params, body }) => {
      const type = String(params[0]).toUpperCase()
      const channel = String(params[1]).toUpperCase()
      const matrix = (settingsOf(db).notificationMatrix ||= {})
      if (!matrix[type]) throw mockError(400, 'BAD_EVENT_TYPE', `Unknown notification event type: ${params[0]}`)
      if (!CHANNELS.includes(channel)) throw mockError(400, 'BAD_CHANNEL', `Unknown channel: ${params[1]}`)
      matrix[type][channel] = !!body?.enabled
      return NO_CONTENT
    },
  },

  /* ---------------- settings: cosmetic core ---------------- */
  {
    m: 'GET', p: /^\/api\/v1\/settings$/,
    fn: (db) => {
      const s = settingsOf(db)
      return {
        appearance: { ...s.appearance },
        accessibility: { ...s.accessibility },
        messages: { ...s.messages },
        media: { ...s.media },
        settingsVersion: s.settingsVersion ?? 1,
      }
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/settings\/(appearance|accessibility|messages|media)$/,
    fn: (db, { params }) => ({ ...sectionOf(db, params[0]) }),
  },
  {
    m: 'PATCH', p: /^\/api\/v1\/settings\/(appearance|accessibility|messages|media)$/,
    fn: (db, { params, body }) => {
      const block = sectionOf(db, params[0])
      Object.assign(block, body || {})                           // JSON Merge Patch
      return { ...block }
    },
  },
  {
    m: 'PUT', p: /^\/api\/v1\/settings\/(appearance|accessibility|messages|media)$/,
    fn: (db, { params, body }) => {
      const s = settingsOf(db)
      const block = sectionOf(db, params[0])
      /* PUT REPLACES the whole block: a key the caller omitted comes back
         null, exactly as it does server-side. PATCH is the partial path. */
      const next = {}
      for (const k of Object.keys(block)) next[k] = body?.[k] ?? null
      for (const [k, v] of Object.entries(body || {})) next[k] = v
      s[params[0]] = next
      return { ...next }
    },
  },

  /* ---------------- storage ---------------- */
  {
    m: 'GET', p: /^\/api\/v1\/storage\/usage$/,
    fn: (db) => ({ totalBytes: db.storage?.totalBytes ?? 0, byType: { ...(db.storage?.byType || {}) } }),
  },

  /* ---------------- data export & account deletion ---------------- */
  {
    m: 'POST', p: /^\/api\/v1\/privacy\/export$/,
    fn: (db) => {
      const data = (settingsOf(db).data ||= {})
      data.exportJob = {
        jobId: `exp-${Date.now().toString(36)}`,
        status: 'PENDING', createdMinutesAgo: 0, polls: 0,
        expiresInMinutes: 2880, sizeBytes: 18446744,
      }
      return exportJobDto(data.exportJob)
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/privacy\/export\/([^/]+)\/download$/,
    fn: (db, { params }) => {
      const job = settingsOf(db).data?.exportJob
      if (!job || job.jobId !== params[0] || job.status !== 'READY') {
        throw mockError(404, 'NOT_FOUND', 'That download is no longer available')
      }
      const payload = JSON.stringify({ note: 'mock export', jobId: job.jobId, generatedAt: ago(0) }, null, 2)
      return { blob: new Blob([payload], { type: 'application/zip' }), filename: 'irc-export.zip', type: 'application/zip' }
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/privacy\/export\/([^/]+)$/,
    fn: (db, { params }) => {
      const job = settingsOf(db).data?.exportJob
      if (!job || job.jobId !== params[0]) throw mockError(404, 'NOT_FOUND', 'Export job not found')
      /* Let the demo watch a job settle: two polls take PENDING → RUNNING → READY. */
      if (job.status === 'PENDING' || job.status === 'RUNNING') {
        job.polls = (job.polls || 0) + 1
        job.status = job.polls >= 2 ? 'READY' : 'RUNNING'
      }
      return exportJobDto(job)
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/privacy\/history\/([^/]+)$/,
    fn: () => NO_CONTENT,                                        // validated, logged, deletes nothing yet
  },
  {
    m: 'POST', p: /^\/api\/v1\/account\/deletion\/request$/,
    fn: (db) => {
      const data = (settingsOf(db).data ||= {})
      data.deletion = { status: 'PENDING_DELETION', requestedMinutesAgo: 0, purgeInMinutes: 43200 }
      return { status: 'PENDING_DELETION', requestedAt: ago(0), purgeAfter: ahead(43200) }
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/account\/deletion\/cancel$/,
    fn: (db) => {
      const data = (settingsOf(db).data ||= {})
      const req = data.deletion
      if (!req) throw mockError(404, 'NOT_FOUND', 'No deletion request is pending')
      req.status = 'CANCELLED'
      return { status: 'CANCELLED', requestedAt: ago(req.requestedMinutesAgo ?? 0), purgeAfter: null }
    },
  },

  /* ---------------- safety centre ---------------- */
  {
    m: 'POST', p: /^\/api\/v1\/safety\/reports$/,
    fn: (db, { body }) => {
      const s = (db.safety ||= {})
      s.reports = arr(s.reports)
      const open = ['SUBMITTED', 'TRIAGED', 'APPEALED']
      const dupe = s.reports.find(r => r.targetType === body?.targetType &&
        r.targetId === body?.targetId && r.reason === body?.reason && open.includes(r.state))
      if (dupe) return reportDto(dupe)                           // dedup: the open report, as-is
      const row = {
        id: `rep-${Date.now().toString(36)}`,
        targetType: body?.targetType, targetId: body?.targetId,
        reason: body?.reason, details: body?.details || null,
        state: 'SUBMITTED', minutesAgo: 0,
      }
      s.reports.unshift(row)
      return reportDto(row)
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/safety\/reports$/,
    fn: (db, { query }) => page(arr(db.safety?.reports).slice()
      .sort((a, b) => (a.minutesAgo || 0) - (b.minutesAgo || 0))
      .map(reportDto), paging(query)),
  },
  {
    m: 'POST', p: /^\/api\/v1\/safety\/reports\/([^/]+)\/appeal$/,
    fn: (db, { params }) => {
      const row = arr(db.safety?.reports).find(r => r.id === params[0])
      if (!row) throw mockError(404, 'NOT_FOUND', 'Report not found')
      if (!['ACTIONED', 'DISMISSED'].includes(row.state)) {
        throw mockError(400, 'REPORT_NOT_APPEALABLE', 'Only a resolved report can be appealed')
      }
      row.state = 'APPEALED'
      return reportDto(row)
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/safety\/strikes$/,
    fn: (db) => arr(db.safety?.strikes).map(strikeDto),
  },
  {
    m: 'GET', p: /^\/api\/v1\/safety\/score$/,
    fn: (db) => scoreDto(db),
  },

  /* ---------------- app config & policies ---------------- */
  {
    m: 'GET', p: /^\/api\/v1\/app\/config$/,
    fn: (db) => ({ ...(db.appConfig || {}) }),
  },
  {
    m: 'GET', p: /^\/api\/v1\/app\/policies\/me\/accepted$/,
    fn: (db) => arr(db.policies?.accepted).map(a => ({
      policyKey: a.policyKey, version: a.version, acceptedAt: ago(a.minutesAgo),
    })),
  },
  {
    m: 'POST', p: /^\/api\/v1\/app\/policies\/([^/]+)\/accept$/,
    fn: (db, { params }) => {
      const doc = policyDoc(db, params[0])
      if (!doc) throw mockError(404, 'NOT_FOUND', 'Unknown policy')
      const p = (db.policies ||= {})
      p.accepted = arr(p.accepted).filter(a => a.policyKey !== doc.key)
      const row = { policyKey: doc.key, version: doc.version, minutesAgo: 0 }
      p.accepted.push(row)
      return { policyKey: row.policyKey, version: row.version, acceptedAt: ago(0) }
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/app\/policies\/([^/]+)$/,
    fn: (db, { params }) => {
      const doc = policyDoc(db, params[0])
      if (!doc) throw mockError(404, 'NOT_FOUND', 'Unknown policy')
      return { key: doc.key, version: doc.version, effectiveDate: doc.effectiveDate, title: doc.title, body: doc.body }
    },
  },

  /* ---------------- security: sessions ---------------- */
  {
    m: 'GET', p: /^\/api\/v1\/security\/sessions$/,
    fn: (db) => arr(securityOf(db).sessions).map(sessionDto),
  },
  {
    m: 'POST', p: /^\/api\/v1\/security\/sessions\/([^/]+)\/trust$/,
    fn: (db, { params, body }) => {
      const row = arr(securityOf(db).sessions).find(s => s.sid === params[0])
      if (!row) throw mockError(404, 'SESSION_NOT_FOUND', 'Session not found')
      row.trusted = true
      row.trustedDays = Math.max(1, Math.min(90, Number(body?.days) || 30))   // clamped 1..90
      return NO_CONTENT
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/security\/sessions\/([^/]+)$/,
    fn: (db, { params }) => {
      const sec = securityOf(db)
      const before = arr(sec.sessions).length
      sec.sessions = arr(sec.sessions).filter(s => s.sid !== params[0])
      if (sec.sessions.length === before) throw mockError(404, 'SESSION_NOT_FOUND', 'Session not found')
      return NO_CONTENT
    },
  },

  /* ---------------- security: 2FA ---------------- */
  {
    m: 'POST', p: /^\/api\/v1\/security\/2fa\/setup$/,
    fn: (db) => {
      const tf = (securityOf(db).twofa ||= {})
      if (tf.enabled) throw mockError(409, 'TWO_FA_ALREADY_ON', 'Two-factor authentication is already on')
      return { provisioningUri: tf.provisioningUri, secret: tf.secret }       // shown ONCE
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/security\/2fa\/verify$/,
    fn: (db, { body }) => {
      const tf = (securityOf(db).twofa ||= {})
      if (!/^\d{6}$/.test(String(body?.code || ''))) throw mockError(400, 'OTP_INVALID', 'That code is not valid')
      if (tf.enabled) return { codes: [] }                                     // re-verify returns nothing
      tf.enabled = true
      tf.recoveryCodesRemaining = arr(tf.codes).length
      return { codes: arr(tf.codes) }
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/security\/2fa\/disable$/,
    fn: (db) => {
      requireStepUp(db)
      const tf = (securityOf(db).twofa ||= {})
      tf.enabled = false
      tf.recoveryCodesRemaining = 0
      return NO_CONTENT
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/security\/2fa\/status$/,
    fn: (db) => {
      const tf = securityOf(db).twofa || {}
      return { enabled: !!tf.enabled, recoveryCodesRemaining: tf.recoveryCodesRemaining ?? 0 }
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/security\/recovery-codes\/regenerate$/,
    fn: (db) => {
      requireStepUp(db)
      const tf = (securityOf(db).twofa ||= {})
      const quad = () => Math.random().toString(16).slice(2, 6).padEnd(4, '0')
      const codes = arr(tf.codes).map(() => `${quad()}-${quad()}`)
      tf.codes = codes
      tf.recoveryCodesRemaining = codes.length
      return { codes }
    },
  },

  /* ---------------- security: history, step-up, phone ---------------- */
  {
    m: 'GET', p: /^\/api\/v1\/security\/login-history$/,
    fn: (db, { query }) => page(arr(securityOf(db).loginHistory).slice()
      .sort((a, b) => (a.minutesAgo || 0) - (b.minutesAgo || 0))
      .map(loginEventDto), paging(query)),
  },
  {
    m: 'POST', p: /^\/api\/v1\/security\/step-up$/,
    fn: (db, { body }) => {
      const sec = securityOf(db)
      const password = String(body?.password || '')
      const code = String(body?.code || '')
      if (password) {
        // Any real password arms the window; 'wrong' is the scripted failure.
        if (password.toLowerCase() === 'wrong') throw mockError(400, 'STEP_UP_BAD_PASSWORD', 'That password is wrong')
      } else if (code) {
        if (!/^\d{6}$/.test(code)) throw mockError(400, null, 'Bad request')   // a BARE 400, no envelope
      } else {
        throw mockError(400, null, 'Bad request')
      }
      sec.stepUpArmedUntil = Date.now() + 5 * 60_000
      return NO_CONTENT
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/security\/phone\/request$/,
    fn: (db, { body }) => {
      if (!/^\+?[0-9\s-]{7,17}$/.test(String(body?.phone || ''))) {
        throw mockError(400, 'PHONE_INVALID', 'That phone number is not valid')
      }
      securityOf(db).phone = { ...(securityOf(db).phone || {}), pending: String(body.phone) }
      return NO_CONTENT                                          // 202, empty body
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/security\/phone\/verify$/,
    fn: (db, { body }) => {
      if (!/^\d{6}$/.test(String(body?.code || ''))) throw mockError(400, 'OTP_INVALID', 'That code is not valid')
      const e164 = String(body?.phone || '').replace(/[\s-]/g, '')
      securityOf(db).phone = { verified: true, e164 }
      return { verified: true, phone: e164 }
    },
  },
]
