/* =========================================================
   Adapters — map backend DTOs onto the VIEW shapes the design
   components already expect. Each adapter attaches a resolved
   `_author` (and `_user`) object so the components can render
   identically whether the data is mock or live.
   ========================================================= */
import { assetUrl } from './config.js'

/* Plain-text projection of a possibly-HTML string — used for card previews so a
   body that arrives as HTML (e.g. an editor dumped tags into `abstractText`)
   never renders as raw `<h1 …>` markup. Dependency-free, no DOM side-effects. */
export function stripHtml(s) {
  if (!s || typeof s !== 'string' || s.indexOf('<') === -1) return s || ''
  return s
    .replace(/<\s*\/?(br|p|h[1-6]|li|div|tr|blockquote)[^>]*>/gi, ' ')   // block boundaries → space
    .replace(/<[^>]+>/g, '')                                              // strip remaining tags
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#3?9;/g, "'")
    .replace(/\s+/g, ' ').trim()
}

export function initialsOf(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '··'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/** A public @handle must never be an email. A username can't legally contain
 *  '@' (USER_API §8.1 charset), so if a stored value is email-like (legacy /
 *  bad-registration data) show only the local part — never leak the private
 *  email address as a handle (USER_API golden rule: email is private). */
export function handleOf(username, fallback = 'member') {
  const u = String(username || '').trim()
  if (!u) return fallback
  const at = u.indexOf('@')
  return at > 0 ? u.slice(0, at) : u
}

const AVATAR_GRADIENTS = [
  'linear-gradient(135deg,#159a76,#0a4a3c)',
  'linear-gradient(135deg,#bd9344,#7a5a1a)',
  'linear-gradient(135deg,#3f6a8a,#16302a)',
  'linear-gradient(135deg,#5a2a1a,#160a06)',
  'linear-gradient(135deg,#3c5a4a,#0a2a1f)',
]
function gradientFor(id = '') {
  let h = 0
  for (let i = 0; i < String(id).length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return AVATAR_GRADIENTS[h % AVATAR_GRADIENTS.length]
}

/** AuthorSummary → view author object used by Avatar/Verify/etc. */
export function authorFrom(a, fallbackId) {
  const id = a?.id || fallbackId || ''
  const full = a?.fullName || a?.authorFullName || a?.username || a?.authorUsername || 'Member'
  const handle = handleOf(a?.username || a?.authorUsername)
  return {
    id,
    full,
    handle,
    initials: initialsOf(full),
    avc: gradientFor(id || handle),
    profileImage: assetUrl(a?.profileImage || a?.authorProfileImage || null),
    verified: !!a?.verified,
    role: a?.role || 'MEMBER',
  }
}

/** "Jun 2026"-style join label from an ISO instant. */
function monthYear(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}
/** LinkPlatform/ContactPlatform enum → human label (GOOGLE_SCHOLAR → "Google Scholar"). */
function platformLabel(p) {
  if (!p) return 'Link'
  return String(p).toLowerCase().split('_').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ')
}
/** UserAttachment (profile CV/docs) → view file. Handles both the fileType/fileSize
 *  and the mimeType/sizeBytes field spellings across the two API doc revisions. */
export function userAttachmentFrom(a) {
  return {
    id: a.id,
    url: assetUrl(a.fileUrl),
    name: a.fileName || a.originalFileName || 'file',
    mime: a.fileType || a.mimeType || '',
    size: a.fileSize ?? a.sizeBytes ?? 0,
    description: a.description || '',
    order: a.displayOrder ?? 0,
  }
}

/** UserResponse (per USER_API, with nested `profile`) → view user/author.
 *  May 2026: accountType / verificationTier were removed. `verified` is now
 *  derived from `role` (SCHOLAR or RESEARCHER) or from the pre-computed
 *  `badges` array — never from the deprecated accountType field. */
export function meFrom(u) {
  if (!u) return null
  const p = u.profile || {}
  const fullName = [u.fname, u.lname].filter(Boolean).join(' ').trim()
  const full = p.displayName || fullName || u.fullName || u.username || u.handle || 'Member'
  const handle = handleOf(u.username || u.handle)
  const id = u.id || u.userId || handle
  const role = u.role || 'USER'
  const verified = role === 'SCHOLAR' || role === 'RESEARCHER' || (Array.isArray(u.badges) && u.badges.length > 0)
  return {
    id, full, handle,
    initials: initialsOf(full),
    avc: gradientFor(id),
    profileImage: assetUrl(p.avatarUrl || u.avatarUrl || u.profileImage || null),
    coverImage: assetUrl(p.coverImageUrl || null),
    role,
    verified,
    badges: Array.isArray(u.badges) ? u.badges : [],   // §6.2 pre-computed, priority-sorted (render via <Badges>)
    emailVerified: !!u.isEmailVerified,
    bio: p.profileBio || u.bio || '',
    // — rich profile detail (USER_MODEL_API ProfileResponse) — kept as DISTINCT
    //   fields (the old single `field` collapsed academic/institution/tagline). —
    field: p.academicTitle || p.institutionName || p.selfDescriber || '',   // back-compat
    displayName: p.displayName || '',
    selfDescriber: p.selfDescriber || '',
    academicTitle: p.academicTitle || '',
    institution: p.institutionName || '',
    madhhab: p.madhhabName || '',
    location: p.location || '',
    website: p.websiteUrl || u.websiteUrl || '',
    orcid: u.orcidId || u.orcid || '',
    isForHire: !!p.isForHire,
    profileLocked: !!p.isProfileLocked,
    contentLanguage: p.contentLanguage || u.preferredLanguage || '',
    profileViews: p.profileViews ?? 0,
    joinedAt: monthYear(u.createdAt),
    specializations: (p.specializations || [])
      .map(s => ({ id: s.topicId ?? s.id, name: s.topicName || s.nameEn || s.name || '', order: s.displayOrder ?? 0 }))
      .filter(s => s.name).sort((a, b) => a.order - b.order),
    links: (p.links || [])
      .map(l => ({ id: l.id, platform: l.platform || 'OTHER', url: l.url || '', label: l.description || platformLabel(l.platform), order: l.displayOrder ?? 0 }))
      .filter(l => l.url).sort((a, b) => a.order - b.order),
    contacts: (p.contacts || [])
      .map(c => ({ id: c.id, platform: c.platform || 'OTHER', label: platformLabel(c.platform), value: c.value || '', order: c.displayOrder ?? 0 }))
      .filter(c => c.value).sort((a, b) => a.order - b.order),
    attachments: (p.attachments || []).map(userAttachmentFrom).filter(a => a.url).sort((a, b) => a.order - b.order),
    followers: p.followerCount ?? 0,
    following: p.followingCount ?? 0,
    posts: p.postCount ?? 0,
    contributions: p.researchCount ?? 0,
    raw: u,
  }
}

/** Alias — UserResponse rows in lists (followers, search, close friends, blocked). */
export const userFrom = meFrom

/** UserStatsResponse (USER_API §6.9) → profile stat-row counts (live, cross-store). */
export function userStatsFrom(s) {
  return {
    posts:     s?.postCount ?? 0,        // non-reel posts only (backend splits them)
    reels:     s?.reelCount ?? 0,
    research:  s?.researchCount ?? 0,
    questions: s?.questionCount ?? 0,
    followers: s?.followerCount ?? 0,
    following: s?.followingCount ?? 0,
  }
}

/** FollowSuggestionResponse → view person row (Who to follow / suggestions).
 *  May 2026 shape (USER_API §6.7): single `role` field replaced the old
 *  `verificationTier` + `accountType` pair. Verified pill follows role. */
export function followSuggestionFrom(dto) {
  const full = dto.displayName || dto.username || 'Member'
  const handle = handleOf(dto.username)
  const id = dto.id || dto.candidateId || ''
  const role = dto.role || 'USER'
  return {
    id, full, handle,
    initials: initialsOf(full),
    avc: gradientFor(id || handle),
    profileImage: assetUrl(dto.avatarUrl || null),
    verified: role === 'SCHOLAR' || role === 'RESEARCHER',
    role,
    followers: dto.followerCount ?? 0,
    mutual: dto.mutualCount ?? 0,
    reason: dto.reason || '',
    isFollowing: !!dto.isFollowing,
  }
}

export function timeAgo(iso) {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`
  const d = Math.floor(h / 24); if (d < 7) return `${d}d`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

function mediaFromUrls(urls = [], types = []) {
  return (urls || []).map((url, i) => {
    const t = types[i] || 'IMAGE'
    const src = assetUrl(url)   // backend media URLs are relative → make absolute
    if (t === 'IMAGE') return { type: 'IMAGE', url: src, label: 'image', bg: `center/cover no-repeat url("${src}")`, ratio: '16/10' }
    if (t === 'VIDEO') return { type: 'VIDEO', url: src, label: 'video', bg: 'linear-gradient(160deg,#1f3a4a,#070d0b)', ratio: '16/10' }
    return { type: t, url: src, label: t.toLowerCase() }
  })
}

const VIS_MAP = { FOLLOWERS_ONLY: 'FOLLOWERS', PUBLIC: 'PUBLIC', ONLY_ME: 'ONLY_ME' }

/** FeedItemResponse → view post (light list shape). */
export function postFromFeedItem(dto) {
  const a = authorFrom(dto.author, dto.authorId)
  // REEL: `videoUrl` is the playable VIDEO; `mediaUrl` is the cover/poster
  // (FeedItemResponse §3). For old rows videoUrl is null → fall back to the
  // cover (the viewer then re-hydrates via GET /posts/{id}). Non-reels keep
  // mediaUrl as an image thumbnail.
  const isReel = (dto.postType === 'REEL')
  const isVoice = (dto.postType === 'VOICE_POST')
  const video = dto.videoUrl ? assetUrl(dto.videoUrl) : null
  const cover = dto.mediaUrl ? assetUrl(dto.mediaUrl) : null   // VOICE_POST: this is the audio URL
  let media = []
  if (isReel && (video || cover)) {
    media = [{ type: 'VIDEO', url: video || cover, poster: cover, label: 'video', bg: 'linear-gradient(160deg,#1f3a4a,#070d0b)', ratio: '9/16' }]
  } else if (!isVoice && dto.mediaUrl) {
    media = mediaFromUrls([dto.mediaUrl], ['IMAGE'])
  }
  return {
    id: dto.id,
    author: a.id,
    _author: a,
    type: dto.postType || 'TEXT',
    visibility: 'PUBLIC',
    status: 'PUBLISHED',
    time: timeAgo(dto.createdAt),
    body: dto.textPreview || '',
    location: null,
    media,
    videoUrl: video,
    audioUrl: isVoice ? cover : null,   // VOICE_POST playable audio (feed puts it in mediaUrl)
    sharedPostId: dto.sharedPostId || null,   // feed items omit it → RepostEmbed fetches the full post
    likes: dto.reactionCount || 0,
    comments: dto.commentCount || 0,
    shares: dto.shareCount || 0,
    views: dto.viewCount || 0,
    saves: dto.saveCount || 0,
    liked: !!dto.likedByMe,
    saved: !!dto.savedByMe,
    createdAt: dto.createdAt || null,   // raw ISO Instant — drives cursor pagination (FEED_API §8)
    commentPreview: [],
  }
}

/* ---- Mixed home feed (HOME_FEED_FRONTEND_GUIDE) ----------------------------
   GET /api/v1/posts/feed now returns POST, RESEARCH and QUESTION rows in one
   chronological stream, each carrying an `entityType` discriminator. Counters
   are POST-only (zeroed on research/Q&A — the detail page is the truth); the
   light cards carry just title (textPreview), cover (mediaUrl), author + time,
   and the raw createdAt that drives cursor pagination. */

/** FeedItemResponse (RESEARCH) → light research feed-card object. */
export function researchFromFeedItem(dto) {
  const a = authorFrom(dto.author, dto.authorId)
  return {
    kind: 'RESEARCH',
    id: dto.id,
    author: a.id,
    _author: a,
    title: dto.textPreview || 'Untitled research',
    cover: dto.mediaUrl
      ? `center/cover no-repeat url("${assetUrl(dto.mediaUrl)}")`
      : 'radial-gradient(120% 100% at 30% 10%,#1f5a4a,#0a2a22)',
    hasCover: !!dto.mediaUrl,
    time: timeAgo(dto.createdAt),
    createdAt: dto.createdAt || null,
  }
}

/** FeedItemResponse (QUESTION) → light Q&A feed-card object. */
export function questionFromFeedItem(dto) {
  const a = authorFrom(dto.author, dto.authorId)
  return {
    kind: 'QUESTION',
    id: dto.id,
    author: a.id,
    _author: a,
    title: dto.textPreview || 'Untitled question',
    time: timeAgo(dto.createdAt),
    createdAt: dto.createdAt || null,
  }
}

/** Mixed home-feed dispatcher — branch on `entityType` FIRST (guide §2). A null/
 *  unknown type is treated as POST (pre-migration rows read entity_type=null). */
export function feedItemFrom(dto) {
  switch (dto?.entityType) {
    case 'RESEARCH': return researchFromFeedItem(dto)
    case 'QUESTION': return questionFromFeedItem(dto)
    case 'POST':
    default:         return { ...postFromFeedItem(dto), kind: 'POST' }
  }
}

/** PostResponse (full) → view post. */
export function postFromResponse(dto) {
  const a = authorFrom(dto.author, dto.authorId)
  const media = dto.postType === 'VOICE_POST'
    ? [{ type: 'AUDIO', label: dto.audioTrackName || 'voice note', duration: '0:00' }]
    : mediaFromUrls(dto.mediaUrls, dto.mediaTypes)
  return {
    id: dto.id,
    author: a.id,
    _author: a,
    type: dto.postType || 'TEXT',
    visibility: VIS_MAP[dto.visibility] || 'PUBLIC',
    status: dto.status || 'PUBLISHED',
    time: timeAgo(dto.createdAt),
    body: dto.textContent || '',
    location: dto.locationName || null,
    media,
    audioUrl: assetUrl(dto.audioTrackUrl || null),   // VOICE_POST playable audio
    sharedPostId: dto.sharedPostId || null,           // REPOST → original post id (embed it)
    likes: dto.reactionCount || 0,
    comments: dto.commentCount || 0,
    shares: dto.shareCount || 0,
    views: dto.viewCount || 0,
    saves: dto.saveCount || 0,
    liked: !!dto.likedByMe,
    saved: !!dto.savedByMe,
    createdAt: dto.createdAt || null,   // raw ISO Instant — for cursor pagination / sorting
    savedAt: dto.savedAt || null,                 // saved-list only → cursor for the Saved screen
    savedCollectionName: dto.savedCollectionName || null,
    commentPreview: [],
  }
}

/** CommentResponse → view comment-preview row. */
export function commentFrom(dto) {
  const a = authorFrom(dto.author, dto.authorId)
  return {
    id: dto.id,
    author: a.id,
    _author: a,
    body: dto.textContent || '',
    time: timeAgo(dto.createdAt),
    likes: dto.reactionCount || 0,
    liked: !!dto.likedByMe,
    replyCount: dto.replyCount || 0,
  }
}

/** QuestionResponse (§5) → view question. Every documented field is carried. */
export function questionFrom(dto) {
  const a = authorFrom({ username: dto.authorUsername, fullName: dto.authorFullName, profileImage: dto.authorProfileImage, id: dto.authorId })
  return {
    id: dto.id,
    author: a.id,
    _author: a,
    time: dto.timeAgo || timeAgo(dto.createdAt),     // prefer the server's "2 hours ago" string
    formattedDate: dto.formattedDate || '',          // "21 May 2026"
    createdAt: dto.createdAt || null,
    updatedAt: dto.updatedAt || null,
    status: dto.status || 'OPEN',
    title: dto.title || '',
    body: dto.body || '',
    answers: dto.answerCount || 0,
    views: dto.viewCount || 0,
    saves: dto.saveCount || 0,
    saved: !!dto.isSaved,
    answersLocked: !!dto.answersLocked,
    maxAnswers: dto.maxAnswers ?? null,
    acceptsNewAnswers: dto.acceptsNewAnswers ?? null,   // §5 — use this to gate the composer, not status
    hasAcceptedAnswer: !!dto.hasAcceptedAnswer,         // "resolved" badge
    acceptedAnswerCount: dto.acceptedAnswerCount || 0,
    savedAt: dto.savedAt || null,                    // saved-list endpoints only (§17)
    tags: dto.tags || [],
    keywords: dto.keywords || '',
    answerList: [],
  }
}

/** AnswerAttachmentResponse (§5/§16) → view attachment row. */
export function attachmentFrom(at) {
  return {
    id: at.id,
    answerId: at.answerId || null,
    url: assetUrl(at.fileUrl),
    name: at.originalFileName || 'file',
    mime: at.mimeType || '',
    mediaType: at.mediaType || 'OTHER',
    size: at.fileSize || 0,
    caption: at.caption || '',
    order: at.displayOrder ?? 0,
    duration: at.durationSeconds ?? null,
    thumbnailUrl: assetUrl(at.thumbnailUrl || null),
    createdAt: at.createdAt || null,
  }
}

/** AnswerSourceResponse (§5/§17) → view source row. Keeps every field +
    derives a clickable `href` (url → fileUrl) and a `sub` line. */
export function sourceFrom(s) {
  const sub = s.citationText || s.url || (s.isbn ? `ISBN ${s.isbn}` : '') || s.originalFileName || ''
  const href = s.url || s.fileUrl || null
  return {
    id: s.id,
    answerId: s.answerId || null,
    type: s.sourceType,
    title: s.title,
    citationText: s.citationText || '',
    sub,
    url: s.url || null,
    isbn: s.isbn || null,
    fileUrl: assetUrl(s.fileUrl || null),
    fileName: s.originalFileName || null,
    fileSize: s.fileSize ?? null,
    mimeType: s.mimeType || null,
    href: href ? assetUrl(href) : null,
    order: s.displayOrder ?? 0,
    createdAt: s.createdAt || null,
  }
}


/** ResearchSummaryResponse → view research card. */
export function researchFrom(dto) {
  const a = authorFrom({ username: dto.researcherUsername, fullName: dto.researcherFullName, profileImage: dto.researcherProfileImage, id: dto.researcherId })
  return {
    id: dto.id,
    author: a.id,
    _author: a,
    time: timeAgo(dto.publishedAt || dto.createdAt),
    status: dto.status || 'PUBLISHED',
    irc: dto.ircId || '',
    title: dto.title || '',
    abstract: stripHtml(dto.abstractText || ''),         // card preview = plain text (some rows store HTML here)
    abstractHtml: dto.abstractHtml || '',                // server-rendered preview HTML for feed cards
    bodyFormat: dto.bodyFormat || 'PLAIN',
    overview: dto.description || dto.abstractText || '',
    keywords: dto.keywords || '',
    visibility: dto.visibility || 'PUBLIC',
    tags: dto.tags || [],
    cover: dto.coverImageUrl ? `center/cover no-repeat url("${assetUrl(dto.coverImageUrl)}")` : 'radial-gradient(120% 100% at 30% 10%,#1f5a4a,#0a2a22)',
    hasVideo: !!dto.videoPromoThumbnailUrl,
    metrics: {
      views: dto.viewCount || 0, downloads: dto.downloadCount || 0, reactions: dto.reactionCount || 0,
      comments: dto.commentCount || 0, saves: dto.saveCount || 0, citations: dto.citationCount || 0,
    },
    liked: !!dto.currentUserReacted,
    saved: !!dto.currentUserSaved,
    contributors: [],
    sources: [],
    figures: [],
    citation: dto.citation || '',
  }
}

/** QuestionAnswerResponse (§5) → view answer row. Every documented field carried. */
export function answerFrom(dto) {
  const a = authorFrom({ username: dto.authorUsername, fullName: dto.authorFullName, profileImage: dto.authorProfileImage, id: dto.authorId })
  return {
    id: dto.id,
    questionId: dto.questionId || null,
    author: a.id,
    _author: a,
    time: dto.timeAgo || timeAgo(dto.createdAt),
    formattedDate: dto.formattedDate || '',
    createdAt: dto.createdAt || null,
    updatedAt: dto.updatedAt || null,
    accepted: !!dto.accepted,                        // author-accept is the sole quality signal (best-answer voting removed)
    likes: dto.reactionCount || 0,
    myReaction: dto.myReaction || null,
    _liked: dto.myReaction === 'LIKE',
    body: dto.body || '',
    parentAnswerId: dto.parentAnswerId || null,
    replyToAnswerId: dto.replyToAnswerId || null,    // E2 — actual target before depth-1 hoisting
    replyToUserId: dto.replyToUserId || null,
    replyCount: dto.replyCount || 0,
    edited: !!dto.edited,
    editedAt: dto.editedAt || null,
    deleted: !!dto.deleted,
    deletedAt: dto.deletedAt || null,
    mediaUrl: assetUrl(dto.mediaUrl || null),
    mediaType: dto.mediaType || null,
    mediaThumbnailUrl: assetUrl(dto.mediaThumbnailUrl || null),
    voiceUrl: assetUrl(dto.voiceUrl || null),
    voiceDurationSeconds: dto.voiceDurationSeconds ?? null,
    links: dto.links || null,
    attachments: (dto.attachments || []).map(attachmentFrom),   // §16
    sources: (dto.sources || []).map(sourceFrom),               // §17
  }
}

/** Research CommentResponse → view comment (depth-1, replies inline). */
export function researchCommentFrom(dto) {
  const a = authorFrom({ id: dto.userId, username: dto.userUsername, fullName: dto.userFullName, profileImage: dto.userProfileImage })
  return {
    id: dto.id,
    author: a.id,
    _author: a,
    body: dto.content || '',
    time: dto.timeAgo || timeAgo(dto.createdAt),
    likes: dto.likeCount || 0,
    liked: dto.myReaction === 'LIKE',
    replyCount: dto.replyCount || 0,
    edited: !!dto.isEdited,
    hidden: !!dto.isHidden,
    parentId: dto.parentId || null,
    mediaUrl: assetUrl(dto.mediaUrl || null),
    mediaType: dto.mediaType || null,
    mediaThumbnailUrl: assetUrl(dto.mediaThumbnailUrl || null),
    voiceUrl: assetUrl(dto.voiceUrl || null),
    voiceDurationSeconds: dto.voiceDurationSeconds ?? null,
    replies: (dto.replies || []).map(researchCommentFrom),
  }
}

/** ResearchResponse (full) → view research detail object. */
export function researchDetailFrom(dto) {
  const summary = researchFrom({
    ...dto,
    abstractText: dto.abstractText, viewCount: dto.viewCount, downloadCount: dto.downloadCount,
    reactionCount: dto.reactionCount, commentCount: dto.commentCount, saveCount: dto.saveCount,
    citationCount: dto.citationCount, publishedAt: dto.publishedAt, createdAt: dto.createdAt,
  })
  return {
    ...summary,
    overview: dto.description || dto.abstractText || '',
    description: dto.description || '',
    descriptionHtml: dto.descriptionHtml || '',          // server-rendered, sanitised HTML for direct render
    abstractHtml: dto.abstractHtml || '',
    abstractSource: dto.abstractText || '',              // RAW abstract (HTML/MD) — lossless fallback + edit prefill
                                                         // (summary.abstract is stripHtml'd to plain for card previews)
    bodyFormat: dto.bodyFormat || 'PLAIN',               // PLAIN | MARKDOWN | HTML (BodyFormat enum)
    keywords: dto.keywords || '',
    visibility: dto.visibility || 'PUBLIC',
    hasVideo: !!dto.videoPromoUrl,
    videoPromoUrl: assetUrl(dto.videoPromoUrl || null),
    videoPromoThumb: assetUrl(dto.videoPromoThumbnailUrl || null),
    videoPromoDuration: dto.videoPromoDurationSeconds ?? null,
    coverImageUrl: assetUrl(dto.coverImageUrl || null),         // raw URL for the editor (cover prefill / remove)
    scheduledPublishAt: dto.scheduledPublishAt || null,         // prefill the scheduler on drafts
    commentsEnabled: dto.commentsEnabled !== false,
    downloadsEnabled: dto.downloadsEnabled !== false,
    shareUrl: dto.shareUrl || null,
    slug: dto.slug || null,
    mediaFiles: (dto.mediaFiles || []).map(m => ({
      id: m.id,
      type: m.mediaType,
      url: assetUrl(m.fileUrl),
      name: m.originalFileName,
      mimeType: m.mimeType || null,
      fileSize: m.fileSize ?? null,
      caption: m.caption || '',
      altText: m.altText || '',
      thumbnailUrl: assetUrl(m.thumbnailUrl || null),
      duration: m.durationSeconds ?? null,
      width:  m.widthPx ?? null,
      height: m.heightPx ?? null,
      order:  m.displayOrder ?? 0,
    })),
    contributors: (dto.contributors || []).map(c => ({
      user: '', _user: authorFrom({ fullName: c.fullName, username: c.username, profileImage: c.profileImage, id: c.userId }),
      role: c.role || 'CONTRIBUTOR', note: c.contributionNote || '',
    })),
    sources: (dto.sources || []).map(sourceFrom),   // includes MEDIA_FILE → clickable fileUrl
    figures: (dto.mediaFiles || []).filter(m => m.mediaType === 'IMAGE').map(m => ({
      bg: m.fileUrl ? `center/cover no-repeat url("${assetUrl(m.fileUrl)}")` : 'linear-gradient(140deg,#16302a,#0a4a3c)',
      label: m.caption || m.originalFileName || 'figure',
    })),
    citation: dto.citation || '',
  }
}

/** GlobalSearchHit (SEARCH_API §2, May 2026 shape) → view row.
 *  Canonical fields are `contentType` / `contentId`. The deprecated aliases
 *  `type` / `id` are still emitted by the backend for one release window —
 *  we read the canonical ones first and fall back so older deploys keep
 *  working. With `expand=true` (default) the hit carries enough to render
 *  a typeahead row WITHOUT a follow-up hydration call. */
export function searchHit(dto) {
  const contentType = dto?.contentType || dto?.type || ''
  const contentId   = dto?.contentId   || dto?.id   || ''
  return {
    type: contentType,                           // back-compat shorthand for existing callers
    id: contentId,
    contentType, contentId,
    score: dto?.score ?? 0,
    titlePreview: dto?.titlePreview || '',       // brief render data (no extra GET needed)
    authorUsername: dto?.authorUsername || '',
    authorName: dto?.authorName || '',
    createdAt: dto?.createdAt || null,
    time: timeAgo(dto?.createdAt),
  }
}

/** TrendingTagResponse (§7.3) → view chip. Already pre-ranked; render in order. */
export function trendingTagFrom(dto) {
  return {
    tag: dto?.tag || '',
    usageCount: dto?.usageCount ?? 0,
    rank: dto?.rank ?? 0,
  }
}

/** TagContentRow (§7.4) → view feed row for the tag page. `contentType` now
 *  includes POST / REEL (unified fan-out, May 2026) on top of QUESTION /
 *  RESEARCH. `titlePreview` is denormalized — and refreshed in place when
 *  the underlying title is edited, so it doesn't go stale. */
export function tagContentRowFrom(dto) {
  return {
    id: dto?.contentId || '',
    type: dto?.contentType || '',          // 'POST' | 'REEL' | 'QUESTION' | 'RESEARCH'
    contentType: dto?.contentType || '',
    contentId: dto?.contentId || '',
    authorId: dto?.authorId || '',
    titlePreview: dto?.titlePreview || '',
    createdAt: dto?.createdAt || null,
    time: timeAgo(dto?.createdAt),
  }
}

/** TagSuggestion (§7.6) → autocomplete row. Ordered by tag name ASC by
 *  default; client can re-sort by usageCount for "popular first". */
export function tagSuggestionFrom(dto) {
  return { tag: dto?.tag || '', usageCount: dto?.usageCount ?? 0 }
}
