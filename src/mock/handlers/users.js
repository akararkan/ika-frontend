/* =========================================================
   Mock handlers — users, profiles & the social graph
   ---------------------------------------------------------
   Wire shapes only. Every value returned here is the Java DTO
   the real controller returns, because the response still runs
   through src/api/adapters.js (userFrom / followSuggestionFrom
   / userStatsFrom) exactly as a live one does:

     UserResponse        → user/mapper/UserMapper#toResponse
     ProfileResponse     → …#toProfileResponse   (links & contacts
                            are filtered by isPublic THERE, for the
                            owner too — mirrored here on purpose)
     SocialActionResponse / SocialStatusResponse
     FollowSuggestionResponse / UserStatsResponse
     Topic / Madhhab rows (id + nameEn/nameAr/nameCkb)
     TagController.TrendingTag / TaggedContent / TagSuggestion

   COUNTS ARE DERIVED, NOT STORED. `followerCount` is a stored
   base (the people not in the fixture) PLUS the live edge count,
   so following someone moves the number on the profile header,
   in social-status and in the follower list at once — and a
   reload puts it back. Anything else makes the demo lie.
   ========================================================= */
import { page, paging, NO_CONTENT, mockError, agoIso } from '../util.js'

/* ---------- fixture access ---------- */

const FALLBACK_ME = 'u-amina'

/** The signed-in user, as the LIVE object out of db.users — db.me is rewritten
 *  to point at it so a mutation through either handle sticks for both.
 *
 *  The fixture's `me` stub carries `userId`; other domains' handlers read it to
 *  learn who the viewer is. Re-pointing `db.me` at a UserResponse-shaped row
 *  would take that key away from them, so it is re-attached NON-ENUMERABLY —
 *  visible to `db.me.userId`, invisible to JSON.stringify and Object.keys, so
 *  it can never leak onto the wire through some other domain's projection. */
function meUser(db) {
  const id = db?.me?.userId || db?.me?.id || FALLBACK_ME
  const u = list(db, 'users').find(x => String(x.id) === String(id)) || list(db, 'users')[0] || null
  if (u && db.me !== u) {
    if (!('userId' in u)) {
      try { Object.defineProperty(u, 'userId', { value: u.id, enumerable: false, configurable: true }) } catch { /* frozen fixture */ }
    }
    db.me = u
  }
  return u
}
function meId(db) { return meUser(db)?.id || FALLBACK_ME }

/** An array-valued fixture key, created on demand so writes always have a home. */
function list(db, key) {
  if (!Array.isArray(db[key])) db[key] = []
  return db[key]
}

function findUser(db, id) {
  if (id === null || id === undefined || id === '') return null
  const s = String(id)
  if (s === 'me') return meUser(db)
  return list(db, 'users').find(u => String(u.id) === s) || null
}
function userOr404(db, id) {
  const u = findUser(db, id)
  if (!u) throw mockError(404, 'USER_NOT_FOUND', 'User not found')
  return u
}

const uid = (p) => `${p}-${Math.random().toString(36).slice(2, 10)}`

/* ---------- the graph ---------- */

const follows = (db) => list(db, 'follows')
const blocks = (db) => list(db, 'blocked')
const restrictions = (db) => list(db, 'restricted')
const closeFriendIds = (db) => list(db, 'closeFriends')

const isFollowing = (db, a, b) => follows(db).some(e => String(e.followerId) === String(a) && String(e.followingId) === String(b))
const isBlocking = (db, a, b) => blocks(db).some(e => String(e.blockerId) === String(a) && String(e.blockedId) === String(b))
const isRestricting = (db, a, b) => restrictions(db).some(e => String(e.restrictorId) === String(a) && String(e.restrictedId) === String(b))

const followerIdsOf = (db, id) => follows(db).filter(e => String(e.followingId) === String(id)).map(e => e.followerId)
const followingIdsOf = (db, id) => follows(db).filter(e => String(e.followerId) === String(id)).map(e => e.followingId)

/* Stored base (everyone the fixture does not model) + the live edges. */
const followerCountOf = (db, u) => (u?._followerBase ?? 0) + followerIdsOf(db, u?.id).length
const followingCountOf = (db, u) => (u?._followingBase ?? 0) + followingIdsOf(db, u?.id).length

/* ---------- DTO projections ---------- */

function topicDto(s) {
  return {
    topicId: s?.topicId ?? s?.id ?? null,
    nameEn: s?.nameEn || '',
    nameAr: s?.nameAr || '',
    nameCkb: s?.nameCkb || '',
  }
}

function linkDto(l) {
  return {
    id: l.id,
    platform: l.platform || 'OTHER',
    description: l.description || '',
    url: l.url || '',
    isPublic: l.isPublic !== false,
    displayOrder: l.displayOrder ?? 0,
  }
}

function contactDto(c) {
  return { id: c.id, platform: c.platform || 'OTHER', value: c.value || '', isPublic: c.isPublic !== false }
}

function attachmentDto(a) {
  return {
    id: a.id,
    fileUrl: a.fileUrl || '',
    fileName: a.fileName || '',
    fileType: a.fileType || '',
    fileSize: a.fileSize ?? 0,
    description: a.description || '',
    uploadedAt: a.uploadedAt || null,
  }
}

/** UserResponse. `self` only widens profileViews — UserMapper filters links and
 *  contacts by isPublic for the owner too, so we do the same. */
function userResponse(db, u, viewerId) {
  if (!u) return null
  const p = u.profile || {}
  const self = String(u.id) === String(viewerId)
  return {
    id: u.id,
    fname: u.fname || '',
    lname: u.lname || '',
    username: u.username || '',
    email: u.email || null,
    role: u.role || 'USER',
    badges: (u.badges || []).map(b => ({
      type: b.type, label: b.label || '', colorKey: b.colorKey || 'gray',
      icon: b.icon || '', priority: b.priority ?? 99,
    })),
    isEmailVerified: !!u.isEmailVerified,
    profile: {
      displayName: p.displayName || '',
      avatarUrl: p.avatarUrl || null,
      coverImageUrl: p.coverImageUrl || null,
      profileBio: p.profileBio || '',
      selfDescriber: p.selfDescriber || '',
      location: p.location || '',
      academicTitle: p.academicTitle || '',
      institutionName: p.institutionName || '',
      madhhabId: p.madhhabId ?? null,
      madhhabName: p.madhhabName ?? null,
      websiteUrl: p.websiteUrl || '',
      specializations: (p.specializations || []).map(topicDto),
      followerCount: followerCountOf(db, u),
      followingCount: followingCountOf(db, u),
      researchCount: p.researchCount ?? 0,
      fatwaCount: p.fatwaCount ?? 0,
      isForHire: !!p.isForHire,
      isProfileLocked: !!p.isProfileLocked,
      contentLanguage: p.contentLanguage || 'EN',
      profileViews: self ? (p.profileViews ?? 0) : 0,
      links: (p.links || []).filter(l => l.isPublic !== false).map(linkDto),
      contacts: (p.contacts || []).filter(c => c.isPublic !== false).map(contactDto),
      attachments: (p.attachments || []).map(attachmentDto),
    },
    createdAt: u.createdAt || null,
  }
}

const usersPage = (db, ids, query, viewerId) =>
  page(ids.map(id => userResponse(db, findUser(db, id), viewerId)).filter(Boolean), paging(query))

function socialStatus(db, viewer, target) {
  return {
    isFollowing: isFollowing(db, viewer, target.id),
    isBlocking: isBlocking(db, viewer, target.id),
    isRestricting: isRestricting(db, viewer, target.id),
    isBlockedByThem: isBlocking(db, target.id, viewer),
    followerCount: followerCountOf(db, target),
    followingCount: followingCountOf(db, target),
  }
}

/** SocialActionResponse — every social write answers with this. */
function socialAction(db, action, target) {
  return {
    action,
    targetId: target.id,
    targetUsername: target.username || '',
    targetProfileImage: target.profile?.avatarUrl || null,
    updatedStatus: socialStatus(db, meId(db), target),
    performedAt: agoIso(0),
  }
}

function followSuggestion(db, u, { mutualCount = 0, reason = '' } = {}) {
  return {
    id: u.id,
    username: u.username || '',
    displayName: u.profile?.displayName || '',
    avatarUrl: u.profile?.avatarUrl || null,
    followerCount: followerCountOf(db, u),
    role: u.role || 'USER',
    isFollowing: isFollowing(db, meId(db), u.id),
    mutualCount,
    reason,
  }
}

/* ---------- misc helpers ---------- */

const norm = (v) => String(v ?? '').toLowerCase().trim()

/** USER_API §8.1 — the username charset, verbatim from UpdateProfileRequest. */
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,50}$/

/** Every text column /users/search matches on (Postgres FTS, mirrored loosely). */
function userHaystack(u) {
  const p = u.profile || {}
  return norm([u.fname, u.lname, u.username, p.displayName, p.academicTitle, p.institutionName, p.selfDescriber,
    ...(p.specializations || []).flatMap(s => [s.nameEn, s.nameAr, s.nameCkb])].filter(Boolean).join(' '))
}

/** The author of a row in ANOTHER domain's fixture — spelled a few ways
 *  across modules, so try each rather than assume one. */
function authorIdOf(row) {
  return String(row?.authorId ?? row?.author?.id ?? row?.userId ?? row?.user?.id ?? row?.ownerId ?? '')
}

/** Live count for one of the profile tabs, from the collection that owns it.
 *  Null when that fixture slice is absent (or names its author differently),
 *  so the caller can fall back to the stored count instead of showing 0. */
function liveCount(db, key, id) {
  const rows = db[key]
  if (!Array.isArray(rows) || !rows.length) return null
  const n = rows.filter(r => authorIdOf(r) === String(id)).length
  return n > 0 ? n : null
}

/** An uploaded image, as something the browser can actually render. The real
 *  endpoint stores the file and returns a URL; a blob URL is the local
 *  equivalent, and it survives until the tab closes — long enough for a demo. */
function uploadedImageUrl(body, fallback) {
  try {
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const file = body.get('image')
      if (file && typeof URL !== 'undefined' && URL.createObjectURL) return URL.createObjectURL(file)
    }
  } catch { /* private mode / no blob support — fall through */ }
  return fallback
}

/** WhoToFollowService#reason, in the demo's four languages.
 *  The live backend hard-codes these English literals; the fixture is a
 *  four-language rehearsal, so a card in Arabic mode must not read
 *  "Verified Scholar". Wire shape is unchanged — still one plain string. */
const WHY_FOLLOW = {
  SCHOLAR: { en: 'Verified Scholar', ar: 'عالِم موثَّق', ku: 'زانای پشتڕاستکراوە', tr: 'Doğrulanmış âlim' },
  RESEARCHER: { en: 'Verified Researcher', ar: 'باحث موثَّق', ku: 'لێکۆڵەری پشتڕاستکراوە', tr: 'Doğrulanmış araştırmacı' },
  USER: { en: 'Suggested for you', ar: 'مقترَح لك', ku: 'پێشنیارکراو بۆ تۆ', tr: 'Sizin için önerildi' },
}
const whyFollow = (role, lang) => {
  const node = WHY_FOLLOW[role] || WHY_FOLLOW.USER
  return node[lang] || node.en
}

/** WhoToFollowService#whoToFollow — SCHOLAR → RESEARCHER → USER, then follower
 *  count DESC; self-excluded, already-followed excluded, block-filtered in
 *  BOTH directions. Shared, because `me/suggestions` documents itself as
 *  falling back to exactly this list when the suggestion partition is empty. */
function whoToFollowRows(db, lang, limit) {
  const me = meId(db)
  const rank = (u) => (u.role === 'SCHOLAR' ? 0 : u.role === 'RESEARCHER' ? 1 : 2)
  return list(db, 'users')
    .filter(u => String(u.id) !== String(me)
      && !isFollowing(db, me, u.id)
      && !isBlocking(db, me, u.id)
      && !isBlocking(db, u.id, me))
    .sort((a, b) => rank(a) - rank(b)
      || followerCountOf(db, b) - followerCountOf(db, a)
      || String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
    .slice(0, limit)
    .map(u => followSuggestion(db, u, { mutualCount: 0, reason: whyFollow(u.role, lang) }))
}

const GENERIC_AVATAR = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'><rect width='96' height='96' fill='%23002147'/><circle cx='48' cy='38' r='15' fill='%23B9D6F2'/><path d='M18 88c6-18 18-26 30-26s24 8 30 26z' fill='%23B9D6F2'/></svg>"
const GENERIC_COVER = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 300'><rect width='1200' height='300' fill='%23002147'/></svg>"

/* =========================================================
   ROUTES — specific literals first, `/users/{id}` last.
   ========================================================= */
export const routes = [

  /* ---------- suggestions (§11.12-11.14) ---------- */
  {
    /* Friends-of-friends. Documented to FALL BACK to who-to-follow when the
       partition comes back empty (a cold graph, or everything dismissed) —
       the people picker in the chat composer reads this endpoint, and an
       empty list there is the difference between a demo and a dead screen. */
    m: 'GET', p: /^\/api\/v1\/users\/me\/suggestions$/,
    fn: (db, { query, lang }) => {
      const me = meId(db)
      const dismissed = list(db, '_dismissedSuggestions')
      const limit = Number(query.limit ?? 20) || 20
      const rows = list(db, 'suggestions')
        .map(s => ({ s, u: findUser(db, s.id) }))
        .filter(({ s, u }) => u && String(u.id) !== String(me)
          && !isFollowing(db, me, u.id)
          && !isBlocking(db, me, u.id)
          && !isBlocking(db, u.id, me)
          && !dismissed.includes(String(s.id)))
        .slice(0, limit)
        .map(({ s, u }) => followSuggestion(db, u, s))
      if (rows.length) return rows
      /* Not dismissal-filtered, and that is the real behaviour, not an
         oversight: `dismiss` deletes from the friends-of-friends partition,
         and findWhoToFollow's only exclusions are self / already-followed /
         blocked-either-way. Dismissing every mutual therefore hands you the
         popular list rather than an empty picker. */
      return whoToFollowRows(db, lang, limit)
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/users\/me\/suggestions\/([^/]+)$/,
    fn: (db, { params }) => {
      const dismissed = list(db, '_dismissedSuggestions')
      if (!dismissed.includes(String(params[0]))) dismissed.push(String(params[0]))
      return NO_CONTENT
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/users\/who-to-follow$/,
    fn: (db, { query, lang }) => whoToFollowRows(db, lang, Number(query.limit ?? 20) || 20),
  },

  /* ---------- search (§9.6) ---------- */
  {
    m: 'GET', p: /^\/api\/v1\/users\/search$/,
    fn: (db, { query }) => {
      const q = norm(query.q)
      const eligible = String(query.eligibleContributor) === 'true'
      const rows = list(db, 'users')
        .filter(u => !eligible || u.role === 'RESEARCHER' || u.role === 'SCHOLAR')
        .filter(u => !q || userHaystack(u).includes(q))
      return page(rows.map(u => userResponse(db, u, meId(db))), paging(query))
    },
  },

  /* ---------- my lists (§11.7 / §11.10 / §13) ---------- */
  {
    m: 'GET', p: /^\/api\/v1\/users\/me\/blocked$/,
    fn: (db, { query }) => usersPage(db, blocks(db).filter(e => String(e.blockerId) === String(meId(db))).map(e => e.blockedId), query, meId(db)),
  },
  {
    m: 'GET', p: /^\/api\/v1\/users\/me\/restricted$/,
    fn: (db, { query }) => usersPage(db, restrictions(db).filter(e => String(e.restrictorId) === String(meId(db))).map(e => e.restrictedId), query, meId(db)),
  },
  {
    m: 'GET', p: /^\/api\/v1\/users\/me\/close-friends$/,
    fn: (db, { query }) => usersPage(db, closeFriendIds(db), query, meId(db)),
  },
  {
    m: 'POST', p: /^\/api\/v1\/users\/me\/close-friends\/([^/]+)$/,
    fn: (db, { params }) => {
      const target = userOr404(db, params[0])
      if (String(target.id) === String(meId(db))) throw mockError(400, 'SELF_ACTION', 'Cannot add yourself to close friends.')
      const cf = closeFriendIds(db)
      if (!cf.some(id => String(id) === String(target.id))) cf.unshift(target.id)
      return NO_CONTENT
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/users\/me\/close-friends\/([^/]+)$/,
    fn: (db, { params }) => {
      const cf = closeFriendIds(db)
      const i = cf.findIndex(id => String(id) === String(params[0]))
      if (i >= 0) cf.splice(i, 1)
      return NO_CONTENT
    },
  },

  /* ---------- my profile (§10) ---------- */
  {
    m: 'GET', p: /^\/api\/v1\/users\/me\/profile$/,
    fn: (db) => userResponse(db, meUser(db), meId(db)),
  },
  {
    /* §10.8 — REPLACE-ALL and transactional: one unknown topicId 404s the whole
       request and nothing is applied. */
    m: 'PATCH', p: /^\/api\/v1\/users\/me\/profile\/specializations$/,
    fn: (db, { body }) => {
      const me = meUser(db)
      const rows = Array.isArray(body?.specializations) ? body.specializations : []
      const next = rows
        .slice()
        .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0))
        .map(r => {
          const t = list(db, 'topics').find(x => Number(x.id) === Number(r.topicId ?? r))
          if (!t) throw mockError(404, 'TOPIC_NOT_FOUND', `Topic ${r.topicId ?? r} not found`)
          return { topicId: t.id, nameEn: t.nameEn, nameAr: t.nameAr, nameCkb: t.nameCkb }
        })
      me.profile.specializations = next
      return userResponse(db, me, me.id)
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/users\/me\/profile\/avatar$/,
    fn: (db, { body }) => {
      const me = meUser(db)
      me.profile.avatarUrl = uploadedImageUrl(body, GENERIC_AVATAR)
      return userResponse(db, me, me.id)
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/users\/me\/profile\/avatar$/,
    fn: (db) => { const me = meUser(db); me.profile.avatarUrl = null; return userResponse(db, me, me.id) },
  },
  {
    m: 'POST', p: /^\/api\/v1\/users\/me\/profile\/cover$/,
    fn: (db, { body }) => {
      const me = meUser(db)
      me.profile.coverImageUrl = uploadedImageUrl(body, GENERIC_COVER)
      return userResponse(db, me, me.id)
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/users\/me\/profile\/cover$/,
    fn: (db) => { const me = meUser(db); me.profile.coverImageUrl = null; return userResponse(db, me, me.id) },
  },
  {
    /* §10.3 — UpdateUserProfileRequest. A null/absent field is left alone;
       an empty string clears. `madhhabId` re-resolves the English name, which
       is the only one the wire carries. */
    m: 'PATCH', p: /^\/api\/v1\/users\/me\/profile$/,
    fn: (db, { body }) => {
      const me = meUser(db)
      const p = me.profile
      const b = body || {}
      for (const k of ['displayName', 'profileBio', 'selfDescriber', 'location', 'academicTitle', 'institutionName', 'websiteUrl', 'contentLanguage']) {
        if (b[k] !== undefined && b[k] !== null) p[k] = b[k]
      }
      for (const k of ['isForHire', 'isProfileLocked']) {
        if (b[k] !== undefined && b[k] !== null) p[k] = !!b[k]
      }
      if (b.madhhabId !== undefined) {
        const m = list(db, 'madhhabs').find(x => Number(x.id) === Number(b.madhhabId))
        if (b.madhhabId !== null && !m) throw mockError(404, 'MADHHAB_NOT_FOUND', 'Madhhab not found')
        p.madhhabId = m ? m.id : null
        p.madhhabName = m ? m.nameEn : null
      }
      return userResponse(db, me, me.id)
    },
  },

  /* ---------- links (§9.7-9.9) ---------- */
  {
    m: 'POST', p: /^\/api\/v1\/users\/me\/links$/,
    fn: (db, { body }) => {
      const me = meUser(db)
      const row = {
        id: uid('lnk'),
        platform: body?.platform || 'OTHER',
        description: body?.description || '',
        url: body?.url || '',
        isPublic: body?.isPublic !== false,
        displayOrder: body?.displayOrder ?? (me.profile.links || []).length,
      }
      if (!Array.isArray(me.profile.links)) me.profile.links = []
      me.profile.links.push(row)
      return linkDto(row)
    },
  },
  {
    m: 'PATCH', p: /^\/api\/v1\/users\/me\/links\/([^/]+)$/,
    fn: (db, { params, body }) => {
      const row = (meUser(db).profile.links || []).find(l => String(l.id) === String(params[0]))
      if (!row) throw mockError(404, 'LINK_NOT_FOUND', 'Link not found')
      for (const k of ['platform', 'description', 'url', 'isPublic', 'displayOrder']) {
        if (body?.[k] !== undefined && body[k] !== null) row[k] = body[k]
      }
      return linkDto(row)
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/users\/me\/links\/([^/]+)$/,
    fn: (db, { params }) => {
      const links = meUser(db).profile.links || []
      const i = links.findIndex(l => String(l.id) === String(params[0]))
      if (i < 0) throw mockError(404, 'LINK_NOT_FOUND', 'Link not found')
      links.splice(i, 1)
      return NO_CONTENT
    },
  },

  /* ---------- contacts (§9.10-9.12) ---------- */
  {
    m: 'POST', p: /^\/api\/v1\/users\/me\/contacts$/,
    fn: (db, { body }) => {
      const me = meUser(db)
      const row = {
        id: uid('ct'),
        platform: body?.platform || 'OTHER',
        value: body?.value || '',
        isPublic: body?.isPublic !== false,
      }
      if (!Array.isArray(me.profile.contacts)) me.profile.contacts = []
      me.profile.contacts.push(row)
      return contactDto(row)
    },
  },
  {
    m: 'PATCH', p: /^\/api\/v1\/users\/me\/contacts\/([^/]+)$/,
    fn: (db, { params, body }) => {
      const row = (meUser(db).profile.contacts || []).find(c => String(c.id) === String(params[0]))
      if (!row) throw mockError(404, 'CONTACT_NOT_FOUND', 'Contact not found')
      for (const k of ['platform', 'value', 'isPublic']) {
        if (body?.[k] !== undefined && body[k] !== null) row[k] = body[k]
      }
      return contactDto(row)
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/users\/me\/contacts\/([^/]+)$/,
    fn: (db, { params }) => {
      const contacts = meUser(db).profile.contacts || []
      const i = contacts.findIndex(c => String(c.id) === String(params[0]))
      if (i < 0) throw mockError(404, 'CONTACT_NOT_FOUND', 'Contact not found')
      contacts.splice(i, 1)
      return NO_CONTENT
    },
  },

  /* ---------- contact-hash matching ---------- */
  {
    m: 'POST', p: /^\/api\/v1\/users\/contacts\/sync$/,
    fn: (db, { body }) => {
      const hashes = Array.isArray(body?.hashes) ? body.hashes.slice(0, 5000) : []
      db._contactHashes = hashes
      /* The real endpoint answers with how many were stored and how many
         resolved to an account; a stable fraction reads like a real address book. */
      return { stored: hashes.length, matched: Math.min(3, hashes.length) }
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/users\/contacts$/,
    fn: (db) => { db._contactHashes = []; return NO_CONTENT },
  },

  /* ---------- identity (§9) ---------- */
  { m: 'GET', p: /^\/api\/v1\/users\/me$/, fn: (db) => userResponse(db, meUser(db), meId(db)) },
  {
    m: 'PATCH', p: /^\/api\/v1\/users\/me$/,
    fn: (db, { body }) => {
      const me = meUser(db)
      /* UpdateProfileRequest: @Size(3,50) + @Pattern(^[a-zA-Z0-9._-]+$). The
         handle IS the charset — a settings form that lets a space through must
         fail here exactly as it fails against the real endpoint. */
      if (body?.username !== undefined && body.username !== null && !USERNAME_RE.test(String(body.username))) {
        throw mockError(400, 'VALIDATION_ERROR', 'Username may only contain letters, digits, dots, hyphens, and underscores')
      }
      if (body?.username && list(db, 'users').some(u => u.id !== me.id && norm(u.username) === norm(body.username))) {
        throw mockError(409, 'USERNAME_TAKEN', 'That username is already in use')
      }
      for (const k of ['fname', 'lname', 'username']) {
        if (body?.[k] !== undefined && body[k] !== null) me[k] = body[k]
      }
      return userResponse(db, me, me.id)
    },
  },
  { m: 'DELETE', p: /^\/api\/v1\/users\/me$/, fn: () => NO_CONTENT },

  {
    m: 'GET', p: /^\/api\/v1\/users\/username\/([^/]+)$/,
    fn: (db, { params }) => {
      const u = list(db, 'users').find(x => norm(x.username) === norm(params[0]))
      if (!u) throw mockError(404, 'USER_NOT_FOUND', 'User not found')
      return userResponse(db, u, meId(db))
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/users\/email\/([^/]+)$/,
    fn: (db, { params }) => {
      const u = list(db, 'users').find(x => norm(x.email) === norm(params[0]))
      if (!u) throw mockError(404, 'USER_NOT_FOUND', 'User not found')
      return userResponse(db, u, meId(db))
    },
  },

  /* ---------- per-user reads (§9.14 / §10.1 / §11) ---------- */
  {
    /* UserStatsResponse — live across stores. Counted off the other fixture
       slices when they exist so a profile tab and its stat agree; the stored
       count is the fallback for a slice that isn't merged in. */
    m: 'GET', p: /^\/api\/v1\/users\/([^/]+)\/stats$/,
    fn: (db, { params }) => {
      const u = userOr404(db, params[0])
      const c = u._counts || {}
      return {
        postCount: liveCount(db, 'posts', u.id) ?? c.postCount ?? 0,
        reelCount: liveCount(db, 'reels', u.id) ?? c.reelCount ?? 0,
        researchCount: liveCount(db, 'research', u.id) ?? c.researchCount ?? u.profile?.researchCount ?? 0,
        questionCount: liveCount(db, 'questions', u.id) ?? c.questionCount ?? 0,
        followerCount: followerCountOf(db, u),
        followingCount: followingCountOf(db, u),
      }
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/users\/([^/]+)\/profile$/,
    fn: (db, { params }) => userResponse(db, userOr404(db, params[0]), meId(db)),
  },
  {
    m: 'GET', p: /^\/api\/v1\/users\/([^/]+)\/followers$/,
    fn: (db, { params, query }) => usersPage(db, followerIdsOf(db, userOr404(db, params[0]).id), query, meId(db)),
  },
  {
    m: 'GET', p: /^\/api\/v1\/users\/([^/]+)\/following$/,
    fn: (db, { params, query }) => usersPage(db, followingIdsOf(db, userOr404(db, params[0]).id), query, meId(db)),
  },
  {
    m: 'GET', p: /^\/api\/v1\/users\/([^/]+)\/social-status$/,
    fn: (db, { params }) => socialStatus(db, meId(db), userOr404(db, params[0])),
  },

  /* ---------- social writes (§11) ---------- */
  {
    m: 'POST', p: /^\/api\/v1\/users\/([^/]+)\/follow$/,
    fn: (db, { params }) => {
      const me = meId(db)
      const target = userOr404(db, params[0])
      if (String(target.id) === String(me)) throw mockError(400, 'SELF_FOLLOW', 'You cannot follow yourself')
      if (isBlocking(db, target.id, me)) throw mockError(403, 'BLOCKED_BY_USER', 'You cannot follow this user')
      if (!isFollowing(db, me, target.id)) {
        follows(db).unshift({ followerId: me, followingId: target.id, createdAt: agoIso(0) })
      }
      return socialAction(db, 'FOLLOWED', target)
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/users\/([^/]+)\/follow$/,
    fn: (db, { params }) => {
      const me = meId(db)
      const target = userOr404(db, params[0])
      const i = follows(db).findIndex(e => String(e.followerId) === String(me) && String(e.followingId) === String(target.id))
      if (i >= 0) follows(db).splice(i, 1)
      return socialAction(db, 'UNFOLLOWED', target)
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/users\/([^/]+)\/block$/,
    fn: (db, { params }) => {
      const me = meId(db)
      const target = userOr404(db, params[0])
      if (String(target.id) === String(me)) throw mockError(400, 'SELF_BLOCK', 'You cannot block yourself')
      if (!isBlocking(db, me, target.id)) blocks(db).unshift({ blockerId: me, blockedId: target.id, createdAt: agoIso(0) })
      /* A block severs the follow edges in BOTH directions — the real service
         does this, and a "blocked" user still sitting in your following list is
         the classic way to notice it wasn't mocked. */
      db.follows = follows(db).filter(e => !(
        (String(e.followerId) === String(me) && String(e.followingId) === String(target.id))
        || (String(e.followerId) === String(target.id) && String(e.followingId) === String(me))))
      return socialAction(db, 'BLOCKED', target)
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/users\/([^/]+)\/block$/,
    fn: (db, { params }) => {
      const me = meId(db)
      const target = userOr404(db, params[0])
      const i = blocks(db).findIndex(e => String(e.blockerId) === String(me) && String(e.blockedId) === String(target.id))
      if (i >= 0) blocks(db).splice(i, 1)
      return socialAction(db, 'UNBLOCKED', target)
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/users\/([^/]+)\/restrict$/,
    fn: (db, { params }) => {
      const me = meId(db)
      const target = userOr404(db, params[0])
      if (String(target.id) === String(me)) throw mockError(400, 'SELF_RESTRICT', 'You cannot restrict yourself')
      if (!isRestricting(db, me, target.id)) restrictions(db).unshift({ restrictorId: me, restrictedId: target.id, createdAt: agoIso(0) })
      return socialAction(db, 'RESTRICTED', target)
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/users\/([^/]+)\/restrict$/,
    fn: (db, { params }) => {
      const me = meId(db)
      const target = userOr404(db, params[0])
      const i = restrictions(db).findIndex(e => String(e.restrictorId) === String(me) && String(e.restrictedId) === String(target.id))
      if (i >= 0) restrictions(db).splice(i, 1)
      return socialAction(db, 'UNRESTRICTED', target)
    },
  },

  /* ---------- the catch-all id read, LAST ---------- */
  {
    m: 'GET', p: /^\/api\/v1\/users\/([^/]+)$/,
    fn: (db, { params }) => userResponse(db, userOr404(db, params[0]), meId(db)),
  },

  /* ---------- knowledge taxonomy (TAXONOMY §1-2) ----------
     Rows are the JPA entities verbatim: id + all three name columns. Blank `q`
     is the full vocabulary; otherwise a case-insensitive contains across
     nameEn / nameAr / nameCkb, exactly as KnowledgeController does it. */
  {
    m: 'GET', p: /^\/api\/v1\/topics$/,
    fn: (db, { query }) => vocabulary(list(db, 'topics'), query.q),
  },
  {
    m: 'GET', p: /^\/api\/v1\/madhhabs$/,
    fn: (db, { query }) => vocabulary(list(db, 'madhhabs'), query.q),
  },

  /* ---------- tags (SEARCH_API §7) ---------- */
  {
    m: 'GET', p: /^\/api\/v1\/tags\/trending$/,
    fn: (db, { query }) => {
      const scope = tagScope(query.scope)
      const limit = Math.min(Math.max(Number(query.limit ?? 20) || 20, 1), 100)
      return tagRows(db)
        .map(t => ({ tag: t.tag, usageCount: usageIn(t, scope) }))
        .filter(t => t.usageCount > 0)
        .sort((a, b) => b.usageCount - a.usageCount)
        .slice(0, limit)
        .map((t, i) => ({ tag: t.tag, usageCount: t.usageCount, rank: i }))
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/tags\/search$/,
    fn: (db, { query }) => {
      const prefix = norm(query.prefix)
      if (!prefix) return []
      const scope = tagScope(query.scope)
      const limit = Math.min(Math.max(Number(query.limit ?? 10) || 10, 1), 50)
      return tagRows(db)
        .filter(t => norm(t.tag).startsWith(prefix))
        .map(t => ({ tag: t.tag, usageCount: usageIn(t, scope) }))
        .sort((a, b) => a.tag.localeCompare(b.tag))
        .slice(0, limit)
    },
  },
  {
    /* §7.4 — newest-first, cursor-paged. The cursor is opaque to the client, so
       the last row's contentId serves; the fan-out is assembled from whichever
       content slices are merged into the fixture. */
    m: 'GET', p: /^\/api\/v1\/tags\/([^/]+)\/content$/,
    fn: (db, { params, query }) => {
      const tag = norm(params[0])
      const size = Math.min(Math.max(Number(query.pageSize ?? 20) || 20, 1), 100)
      const all = taggedContent(db, tag)
      const cursor = query.cursor && query.cursor !== 'head' ? String(query.cursor) : null
      const from = cursor ? all.findIndex(r => String(r.contentId) === cursor) + 1 : 0
      const items = all.slice(from, from + size)
      const more = from + size < all.length
      return {
        tag,
        items,
        nextCursor: more && items.length ? String(items[items.length - 1].contentId) : '',
        pageSize: size,
      }
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/tags\/([^/]+)\/usage$/,
    fn: (db, { params, query }) => {
      const tag = norm(params[0])
      const row = tagRows(db).find(t => norm(t.tag) === tag)
      const scope = String(query.scope ?? 'ALL')
      if (scope === '*' || scope.toUpperCase() === 'ALL_SCOPES') {
        return {
          tag,
          scopes: {
            ALL: usageIn(row, 'ALL'),
            QUESTION: usageIn(row, 'QUESTION'),
            RESEARCH: usageIn(row, 'RESEARCH'),
            POST: usageIn(row, 'POST'),
            REEL: usageIn(row, 'REEL'),
          },
        }
      }
      const s = tagScope(scope)
      return { tag, scope: s, usageCount: usageIn(row, s) }
    },
  },
]

/* ---------- taxonomy / tag helpers (below the table so the routes read first) ---------- */

function vocabulary(rows, q) {
  const needle = norm(q)
  const out = rows.map(r => ({ id: r.id, nameEn: r.nameEn || '', nameAr: r.nameAr || '', nameCkb: r.nameCkb || '' }))
  if (!needle) return out
  return out.filter(r => norm(r.nameEn).includes(needle) || norm(r.nameAr).includes(needle) || norm(r.nameCkb).includes(needle))
}

const TAG_SCOPES = ['QUESTION', 'RESEARCH', 'POST', 'REEL', 'ALL']
function tagScope(s) {
  const v = String(s ?? 'ALL').trim().toUpperCase()
  return TAG_SCOPES.includes(v) ? v : 'ALL'
}
const tagRows = (db) => list(db, 'tags')

/** ALL is the sum of the per-scope counters — the backend keeps a separate ALL
 *  partition, but a fixture that hand-wrote both would drift. */
function usageIn(row, scope) {
  const s = row?.scopes || {}
  if (!row) return 0
  if (scope === 'ALL') return s.ALL ?? ['QUESTION', 'RESEARCH', 'POST', 'REEL'].reduce((n, k) => n + (s[k] ?? 0), 0)
  return s[scope] ?? 0
}

/* Which fixture slice feeds which contentType in a tag's fan-out. */
const TAG_SOURCES = [['posts', 'POST'], ['reels', 'REEL'], ['questions', 'QUESTION'], ['research', 'RESEARCH']]

function rowTags(r) {
  const t = r?.tags || r?.hashtags || r?.tagList || []
  return Array.isArray(t) ? t.map(x => norm(typeof x === 'string' ? x : x?.tag ?? x?.name)) : []
}
function rowTitle(r) {
  return String(r?.title ?? r?.questionTitle ?? r?.caption ?? r?.content ?? r?.body ?? r?.text ?? '')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140)
}

/** Some fixture slices store age as `minsAgo` rather than an instant (it keeps
 *  a demo's timestamps relative to when it is opened). Derive the instant, or
 *  the tag page renders every row with a blank time. */
function rowCreatedAt(r) {
  if (r?.createdAt) return r.createdAt
  if (r?.publishedAt) return r.publishedAt
  if (typeof r?.minsAgo === 'number') return agoIso(r.minsAgo)
  return null
}

function taggedContent(db, tag) {
  const out = []
  for (const [key, type] of TAG_SOURCES) {
    for (const r of (Array.isArray(db[key]) ? db[key] : [])) {
      if (!rowTags(r).includes(tag)) continue
      out.push({
        contentId: r.id ?? r.contentId ?? '',
        contentType: type,
        authorId: authorIdOf(r) || null,
        titlePreview: rowTitle(r),
        createdAt: rowCreatedAt(r),
      })
    }
  }
  return out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
}
