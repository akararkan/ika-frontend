/* =========================================================
   Mock handlers — Q&A  (/api/v1/questions/**)
   ---------------------------------------------------------
   Wire shapes only: QuestionResponse, QuestionAnswerResponse,
   AnswerAttachmentResponse, AnswerSourceResponse, ShareLinkInfo
   and Spring's Page / CursorPage envelopes — exactly what
   QuestionController returns, so src/api/adapters.js parses the
   fixture the same way it parses the backend.

   Fixture keys owned here:
     questions       — top-level question rows
     answers         — top-level answers (parentAnswerId = null)
     answerComments  — reanswers / replies (depth 1)
     qnaSources      — answer sources, keyed by answerId
   Attachments live inline on their answer row.

   Writes mutate `db` in place: posting an answer, replying,
   reacting, accepting, locking, saving and every source /
   attachment CRUD survives until the page is reloaded.

   Three rules here come from QuestionServiceImpl, NOT from
   QNA_API.md — the doc contradicts the code on all three, and
   the code is what a real response would obey:
     · `status` tracks the ANSWER ROWS (first answer → ANSWERED,
       last one deleted → OPEN). Accept/unaccept never move it,
       so OPEN + answerCount > 0 is a state the server cannot
       produce and the fixture must not contain.
     · answers list OLDEST first (createdAt ASC).
     · GET /{id} returns the POST-bump viewCount, counted once
       per viewer for good (`_viewed` on the row stands in for
       the question_views ledger).
   ========================================================= */
import { page, paging, cursorPage, NO_CONTENT, mockError, agoIso } from '../util.js'

/* ---------- identity ---------- */

/** The signed-in demo user. The users/social fixture owns the profile; this
 *  only needs the id, and falls back to the asker who appears everywhere. */
function meId(db) {
  return db.me?.id || db.currentUser?.id || db.viewer?.id || 'u-amina'
}

function userRow(db, id) {
  const list = Array.isArray(db.users) ? db.users : []
  return list.find(u => (u?.id || u?.userId) === id) || null
}

/** Denormalised author columns, as the Question/Answer DTOs carry them.
 *  Prefer the shared users fixture so every domain shows the same person;
 *  the row's own copy is the fallback when that fixture is absent. */
function identity(db, row) {
  const u = userRow(db, row.authorId)
  const p = u?.profile || {}
  const full = p.displayName
    || [u?.fname, u?.lname].filter(Boolean).join(' ').trim()
    || u?.fullName || ''
  return {
    authorId: row.authorId || null,
    authorUsername: u?.username || row.authorUsername || 'member',
    authorFullName: full || row.authorFullName || row.authorUsername || 'Member',
    authorProfileImage: p.avatarUrl || u?.avatarUrl || u?.profileImage || null,
  }
}

/* ---------- time ---------- */

/** Stamp the row's ISO instant once, so a re-render does not slide it. */
function isoOf(row) {
  if (!row.createdAt) row.createdAt = agoIso(row.minutesAgo || 0)
  return row.createdAt
}

const LOCALES = { en: 'en-GB', ar: 'ar', ku: 'ckb-IQ', tr: 'tr' }

/** The server's `formattedDate` ("21 May 2026"), in the fixture's language. */
function fmtDate(iso, lang) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  try {
    return d.toLocaleDateString(LOCALES[lang] || 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  } catch {
    return d.toISOString().slice(0, 10)
  }
}

/* ---------- collections ---------- */

const questions = (db) => (db.questions ||= [])
const answers = (db) => (db.answers ||= [])
const replies = (db) => (db.answerComments ||= [])
const sources = (db) => (db.qnaSources ||= [])

const questionById = (db, id) => questions(db).find(q => q.id === id) || null
const topAnswers = (db, qid) => answers(db).filter(a => a.questionId === qid && !a.deleted)
const repliesOf = (db, aid) => replies(db).filter(r => r.parentAnswerId === aid && !r.deleted)

/** Answers and reanswers share one id space — reactions, edits and deletes
 *  all address either kind through the same `{answerId}` path segment. */
const anyAnswerById = (db, id) =>
  answers(db).find(a => a.id === id) || replies(db).find(r => r.id === id) || null

/* The 404 envelope the backend builds (ResourceNotFoundException):
   code = "<RESOURCE>_NOT_FOUND", message = "<Resource> not found with id: <v>". */
const notFound = (resource, id) =>
  mockError(404, `${resource.toUpperCase()}_NOT_FOUND`, `${resource} not found with id: ${id}`)

/* Bean-Validation rejects (@NotBlank on title / body / source title) never reach
   the service, so they carry the generic envelope + a `fieldErrors` array —
   errorCode VALIDATION_FAILED, not the service's own codes. ApiError lifts
   `fieldErrors` off the body, so a form can still point at the guilty field. */
function invalid(field, message) {
  const err = mockError(400, 'VALIDATION_FAILED', "One or more fields failed validation. Check 'fieldErrors' for details.")
  err.__mockBody.fieldErrors = [{ field, message, rejectedValue: null }]
  return err
}

/** ContentTagService.normalize — trim, strip a leading '#', lowercase, drop
 *  blanks, keep insertion order, dedupe, cap at 30. The stored tag is what the
 *  card renders, so normalising here is what stops "#Usul " and "usul" from
 *  showing up as two chips after an edit. */
const normTags = (raw) => [...new Set((Array.isArray(raw) ? raw : [])
  .map(t => String(t ?? '').trim().replace(/^#/, '').trim().toLowerCase().slice(0, 100))
  .filter(Boolean))].slice(0, 30)

/** @NotBlank — the one rule every Q&A write body shares. */
function requireText(value, field, message) {
  const v = value == null ? '' : String(value)
  if (!v.trim()) throw invalid(field, message)
  return v.trim()
}

function requireQuestion(db, id) {
  const q = questionById(db, id)
  if (!q) throw notFound('Question', id)
  return q
}

function requireAnswer(db, id) {
  const a = anyAnswerById(db, id)
  if (!a) throw notFound('Answer', id)
  return a
}

/* ---------- response builders ---------- */

function sourceRes(s) {
  return {
    id: s.id,
    answerId: s.answerId || null,
    sourceType: s.sourceType || 'MANUAL',
    title: s.title || '',
    citationText: s.citationText || null,
    url: s.url || null,
    isbn: s.isbn || null,
    fileUrl: s.fileUrl || null,
    originalFileName: s.originalFileName || null,
    displayOrder: s.displayOrder ?? 0,
    createdAt: isoOf(s),
  }
}

function attachmentRes(at, answerId) {
  return {
    id: at.id,
    answerId: at.answerId || answerId || null,
    fileUrl: at.fileUrl || null,
    originalFileName: at.originalFileName || 'file',
    mimeType: at.mimeType || null,
    mediaType: at.mediaType || 'OTHER',
    fileSize: at.fileSize ?? null,
    displayOrder: at.displayOrder ?? 0,
    caption: at.caption || null,
    durationSeconds: at.durationSeconds ?? null,
    thumbnailUrl: at.thumbnailUrl || null,
    createdAt: isoOf(at),
  }
}

/* Both sub-resources come back ordered by displayOrder — the citation list and
   the attachment strip are author-ordered, never insertion-ordered. */
const byOrder = (a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0)
const sourcesOf = (db, answerId) => sources(db).filter(s => s.answerId === answerId).sort(byOrder)
const attachmentsOf = (a) => (a.attachments || []).slice().sort(byOrder)

/** QuestionAnswerResponse — used for answers AND reanswers. */
function answerRes(db, a, ctx) {
  const created = isoOf(a)
  const deleted = !!a.deleted
  return {
    id: a.id,
    questionId: a.questionId || null,
    ...identity(db, a),
    body: deleted ? null : (a.body || ''),
    parentAnswerId: a.parentAnswerId || null,
    replyToAnswerId: a.replyToAnswerId || null,
    replyToUserId: a.replyToUserId || null,
    replyCount: a.parentAnswerId ? 0 : repliesOf(db, a.id).length,
    mediaUrl: deleted ? null : (a.mediaUrl || null),
    mediaType: deleted ? null : (a.mediaType || null),
    mediaThumbnailUrl: deleted ? null : (a.mediaThumbnailUrl || null),
    voiceUrl: deleted ? null : (a.voiceUrl || null),
    voiceDurationSeconds: deleted ? null : (a.voiceDurationSeconds ?? null),
    links: deleted ? null : (a.links || null),
    attachments: deleted ? [] : attachmentsOf(a).map(at => attachmentRes(at, a.id)),
    sources: deleted ? [] : sourcesOf(db, a.id).map(sourceRes),
    accepted: !!a.accepted,
    edited: !!a.edited,
    editedAt: a.edited ? (a.editedAt || created) : null,
    deleted,
    deletedAt: a.deletedAt || null,
    reactionCount: a.reactionCount || 0,
    myReaction: a.myReaction || null,
    createdAt: created,
    updatedAt: a.updatedAt || created,
    timeAgo: null,                                   // adapter derives it from createdAt in the viewer's locale
    formattedDate: fmtDate(created, ctx.lang),
  }
}

/* The backend keeps `status` in lock-step with the answer rows, and NOT with
   accept/unaccept (QuestionServiceImpl:547-558 + :882-884 — the API doc claims
   otherwise, the code is the truth):
     · the first top-level answer flips OPEN → ANSWERED
     · deleting the last one flips ANSWERED → OPEN
     · accept / unaccept never touch it — "resolved" rides hasAcceptedAnswer.
   CLOSED and ARCHIVED are never entered or left by these paths. */
function syncStatus(db, q) {
  if (q.status !== 'OPEN' && q.status !== 'ANSWERED') return
  q.status = topAnswers(db, q.id).length ? 'ANSWERED' : 'OPEN'
}

/** QuestionResponse. `answerCount` / `acceptedAnswerCount` are derived from the
 *  answer rows, so every mutation is reflected without a second bookkeeping
 *  field going stale. */
function questionRes(db, q, ctx, extra = {}) {
  const list = topAnswers(db, q.id)
  const accepted = list.filter(a => a.accepted).length
  const created = isoOf(q)
  const capped = q.maxAnswers != null && list.length >= q.maxAnswers
  return {
    id: q.id,
    ...identity(db, q),
    title: q.title || '',
    body: q.body || '',
    status: q.status || 'OPEN',
    answerCount: list.length,
    viewCount: q.viewCount || 0,
    saveCount: q.saveCount || 0,
    answersLocked: !!q.answersLocked,
    maxAnswers: q.maxAnswers ?? null,
    acceptsNewAnswers: (q.status || 'OPEN') === 'OPEN' && !q.answersLocked && !capped,
    hasAcceptedAnswer: accepted > 0,
    acceptedAnswerCount: accepted,
    isSaved: !!q.isSaved,
    createdAt: created,
    updatedAt: q.updatedAt || created,
    timeAgo: null,
    formattedDate: fmtDate(created, ctx.lang),
    savedAt: null,
    tags: q.tags || [],
    keywords: q.keywords || '',
    ...extra,
  }
}

/** Newest first, on the raw fixture rows (isoOf stamps them on first touch). */
const byNewest = (a, b) => (isoOf(a) < isoOf(b) ? 1 : isoOf(a) > isoOf(b) ? -1 : 0)

function feedList(db, ctx) {
  return questions(db)
    .slice()
    .sort(byNewest)
    .map(q => questionRes(db, q, ctx))
}

/** The saved endpoints page over the SAVE rows, so they order by when the
 *  viewer bookmarked (newest bookmark first) — not by when the question was
 *  asked — and they are the only two that carry `savedAt`. */
function savedList(db, ctx, extra = () => true) {
  const at = (q) => q.savedAt || isoOf(q)
  return questions(db)
    .filter(q => q.isSaved && extra(q))
    .sort((a, b) => (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0))
    .map(q => questionRes(db, q, ctx, { savedAt: at(q) }))
}

/* ---------- multipart helpers (the /upload + attachment routes) ---------- */

async function jsonPart(fd, name) {
  const part = fd?.get?.(name)
  if (!part) return {}
  if (typeof part === 'string') { try { return JSON.parse(part) } catch { return {} } }
  try { return JSON.parse(await part.text()) } catch { return {} }
}

function filePart(fd, name) {
  const f = fd?.get?.(name)
  if (!f || typeof f === 'string') return null
  let url = null
  try { url = URL.createObjectURL(f) } catch { /* no object URLs here — the row simply has no playable file */ }   // blob: passes assetUrl() untouched
  return { url, name: f.name || 'file', mime: f.type || '', size: f.size || 0 }
}

/** MIME → MediaType, the same ladder as QuestionServiceImpl.resolveMediaType —
 *  note text/csv is a SPREADSHEET, and anything unrecognised is OTHER (the
 *  attachment row renders its icon and chip straight off this value). */
function mediaKind(mime = '') {
  const m = String(mime).toLowerCase()
  if (m.startsWith('image/')) return 'IMAGE'
  if (m.startsWith('video/')) return 'VIDEO'
  if (m.startsWith('audio/')) return 'AUDIO'
  if (m === 'application/pdf' || /wordprocessingml|msword|presentationml|powerpoint/.test(m)) return 'DOCUMENT'
  if (/spreadsheetml|excel/.test(m) || m === 'text/csv') return 'SPREADSHEET'
  if (m === 'application/zip' || /tar|rar|7z|gzip/.test(m)) return 'ARCHIVE'
  return 'OTHER'
}

let seq = 0
const newId = (prefix) => `${prefix}-${Date.now().toString(36)}-${seq++}`

const origin = () => (typeof location !== 'undefined' && location.origin) || 'https://ika.example'

/** ShareLinkInfo — the one payload every share endpoint answers with. */
const shareInfo = (q) => ({
  shortUrl: `https://ika.link/q/${q.id}`,
  canonicalUrl: `${origin()}/qna/${q.id}`,
  token: q.id,
  shareCount: q.shareCount || 0,
})

/* ---------- creation ---------- */

/** Copy the demo user's denormalised name onto a freshly-created row, so a
 *  mock without the users fixture still signs new content with a real name. */
function stampAuthor(db, row) {
  const seed = questions(db).find(q => q.authorId === row.authorId)
    || answers(db).find(a => a.authorId === row.authorId)
  if (seed) {
    row.authorUsername = seed.authorUsername
    row.authorFullName = seed.authorFullName
  }
  return row
}

function makeAnswer(db, questionId, req, media, voice, prefix = 'a-new') {
  /* @NotBlank body — a media- or voice-only answer is rejected before the
     controller runs, exactly as it is against the real server. */
  const body = requireText(req.body, 'body', 'Answer body is required')
  const row = stampAuthor(db, {
    id: newId(prefix),
    questionId,
    authorId: meId(db),
    body,
    parentAnswerId: null,
    replyToAnswerId: null,
    replyToUserId: null,
    accepted: false,
    reactionCount: 0,
    myReaction: null,
    edited: false,
    createdAt: agoIso(0),
    attachments: [],
    mediaUrl: media?.url || null,
    mediaType: media ? mediaKind(media.mime) : null,
    voiceUrl: voice?.url || null,
    voiceDurationSeconds: voice ? 12 : null,   // the server probes the file; the player re-measures from the audio element anyway
  })
  for (const s of (req.sources || [])) {
    sources(db).push({
      id: newId('src'),
      answerId: row.id,
      sourceType: s.sourceType || 'MANUAL',
      title: requireText(s.title, 'sources[].title', 'Source title is required'),
      citationText: s.citationText || null,
      url: s.url || null,
      isbn: s.isbn || null,
      displayOrder: sourcesOf(db, row.id).length,   // server-assigned; not a request field
      createdAt: agoIso(0),
    })
  }
  return row
}

/** The three write guards addAnswer runs, in the backend's order, for BOTH the
 *  JSON and the multipart create routes. All three are BadRequestException →
 *  400, not 403 (QuestionServiceImpl:465-509); reanswers skip the answer cap. */
function requireAnswerable(db, q, topLevel) {
  if (q.status === 'CLOSED' || q.status === 'ARCHIVED') throw mockError(400, 'QUESTION_CLOSED', 'Question is closed')
  if (q.answersLocked) throw mockError(400, 'ANSWERS_LOCKED', 'Answers are locked for this question')
  if (topLevel && q.maxAnswers != null && topAnswers(db, q.id).length >= q.maxAnswers) {
    throw mockError(400, 'ANSWER_LIMIT_REACHED', `Maximum number of answers (${q.maxAnswers}) reached`)
  }
}

/** Depth-1 hoisting: a reply aimed at a reply becomes a sibling under the same
 *  root, keeping replyToAnswerId / replyToUserId so the UI can still render
 *  "replying to @X" (QNA_BACKEND_NOTES E2). */
function makeReanswer(db, questionId, targetId, req, media, voice) {
  const target = requireAnswer(db, targetId)
  const hoisted = !!target.parentAnswerId
  /* The prefix is passed in rather than renamed afterwards: makeAnswer files
     the inline `sources` under the id it minted, so a later rename would
     orphan every one of them. */
  const row = makeAnswer(db, questionId, req, media, voice, 'r-new')
  row.parentAnswerId = hoisted ? target.parentAnswerId : target.id
  row.replyToAnswerId = hoisted ? target.id : null
  row.replyToUserId = hoisted ? target.authorId : null
  return row
}

/* =========================================================
   Routes — most specific first
   ========================================================= */
export const routes = [
  /* ---- feeds ---- */
  {
    m: 'GET', p: /^\/api\/v1\/questions\/feed\/cursor$/,
    fn: (db, ctx) => cursorPage(feedList(db, ctx), ctx.query, 'createdAt'),
  },
  {
    m: 'GET', p: /^\/api\/v1\/questions\/feed\/following$/,
    fn: (db, ctx) => {
      /* The users/social fixture owns the graph (`follows` edge rows); the
         other spellings and the literal set are fallbacks so this feed is
         never empty when Q&A is loaded on its own. */
      const me = meId(db)
      const edges = Array.isArray(db.follows) ? db.follows : []
      const raw = edges.length
        ? edges.filter(e => (e.followerId || e.follower) === me).map(e => e.followingId || e.following)
        : (db.following || db.social?.following || [])
      const ids = Array.isArray(raw) && raw.length
        ? new Set(raw.map(x => (typeof x === 'string' ? x : x?.id)).filter(Boolean))
        : new Set(['u-karwan', 'u-yusuf', 'u-zeynep', 'u-hana', 'u-dilan'])
      ids.add(me)   // the viewer's OWN questions are always in this feed (QuestionServiceImpl:387)
      return page(feedList(db, ctx).filter(q => ids.has(q.authorId)), paging(ctx.query))
    },
  },

  /* ---- saved collections (before /{id}, which would swallow "me") ---- */
  {
    m: 'GET', p: /^\/api\/v1\/questions\/me\/saved\/collections$/,
    fn: (db) => [...new Set(questions(db).filter(q => q.isSaved && q.savedCollection).map(q => q.savedCollection))],
  },
  {
    m: 'PATCH', p: /^\/api\/v1\/questions\/me\/saved\/collections$/,
    fn: (db, ctx) => {
      const { oldName, newName } = ctx.query || {}
      if (!oldName || !String(oldName).trim()) throw mockError(400, 'MISSING_OLD_NAME', 'Old collection name is required')
      if (!newName || !String(newName).trim()) throw mockError(400, 'MISSING_NEW_NAME', 'New collection name is required')
      questions(db).forEach(q => { if (q.savedCollection === oldName) q.savedCollection = String(newName).trim() })
      return NO_CONTENT
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/questions\/me\/saved\/collection$/,
    fn: (db, ctx) => {
      const name = ctx.query?.name
      if (!name || !String(name).trim()) throw mockError(400, 'MISSING_COLLECTION_NAME', 'Collection name is required')
      return page(savedList(db, ctx, q => q.savedCollection === String(name).trim()), paging(ctx.query))
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/questions\/me\/saved$/,
    fn: (db, ctx) => page(savedList(db, ctx), paging(ctx.query)),
  },
  {
    m: 'GET', p: /^\/api\/v1\/questions\/me$/,
    fn: (db, ctx) => {
      const me = meId(db)
      return page(feedList(db, ctx).filter(q => q.authorId === me), paging(ctx.query))
    },
  },

  /* ---- answer sources (§16) ---- */
  {
    m: 'POST', p: /^\/api\/v1\/questions\/([^/]+)\/answers\/([^/]+)\/sources\/([^/]+)\/file$/,
    fn: async (db, ctx) => {
      const [, , sourceId] = ctx.params
      const row = sources(db).find(s => s.id === sourceId)
      if (!row) throw notFound('Source', sourceId)
      const f = filePart(ctx.body, 'file')
      if (f) { row.fileUrl = f.url; row.originalFileName = f.name }
      return sourceRes(row)
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/questions\/([^/]+)\/answers\/([^/]+)\/sources$/,
    fn: (db, ctx) => sourcesOf(db, ctx.params[1]).map(sourceRes),
  },
  {
    m: 'POST', p: /^\/api\/v1\/questions\/([^/]+)\/answers\/([^/]+)\/sources$/,
    fn: (db, ctx) => {
      const answerId = ctx.params[1]
      requireAnswer(db, answerId)
      const b = ctx.body || {}
      if (!b.sourceType) throw invalid('sourceType', 'Source type is required')
      const row = {
        id: newId('src'),
        answerId,
        sourceType: b.sourceType,
        title: requireText(b.title, 'title', 'Source title is required'),
        citationText: b.citationText || null,
        url: b.url || null,
        isbn: b.isbn || null,
        displayOrder: sourcesOf(db, answerId).length,
        createdAt: agoIso(0),
      }
      sources(db).push(row)
      return sourceRes(row)
    },
  },
  {
    m: 'PATCH', p: /^\/api\/v1\/questions\/([^/]+)\/answers\/([^/]+)\/sources\/([^/]+)$/,
    fn: (db, ctx) => {
      const row = sources(db).find(s => s.id === ctx.params[2])
      if (!row) throw notFound('Source', ctx.params[2])
      const b = ctx.body || {}
      for (const k of ['title', 'citationText', 'url', 'isbn', 'sourceType', 'displayOrder']) {
        if (b[k] !== undefined) row[k] = b[k]
      }
      return sourceRes(row)
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/questions\/([^/]+)\/answers\/([^/]+)\/sources\/([^/]+)$/,
    fn: (db, ctx) => {
      const i = sources(db).findIndex(s => s.id === ctx.params[2])
      if (i < 0) throw notFound('Source', ctx.params[2])
      sources(db).splice(i, 1)
      return NO_CONTENT
    },
  },

  /* ---- answer attachments (§15) ---- */
  {
    m: 'GET', p: /^\/api\/v1\/questions\/([^/]+)\/answers\/([^/]+)\/attachments$/,
    fn: (db, ctx) => {
      const a = requireAnswer(db, ctx.params[1])
      return attachmentsOf(a).map(at => attachmentRes(at, a.id))
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/questions\/([^/]+)\/answers\/([^/]+)\/attachments$/,
    fn: async (db, ctx) => {
      const a = requireAnswer(db, ctx.params[1])
      const f = filePart(ctx.body, 'file')
      if (!f) throw mockError(400, 'VALIDATION_ERROR', 'A file is required')
      const at = {
        id: newId('att'),
        answerId: a.id,
        fileUrl: f.url,
        originalFileName: f.name,
        mimeType: f.mime,
        mediaType: mediaKind(f.mime),
        fileSize: f.size,
        displayOrder: (a.attachments || []).length,
        caption: ctx.query?.caption || '',
        durationSeconds: null,
        thumbnailUrl: null,
        createdAt: agoIso(0),
      }
      ;(a.attachments ||= []).push(at)
      return attachmentRes(at, a.id)
    },
  },
  {
    m: 'PATCH', p: /^\/api\/v1\/questions\/([^/]+)\/answers\/([^/]+)\/attachments\/([^/]+)$/,
    fn: (db, ctx) => {
      const a = requireAnswer(db, ctx.params[1])
      const at = (a.attachments || []).find(x => x.id === ctx.params[2])
      if (!at) throw notFound('Attachment', ctx.params[2])
      const b = ctx.body || {}
      if (b.caption !== undefined) at.caption = b.caption
      if (b.displayOrder !== undefined) at.displayOrder = b.displayOrder
      return attachmentRes(at, a.id)
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/questions\/([^/]+)\/answers\/([^/]+)\/attachments\/([^/]+)$/,
    fn: (db, ctx) => {
      const a = requireAnswer(db, ctx.params[1])
      a.attachments = (a.attachments || []).filter(x => x.id !== ctx.params[2])
      return NO_CONTENT
    },
  },

  /* ---- reactions (answers AND reanswers) ---- */
  {
    m: 'POST', p: /^\/api\/v1\/questions\/([^/]+)\/answers\/([^/]+)\/react$/,
    fn: (db, ctx) => {
      const a = requireAnswer(db, ctx.params[1])
      if (a.myReaction !== 'LIKE') { a.myReaction = 'LIKE'; a.reactionCount = (a.reactionCount || 0) + 1 }
      return answerRes(db, a, ctx)
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/questions\/([^/]+)\/answers\/([^/]+)\/react$/,
    fn: (db, ctx) => {
      const a = requireAnswer(db, ctx.params[1])
      if (a.myReaction) { a.myReaction = null; a.reactionCount = Math.max(0, (a.reactionCount || 0) - 1) }
      return answerRes(db, a, ctx)
    },
  },

  /* ---- accept / unaccept (author only — the sole quality signal) ----
     Neither touches `status`: several answers can be accepted at once, and the
     "resolved" badge reads hasAcceptedAnswer / acceptedAnswerCount, both of
     which questionRes derives from the answer rows. */
  {
    m: 'POST', p: /^\/api\/v1\/questions\/([^/]+)\/answers\/([^/]+)\/accept$/,
    fn: (db, ctx) => {
      requireQuestion(db, ctx.params[0])
      const a = requireAnswer(db, ctx.params[1])
      if (a.parentAnswerId) throw mockError(400, 'REANSWER_NOT_ACCEPTABLE', 'Reanswers cannot be accepted as best answer')
      a.accepted = true
      return answerRes(db, a, ctx)
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/questions\/([^/]+)\/answers\/([^/]+)\/accept$/,
    fn: (db, ctx) => {
      requireQuestion(db, ctx.params[0])
      const a = requireAnswer(db, ctx.params[1])
      a.accepted = false
      return answerRes(db, a, ctx)
    },
  },

  /* ---- reanswers (both spellings the controller maps) ---- */
  {
    m: 'POST', p: /^\/api\/v1\/questions\/([^/]+)\/answers\/([^/]+)\/(?:reanswers|replies)\/upload$/,
    fn: async (db, ctx) => {
      const q = requireQuestion(db, ctx.params[0])
      requireAnswerable(db, q, false)
      const req = await jsonPart(ctx.body, 'data')
      const row = makeReanswer(db, q.id, ctx.params[1], req, filePart(ctx.body, 'media'), filePart(ctx.body, 'voice'))
      replies(db).push(row)
      return answerRes(db, row, ctx)
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/questions\/([^/]+)\/answers\/([^/]+)\/(?:reanswers|replies)$/,
    fn: (db, ctx) => {
      const list = repliesOf(db, ctx.params[1])
        .slice()
        .sort((a, b) => (isoOf(a) < isoOf(b) ? -1 : 1))
        .map(r => answerRes(db, r, ctx))
      return page(list, paging(ctx.query))
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/questions\/([^/]+)\/answers\/([^/]+)\/(?:reanswers|replies)$/,
    fn: (db, ctx) => {
      const q = requireQuestion(db, ctx.params[0])
      requireAnswerable(db, q, false)
      const row = makeReanswer(db, q.id, ctx.params[1], ctx.body || {}, null, null)
      replies(db).push(row)
      return answerRes(db, row, ctx)
    },
  },

  /* ---- answers ---- */
  {
    m: 'POST', p: /^\/api\/v1\/questions\/([^/]+)\/answers\/upload$/,
    fn: async (db, ctx) => {
      const q = requireQuestion(db, ctx.params[0])
      requireAnswerable(db, q, true)
      const req = await jsonPart(ctx.body, 'data')
      const row = makeAnswer(db, q.id, req, filePart(ctx.body, 'media'), filePart(ctx.body, 'voice'))
      answers(db).push(row)
      syncStatus(db, q)
      return answerRes(db, row, ctx)
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/questions\/([^/]+)\/answers$/,
    fn: (db, ctx) => {
      /* OLDEST FIRST — `findVisibleTopLevelAnswers` is ORDER BY a.createdAt ASC,
         and the detail screen APPENDS a newly posted answer to the end of the
         list, so any other ordering here would put a fresh answer in a place
         the next reload moves it away from. Soft-deleted rows are excluded (E1). */
      const list = topAnswers(db, ctx.params[0])
        .slice()
        .sort((a, b) => (isoOf(a) < isoOf(b) ? -1 : 1))
        .map(a => answerRes(db, a, ctx))
      return page(list, paging(ctx.query))
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/questions\/([^/]+)\/answers$/,
    fn: (db, ctx) => {
      const q = requireQuestion(db, ctx.params[0])
      requireAnswerable(db, q, true)
      const row = makeAnswer(db, q.id, ctx.body || {}, null, null)
      answers(db).push(row)
      syncStatus(db, q)
      return answerRes(db, row, ctx)
    },
  },
  {
    m: 'PATCH', p: /^\/api\/v1\/questions\/([^/]+)\/answers\/([^/]+)$/,
    fn: (db, ctx) => {
      const a = requireAnswer(db, ctx.params[1])
      a.body = requireText((ctx.body || {}).body, 'body', 'Answer body is required')
      a.edited = true
      a.editedAt = agoIso(0)
      a.updatedAt = a.editedAt
      return answerRes(db, a, ctx)
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/questions\/([^/]+)\/answers\/([^/]+)$/,
    fn: (db, ctx) => {
      const q = requireQuestion(db, ctx.params[0])
      const a = requireAnswer(db, ctx.params[1])
      a.deleted = true              // soft delete — reply threads survive under the tombstone
      a.deletedAt = agoIso(0)
      a.accepted = false            // the accept is released and its reactions purged first
      a.reactionCount = 0
      a.myReaction = null
      if (!a.parentAnswerId) syncStatus(db, q)   // last answer gone → back to OPEN
      return NO_CONTENT
    },
  },

  /* ---- answer controls (author) ---- */
  {
    m: 'POST', p: /^\/api\/v1\/questions\/([^/]+)\/lock-answers$/,
    fn: (db, ctx) => { const q = requireQuestion(db, ctx.params[0]); q.answersLocked = true; return questionRes(db, q, ctx) },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/questions\/([^/]+)\/lock-answers$/,
    fn: (db, ctx) => { const q = requireQuestion(db, ctx.params[0]); q.answersLocked = false; return questionRes(db, q, ctx) },
  },
  {
    m: 'PATCH', p: /^\/api\/v1\/questions\/([^/]+)\/answer-limit$/,
    fn: (db, ctx) => {
      const q = requireQuestion(db, ctx.params[0])
      const raw = ctx.query?.maxAnswers
      const n = raw === undefined || raw === null || raw === '' ? null : Number(raw)
      q.maxAnswers = n == null || Number.isNaN(n) || n <= 0 ? null : n   // "0 or less" means unlimited
      return questionRes(db, q, ctx)
    },
  },

  /* ---- save / share ----
     ShareLinkInfo: shortUrl is the backend's OG-preview redirect, canonicalUrl
     the in-app destination, token the question UUID. The canonical is built on
     the running origin (as the posts fixture does) so the copied link actually
     opens the question in this build. */
  {
    m: 'POST', p: /^\/api\/v1\/questions\/([^/]+)\/save$/,
    fn: (db, ctx) => {
      const q = requireQuestion(db, ctx.params[0])
      if (!q.isSaved) { q.isSaved = true; q.saveCount = (q.saveCount || 0) + 1; q.savedAt = agoIso(0) }
      if (ctx.query?.collection) q.savedCollection = ctx.query.collection
      return questionRes(db, q, ctx)   // savedAt is populated by the saved-LIST endpoints only
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/questions\/([^/]+)\/save$/,
    fn: (db, ctx) => {
      const q = requireQuestion(db, ctx.params[0])
      if (q.isSaved) { q.isSaved = false; q.saveCount = Math.max(0, (q.saveCount || 0) - 1) }
      q.savedAt = null
      return questionRes(db, q, ctx)
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/questions\/([^/]+)\/share-link$/,
    fn: (db, ctx) => shareInfo(requireQuestion(db, ctx.params[0])),      // preview — no bump
  },
  {
    m: 'POST', p: /^\/api\/v1\/questions\/([^/]+)\/share$/,
    fn: (db, ctx) => {
      const q = requireQuestion(db, ctx.params[0])
      q.shareCount = (q.shareCount || 0) + 1
      return shareInfo(q)
    },
  },

  /* ---- question list / detail / lifecycle ---- */
  {
    m: 'GET', p: /^\/api\/v1\/questions$/,
    fn: (db, ctx) => page(feedList(db, ctx), paging(ctx.query)),
  },
  {
    m: 'POST', p: /^\/api\/v1\/questions$/,
    fn: (db, ctx) => {
      const b = ctx.body || {}
      const title = requireText(b.title, 'title', 'Question title is required')
      const body = requireText(b.body, 'body', 'Question body is required')
      const q = stampAuthor(db, {
        id: newId('q-new'),
        authorId: meId(db),
        title,
        body,
        status: 'OPEN',
        viewCount: 0,
        saveCount: 0,
        shareCount: 0,
        answersLocked: !!b.answersLocked,
        maxAnswers: b.maxAnswers ?? null,
        isSaved: false,
        createdAt: agoIso(0),
        tags: normTags(b.tags),
        keywords: b.keywords || '',
      })
      questions(db).unshift(q)
      return questionRes(db, q, ctx)
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/questions\/([^/]+)$/,
    fn: (db, ctx) => {
      const q = requireQuestion(db, ctx.params[0])
      /* The view is counted ONCE per (question, viewer) and forever — a durable
         ledger, not a TTL — so re-opening the page does not inflate it. The
         response carries the POST-bump number: recordView writes the fresh
         count through the counter cache BEFORE the mapper reads it
         (QuestionServiceImpl:270-271 / :291-300), whatever §6.2 claims. */
      if (!q._viewed) { q._viewed = true; q.viewCount = (q.viewCount || 0) + 1 }
      return questionRes(db, q, ctx)
    },
  },
  {
    m: 'PATCH', p: /^\/api\/v1\/questions\/([^/]+)$/,
    fn: (db, ctx) => {
      const q = requireQuestion(db, ctx.params[0])
      const b = ctx.body || {}
      /* Every field is OPTIONAL here (null = leave alone), so a blank title or
         body reaches the service and gets ITS codes — EMPTY_TITLE / EMPTY_BODY —
         rather than the bean-validation envelope the create path returns. */
      if (b.title != null) {
        if (!String(b.title).trim()) throw mockError(400, 'EMPTY_TITLE', 'Question title cannot be empty')
        q.title = String(b.title).trim()
      }
      if (b.body != null) {
        if (!String(b.body).trim()) throw mockError(400, 'EMPTY_BODY', 'Question body cannot be empty')
        q.body = String(b.body).trim()
      }
      if (b.answersLocked != null) q.answersLocked = !!b.answersLocked
      if (b.maxAnswers != null) q.maxAnswers = Number(b.maxAnswers) <= 0 ? null : Number(b.maxAnswers)
      if (b.keywords != null) q.keywords = b.keywords
      if (b.tags != null) q.tags = normTags(b.tags)      // full replace, normalised
      q.updatedAt = agoIso(0)
      return questionRes(db, q, ctx)
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/questions\/([^/]+)$/,
    fn: (db, ctx) => {
      const i = questions(db).findIndex(q => q.id === ctx.params[0])
      if (i < 0) throw notFound('Question', ctx.params[0])
      questions(db).splice(i, 1)
      return NO_CONTENT
    },
  },
]
