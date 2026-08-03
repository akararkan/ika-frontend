/* =========================================================
   Mock routes — /api/v1/researches  (RESEARCH_API surface)
   ---------------------------------------------------------
   Everything returned here is a WIRE shape: ResearchSummaryResponse
   for the paged feeds, ResearchResponse for the detail / lifecycle
   calls, CommentResponse, SourceResponse, MediaResponse and
   ContributorResponse for the children — exactly the records in
   ak.dev.irc.app.research.dto.response. The fixture stores a leaner
   row (one `body` instead of description + descriptionHtml, an
   `agoMin` instead of an instant) and this file projects it, so the
   response still travels through src/api/adapters.js unchanged.

   Writes mutate `db` in place: reacting, saving, commenting,
   publishing, uploading and deleting all stick until reload.
   ========================================================= */
import { page, paging, NO_CONTENT, mockError, agoIso } from '../util.js'

/* ---------- shared helpers ---------- */

const SHARE_HOST = 'https://irc.example.com'

/** Fixture minutes-ago → the backend's strict instant (null stays null). */
const iso = (min) => (min == null ? null : agoIso(min))
/** `scheduledPublishAt` is stored as minutes in the FUTURE. */
const future = (min) => (min == null ? null : agoIso(-min))

/** The server's `formattedDate` — TimeDisplayUtil.FULL_FORMAT, i.e.
 *  "Saturday, March 15, 2025 at 3:45 PM". Same shape here, rendered in the
 *  demo's language (the real server always answers in English, which would
 *  read wrong on an Arabic or Kurdish demo). */
const DATE_OPTS = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' }
function formatted(isoStr, lang = 'en') {
  if (!isoStr) return ''
  const d = new Date(isoStr)
  if (isNaN(d.getTime())) return ''
  const locale = { en: 'en-GB', ar: 'ar', ku: 'ckb-IQ', tr: 'tr' }[lang] || 'en-GB'
  try { return d.toLocaleString(locale, DATE_OPTS) }
  catch { return d.toLocaleString('en-GB', DATE_OPTS) }
}

/** mockError() is converted to an ApiError by http.js only on the SYNCHRONOUS
 *  throw path — a route that must `await` (the multipart create) rejects after
 *  resolveMock has already returned, so its error never passes through that
 *  conversion. Give those the ApiError surface (`status` / `code` / `payload`)
 *  up front so a caller reading `e.code` behaves identically either way. */
function asyncError(status, code, message) {
  const e = mockError(status, code, message)
  e.name = 'ApiError'
  e.status = status
  e.code = code
  e.payload = e.__mockBody
  return e
}

/** The signed-in demo user. The users fixture owns the profile; this only
 *  needs the id, and falls back to the researcher every other domain uses. */
function meId(db) {
  return db.me?.id || db.currentUser?.id || db.session?.userId || 'u-amina'
}

/** Cross-domain identity: prefer the users fixture so a research card and a
 *  profile page never disagree about someone's name; fall back to the copy
 *  carried on the research row (which is all a standalone fragment has). */
function identity(db, userId, fallback) {
  const u = (db.users || []).find(x => x?.id === userId || x?.userId === userId)
  if (!u && !fallback) fallback = knownUser(db, userId)
  const p = u?.profile || {}
  const joined = u ? [u.fname, u.lname].filter(Boolean).join(' ').trim() : ''
  return {
    id: userId,
    fullName: p.displayName || joined || u?.fullName || fallback?.fullName || 'Member',
    username: u?.username || fallback?.username || 'member',
    profileImage: p.avatarUrl || u?.avatarUrl || u?.profileImage || fallback?.profileImage || null,
    role: u?.role || fallback?.role || 'RESEARCHER',
  }
}

/** Last-resort identity: the name snapshot every research / comment row in this
 *  fragment carries, so the demo still reads correctly if the users fixture is
 *  missing (and so a comment written during the demo is signed properly). */
function knownUser(db, userId) {
  const r = (db.research || []).find(x => x.researcherId === userId && x.researcher)
  if (r) return r.researcher
  const c = (db.researchComments || []).find(x => x.userId === userId && x.user)
  return c ? c.user : null
}

const researchList = (db) => db.research || []
const findResearch = (db, id) => researchList(db).find(r => r.id === id)
function mustFind(db, id) {
  const r = findResearch(db, id)
  if (!r) throw mockError(404, 'RESEARCH_NOT_FOUND', 'Research not found')
  return r
}

const mediaOf   = (db, id) => (db.researchMedia || []).filter(m => m.researchId === id)
const sourcesOf = (db, id) => (db.researchSources || []).filter(s => s.researchId === id)
const commentsOf = (db, id) => (db.researchComments || []).filter(c => c.researchId === id)

/* ---------- DTO projections ---------- */

function sourceDto(s) {
  return {
    id: s.id,
    sourceType: s.sourceType,
    title: s.title || '',
    citationText: s.citationText || null,
    url: s.url || null,
    isbn: s.isbn || null,
    fileUrl: s.fileUrl || null,
    originalFileName: s.originalFileName || null,
    mimeType: s.mimeType || null,
    fileSize: s.fileSize ?? null,
    displayOrder: s.displayOrder ?? 0,
  }
}

function mediaDto(m) {
  return {
    id: m.id,
    fileUrl: m.fileUrl,
    originalFileName: m.originalFileName,
    mimeType: m.mimeType || null,
    mediaType: m.mediaType,
    fileSize: m.fileSize ?? null,
    displayOrder: m.displayOrder ?? 0,
    caption: m.caption || null,
    altText: m.altText || null,
    durationSeconds: m.durationSeconds ?? null,
    thumbnailUrl: m.thumbnailUrl || null,
    widthPx: m.widthPx ?? null,
    heightPx: m.heightPx ?? null,
  }
}

function contributorDto(db, c) {
  const u = identity(db, c.userId, c.user)
  return {
    id: c.id,
    userId: c.userId,
    fullName: u.fullName,
    username: u.username,
    profileImage: u.profileImage,
    userRole: u.role,
    role: c.role || 'CONTRIBUTOR',
    displayOrder: c.displayOrder ?? 0,
    contributionNote: c.contributionNote || null,
    addedAt: iso(c.addedAgoMin ?? 10000),
  }
}

/** Denormalised comment counter — derived, so a new comment or a delete is
 *  reflected on the detail header without a second bookkeeping step. */
const commentCount = (db, id) => commentsOf(db, id).length

/** A hidden comment is visible to the RESEARCH OWNER only — ResearchServiceImpl
 *  picks the `…AndIsHiddenFalse…` query for everyone else, and ResearchMapper
 *  applies the same filter to the nested replies. Leaking one here would put a
 *  "hidden" row on a stranger's paper, which the real API can never do. */
const canViewHidden = (db, researchId) => findResearch(db, researchId)?.researcherId === meId(db)

function commentDto(db, c, lang, withReplies = true) {
  const u = identity(db, c.userId, c.user)
  const created = iso(c.agoMin)
  const seeHidden = canViewHidden(db, c.researchId)
  const replies = withReplies
    ? commentsOf(db, c.researchId)
        .filter(x => x.parentId === c.id && (seeHidden || !x.isHidden))
        .sort((a, b) => (b.agoMin ?? 0) - (a.agoMin ?? 0))
        .map(x => commentDto(db, x, lang, false))
    : []
  return {
    id: c.id,
    researchId: c.researchId,
    userId: c.userId,
    userFullName: u.fullName,
    userUsername: u.username,
    userProfileImage: u.profileImage,
    content: c.content || '',
    mediaUrl: c.mediaUrl || null,
    mediaType: c.mediaType || null,
    mediaThumbnailUrl: c.mediaThumbnailUrl || null,
    voiceUrl: c.voiceUrl || null,
    voiceDurationSeconds: c.voiceDurationSeconds ?? null,
    likeCount: c.likeCount ?? 0,
    replyCount: commentsOf(db, c.researchId).filter(x => x.parentId === c.id).length,
    myReaction: c.myReaction || null,
    isEdited: !!c.isEdited,
    editedAt: c.isEdited ? iso(Math.max(0, (c.agoMin ?? 0) - 5)) : null,
    isHidden: !!c.isHidden,
    hiddenAt: c.isHidden ? iso(Math.max(0, (c.agoMin ?? 0) - 2)) : null,
    parentId: c.parentId || null,
    replies,
    createdAt: created,
    timeAgo: null,                       // client derives it — the demo has four languages
    formattedDate: formatted(created, lang),
  }
}

/** ResearchSummaryResponse — the feed / card projection. */
function summaryDto(db, r) {
  const u = identity(db, r.researcherId, r.researcher)
  return {
    id: r.id,
    slug: r.slug,
    ircId: r.ircId,
    title: r.title,
    abstractText: r.abstract || '',
    abstractHtml: r.abstract || '',
    coverImageUrl: r.coverImageUrl || null,
    videoPromoThumbnailUrl: r.videoPromoThumbnailUrl || null,
    researcherId: r.researcherId,
    researcherFullName: u.fullName,
    researcherUsername: u.username,
    researcherProfileImage: u.profileImage,
    status: r.status,
    publishedAt: iso(r.publishedAgoMin),
    viewCount: r.viewCount ?? 0,
    reactionCount: r.reactionCount ?? 0,
    commentCount: commentCount(db, r.id),
    downloadCount: r.downloadCount ?? 0,
    saveCount: r.saveCount ?? 0,
    shareCount: r.shareCount ?? 0,
    citationCount: r.citationCount ?? 0,
    tags: r.tags || [],
    shareUrl: `${SHARE_HOST}/r/${r.shareToken}`,
    currentUserReacted: !!r.currentUserReacted,
    currentUserSaved: !!r.currentUserSaved,
    savedAt: null,
  }
}

/** The saved-list variant — same row, plus the bookmark instant (§17). */
function savedSummaryDto(db, r) {
  return { ...summaryDto(db, r), savedAt: iso(r.savedAgoMin ?? 600) }
}

/** ResearchResponse — the full detail / lifecycle projection. */
function fullDto(db, r, lang) {
  const u = identity(db, r.researcherId, r.researcher)
  const created = iso(r.createdAgoMin)
  return {
    id: r.id,
    slug: r.slug,
    ircId: r.ircId,
    researcherId: r.researcherId,
    researcherFullName: u.fullName,
    researcherUsername: u.username,
    researcherProfileImage: u.profileImage,
    title: r.title,
    description: r.body || '',
    descriptionHtml: r.body || '',
    abstractText: r.abstract || '',
    abstractHtml: r.abstract || '',
    bodyFormat: r.bodyFormat || 'HTML',
    keywords: r.keywords || '',
    citation: r.citation || '',
    videoPromoUrl: r.videoPromoUrl || null,
    videoPromoDurationSeconds: r.videoPromoDurationSeconds ?? null,
    videoPromoThumbnailUrl: r.videoPromoThumbnailUrl || null,
    coverImageUrl: r.coverImageUrl || null,
    status: r.status,
    visibility: r.visibility || 'PUBLIC',
    scheduledPublishAt: future(r.scheduledPublishAt),
    publishedAt: iso(r.publishedAgoMin),
    viewCount: r.viewCount ?? 0,
    downloadCount: r.downloadCount ?? 0,
    reactionCount: r.reactionCount ?? 0,
    commentCount: commentCount(db, r.id),
    saveCount: r.saveCount ?? 0,
    shareCount: r.shareCount ?? 0,
    citationCount: r.citationCount ?? 0,
    commentsEnabled: r.commentsEnabled !== false,
    downloadsEnabled: r.downloadsEnabled !== false,
    shareToken: r.shareToken,
    shareUrl: `${SHARE_HOST}/r/${r.shareToken}`,
    tags: r.tags || [],
    mediaFiles: mediaOf(db, r.id).slice().sort(byOrder).map(mediaDto),
    sources: sourcesOf(db, r.id).slice().sort(byOrder).map(sourceDto),
    contributors: (r.contributors || []).slice().sort(byOrder).map(c => contributorDto(db, c)),
    currentUserReacted: !!r.currentUserReacted,
    currentUserReactionType: r.currentUserReacted ? 'LIKE' : null,
    currentUserSaved: !!r.currentUserSaved,
    createdAt: created,
    updatedAt: iso(r.updatedAgoMin ?? r.createdAgoMin),
    timeAgo: null,
    formattedDate: formatted(iso(r.publishedAgoMin) || created, lang),
  }
}

const byOrder = (a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0)
/** Newest first — publishedAt desc is the feed's declared sort. */
const byRecency = (a, b) => (a.publishedAgoMin ?? a.createdAgoMin ?? 0) - (b.publishedAgoMin ?? b.createdAgoMin ?? 0)

const isPublic = (r) => r.status === 'PUBLISHED' && (r.visibility || 'PUBLIC') === 'PUBLIC'

/** A newly uploaded file has no server URL in a fixture — an object URL keeps
 *  the demo honest (the image the user just picked actually renders). */
function localUrl(file) {
  try {
    if (typeof URL !== 'undefined' && typeof File !== 'undefined' && file instanceof File) return URL.createObjectURL(file)
  } catch { /* no DOM (SSR / tests) — fall through */ }
  return null
}

const isForm = (b) => (typeof FormData !== 'undefined' && b instanceof FormData)
const formFile = (b, ...names) => {
  if (!isForm(b)) return null
  for (const n of names) { const v = b.get(n); if (v && typeof v !== 'string') return v }
  return null
}
/** The create call's `data` part is an application/json Blob — read it async. */
async function formJson(b, name = 'data') {
  if (!isForm(b)) return b || {}
  const v = b.get(name)
  if (!v) return {}
  if (typeof v === 'string') { try { return JSON.parse(v) } catch { return {} } }
  try { return JSON.parse(await v.text()) } catch { return {} }
}

let seq = 0
const newId = (p) => `${p}-new-${Date.now().toString(36)}-${++seq}`

/** ResearchServiceImpl.resolveMediaType(), rule for rule — including the ones
 *  that look like oversights (`application/vnd.ms-excel` contains neither
 *  "spreadsheet" nor "csv", so the server files it under OTHER, and DATASET /
 *  CODE are never produced by the upload path at all). Guessing "better" here
 *  would hide a real classification from the screens that bucket on it. */
function mediaTypeOf(mime) {
  if (!mime) return 'OTHER'
  const l = String(mime).toLowerCase()
  if (l.startsWith('image/')) return 'IMAGE'
  if (l.startsWith('video/')) return 'VIDEO'
  if (l.startsWith('audio/')) return 'AUDIO'
  if (l.includes('pdf') || l.includes('word') || l.includes('presentation')) return 'DOCUMENT'
  if (l.includes('spreadsheet') || l.includes('csv')) return 'SPREADSHEET'
  if (l.includes('zip') || l.includes('tar') || l.includes('gzip')) return 'ARCHIVE'
  return 'OTHER'
}

/* ---------- routes ---------- */

export const routes = [
  /* ===== feeds & lists (most specific paths first) ===== */

  { m: 'GET', p: /^\/api\/v1\/researches\/feed\/following$/, fn: (db, ctx) => {
    const me = meId(db)
    /* "Following" is everyone but you — the follow graph lives in the social
       fixture, and a demo feed that hid half the corpus would look broken. */
    const rows = researchList(db).filter(r => isPublic(r) && r.researcherId !== me).sort(byRecency)
    return page(rows.map(r => summaryDto(db, r)), paging(ctx.query))
  } },

  { m: 'GET', p: /^\/api\/v1\/researches\/feed$/, fn: (db, ctx) =>
    page(researchList(db).filter(isPublic).sort(byRecency).map(r => summaryDto(db, r)), paging(ctx.query)) },

  { m: 'GET', p: /^\/api\/v1\/researches\/me\/drafts$/, fn: (db, ctx) => {
    const me = meId(db)
    let rows = researchList(db).filter(r => r.researcherId === me && r.status === 'DRAFT')
    if (!rows.length) rows = researchList(db).filter(r => r.status === 'DRAFT')
    return page(rows.sort(byRecency).map(r => summaryDto(db, r)), paging(ctx.query))
  } },

  { m: 'GET', p: /^\/api\/v1\/researches\/me\/all$/, fn: (db, ctx) => {
    const me = meId(db)
    let rows = researchList(db).filter(r => r.researcherId === me)
    if (!rows.length) rows = researchList(db).filter(r => r.researcherId === 'u-amina')
    return page(rows.sort(byRecency).map(r => summaryDto(db, r)), paging(ctx.query))
  } },

  { m: 'GET', p: /^\/api\/v1\/researches\/me\/saved\/collections$/, fn: (db) =>
    [...new Set(researchList(db).filter(r => r.currentUserSaved && r.savedCollection).map(r => r.savedCollection))] },

  { m: 'PATCH', p: /^\/api\/v1\/researches\/me\/saved\/collections$/, fn: (db, ctx) => {
    const { oldName, newName } = ctx.query || {}
    if (!oldName || !newName) throw mockError(400, 'INVALID_REQUEST', 'oldName and newName are required')
    researchList(db).forEach(r => { if (r.savedCollection === oldName) r.savedCollection = newName })
    return NO_CONTENT
  } },

  { m: 'GET', p: /^\/api\/v1\/researches\/me\/saved\/collection$/, fn: (db, ctx) => {
    const name = ctx.query?.name
    const rows = researchList(db).filter(r => r.currentUserSaved && r.savedCollection === name)
      .sort((a, b) => (a.savedAgoMin ?? 0) - (b.savedAgoMin ?? 0))
    return page(rows.map(r => savedSummaryDto(db, r)), paging(ctx.query))
  } },

  { m: 'GET', p: /^\/api\/v1\/researches\/me\/saved$/, fn: (db, ctx) => {
    const rows = researchList(db).filter(r => r.currentUserSaved)
      .sort((a, b) => (a.savedAgoMin ?? 0) - (b.savedAgoMin ?? 0))
    return page(rows.map(r => savedSummaryDto(db, r)), paging(ctx.query))
  } },

  { m: 'GET', p: /^\/api\/v1\/researches\/search\/tags$/, fn: (db, ctx) => {
    const raw = ctx.query?.tags
    const wanted = (Array.isArray(raw) ? raw : String(raw || '').split(',')).map(t => String(t).trim().toLowerCase()).filter(Boolean)
    const rows = researchList(db)
      .filter(r => isPublic(r) && (!wanted.length || (r.tags || []).some(t => wanted.includes(String(t).toLowerCase()))))
      .sort(byRecency)
    return page(rows.map(r => summaryDto(db, r)), paging(ctx.query))
  } },

  /* Legacy per-module trending (superseded by /api/v1/tags/trending) → List<String>. */
  { m: 'GET', p: /^\/api\/v1\/researches\/tags\/trending$/, fn: (db, ctx) => {
    const counts = new Map()
    researchList(db).filter(isPublic).forEach(r => (r.tags || []).forEach(t => counts.set(t, (counts.get(t) || 0) + 1)))
    const limit = Number(ctx.query?.limit ?? 10) || 10
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([t]) => t)
  } },

  { m: 'GET', p: /^\/api\/v1\/researches\/researcher\/([^/]+)$/, fn: (db, ctx) => {
    const rows = researchList(db).filter(r => r.researcherId === ctx.params[0] && r.status === 'PUBLISHED').sort(byRecency)
    return page(rows.map(r => summaryDto(db, r)), paging(ctx.query))
  } },

  { m: 'GET', p: /^\/api\/v1\/researches\/slug\/([^/]+)$/, fn: (db, ctx) => {
    const r = researchList(db).find(x => x.slug === ctx.params[0])
    if (!r) throw mockError(404, 'RESEARCH_NOT_FOUND', 'Research not found')
    return fullDto(db, r, ctx.lang)
  } },

  { m: 'GET', p: /^\/api\/v1\/researches\/share\/([^/]+)$/, fn: (db, ctx) => {
    const r = researchList(db).find(x => x.shareToken === ctx.params[0])
    if (!r) throw mockError(404, 'SHARE_TOKEN_INVALID', 'This share link is no longer valid')
    return fullDto(db, r, ctx.lang)
  } },

  /* ===== sources ===== */

  { m: 'GET', p: /^\/api\/v1\/researches\/([^/]+)\/sources$/, fn: (db, ctx) => {
    mustFind(db, ctx.params[0])
    return sourcesOf(db, ctx.params[0]).slice().sort(byOrder).map(sourceDto)
  } },

  { m: 'POST', p: /^\/api\/v1\/researches\/([^/]+)\/sources\/([^/]+)\/file$/, fn: (db, ctx) => {
    const s = sourcesOf(db, ctx.params[0]).find(x => x.id === ctx.params[1])
    if (!s) throw mockError(404, 'SOURCE_NOT_FOUND', 'Source not found')
    const f = formFile(ctx.body, 'file')
    if (!f) throw mockError(400, 'FILE_REQUIRED', 'A file part is required')
    s.sourceType = 'MEDIA_FILE'
    s.fileUrl = localUrl(f) || `https://files.example.org/ika/${f.name}`
    s.originalFileName = f.name
    s.mimeType = f.type || 'application/octet-stream'
    s.fileSize = f.size ?? null
    return sourceDto(s)
  } },

  { m: 'PATCH', p: /^\/api\/v1\/researches\/([^/]+)\/sources\/([^/]+)$/, fn: (db, ctx) => {
    const s = sourcesOf(db, ctx.params[0]).find(x => x.id === ctx.params[1])
    if (!s) throw mockError(404, 'SOURCE_NOT_FOUND', 'Source not found')
    const b = ctx.body || {}
    for (const k of ['sourceType', 'title', 'citationText', 'url', 'isbn', 'displayOrder']) {
      if (b[k] !== undefined) s[k] = b[k]
    }
    return sourceDto(s)
  } },

  /* ===== contributors ===== */

  { m: 'GET', p: /^\/api\/v1\/researches\/([^/]+)\/contributors$/, fn: (db, ctx) =>
    (mustFind(db, ctx.params[0]).contributors || []).slice().sort(byOrder).map(c => contributorDto(db, c)) },

  { m: 'POST', p: /^\/api\/v1\/researches\/([^/]+)\/contributors$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    const b = ctx.body || {}
    if (!b.userId) throw mockError(400, 'INVALID_REQUEST', 'userId is required')
    r.contributors = r.contributors || []
    const row = { id: newId('rct'), userId: b.userId, role: b.role || 'CO_AUTHOR', displayOrder: b.displayOrder ?? r.contributors.length + 1, contributionNote: b.contributionNote || null, addedAgoMin: 0 }
    r.contributors.push(row)
    return contributorDto(db, row)
  } },

  { m: 'PUT', p: /^\/api\/v1\/researches\/([^/]+)\/contributors$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    const list = Array.isArray(ctx.body) ? ctx.body : []
    r.contributors = list.map((b, i) => ({
      id: newId('rct'), userId: b.userId, role: b.role || 'CO_AUTHOR',
      displayOrder: b.displayOrder ?? i + 1, contributionNote: b.contributionNote || null, addedAgoMin: 0,
    }))
    return r.contributors.map(c => contributorDto(db, c))
  } },

  { m: 'PATCH', p: /^\/api\/v1\/researches\/([^/]+)\/contributors\/([^/]+)$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    const c = (r.contributors || []).find(x => x.id === ctx.params[1])
    if (!c) throw mockError(404, 'CONTRIBUTOR_NOT_FOUND', 'Contributor not found')
    const b = ctx.body || {}
    for (const k of ['role', 'displayOrder', 'contributionNote']) if (b[k] !== undefined) c[k] = b[k]
    return contributorDto(db, c)
  } },

  { m: 'DELETE', p: /^\/api\/v1\/researches\/([^/]+)\/contributors\/([^/]+)$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    r.contributors = (r.contributors || []).filter(x => x.id !== ctx.params[1])
    return NO_CONTENT
  } },

  /* ===== comments ===== */

  /* Roots only, newest first (…ParentIsNull…OrderByCreatedAtDesc), and hidden
     rows are dropped unless the viewer owns the research. */
  { m: 'GET', p: /^\/api\/v1\/researches\/([^/]+)\/comments$/, fn: (db, ctx) => {
    mustFind(db, ctx.params[0])
    const seeHidden = canViewHidden(db, ctx.params[0])
    const roots = commentsOf(db, ctx.params[0])
      .filter(c => !c.parentId && (seeHidden || !c.isHidden))
      .sort((a, b) => (a.agoMin ?? 0) - (b.agoMin ?? 0))
    return page(roots.map(c => commentDto(db, c, ctx.lang)), paging(ctx.query))
  } },

  /* Deliberately NOT async: reading a FormData part is synchronous, and a
     route that returns a promise loses the mockError → ApiError conversion in
     http.js (see asyncError above). */
  { m: 'POST', p: /^\/api\/v1\/researches\/([^/]+)\/comments\/upload$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    if (r.commentsEnabled === false) throw mockError(403, 'COMMENTS_DISABLED', 'Comments are turned off for this research')
    const b = ctx.body
    const text = isForm(b) ? String(b.get('content') || '') : String(b?.content || '')
    const parentId = (isForm(b) ? b.get('parentId') : b?.parentId) || null
    const file = formFile(b, 'file', 'media', 'image', 'video', 'voice', 'audio')
    const url = file ? (localUrl(file) || `https://files.example.org/ika/${file.name}`) : null
    const isVoice = !!file && /^audio\//.test(file.type || '')
    const row = {
      id: newId('rcm'), researchId: r.id, userId: meId(db), parentId, agoMin: 0,
      content: text, likeCount: 0, myReaction: null, isEdited: false, isHidden: false,
      mediaUrl: isVoice ? null : url,
      mediaType: file && !isVoice ? (/^video\//.test(file.type || '') ? 'VIDEO' : 'IMAGE') : null,
      mediaThumbnailUrl: null,
      voiceUrl: isVoice ? url : null,
      voiceDurationSeconds: isVoice ? 12 : null,
    }
    db.researchComments = db.researchComments || []
    db.researchComments.push(row)
    return commentDto(db, row, ctx.lang)
  } },

  { m: 'POST', p: /^\/api\/v1\/researches\/([^/]+)\/comments\/([^/]+)\/reactions$/, fn: (db, ctx) => {
    const c = commentsOf(db, ctx.params[0]).find(x => x.id === ctx.params[1])
    if (!c) throw mockError(404, 'COMMENT_NOT_FOUND', 'Comment not found')
    if (c.myReaction !== 'LIKE') { c.myReaction = 'LIKE'; c.likeCount = (c.likeCount ?? 0) + 1 }
    return NO_CONTENT
  } },

  { m: 'DELETE', p: /^\/api\/v1\/researches\/([^/]+)\/comments\/([^/]+)\/reactions$/, fn: (db, ctx) => {
    const c = commentsOf(db, ctx.params[0]).find(x => x.id === ctx.params[1])
    if (!c) throw mockError(404, 'COMMENT_NOT_FOUND', 'Comment not found')
    if (c.myReaction === 'LIKE') { c.myReaction = null; c.likeCount = Math.max(0, (c.likeCount ?? 0) - 1) }
    return commentDto(db, c, ctx.lang)
  } },

  { m: 'POST', p: /^\/api\/v1\/researches\/([^/]+)\/comments\/([^/]+)\/hide$/, fn: (db, ctx) => {
    const c = commentsOf(db, ctx.params[0]).find(x => x.id === ctx.params[1])
    if (!c) throw mockError(404, 'COMMENT_NOT_FOUND', 'Comment not found')
    c.isHidden = true
    return NO_CONTENT
  } },

  { m: 'POST', p: /^\/api\/v1\/researches\/([^/]+)\/comments\/([^/]+)\/unhide$/, fn: (db, ctx) => {
    const c = commentsOf(db, ctx.params[0]).find(x => x.id === ctx.params[1])
    if (!c) throw mockError(404, 'COMMENT_NOT_FOUND', 'Comment not found')
    c.isHidden = false
    return NO_CONTENT
  } },

  { m: 'PATCH', p: /^\/api\/v1\/researches\/([^/]+)\/comments\/([^/]+)$/, fn: (db, ctx) => {
    const c = commentsOf(db, ctx.params[0]).find(x => x.id === ctx.params[1])
    if (!c) throw mockError(404, 'COMMENT_NOT_FOUND', 'Comment not found')
    const content = String(ctx.body?.content || '').trim()
    if (!content) throw mockError(400, 'INVALID_REQUEST', 'Comment text is required')
    c.content = content
    c.isEdited = true
    return commentDto(db, c, ctx.lang)
  } },

  { m: 'DELETE', p: /^\/api\/v1\/researches\/([^/]+)\/comments\/([^/]+)$/, fn: (db, ctx) => {
    const id = ctx.params[1]
    /* Deleting a root takes its replies with it, exactly as the cascade does. */
    db.researchComments = (db.researchComments || []).filter(c => c.id !== id && c.parentId !== id)
    return NO_CONTENT
  } },

  { m: 'POST', p: /^\/api\/v1\/researches\/([^/]+)\/comments$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    if (r.commentsEnabled === false) throw mockError(403, 'COMMENTS_DISABLED', 'Comments are turned off for this research')
    const content = String(ctx.body?.content || '').trim()
    if (!content) throw mockError(400, 'INVALID_REQUEST', 'Comment text is required')
    const row = {
      id: newId('rcm'), researchId: r.id, userId: meId(db), parentId: ctx.body?.parentId || null,
      agoMin: 0, content, likeCount: 0, myReaction: null, isEdited: false, isHidden: false,
      mediaUrl: null, mediaType: null, mediaThumbnailUrl: null, voiceUrl: null, voiceDurationSeconds: null,
    }
    db.researchComments = db.researchComments || []
    db.researchComments.push(row)
    return commentDto(db, row, ctx.lang)
  } },

  /* ===== reactions / save ===== */

  { m: 'GET', p: /^\/api\/v1\/researches\/([^/]+)\/reactions\/breakdown$/, fn: (db, ctx) =>
    ({ LIKE: mustFind(db, ctx.params[0]).reactionCount ?? 0 }) },

  { m: 'POST', p: /^\/api\/v1\/researches\/([^/]+)\/reactions$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    if (!r.currentUserReacted) { r.currentUserReacted = true; r.reactionCount = (r.reactionCount ?? 0) + 1 }
    return NO_CONTENT
  } },

  { m: 'DELETE', p: /^\/api\/v1\/researches\/([^/]+)\/reactions$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    if (r.currentUserReacted) { r.currentUserReacted = false; r.reactionCount = Math.max(0, (r.reactionCount ?? 0) - 1) }
    return fullDto(db, r, ctx.lang)
  } },

  { m: 'POST', p: /^\/api\/v1\/researches\/([^/]+)\/save$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    if (!r.currentUserSaved) { r.currentUserSaved = true; r.saveCount = (r.saveCount ?? 0) + 1 }
    r.savedAgoMin = 0
    if (ctx.query?.collection) r.savedCollection = ctx.query.collection
    return fullDto(db, r, ctx.lang)
  } },

  { m: 'DELETE', p: /^\/api\/v1\/researches\/([^/]+)\/save$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    if (r.currentUserSaved) { r.currentUserSaved = false; r.saveCount = Math.max(0, (r.saveCount ?? 0) - 1) }
    r.savedCollection = null
    r.savedAgoMin = null
    return fullDto(db, r, ctx.lang)
  } },

  /* ===== views / downloads / share / cite ===== */

  { m: 'POST', p: /^\/api\/v1\/researches\/([^/]+)\/view$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    if (!r._viewed) { r._viewed = true; r.viewCount = (r.viewCount ?? 0) + 1 }   // one view per session, like the server-side dedupe
    return NO_CONTENT
  } },

  { m: 'POST', p: /^\/api\/v1\/researches\/([^/]+)\/download$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    const mediaId = ctx.query?.mediaId
    if (!mediaId) throw mockError(400, 'MISSING_MEDIA_ID', 'mediaId is required — downloads are tracked per file')
    const m = mediaOf(db, r.id).find(x => x.id === mediaId)
    if (!m) throw mockError(404, 'MEDIA_NOT_FOUND', 'File not found on this research')
    if (r.downloadsEnabled === false) throw mockError(403, 'DOWNLOADS_DISABLED', 'Downloads are turned off for this research')
    r.downloadCount = (r.downloadCount ?? 0) + 1
    return { url: m.fileUrl }
  } },

  { m: 'GET', p: /^\/api\/v1\/researches\/([^/]+)\/share-link$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    return { shortUrl: `${SHARE_HOST}/r/${r.shareToken}`, canonicalUrl: `${SHARE_HOST}/research/${r.id}`, token: r.shareToken, shareCount: r.shareCount ?? 0 }
  } },

  { m: 'POST', p: /^\/api\/v1\/researches\/([^/]+)\/share$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    r.shareCount = (r.shareCount ?? 0) + 1
    return { shortUrl: `${SHARE_HOST}/r/${r.shareToken}`, canonicalUrl: `${SHARE_HOST}/research/${r.id}`, token: r.shareToken, shareCount: r.shareCount }
  } },

  { m: 'POST', p: /^\/api\/v1\/researches\/([^/]+)\/cite$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    r.citationCount = (r.citationCount ?? 0) + 1
    return NO_CONTENT
  } },

  /* ===== media / cover / promo ===== */

  { m: 'POST', p: /^\/api\/v1\/researches\/([^/]+)\/media$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    const f = formFile(ctx.body, 'file', 'files', 'media', 'image', 'video')
    if (!f) throw mockError(400, 'FILE_REQUIRED', 'A file part is required')
    const row = {
      id: newId('rmed'), researchId: r.id,
      fileUrl: localUrl(f) || `https://files.example.org/ika/${f.name}`,
      originalFileName: f.name, mimeType: f.type || 'application/octet-stream',
      mediaType: mediaTypeOf(f.type || ''), fileSize: f.size ?? null,
      displayOrder: Number(ctx.query?.displayOrder ?? mediaOf(db, r.id).length) || 0,
      caption: ctx.query?.caption || null, altText: ctx.query?.altText || null,
      durationSeconds: null, thumbnailUrl: null, widthPx: null, heightPx: null,
    }
    db.researchMedia = db.researchMedia || []
    db.researchMedia.push(row)
    return mediaDto(row)
  } },

  { m: 'PATCH', p: /^\/api\/v1\/researches\/([^/]+)\/media\/([^/]+)$/, fn: (db, ctx) => {
    const m = mediaOf(db, ctx.params[0]).find(x => x.id === ctx.params[1])
    if (!m) throw mockError(404, 'MEDIA_NOT_FOUND', 'File not found on this research')
    const b = ctx.body || {}
    for (const k of ['caption', 'altText', 'displayOrder', 'durationSeconds', 'widthPx', 'heightPx']) {
      if (b[k] !== undefined) m[k] = b[k]
    }
    return mediaDto(m)
  } },

  { m: 'DELETE', p: /^\/api\/v1\/researches\/([^/]+)\/media\/([^/]+)$/, fn: (db, ctx) => {
    db.researchMedia = (db.researchMedia || []).filter(m => !(m.researchId === ctx.params[0] && m.id === ctx.params[1]))
    return NO_CONTENT
  } },

  { m: 'POST', p: /^\/api\/v1\/researches\/([^/]+)\/cover-image$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    const f = formFile(ctx.body, 'image', 'file', 'cover')
    if (!f) throw mockError(400, 'FILE_REQUIRED', 'The multipart part must be named `image`')
    r.coverImageUrl = localUrl(f) || `https://picsum.photos/seed/${encodeURIComponent(r.id)}-cover/1600/900`
    return fullDto(db, r, ctx.lang)
  } },

  { m: 'DELETE', p: /^\/api\/v1\/researches\/([^/]+)\/cover-image$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    r.coverImageUrl = null
    return fullDto(db, r, ctx.lang)
  } },

  { m: 'POST', p: /^\/api\/v1\/researches\/([^/]+)\/video-promo$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    const v = formFile(ctx.body, 'video', 'file')
    if (!v) throw mockError(400, 'FILE_REQUIRED', 'A `video` part is required')
    const thumb = formFile(ctx.body, 'thumbnail', 'poster')
    r.videoPromoUrl = localUrl(v) || `https://files.example.org/ika/${v.name}`
    r.videoPromoDurationSeconds = 45
    r.videoPromoThumbnailUrl = thumb ? (localUrl(thumb) || null) : `https://picsum.photos/seed/${encodeURIComponent(r.id)}-promo/1280/720`
    return fullDto(db, r, ctx.lang)
  } },

  { m: 'DELETE', p: /^\/api\/v1\/researches\/([^/]+)\/video-promo$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    r.videoPromoUrl = null
    r.videoPromoDurationSeconds = null
    r.videoPromoThumbnailUrl = null
    return fullDto(db, r, ctx.lang)
  } },

  /* ===== lifecycle ===== */

  { m: 'POST', p: /^\/api\/v1\/researches\/([^/]+)\/publish$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    r.status = 'PUBLISHED'
    r.publishedAgoMin = 0
    r.updatedAgoMin = 0
    if ((r.visibility || 'PRIVATE') === 'PRIVATE') r.visibility = 'PUBLIC'
    return fullDto(db, r, ctx.lang)
  } },

  { m: 'POST', p: /^\/api\/v1\/researches\/([^/]+)\/unpublish$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    r.status = 'DRAFT'
    r.publishedAgoMin = null
    r.updatedAgoMin = 0
    return fullDto(db, r, ctx.lang)
  } },

  { m: 'POST', p: /^\/api\/v1\/researches\/([^/]+)\/archive$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    r.status = 'ARCHIVED'
    r.updatedAgoMin = 0
    return fullDto(db, r, ctx.lang)
  } },

  { m: 'POST', p: /^\/api\/v1\/researches\/([^/]+)\/retract$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    r.status = 'RETRACTED'
    r.updatedAgoMin = 0
    return fullDto(db, r, ctx.lang)
  } },

  /* Not in the Java controller yet — the client calls it to mirror unpublish
     (RETRACTED → PUBLISHED). Kept so the owner toolbar round-trips in a demo. */
  { m: 'POST', p: /^\/api\/v1\/researches\/([^/]+)\/unretract$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    r.status = 'PUBLISHED'
    r.updatedAgoMin = 0
    return fullDto(db, r, ctx.lang)
  } },

  /* ===== create / update / delete / read-one (least specific, last) ===== */

  { m: 'POST', p: /^\/api\/v1\/researches$/, fn: async (db, ctx) => {
    const data = await formJson(ctx.body, 'data')
    if (!data.title || !String(data.title).trim()) throw asyncError(400, 'VALIDATION_ERROR', 'Title is required')
    const me = meId(db)
    const id = newId('r')
    const n = researchList(db).length + 1
    const row = {
      id,
      slug: String(data.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || id,
      ircId: `IRC-2026-${String(200 + n).padStart(6, '0')}`,
      researcherId: me,
      researcher: identity(db, me),
      status: 'DRAFT',
      visibility: data.visibility || 'PUBLIC',
      bodyFormat: data.bodyFormat || 'HTML',
      coverImageUrl: null,
      videoPromoUrl: null, videoPromoDurationSeconds: null, videoPromoThumbnailUrl: null,
      shareToken: Math.random().toString(16).slice(2, 18).padEnd(16, '0'),
      tags: data.tags || [],
      publishedAgoMin: null, createdAgoMin: 0, updatedAgoMin: 0,
      scheduledPublishAt: null,
      viewCount: 0, downloadCount: 0, reactionCount: 0, commentCount: 0, saveCount: 0, shareCount: 0, citationCount: 0,
      commentsEnabled: data.commentsEnabled !== false,
      downloadsEnabled: data.downloadsEnabled !== false,
      currentUserReacted: false, currentUserSaved: false, savedCollection: null, savedAgoMin: null,
      contributors: (data.contributors || []).map((c, i) => ({
        id: newId('rct'), userId: c.userId, role: c.role || 'CO_AUTHOR',
        displayOrder: c.displayOrder ?? i + 1, contributionNote: c.contributionNote || null, addedAgoMin: 0,
      })),
      title: String(data.title).trim(),
      abstract: data.abstractText || '',
      body: data.description || '',
      keywords: data.keywords || '',
      citation: data.citation || '',
    }
    db.research = researchList(db)
    db.research.unshift(row)

    /* sources[] and mediaFiles[] arrive with the create call; the binary parts
       are matched to mediaFiles metadata by index (`files[i]` ⇄ mediaFiles[i]). */
    db.researchSources = db.researchSources || []
    ;(data.sources || []).forEach((s, i) => db.researchSources.push({
      id: newId('rsrc'), researchId: id, sourceType: s.sourceType || 'MANUAL', title: s.title || '',
      citationText: s.citationText || null, url: s.url || null, isbn: s.isbn || null,
      fileUrl: null, originalFileName: null, mimeType: null, fileSize: null,
      displayOrder: s.displayOrder ?? i,
    }))
    const files = isForm(ctx.body)
      ? [...ctx.body.getAll('files'), ...ctx.body.getAll('files[]')].filter(f => f && typeof f !== 'string')
      : []
    db.researchMedia = db.researchMedia || []
    ;(data.mediaFiles || []).forEach((meta, i) => {
      const f = files[i]
      db.researchMedia.push({
        id: newId('rmed'), researchId: id,
        fileUrl: (f && localUrl(f)) || `https://files.example.org/ika/${f?.name || `upload-${i + 1}`}`,
        originalFileName: f?.name || `upload-${i + 1}`,
        mimeType: f?.type || 'application/octet-stream',
        mediaType: mediaTypeOf(f?.type || ''), fileSize: f?.size ?? null,
        displayOrder: meta.displayOrder ?? i, caption: meta.caption || null, altText: meta.altText || null,
        durationSeconds: null, thumbnailUrl: null, widthPx: null, heightPx: null,
      })
    })
    if (data.scheduledPublishAt) {
      const mins = Math.round((new Date(data.scheduledPublishAt).getTime() - Date.now()) / 60000)
      row.scheduledPublishAt = Number.isFinite(mins) ? mins : null
    }
    return fullDto(db, row, ctx.lang)
  } },

  { m: 'PATCH', p: /^\/api\/v1\/researches\/([^/]+)$/, fn: (db, ctx) => {
    const r = mustFind(db, ctx.params[0])
    const b = ctx.body || {}
    if (b.title !== undefined) r.title = b.title
    if (b.description !== undefined) r.body = b.description
    if (b.abstractText !== undefined) r.abstract = b.abstractText
    for (const k of ['bodyFormat', 'keywords', 'citation', 'visibility', 'tags']) if (b[k] !== undefined) r[k] = b[k]
    if (b.commentsEnabled !== undefined) r.commentsEnabled = !!b.commentsEnabled
    if (b.downloadsEnabled !== undefined) r.downloadsEnabled = !!b.downloadsEnabled
    if (b.scheduledPublishAt !== undefined) {
      const t = b.scheduledPublishAt ? Math.round((new Date(b.scheduledPublishAt).getTime() - Date.now()) / 60000) : null
      r.scheduledPublishAt = Number.isFinite(t) ? t : null
    }
    if (Array.isArray(b.sources)) {
      db.researchSources = (db.researchSources || []).filter(s => s.researchId !== r.id)
      b.sources.forEach((s, i) => db.researchSources.push({
        id: newId('rsrc'), researchId: r.id, sourceType: s.sourceType || 'MANUAL', title: s.title || '',
        citationText: s.citationText || null, url: s.url || null, isbn: s.isbn || null,
        fileUrl: null, originalFileName: null, mimeType: null, fileSize: null, displayOrder: s.displayOrder ?? i,
      }))
    }
    if (Array.isArray(b.contributors)) {
      r.contributors = b.contributors.map((c, i) => ({
        id: newId('rct'), userId: c.userId, role: c.role || 'CO_AUTHOR',
        displayOrder: c.displayOrder ?? i + 1, contributionNote: c.contributionNote || null, addedAgoMin: 0,
      }))
    }
    r.updatedAgoMin = 0
    return fullDto(db, r, ctx.lang)
  } },

  { m: 'DELETE', p: /^\/api\/v1\/researches\/([^/]+)$/, fn: (db, ctx) => {
    const id = ctx.params[0]
    mustFind(db, id)
    db.research = researchList(db).filter(r => r.id !== id)
    db.researchComments = (db.researchComments || []).filter(c => c.researchId !== id)
    db.researchSources = (db.researchSources || []).filter(s => s.researchId !== id)
    db.researchMedia = (db.researchMedia || []).filter(m => m.researchId !== id)
    return NO_CONTENT
  } },

  { m: 'GET', p: /^\/api\/v1\/researches\/([^/]+)$/, fn: (db, ctx) => fullDto(db, mustFind(db, ctx.params[0]), ctx.lang) },
]

export default routes
