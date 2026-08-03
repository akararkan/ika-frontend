/* =========================================================
   Mock handlers — POSTS, COMMENTS, REACTIONS, HOME FEED
   ---------------------------------------------------------
   Every value returned here is a WIRE shape (the Java record),
   never a view shape: the response still travels through
   src/api/adapters.js exactly as a live one does.

     PostResponse      post/dto/PostResponse.java
     FeedItemResponse  post/dto/FeedItemResponse.java
     HomeFeedResponse  post/dto/HomeFeedResponse.java
     CommentResponse   post/dto/CommentResponse.java
     ReplyResponse     post/dto/ReplyResponse.java
     AuthorSummary     post/dto/AuthorSummary.java  (id/username/fullName/profileImage — nothing else)

   Enums are the backend's, verbatim: PostType is
   TEXT | EMBEDDED | VOICE_POST | REEL | REPOST | STORY (there is no POLL
   post — polls belong to STORIES), PostMediaType is IMAGE | VIDEO |
   AUDIO_TRACK | DOCUMENT, and PostReactionType has exactly one member,
   LIKE. That is why every reaction endpoint answers `{liked}` rather than
   a reaction-type mix.

   Writes mutate `db` in memory and return what the real endpoint returns,
   so a like, a save, a comment, a reply, a share and a delete all stick
   until the page is reloaded.
   ========================================================= */
import { mockError, seeded } from '../util.js'

/* One clock for the whole session. The fixture stores ages in minutes rather
   than dates, so "2h ago" stays true however long this file lives — but the
   instant has to be computed against a FIXED base, not Date.now(): the feed
   cursor IS a createdAt value, and a timestamp that drifts a few milliseconds
   between two requests makes the cursor un-findable and the feed paginate
   forever over page one. Same format as util.agoIso (JacksonConfig's
   yyyy-MM-dd'T'HH:mm:ss.SSS'Z'). */
const T0 = Date.now()
const agoIso = (minutes) => new Date(T0 - (Number(minutes) || 0) * 60_000).toISOString().replace(/\.(\d{3})Z$/, '.$1Z')

/* ---------- identity ---------------------------------------------------- */

/** The signed-in viewer. The users/auth fragment owns `me`; fall back to the
 *  id this fixture's saves and SELF feed rows are written against. */
function viewer(db) {
  return db.me?.id || db.currentUser?.id || db.session?.userId || db.auth?.me?.id || 'u-amina'
}

function userRow(db, id) {
  return (db.users || []).find(u => String(u.id) === String(id)) || null
}

/** AuthorSummary. The inline copy in the fixture keeps this domain standalone;
 *  when the users fragment is merged its profile wins, so a name is never
 *  told two different ways on two different screens. */
function authorSummary(db, id, inline) {
  const u = userRow(db, id)
  if (!u) return inline || null
  const p = u.profile || {}
  const full = p.displayName || [u.fname, u.lname].filter(Boolean).join(' ').trim() || u.fullName
  return {
    id: u.id,
    username: u.username || inline?.username || '',
    fullName: full || inline?.fullName || '',
    profileImage: p.avatarUrl || u.avatarUrl || u.profileImage || inline?.profileImage || null,
  }
}

/* The fixture writes mentions against stable first-name aliases; the real
   handle is whatever the users fragment gave that person. Rewriting here
   keeps `@…` clickable (MentionLink resolves by username) instead of
   dead-ending in search. */
const MENTION_ALIAS = {
  amina: 'u-amina', karwan: 'u-karwan', yusuf: 'u-yusuf', zeynep: 'u-zeynep',
  hana: 'u-hana', omar: 'u-omar', dilan: 'u-dilan', mehmet: 'u-mehmet',
}
function mentions(db, text) {
  if (!text || text.indexOf('@') === -1) return text || ''
  // A dot only stays inside the handle when a word follows it, so "@karwan."
  // at the end of a sentence resolves as "karwan" and keeps its full stop.
  return text.replace(/@([A-Za-z]\w*(?:\.\w+)*)/g, (whole, handle) => {
    const id = MENTION_ALIAS[handle.toLowerCase()]
    const u = id ? userRow(db, id) : null
    return u?.username ? '@' + u.username : whole
  })
}

/* ---------- wire builders ----------------------------------------------- */

const iso = (row) => agoIso(Number(row?.minutesAgo) || 0)

/* A feed row carries a PREVIEW, not the body: CassandraPostService.preview and
   PostHydrator.livePreview both cut at 280 characters. Several of these posts
   are longer than that, so a card really does show less than its detail page —
   keeping the cut here is what makes the two screens differ the way they do
   against the real server. */
const preview = (text) => (typeof text === 'string' && text.length > 280 ? text.slice(0, 280) : text || '')

/** PostByIdEntity + counters + viewer flags → PostResponse. */
function postWire(db, p) {
  return {
    id: p.id,
    authorId: p.authorId,
    author: authorSummary(db, p.authorId, p.author),
    postType: p.postType,
    status: p.status || 'PUBLISHED',
    visibility: p.visibility || 'PUBLIC',
    textContent: mentions(db, p.textContent),
    audioTrackUrl: p.audioTrackUrl || null,
    audioTrackName: p.audioTrackName || null,
    locationName: p.locationName || null,
    locationLat: p.locationLat ?? null,
    locationLng: p.locationLng ?? null,
    sharedPostId: p.sharedPostId || null,
    shareLink: p.shareLink || null,
    mediaUrls: p.mediaUrls || [],
    mediaTypes: p.mediaTypes || [],
    reactionCount: p.reactionCount || 0,
    commentCount: p.commentCount || 0,
    viewCount: p.viewCount || 0,
    saveCount: p.saveCount || 0,
    shareCount: p.shareCount || 0,
    likedByMe: !!p.likedByMe,
    savedByMe: !!p.savedByMe,
    createdAt: iso(p),
    updatedAt: agoIso(Number(p.updatedMinutesAgo ?? p.minutesAgo) || 0),
    savedAt: null,                 // saved-list endpoints only
    savedCollectionName: null,
  }
}

/** PostResponse + the save row that pointed at it (saved-list endpoints). */
function savedPostWire(db, p, save) {
  return {
    ...postWire(db, p),
    savedAt: iso(save),
    savedCollectionName: save.collectionName || 'Default',
  }
}

/** Post → FeedItemResponse.
 *
 *  Both media fields are PostHydrator's, exactly: `mediaUrl` is
 *  liveCoverMedia — the FIRST media url, whatever its type — and `videoUrl` is
 *  liveVideoUrl, the first VIDEO url and REEL-only. A VOICE_POST therefore
 *  arrives with mediaUrl NULL (its audio lives in `audioTrackUrl`, which the
 *  feed row does not carry), which is why VoicePostOrbit re-reads
 *  GET /posts/{id} on mount. Handing the audio over in `mediaUrl` would look
 *  nicer here and would hide that round trip — i.e. it would stop the mock
 *  from breaking the way the backend breaks. */
function feedItemWire(db, p, meta = {}) {
  const isReel = p.postType === 'REEL'
  const firstVideo = (p.mediaTypes || []).indexOf('VIDEO')
  return {
    id: p.id,
    authorId: p.authorId,
    author: authorSummary(db, p.authorId, p.author),
    entityType: 'POST',
    postType: p.postType,
    textPreview: preview(mentions(db, p.textContent)),
    mediaUrl: (p.mediaUrls || [])[0] || null,
    videoUrl: isReel && firstVideo >= 0 ? p.mediaUrls[firstVideo] : null,
    reactionCount: p.reactionCount || 0,
    commentCount: p.commentCount || 0,
    viewCount: p.viewCount || 0,
    saveCount: p.saveCount || 0,
    shareCount: p.shareCount || 0,
    likedByMe: !!p.likedByMe,
    savedByMe: !!p.savedByMe,
    createdAt: iso(p),
    source: meta.source || null,
    rankScore: typeof meta.rankScore === 'number' ? meta.rankScore : null,
    channel: null,
    channelPostId: null,
  }
}

function commentWire(db, postId, cm) {
  return {
    id: cm.id,
    postId,
    authorId: cm.authorId,
    author: authorSummary(db, cm.authorId, cm.author),
    textContent: mentions(db, cm.textContent),
    mediaUrl: cm.mediaUrl || null,
    mediaType: cm.mediaType || null,
    reactionCount: cm.reactionCount || 0,
    replyCount: (cm.replies || []).length,
    likedByMe: !!cm.likedByMe,
    deleted: !!cm.deleted,
    edited: !!cm.edited,
    createdAt: iso(cm),
  }
}

function replyWire(db, postId, parentId, rp) {
  return {
    id: rp.id,
    parentId,
    postId,
    authorId: rp.authorId,
    author: authorSummary(db, rp.authorId, rp.author),
    textContent: mentions(db, rp.textContent),
    mediaUrl: rp.mediaUrl || null,
    reactionCount: rp.reactionCount || 0,
    likedByMe: !!rp.likedByMe,
    deleted: !!rp.deleted,
    edited: !!rp.edited,
    createdAt: iso(rp),
  }
}

/* ---------- lookups ----------------------------------------------------- */

function findPost(db, id) {
  const hit = (db.posts || []).find(p => String(p.id) === String(id))
  if (hit) return hit
  /* Reels live in their own fragment but answer on /posts/{id}. If that
     fragment already stores wire-shaped rows, serve them rather than 404 —
     whichever handler the registry reaches first must not break the other. */
  const reel = (db.reels || []).find(p => p && String(p.id) === String(id) && p.postType)
  return reel || null
}

function requirePost(db, id) {
  const p = findPost(db, id)
  if (!p) throw mockError(404, 'POST_NOT_FOUND', 'Post not found')
  return p
}

/** Every comment/reply on the fixture, with the post it belongs to. */
function allThreads(db) {
  const out = []
  const map = db.postComments || {}
  for (const postId of Object.keys(map)) {
    for (const cm of map[postId] || []) out.push({ postId, comment: cm })
  }
  return out
}

function findComment(db, commentId) {
  for (const { postId, comment } of allThreads(db)) {
    if (String(comment.id) === String(commentId)) return { postId, comment, parent: null }
    const rp = (comment.replies || []).find(x => String(x.id) === String(commentId))
    if (rp) return { postId, comment: rp, parent: comment }
  }
  return null
}

/* ---------- paging ------------------------------------------------------ */

// Pages.clamp — [1, 100]. The ceiling is the server's, not a guess.
const size = (q, d = 20) => Math.min(100, Math.max(1, Number(q.pageSize ?? q.limit ?? q.size ?? d) || d))
const isRanked = (q) => !(q.ranked === false || q.ranked === 'false')

/** Cursor page over an already-ordered list, keyed on `createdAt` — the
 *  server's own cursor token. Ranked order is not chronological order, so the
 *  cursor is positional: it names the last row handed out, never a date range
 *  (which is exactly why /feed/home returns nextCursor explicitly). */
function afterCursor(items, cursor, key = 'createdAt') {
  if (!cursor) return items
  const i = items.findIndex(x => String(x[key]) === String(cursor))
  return i === -1 ? items : items.slice(i + 1)
}

/* ---------- the ranked home feed ---------------------------------------- */

/* The research / Q&A fragments name their arrays themselves, so every plausible
   spelling is tried and the first non-empty one wins. A wrong guess costs a
   posts-only feed, never an exception. */
const firstArray = (db, ...keys) => {
  for (const k of keys) if (Array.isArray(db[k]) && db[k].length) return db[k]
  return []
}

/* Foreign fragments date their rows the same way this one does — an age in
   minutes under a name of their choosing — so the age is read first and an ISO
   field only used when one is actually there. Getting this wrong is not
   cosmetic: `?ranked=false` sorts on createdAt, so a research paper stamped
   with a made-up time lands in the wrong place in the Latest tab. */
function foreignIso(row, fallbackMinutes) {
  for (const k of ['publishedAgoMin', 'createdAgoMin', 'minutesAgo', 'minsAgo', '_ago']) {
    if (row[k] != null && Number.isFinite(Number(row[k]))) return agoIso(Number(row[k]))
  }
  for (const k of ['publishedAt', 'createdAt']) {
    if (typeof row[k] === 'string' && row[k]) return row[k]
  }
  return agoIso(fallbackMinutes)
}

/** Research / Q&A rows are injected from their own fragments when they are
 *  present, so the mixed home feed is really mixed — and so a card that is
 *  tapped opens a detail page that exists. Counters are zero on those rows by
 *  design (FeedItemResponse javadoc: not bulk-hydrated at feed-read time). */
function foreignItems(db, { channels: withChannels = true } = {}) {
  const out = []
  const research = firstArray(db, 'research', 'researches', 'researchList', 'papers')
    .filter(r => r && r.id && typeof r.title === 'string')
  research.slice(0, 3).forEach((r, i) => {
    out.push({
      id: r.id,
      authorId: r.researcherId || null,
      author: authorSummary(db, r.researcherId, {
        id: r.researcherId, username: r.researcherUsername || '',
        fullName: r.researcherFullName || '', profileImage: r.researcherProfileImage || null,
      }),
      entityType: 'RESEARCH',
      postType: 'PUBLICATION',
      textPreview: preview(r.title),
      mediaUrl: r.coverImageUrl || null,
      videoUrl: null,
      reactionCount: 0, commentCount: 0, viewCount: 0, saveCount: 0, shareCount: 0,
      likedByMe: false, savedByMe: false,
      createdAt: foreignIso(r, 150 + i * 260),
      source: 'FOLLOWING', rankScore: 0.9 - i * 0.11,
      channel: null, channelPostId: null,
    })
  })
  const questions = firstArray(db, 'questions', 'qna', 'qnaQuestions', 'qnaList')
    .filter(q => q && q.id && typeof q.title === 'string')
  questions.slice(0, 2).forEach((q, i) => {
    out.push({
      id: q.id,
      authorId: q.authorId || null,
      author: authorSummary(db, q.authorId, {
        id: q.authorId, username: q.authorUsername || '',
        fullName: q.authorFullName || '', profileImage: q.authorProfileImage || null,
      }),
      entityType: 'QUESTION',
      postType: 'QUESTION',
      textPreview: preview(q.title),
      mediaUrl: null,
      videoUrl: null,
      reactionCount: 0, commentCount: 0, viewCount: 0, saveCount: 0, shareCount: 0,
      likedByMe: false, savedByMe: false,
      createdAt: foreignIso(q, 220 + i * 340),
      source: 'FOLLOWING', rankScore: 0.83 - i * 0.15,
      channel: null, channelPostId: null,
    })
  })
  /* CHANNEL_POST rows are signed by the CHANNEL: `author` is null and the
     counters are re-pointed (views / forwards / discussion comments). The
     synthetic `id` is a list key only — `channelPostId` is the real message
     snowflake, and it stays a string.

     They exist ONLY on the ranked path: HomeFeedService injects them at read
     time, nothing fans them out into feed_by_user, so `?ranked=false` must not
     show a single one. */
  const channels = Array.isArray(db.channels) ? db.channels : []
  const byChannel = (db.channelPosts && !Array.isArray(db.channelPosts)) ? db.channelPosts : null
  if (withChannels && byChannel) {
    const rows = []
    for (const ch of channels) {
      for (const m of byChannel[ch.id] || []) {
        if (m && m.messageId != null && typeof m.body === 'string') rows.push({ ch, m })
      }
    }
    rows.sort((a, b) => (Number(a.m._ago) || 0) - (Number(b.m._ago) || 0))
    rows.slice(0, 2).forEach(({ ch, m }) => {
      const cover = Array.isArray(m.media) && typeof m.media[0]?.url === 'string' ? m.media[0].url : null
      out.push({
        id: `cp-${ch.id}-${m.messageId}`,
        authorId: null,
        author: null,
        entityType: 'CHANNEL_POST',
        postType: 'CHANNEL_POST',
        textPreview: preview(m.body),
        mediaUrl: cover,
        videoUrl: null,
        reactionCount: 0,
        commentCount: Number(m.comments) || 0,
        viewCount: Number(m.views) || 0,
        saveCount: 0,
        shareCount: Number(m.forwards) || 0,
        likedByMe: false, savedByMe: false,
        createdAt: agoIso(Number(m._ago) || 0),
        // rankScore stays null: toFeedItem() builds channel rows with the
        // source set and the score field empty — they are placed, not scored.
        source: 'CHANNEL', rankScore: null,
        channel: {
          id: ch.id,
          handle: String(ch.handle || '').replace(/^@/, ''),
          title: typeof ch.title === 'string' ? ch.title : '',
          avatarUrl: ch.avatarUrl || null,
          verified: !!ch.verified,
          subscriberCount: Number(ch.subscriberCount) || 0,
        },
        channelPostId: String(m.messageId),
      })
    })
  }
  return out
}

/** The whole ranked stream, best-first. Fixture order IS the ranking. */
function rankedStream(db) {
  const rows = []
  for (const f of db.feed || []) {
    const p = (db.posts || []).find(x => String(x.id) === String(f.postId))
    if (p) rows.push(feedItemWire(db, p, f))
  }
  /* Posts created during the demo have no ranking row — they belong at the top
     of their own author's feed, which is what SELF means here. */
  for (const p of db.posts || []) {
    if (!rows.some(r => String(r.id) === String(p.id))) rows.unshift(feedItemWire(db, p, { source: 'SELF', rankScore: 1 }))
  }
  const foreign = foreignItems(db)
  if (!foreign.length) return rows
  // Interleave rather than append: a stream that runs 18 posts then 5 papers
  // is not a mixed feed, it is two feeds stapled together.
  const out = []
  let f = 0
  rows.forEach((row, i) => {
    out.push(row)
    if (i % 4 === 3 && f < foreign.length) out.push(foreign[f++])
  })
  while (f < foreign.length) out.push(foreign[f++])
  return out
}

/** `?ranked=false` — the raw fanout read. Still MIXED, because feed_by_user
 *  carries the research and question rows itself, but strictly chronological
 *  and with NO ranking metadata: source and rankScore are null here, which is
 *  what makes the "Suggested for you" chrome disappear on the Latest tab.
 *  No channel posts: those are injected by the ranker, not fanned out. */
function chronoStream(db) {
  const rows = (db.posts || []).map(p => feedItemWire(db, p, {}))
  for (const f of foreignItems(db, { channels: false })) rows.push({ ...f, source: null, rankScore: null })
  return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}

/* ---------- friend suggestions ------------------------------------------ */

/** The users fragment owns the candidates; the score is a composite double
 *  here (mutual follows dominate it, plus a stable per-candidate jitter so the
 *  ordering is not a straight line), dismissed rows are gone, and nobody is
 *  ever suggested to themselves. */
function suggestionRows(db) {
  const me = viewer(db)
  const dismissed = db._dismissedSuggestions || []
  /* Following someone removes them from the partition on the next recompute —
     and follow/unfollow fires one server-side. Applying it on read is what
     keeps the card from suggesting a person the viewer already follows after
     they tapped Follow in the rail (the row stays put, but a reload must not
     bring it back). */
  const follows = Array.isArray(db.follows) ? db.follows : []
  const following = (id) => follows.some(f => String(f.followerId) === String(me) && String(f.followingId) === String(id))
  return (Array.isArray(db.suggestions) ? db.suggestions : [])
    .filter(s => s && s.id && String(s.id) !== String(me) && !dismissed.includes(String(s.id)) && !following(s.id) && userRow(db, s.id))
    .map(s => ({
      id: s.id,
      reason: typeof s.reason === 'string' ? s.reason : '',
      score: Math.round(((Number(s.mutualCount) || 0) * 7.5 + 3 + seeded('sg:' + s.id) * 4) * 10) / 10,
    }))
    .sort((a, b) => b.score - a.score)
}

/* ---------- shares ------------------------------------------------------ */

/** The append-only share ledger. Seeded deterministically from the post's own
 *  share counter the first time it is read, so the share-stats panel is not
 *  empty on a post that says it was shared nine times. */
function shareLedger(db, post) {
  db._shares = db._shares || {}
  if (!db._shares[post.id]) {
    const people = ['u-karwan', 'u-zeynep', 'u-hana', 'u-omar', 'u-dilan', 'u-mehmet', 'u-yusuf', 'u-amina']
    const n = Math.min(post.shareCount || 0, 8)
    db._shares[post.id] = Array.from({ length: n }, (_, i) => {
      const s = seeded(post.id + ':' + i)
      return {
        postId: post.id,
        createdAt: agoIso(Math.round((Number(post.minutesAgo) || 60) * (0.15 + 0.8 * s))),
        shareId: `sh-${post.id}-${i}`,
        sharerId: people[Math.floor(s * people.length) % people.length],
        caption: null,
      }
    }).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }
  return db._shares[post.id]
}

const origin = () => (typeof location !== 'undefined' && location.origin) || 'https://ika.example'

function shareLinkInfo(post) {
  return {
    shortUrl: `https://ika.link/p/${post.shareLink}`,
    canonicalUrl: `${origin()}/posts/${post.id}`,
    token: post.shareLink,
    shareCount: post.shareCount || 0,
  }
}

/* ---------- create ------------------------------------------------------ */

let seq = 0

/** Multipart create: the files never leave the browser, so each one is turned
 *  into a blob: URL — the composer's own photo is then the photo on the card,
 *  which is the whole point of demoing a composer. */
function fromFormData(fd) {
  const get = (k) => { try { return fd.get(k) } catch { return null } }
  const files = []
  for (const key of ['files', 'files[]', 'media', 'media[]', 'file', 'video', 'videos', 'image', 'images']) {
    let all
    try { all = fd.getAll(key) } catch { all = [] }
    for (const f of all || []) if (f && typeof f === 'object' && typeof f.name === 'string') files.push(f)
  }
  const urls = []
  const types = []
  for (const f of files) {
    let url
    try { url = URL.createObjectURL(f) } catch { url = null }
    if (!url) continue
    urls.push(url)
    // classifyMedia() — the multipart path labels parts IMAGE | VIDEO | AUDIO |
    // OTHER off the content type, NOT with the PostMediaType names the JSON
    // path uses. Same asymmetry as the server.
    const ct = String(f.type || '').toLowerCase()
    types.push(ct.startsWith('image/') ? 'IMAGE' : ct.startsWith('video/') ? 'VIDEO' : ct.startsWith('audio/') ? 'AUDIO' : 'OTHER')
  }
  const postType = String(get('postType') || 'TEXT')
  let audioTrackUrl = get('audioTrackUrl') != null ? String(get('audioTrackUrl')) : null
  /* Only a VOICE_POST promotes its audio part out of the media lists — an
     ordinary post with a sound attached keeps it in `mediaUrls` server-side. */
  let audio = -1
  if (postType.toUpperCase() === 'VOICE_POST' && !audioTrackUrl) {
    audio = types.indexOf('AUDIO')
    if (audio >= 0) audioTrackUrl = urls[audio]
  }
  return {
    postType,
    visibility: String(get('visibility') || 'PUBLIC'),
    textContent: get('textContent') != null ? String(get('textContent')) : '',
    audioTrackName: get('audioTrackName') != null ? String(get('audioTrackName')) : null,
    audioTrackUrl,
    locationName: get('locationName') != null ? String(get('locationName')) : null,
    sharedPostId: get('sharedPostId') != null ? String(get('sharedPostId')) : null,
    mediaUrls: audio >= 0 ? urls.filter((_, i) => i !== audio) : urls,
    mediaTypes: audio >= 0 ? types.filter((_, i) => i !== audio) : types,
  }
}

function createPost(db, ctx) {
  const body = ctx.body
  const isForm = !!body && typeof body.get === 'function' && typeof body.append === 'function'
  const cmd = isForm ? fromFormData(body) : (body || {})
  const me = viewer(db)
  const id = `p-new-${++seq}`
  const row = {
    id,
    authorId: me,
    author: authorSummary(db, me, { id: me, username: 'you', fullName: 'You', profileImage: null }),
    postType: cmd.postType || 'TEXT',
    status: 'PUBLISHED',
    visibility: cmd.visibility || 'PUBLIC',
    textContent: cmd.textContent || cmd.text || '',
    audioTrackUrl: cmd.audioTrackUrl || null,
    audioTrackName: cmd.audioTrackName || null,
    locationName: cmd.locationName || null,
    locationLat: cmd.locationLat ?? null,
    locationLng: cmd.locationLng ?? null,
    sharedPostId: cmd.sharedPostId || null,
    shareLink: `mk${String(id).replace(/\W/g, '')}`.slice(0, 12),
    mediaUrls: cmd.mediaUrls || [],
    mediaTypes: cmd.mediaTypes || [],
    reactionCount: 0, commentCount: 0, viewCount: 0, saveCount: 0, shareCount: 0,
    likedByMe: false, savedByMe: false,
    minutesAgo: 0, updatedMinutesAgo: 0,
  }
  db.posts = db.posts || []
  db.posts.unshift(row)
  db.feed = db.feed || []
  db.feed.unshift({ postId: id, source: 'SELF', rankScore: 1 })
  // A repost is a share of the original — the original's counter says so.
  if (row.sharedPostId) {
    const orig = findPost(db, row.sharedPostId)
    if (orig) orig.shareCount = (orig.shareCount || 0) + 1
  }
  return postWire(db, row)
}

/* =========================================================
   Routes — most specific pattern first.
   ========================================================= */

/* `/posts/{id}` must not swallow the sibling namespaces that other fragments
   own (reels, hashtags, stories…): the registry returns on the FIRST match, so
   a greedy pattern here would 404 someone else's screen.

   The same hazard runs one level deeper, and a lookahead over the FIRST
   segment cannot see it: `/posts/{id}/reactions` and `/posts/{id}/comments`
   are also reels routes, and a reel id is indistinguishable from a post id to
   a regex. Every post-scoped pattern therefore carries `(?!r-\d)` — reel ids
   are `r-01…r-16`, reel comment ids `rc-…` — so this file cannot answer for a
   reel WHATEVER order the registry imports the two handlers in. (Register
   reels first anyway; belt and braces, because getting it wrong is silent.) */
const ID = '(?!feed|reels|suggestions|comments|users|by-author|hashtags|tags|sounds|stories|highlights|media|polls|drafts|r-\\d)([^/]+)'

export const routes = [
  /* ---- feed ---- */
  {
    m: 'GET', p: /^\/api\/v1\/posts\/feed\/home$/,
    fn: (db, ctx) => {
      const ranked = isRanked(ctx.query)
      const all = ranked ? rankedStream(db) : chronoStream(db)
      const pool = afterCursor(all, ctx.query.cursor)
      const n = size(ctx.query)
      const items = pool.slice(0, n)
      const next = pool.length > n && items.length ? items[items.length - 1].createdAt : null
      return {
        items,
        // First page only, and the live domain owns the rail's contents.
        liveNow: ctx.query.cursor ? [] : (Array.isArray(db.liveStreams) ? db.liveStreams : []),
        nextCursor: next,
        ranked,
      }
    },
  },
  {
    // Legacy bare array. Tail-pinned: the oldest row of the page goes last so
    // a client deriving `?cursor=` from items.at(-1) still paginates.
    m: 'GET', p: /^\/api\/v1\/posts\/feed(?:\/cursor)?$/,
    fn: (db, ctx) => {
      const all = isRanked(ctx.query) ? rankedStream(db) : chronoStream(db)
      const page = afterCursor(all, ctx.query.cursor).slice(0, size(ctx.query))
      if (page.length < 2) return page
      let oldest = 0
      page.forEach((r, i) => { if (r.createdAt < page[oldest].createdAt) oldest = i })
      const out = page.slice()
      out.push(out.splice(oldest, 1)[0])
      return out
    },
  },
  {
    /* The rail alone, for clients that refresh it more often than the body.
       The live domain owns the rows; an empty rail is an ordinary state
       (nobody you follow is broadcasting), not a failure. */
    m: 'GET', p: /^\/api\/v1\/posts\/feed\/live-now$/,
    fn: (db) => (Array.isArray(db.liveStreams) ? db.liveStreams : []),
  },

  /* ---- People you may know -----------------------------------------------
     These live in the POSTS namespace on this backend (CassandraFeedController),
     even though the candidates are users — so they are served here, off the
     users fragment's `suggestions` rows. Both read shapes come from the same
     store and must disagree in exactly one way: the raw rows carry the STORED
     score, which is round(score × 10) because the Cassandra clustering column
     is an int, and the detailed rows carry the real double. */
  {
    m: 'GET', p: /^\/api\/v1\/posts\/suggestions\/detailed$/,
    fn: (db, ctx) => suggestionRows(db).slice(0, size(ctx.query))
      .map(s => ({
        candidateId: s.id,
        candidate: authorSummary(db, s.id, null),
        score: s.score,
        reason: s.reason,
        computedAt: agoIso(90),
      }))
      .filter(s => s.candidate),
  },
  {
    m: 'POST', p: /^\/api\/v1\/posts\/suggestions\/recompute$/,
    fn: () => null,                                   // 202 Accepted — async
  },
  {
    m: 'POST', p: /^\/api\/v1\/posts\/suggestions\/([^/]+)\/dismiss$/,
    fn: (db, ctx) => {
      // Same scratch key users.js writes, so a dismissal holds on both surfaces.
      db._dismissedSuggestions = db._dismissedSuggestions || []
      if (!db._dismissedSuggestions.includes(String(ctx.params[0]))) db._dismissedSuggestions.push(String(ctx.params[0]))
      return null                                     // 204
    },
  },
  {
    // Legacy raw `friend_suggestions_by_user` rows — no identity hydration.
    m: 'GET', p: /^\/api\/v1\/posts\/suggestions$/,
    fn: (db, ctx) => suggestionRows(db).slice(0, size(ctx.query))
      .map(s => ({
        userId: viewer(db),
        score: Math.round(s.score * 10),
        candidateId: s.id,
        reason: s.reason,
        computedAt: agoIso(90),
      })),
  },

  {
    m: 'GET', p: /^\/api\/v1\/posts\/by-author\/([^/]+)$/,
    fn: (db, ctx) => {
      const rows = (db.posts || [])
        .filter(p => String(p.authorId) === String(ctx.params[0]))
        .map(p => feedItemWire(db, p, {}))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      return afterCursor(rows, ctx.query.cursor).slice(0, size(ctx.query))
    },
  },

  /* ---- saves & reaction history (user-scoped) ---- */
  {
    m: 'GET', p: /^\/api\/v1\/posts\/users\/([^/]+)\/saves$/,
    fn: (db, ctx) => {
      const uid = ctx.params[0]
      const all = db.savedPosts || []
      const mine = all.filter(s => String(s.userId) === String(uid))
      const rows = (mine.length ? mine : all)
        .map(s => { const p = findPost(db, s.postId); return p ? savedPostWire(db, p, s) : null })
        .filter(Boolean)
        .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))
      // The Saved screen pages on the SAVE row's timestamp, not the post's.
      return afterCursor(rows, ctx.query.cursor, 'savedAt').slice(0, size(ctx.query))
    },
  },
  {
    // ReactionByUserEntity — light {userId, createdAt, postId} tuples.
    m: 'GET', p: /^\/api\/v1\/posts\/users\/([^/]+)\/reactions$/,
    fn: (db, ctx) => (db.posts || [])
      .filter(p => p.likedByMe)
      .map(p => ({ userId: ctx.params[0], createdAt: iso(p), postId: p.id }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, size(ctx.query)),
  },

  /* ---- replies (comment-scoped) ---- */
  {
    m: 'GET', p: /^\/api\/v1\/posts\/comments\/(?!rc-)([^/]+)\/replies$/,
    fn: (db, ctx) => {
      const hit = findComment(db, ctx.params[0])
      if (!hit || hit.parent) return []
      return (hit.comment.replies || [])
        .map(rp => replyWire(db, hit.postId, hit.comment.id, rp))
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
        .slice(0, size(ctx.query))
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/posts\/comments\/(?!rc-)([^/]+)\/replies$/,
    fn: (db, ctx) => {
      const hit = findComment(db, ctx.params[0])
      if (!hit) throw mockError(404, 'COMMENT_NOT_FOUND', 'Comment not found')
      // Depth-1 rule: replying to a reply lands under the same top-level parent.
      const parent = hit.parent || hit.comment
      const me = viewer(db)
      const rp = {
        id: `r-new-${++seq}`,
        authorId: me,
        author: authorSummary(db, me, { id: me, username: 'you', fullName: 'You', profileImage: null }),
        textContent: String(ctx.body?.text || ''),
        mediaUrl: ctx.body?.mediaUrl || null,
        reactionCount: 0, likedByMe: false, edited: false, deleted: false, minutesAgo: 0,
      }
      parent.replies = parent.replies || []
      parent.replies.push(rp)
      const post = findPost(db, hit.postId)
      if (post) post.commentCount = (post.commentCount || 0) + 1
      return replyWire(db, hit.postId, parent.id, rp)
    },
  },
  {
    m: 'PATCH', p: /^\/api\/v1\/posts\/comments\/([^/]+)$/,
    fn: (db, ctx) => {
      const hit = findComment(db, ctx.params[0])
      if (!hit) throw mockError(404, 'COMMENT_NOT_FOUND', 'Comment not found')
      hit.comment.textContent = String(ctx.body?.text ?? hit.comment.textContent)
      hit.comment.edited = true
      return null                                   // 204
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/posts\/comments\/([^/]+)$/,
    fn: (db, ctx) => {
      const hit = findComment(db, ctx.params[0])
      if (!hit) throw mockError(404, 'COMMENT_NOT_FOUND', 'Comment not found')
      const post = findPost(db, hit.postId)
      if (hit.parent) {
        hit.parent.replies = hit.parent.replies.filter(x => x.id !== hit.comment.id)
        if (post) post.commentCount = Math.max(0, (post.commentCount || 0) - 1)
      } else {
        const gone = 1 + (hit.comment.replies || []).length
        db.postComments[hit.postId] = (db.postComments[hit.postId] || []).filter(x => x.id !== hit.comment.id)
        if (post) post.commentCount = Math.max(0, (post.commentCount || 0) - gone)
      }
      return null                                   // 204
    },
  },

  /* ---- comments (post-scoped) ---- */
  {
    m: 'GET', p: /^\/api\/v1\/posts\/(?!r-\d)([^/]+)\/comments$/,
    fn: (db, ctx) => {
      const postId = ctx.params[0]
      const rows = (db.postComments?.[postId] || [])
        .map(cm => commentWire(db, postId, cm))
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      return afterCursor(rows, ctx.query.cursor).slice(0, size(ctx.query))
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/posts\/(?!r-\d)([^/]+)\/comments$/,
    fn: (db, ctx) => {
      const post = requirePost(db, ctx.params[0])
      const me = viewer(db)
      const cm = {
        id: `c-new-${++seq}`,
        authorId: me,
        author: authorSummary(db, me, { id: me, username: 'you', fullName: 'You', profileImage: null }),
        textContent: String(ctx.body?.text || ''),
        mediaUrl: ctx.body?.mediaUrl || null,
        mediaType: ctx.body?.mediaType || null,
        reactionCount: 0, likedByMe: false, edited: false, deleted: false,
        minutesAgo: 0, replies: [],
      }
      db.postComments = db.postComments || {}
      db.postComments[post.id] = db.postComments[post.id] || []
      db.postComments[post.id].push(cm)
      post.commentCount = (post.commentCount || 0) + 1
      return commentWire(db, post.id, cm)
    },
  },

  /* ---- comment reactions (LIKE only — PostReactionType has one member) ---- */
  {
    m: 'POST', p: /^\/api\/v1\/posts\/(?!r-\d)([^/]+)\/comments\/([^/]+)\/reactions$/,
    fn: (db, ctx) => {
      const hit = findComment(db, ctx.params[1])
      if (!hit) throw mockError(404, 'COMMENT_NOT_FOUND', 'Comment not found')
      const cm = hit.comment
      cm.likedByMe = !cm.likedByMe
      cm.reactionCount = Math.max(0, (cm.reactionCount || 0) + (cm.likedByMe ? 1 : -1))
      return { commentId: cm.id, userId: viewer(db), liked: cm.likedByMe }
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/posts\/(?!r-\d)([^/]+)\/comments\/([^/]+)\/reactions$/,
    fn: (db, ctx) => {
      const hit = findComment(db, ctx.params[1])
      if (hit && hit.comment.likedByMe) {
        hit.comment.likedByMe = false
        hit.comment.reactionCount = Math.max(0, (hit.comment.reactionCount || 0) - 1)
      }
      return { commentId: ctx.params[1], liked: false }
    },
  },

  /* ---- post reactions ---- */
  {
    m: 'GET', p: /^\/api\/v1\/posts\/(?!r-\d)([^/]+)\/reactions\/me$/,
    fn: (db, ctx) => {
      const post = requirePost(db, ctx.params[0])
      return { postId: post.id, userId: viewer(db), liked: !!post.likedByMe }
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/posts\/(?!r-\d)([^/]+)\/reactions$/,
    fn: (db, ctx) => {
      const post = requirePost(db, ctx.params[0])
      post.likedByMe = !post.likedByMe
      post.reactionCount = Math.max(0, (post.reactionCount || 0) + (post.likedByMe ? 1 : -1))
      return { postId: post.id, userId: viewer(db), liked: post.likedByMe }
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/posts\/(?!r-\d)([^/]+)\/reactions$/,
    fn: (db, ctx) => {
      const post = requirePost(db, ctx.params[0])
      if (post.likedByMe) {
        post.likedByMe = false
        post.reactionCount = Math.max(0, (post.reactionCount || 0) - 1)
      }
      return { postId: post.id, liked: false }
    },
  },

  /* ---- saves ---- */
  {
    m: 'GET', p: /^\/api\/v1\/posts\/(?!r-\d)([^/]+)\/saves\/me$/,
    fn: (db, ctx) => {
      const post = requirePost(db, ctx.params[0])
      return { postId: post.id, userId: viewer(db), saved: !!post.savedByMe }
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/posts\/(?!r-\d)([^/]+)\/saves$/,
    fn: (db, ctx) => {
      const post = requirePost(db, ctx.params[0])
      const me = viewer(db)
      db.savedPosts = db.savedPosts || []
      post.savedByMe = !post.savedByMe
      post.saveCount = Math.max(0, (post.saveCount || 0) + (post.savedByMe ? 1 : -1))
      if (post.savedByMe) {
        db.savedPosts.unshift({
          userId: me, postId: post.id, minutesAgo: 0,
          collectionName: ctx.query.collection || 'Default',
        })
      } else {
        // Only MY save row goes — saves_by_user is partitioned per viewer.
        db.savedPosts = db.savedPosts.filter(s => !(String(s.postId) === String(post.id) && String(s.userId) === String(me)))
      }
      return { postId: post.id, userId: me, saved: post.savedByMe }
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/posts\/(?!r-\d)([^/]+)\/saves$/,
    fn: (db, ctx) => {
      const post = requirePost(db, ctx.params[0])
      if (post.savedByMe) {
        post.savedByMe = false
        post.saveCount = Math.max(0, (post.saveCount || 0) - 1)
      }
      const me = viewer(db)
      db.savedPosts = (db.savedPosts || []).filter(s => !(String(s.postId) === String(post.id) && String(s.userId) === String(me)))
      return { postId: post.id, saved: false }
    },
  },

  /* ---- views ---- */
  {
    m: 'POST', p: /^\/api\/v1\/posts\/(?!r-\d)([^/]+)\/views$/,
    fn: (db, ctx) => {
      const post = requirePost(db, ctx.params[0])
      db._viewed = db._viewed || {}
      const counted = !db._viewed[post.id]                 // idempotent per viewer
      if (counted) { db._viewed[post.id] = true; post.viewCount = (post.viewCount || 0) + 1 }
      return { postId: post.id, userId: viewer(db), counted, viewCount: post.viewCount || 0 }
    },
  },

  /* ---- shares ---- */
  {
    m: 'GET', p: /^\/api\/v1\/posts\/(?!r-\d)([^/]+)\/share-link$/,
    fn: (db, ctx) => shareLinkInfo(requirePost(db, ctx.params[0])),      // preview — no bump
  },
  {
    m: 'POST', p: /^\/api\/v1\/posts\/(?!r-\d)([^/]+)\/share$/,
    fn: (db, ctx) => {
      const post = requirePost(db, ctx.params[0])
      post.shareCount = (post.shareCount || 0) + 1
      shareLedger(db, post).unshift({
        postId: post.id, createdAt: agoIso(0), shareId: `sh-new-${++seq}`,
        sharerId: viewer(db), caption: ctx.body?.caption || null,
      })
      return shareLinkInfo(post)
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/posts\/(?!r-\d)([^/]+)\/shares$/,
    fn: (db, ctx) => shareLedger(db, requirePost(db, ctx.params[0])).slice(0, size(ctx.query)),
  },
  {
    m: 'POST', p: /^\/api\/v1\/posts\/(?!r-\d)([^/]+)\/shares$/,
    fn: (db, ctx) => {
      const post = requirePost(db, ctx.params[0])
      post.shareCount = (post.shareCount || 0) + 1
      const row = {
        postId: post.id, createdAt: agoIso(0), shareId: `sh-new-${++seq}`,
        sharerId: viewer(db), caption: ctx.body?.caption || null,
      }
      shareLedger(db, post).unshift(row)
      return row                                            // ShareByPostEntity
    },
  },

  /* ---- single post ---- */
  { m: 'GET', p: new RegExp(`^/api/v1/posts/${ID}$`), fn: (db, ctx) => postWire(db, requirePost(db, ctx.params[0])) },
  {
    m: 'PATCH', p: new RegExp(`^/api/v1/posts/${ID}$`),
    fn: (db, ctx) => {
      const post = requirePost(db, ctx.params[0])
      const b = ctx.body || {}
      const text = b.textContent ?? b.text ?? b.content ?? b.body        // Jackson aliases
      if (text != null) post.textContent = String(text)
      if (b.visibility) post.visibility = b.visibility
      if (b.locationName !== undefined) post.locationName = b.locationName
      const media = b.mediaUrls ?? b.media ?? b.images
      if (media) { post.mediaUrls = media; post.mediaTypes = b.mediaTypes || media.map(() => 'IMAGE') }
      if (b.audioTrackName) post.audioTrackName = b.audioTrackName
      post.updatedMinutesAgo = 0
      return postWire(db, post)
    },
  },
  {
    m: 'DELETE', p: new RegExp(`^/api/v1/posts/${ID}$`),
    fn: (db, ctx) => {
      const post = requirePost(db, ctx.params[0])
      db.posts = (db.posts || []).filter(p => p.id !== post.id)
      db.feed = (db.feed || []).filter(f => String(f.postId) !== String(post.id))
      db.savedPosts = (db.savedPosts || []).filter(s => String(s.postId) !== String(post.id))
      if (db.postComments) delete db.postComments[post.id]
      return null                                           // 204
    },
  },

  /* ---- create (JSON body or multipart FormData) ---- */
  { m: 'POST', p: /^\/api\/v1\/posts$/, fn: createPost },
]
