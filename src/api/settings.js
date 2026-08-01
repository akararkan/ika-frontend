/* =========================================================
   Settings module — the full server-enforced settings surface
   (SETTINGS docs: core cosmetics, privacy resolver, presence,
   discovery/QR, consent, contact sync, blocks, notification
   matrix + DND + push tokens, storage usage, data export /
   account deletion, safety center, app config & policies).

   Wire truths (probed from the backend source, not the docs):
   - No success envelopes anywhere. Spring Page only where noted.
   - Jackson NON_NULL: absent key === null. Parse defensively.
   - Cosmetic sections: PUT replaces the WHOLE block (missing
     keys become null server-side) — PATCH is the safe partial
     path, so that is what the helpers below use for edits.
   - GET /settings/privacy/muted returns bare UUID strings, not
     user DTOs — hydrate client-side (see mutedUsers()).
   - Deletion request instantly soft-deletes + revokes all
     refresh tokens: treat success as a logout.
   ========================================================= */
import { http } from './http.js'
import { userFrom } from './adapters.js'

const page = (res, map = (x) => x) => ({
  items: (res?.content || res || []).map(map),
  total: res?.totalElements ?? null,
  hasMore: res ? !res.last : false,
})

/* ---------- enums & labels (exact backend constants) ---------- */

export const VISIBILITY_LEVELS = ['EVERYONE', 'FOLLOWERS', 'FRIENDS', 'CLOSE_FRIENDS', 'CUSTOM', 'ONLY_ME']
export const VISIBILITY_LABELS = {
  EVERYONE: 'Everyone', FOLLOWERS: 'Followers', FRIENDS: 'Friends',
  CLOSE_FRIENDS: 'Close friends', CUSTOM: 'Custom lists', ONLY_ME: 'Only me',
}

/* FieldKey (23) grouped for the privacy panel. The backend map always contains
   every key; the groups only order and label them. */
export const PRIVACY_GROUPS = [
  { label: 'Profile fields', keys: [
    ['BIO', 'Bio'], ['BIRTHDAY', 'Birthday'], ['PROFILE_PICTURE', 'Profile picture'],
    ['COVER_IMAGE', 'Cover image'], ['LOCATION', 'Location'], ['WEBSITE', 'Website'],
    ['OCCUPATION', 'Occupation'], ['EDUCATION', 'Education'],
    ['EMAIL_ADDRESS', 'Email address'], ['PHONE_NUMBER', 'Phone number'],
  ]},
  { label: 'Content', keys: [
    ['POSTS', 'Posts'], ['STORIES', 'Stories'], ['PHOTOS', 'Photos'],
    ['VIDEOS', 'Videos'], ['RESEARCH', 'Research'],
  ]},
  { label: 'Connections', keys: [
    ['FRIENDS_LIST', 'Friends list'], ['FOLLOWERS', 'Followers list'], ['FOLLOWING', 'Following list'],
  ]},
  { label: 'Who can…', keys: [
    ['WHO_CAN_FOLLOW', 'Follow you'], ['WHO_CAN_MESSAGE', 'Message you'],
    ['WHO_CAN_TAG', 'Tag you'], ['WHO_CAN_MENTION', 'Mention you'],
    ['WHO_CAN_FRIEND_REQUEST', 'Send friend requests'],
  ]},
]

export const PRESENCE_POLICIES = [['EVERYONE', 'Everyone'], ['FRIENDS', 'Friends'], ['NOBODY', 'Nobody']]

export const NOTIFICATION_CHANNELS = ['PUSH', 'IN_APP', 'EMAIL', 'SMS', 'DESKTOP']
export const CHANNEL_LABELS = { PUSH: 'Push', IN_APP: 'In-app', EMAIL: 'Email', SMS: 'SMS', DESKTOP: 'Desktop' }

/* The 42 NotificationType rows, grouped for a readable matrix. ACCOUNT_WARNING
   is delivery-bypassed server-side (always sent) — render it locked-on.
   POST_MENTIONED is legacy (superseded by USER_MENTIONED) and hidden. */
export const NOTIFICATION_GROUPS = [
  { label: 'Social', rows: [
    ['NEW_FOLLOWER', 'New follower'], ['CONNECTION_REQUEST', 'Connection request'],
    ['CONNECTION_ACCEPTED', 'Connection accepted'], ['USER_MENTIONED', 'Mentions of you'],
  ]},
  { label: 'Posts & reels', rows: [
    ['POST_NEW', 'New post from people you follow'], ['POST_REACTED', 'Reactions to your posts'],
    ['POST_COMMENTED', 'Comments on your posts'], ['POST_COMMENT_REPLIED', 'Replies to your comments'],
    ['POST_COMMENT_REACTED', 'Reactions to your comments'], ['POST_SHARED', 'Shares of your posts'],
  ]},
  { label: 'Research', rows: [
    ['PUBLICATION_LIKED', 'Likes on your research'], ['PUBLICATION_COMMENTED', 'Comments on your research'],
    ['PUBLICATION_COMMENT_REACTED', 'Reactions to research comments'], ['PUBLICATION_CITED', 'Citations of your research'],
    ['RESEARCH_CONTRIBUTOR_ADDED', 'Added as a contributor'],
  ]},
  { label: 'Questions & answers', rows: [
    ['QUESTION_NEW', 'New questions'], ['QUESTION_ANSWERED', 'Answers to your questions'],
    ['ANSWER_REPLIED', 'Replies to your answers'], ['ANSWER_REACTED', 'Reactions to your answers'],
    ['ANSWER_ACCEPTED', 'Your answer accepted'],
  ]},
  { label: 'Stories', rows: [
    ['STORY_PUBLISHED', 'New stories'], ['STORY_REACTED', 'Reactions to your story'],
    ['STORY_REPLIED', 'Replies to your story'],
  ]},
  { label: 'Messages & calls', rows: [
    ['NEW_MESSAGE', 'New messages'], ['MESSAGE_REQUEST', 'Message requests'],
    ['MESSAGE_MENTION', 'Mentions in chats'], ['ADDED_TO_GROUP', 'Added to a group'],
    ['CALL_MISSED', 'Missed calls'],
  ]},
  { label: 'Channels & live', rows: [
    ['CHANNEL_NEW_POST', 'Channel posts'], ['CHANNEL_JOIN_REQUEST', 'Channel join requests'],
    ['CHANNEL_JOIN_APPROVED', 'Channel join approved'], ['STREAM_STARTED', 'Live streams'],
  ]},
  { label: 'System', rows: [
    ['SYSTEM_MESSAGE', 'System messages'], ['SYSTEM_ANNOUNCEMENT', 'Announcements'],
    ['SOUND_APPROVED', 'Sound approved'], ['TRENDING_DIGEST', 'Trending digest'],
    ['ACCOUNT_WARNING', 'Account warnings'],
  ]},
  /* Rows kept out of the UI on purpose (still valid server-side): UNFOLLOWED,
     BLOCKED, UNBLOCKED, RESTRICTED, POST_MENTIONED. */
]
export const LOCKED_NOTIFICATION_TYPES = new Set(['ACCOUNT_WARNING'])   // BYPASS_ALL: always delivered

/* DND daysMask: bit 0 (1) = Monday … bit 6 (64) = Sunday. 0 = every day. */
export const DND_DAYS = [['Mon', 1], ['Tue', 2], ['Wed', 4], ['Thu', 8], ['Fri', 16], ['Sat', 32], ['Sun', 64]]

export const REPORT_TARGET_TYPES = ['USER', 'POST', 'COMMENT', 'RESEARCH', 'QUESTION', 'ANSWER', 'MESSAGE', 'CHANNEL', 'STORY']
export const REPORT_REASONS = [
  ['SPAM', 'Spam'], ['HARASSMENT', 'Harassment'], ['HATE_SPEECH', 'Hate speech'],
  ['MISINFORMATION', 'Misinformation'], ['NUDITY_SEXUAL', 'Nudity or sexual content'],
  ['VIOLENCE', 'Violence'], ['IMPERSONATION', 'Impersonation'], ['SELF_HARM', 'Self-harm'],
  ['COPYRIGHT', 'Copyright'], ['OTHER', 'Other'],
]
export const REPORT_OUTCOME_LABELS = {
  UNDER_REVIEW: 'Under review', ACTION_TAKEN: 'Action taken',
  NO_ACTION: 'No action', APPEAL_UNDER_REVIEW: 'Appeal under review',
}

export const MEDIA_TIERS = [
  ['DATA_SAVER', 'Data saver', 'Smaller uploads — 1080 px images, 480p video'],
  ['STANDARD', 'Standard', 'Balanced — 1440 px images, 720p video'],
  ['HIGH', 'High', 'Best quality — 1920 px images, 1080p video'],
]

export const POLICY_KEYS = [['privacy', 'Privacy Policy'], ['terms', 'Terms of Service'], ['guidelines', 'Community Guidelines']]

/* ---------- the API surface ---------- */

export const settings = {
  /* ---- cosmetic core (/api/v1/settings) — sections sync verbatim ---- */
  all() { return http.get('/api/v1/settings') },                                  // {appearance, accessibility, messages, media, settingsVersion}
  section(section) { return http.get(`/api/v1/settings/${section}`) },
  /** JSON Merge Patch — the ONLY safe partial write (PUT nulls missing keys). */
  patchSection(section, patch) { return http.patch(`/api/v1/settings/${section}`, patch) },
  /** Full replace. Callers must send the complete block. */
  replaceSection(section, block) { return http.put(`/api/v1/settings/${section}`, block) },

  /* ---- privacy (/api/v1/settings/privacy) ---- */
  privacy: {
    /** Resolved policy map — every FieldKey present: { BIO:'FRIENDS', … } */
    map() { return http.get('/api/v1/settings/privacy') },
    /** Set one field. Responds with the FULL refreshed map — use it. */
    setField(field, visibility) { return http.put(`/api/v1/settings/privacy/${field}`, { visibility }) },

    lists: {
      all() { return http.get('/api/v1/settings/privacy/lists') },                //  [{id,name,type,createdAt}]
      create(name) { return http.post('/api/v1/settings/privacy/lists', { name }) },
      remove(id) { return http.del(`/api/v1/settings/privacy/lists/${id}`) },      // 204, cascades members
      members(id) { return http.get(`/api/v1/settings/privacy/lists/${id}/members`) },   // bare UUID[]
      addMember(id, memberId) { return http.post(`/api/v1/settings/privacy/lists/${id}/members`, { memberId }) },  // 204
      removeMember(id, memberId) { return http.del(`/api/v1/settings/privacy/lists/${id}/members/${memberId}`) },  // 204
    },

    muted: {
      ids() { return http.get('/api/v1/settings/privacy/muted') },                 // bare UUID[]
      mute(userId) { return http.post(`/api/v1/settings/privacy/muted/${userId}`, {}) },   // 204, idempotent
      unmute(userId) { return http.del(`/api/v1/settings/privacy/muted/${userId}`) },      // 204
    },

    keywords: {
      all() { return http.get('/api/v1/settings/privacy/keywords') },              // [{id,keyword,createdAt}]
      add(keyword) { return http.post('/api/v1/settings/privacy/keywords', { keyword }) },  // duplicate → existing row
      remove(id) { return http.del(`/api/v1/settings/privacy/keywords/${id}`) },   // 204
    },
  },

  /** The muted endpoint returns bare ids — resolve them to user cards here so
   *  panels never each reinvent the hydration. Missing/deleted users are
   *  dropped, not errors. */
  async mutedUsers() {
    const ids = (await http.get('/api/v1/settings/privacy/muted')) || []
    const users = await Promise.all(ids.map(id =>
      http.get(`/api/v1/users/${id}`).then(userFrom).catch(() => null)
    ))
    return users.filter(Boolean)
  },

  /* ---- presence (/api/v1/settings/presence) — PUT is merge-style ---- */
  presence: {
    get() { return http.get('/api/v1/settings/presence') },                        // {onlineStatusPolicy,lastSeenPolicy}
    update(body) { return http.put('/api/v1/settings/presence', body) },           // null field = unchanged
  },

  /* ---- discovery (/api/v1/settings/discovery) — PUT is merge-style ---- */
  discovery: {
    get() { return http.get('/api/v1/settings/discovery') },                       // {byUsername,byPhone,byEmail,byQr,indexable}
    update(body) { return http.put('/api/v1/settings/discovery', body) },
    qr() { return http.get('/api/v1/settings/discovery/qr') },                     // {opaqueToken,uri,rotatedAt}
    rotateQr() { return http.post('/api/v1/settings/discovery/qr/rotate', {}) },
    async resolveQr(opaque) { return userFrom(await http.get(`/api/v1/discovery/qr/resolve/${opaque}`)) },
  },

  /* ---- consent evidence (/api/v1/settings/consent) ---- */
  consent: {
    record({ scope, granted, appVersion }) { return http.post('/api/v1/settings/consent', { scope, granted, appVersion }) },
    async history(opts) { return page(await http.get('/api/v1/settings/consent', opts)) },   // Spring Page, occurredAt DESC
    state(scope) { return http.get(`/api/v1/settings/consent/${scope}`) },         // {scope,granted} — never 404
  },

  /* ---- contact sync alias (/api/v1/contacts) — 3/24h rate limit ---- */
  contactsSync: {
    sync(hashes, appVersion) { return http.post('/api/v1/contacts/sync', { hashes: hashes || [], appVersion }) },  // {stored,matched}
    clear() { return http.del('/api/v1/contacts/sync') },                          // 204 + consent revocation
  },

  /* ---- blocks alias (/api/v1/blocks) — Spring Page of UserResponse ---- */
  blocks: {
    async list(opts) { return page(await http.get('/api/v1/blocks', opts), userFrom) },
    block(userId) { return http.post(`/api/v1/blocks/${userId}`, {}) },            // SocialActionResponse
    unblock(userId) { return http.del(`/api/v1/blocks/${userId}`) },
  },

  /* ---- notification matrix + DND + push tokens ---- */
  notifications: {
    matrix() { return http.get('/api/v1/settings/notifications') },                // {TYPE:{PUSH:bool,…}} — all 42 rows
    setPref(eventType, channel, enabled) {
      return http.put(`/api/v1/settings/notifications/${eventType}/${channel}`, { enabled })   // 204
    },
    dnd() { return http.get('/api/v1/settings/notifications/dnd') },               // {enabled,timezone,startTime,endTime,daysMask,muteUntil}
    /** Patch semantics — only non-null fields applied. Trap: omitting `enabled`
     *  re-derives it from the window, so always send it explicitly. */
    updateDnd(body) { return http.put('/api/v1/settings/notifications/dnd', body) },
    pushTokens() { return http.get('/api/v1/settings/notifications/push-tokens') },       // [{id,provider,platform,lastSeenAt}]
    registerPushToken(body) { return http.post('/api/v1/settings/notifications/push-tokens', body) },  // {provider,token,platform,sid}
    deletePushToken(id) { return http.del(`/api/v1/settings/notifications/push-tokens/${id}`) },       // 204 always
  },

  /* ---- storage (/api/v1/storage/usage) — cached 1h server-side ---- */
  storage: {
    usage() { return http.get('/api/v1/storage/usage') },                          // {totalBytes, byType:{IMAGE:…}}
  },

  /* ---- data export & account deletion ---- */
  data: {
    requestExport() { return http.post('/api/v1/privacy/export') },                // 202 {jobId,status,createdAt} — 1/30d
    exportStatus(jobId) { return http.get(`/api/v1/privacy/export/${jobId}`) },    // + expiresAt/sizeBytes once READY
    downloadExport(jobId) { return http.download(`/api/v1/privacy/export/${jobId}/download`) },   // authed blob
    clearHistory(type) { return http.del(`/api/v1/privacy/history/${type}`) },     // 'search' | 'watch' → 204
    /** 202. Side effect: account soft-deleted NOW + all sessions revoked —
     *  the caller must treat success as a logout. */
    requestDeletion() { return http.post('/api/v1/account/deletion/request') },
    cancelDeletion() { return http.post('/api/v1/account/deletion/cancel') },      // {status:'CANCELLED',…}
  },

  /* ---- safety center (/api/v1/safety) ---- */
  safety: {
    /** Dedup: an open report for the same (target, reason) is returned as-is. */
    report({ targetType, targetId, reason, details }) {
      return http.post('/api/v1/safety/reports', { targetType, targetId, reason, details: details || undefined })
    },
    async myReports(opts) { return page(await http.get('/api/v1/safety/reports', opts)) },   // Page<ReportResponse>
    appeal(id) { return http.post(`/api/v1/safety/reports/${id}/appeal`) },        // only from ACTIONED/DISMISSED
    strikes() { return http.get('/api/v1/safety/strikes') },                       // bare [{id,reason,issuedAt,expiresAt}]
    score() { return http.get('/api/v1/safety/score') },                           // {score,level,items:[{key,label,passed,recommendation?}]}
  },

  /* ---- app config & policies (/api/v1/app) ---- */
  app: {
    config() { return http.get('/api/v1/app/config') },                            // permitAll {minSupportedVersion,forceUpdate,latestVersion}
    policy(key) { return http.get(`/api/v1/app/policies/${key}`) },                // permitAll {key,version,effectiveDate,title,body}
    acceptPolicy(key) { return http.post(`/api/v1/app/policies/${key}/accept`) },  // {policyKey,version,acceptedAt}
    accepted() { return http.get('/api/v1/app/policies/me/accepted') },            // bare [{policyKey,version,acceptedAt}]
  },
}
