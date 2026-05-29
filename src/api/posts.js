/* =========================================================
   Posts service — /api/v1/posts
   Feed, post CRUD, reactions, comments, saves, shares, views.
   Returns VIEW-shaped objects via the adapters.
   ========================================================= */
import { http } from './http.js'
import { postFromFeedItem, postFromResponse, commentFrom } from './adapters.js'

export const posts = {
  /* ---- Feeds ---- */
  // FEED_API §4: `limit` is the canonical size param (takes precedence over
  // the legacy `pageSize`); `cursor` = createdAt of the last item seen (§8).
  async feed({ cursor, limit = 20 } = {}) {
    const rows = await http.get('/api/v1/posts/feed', { cursor, limit })
    return (rows || []).map(postFromFeedItem)
  },
  async byAuthor(authorId, { cursor, pageSize = 20 } = {}) {
    const rows = await http.get(`/api/v1/posts/by-author/${authorId}`, { cursor, pageSize })
    return (rows || []).map(postFromFeedItem)
  },
  // NOTE: the reels feed (§7.3) and reel-watch view (§13.1/§26) are
  // reel-specific and live in their own namespace — see api.reels.

  /* ---- Single post ---- */
  async get(id) {
    return postFromResponse(await http.get(`/api/v1/posts/${id}`))
  },
  async create(command) {
    return postFromResponse(await http.post('/api/v1/posts', command))
  },
  async createMultipart(formData) {
    return postFromResponse(await http.upload('/api/v1/posts', formData))
  },
  async edit(id, command) {
    return postFromResponse(await http.patch(`/api/v1/posts/${id}`, command))
  },
  async remove(id) {
    return http.del(`/api/v1/posts/${id}`)
  },

  /* ---- Reactions (single LIKE, toggle) ---- */
  toggleReaction(id) { return http.post(`/api/v1/posts/${id}/reactions`, {}) },   // → { liked }
  unreact(id)        { return http.del(`/api/v1/posts/${id}/reactions`) },
  reactedByMe(id)    { return http.get(`/api/v1/posts/${id}/reactions/me`) },
  // §11.4 — posts a user has liked (light {userId,createdAt,postId} tuples; hydrate via get)
  reactionHistory(userId, pageSize = 20) { return http.get(`/api/v1/posts/users/${userId}/reactions`, { pageSize }) },

  /* ---- Comments & replies ---- */
  async comments(postId, { cursor, pageSize = 20 } = {}) {
    const rows = await http.get(`/api/v1/posts/${postId}/comments`, { cursor, pageSize })
    return (rows || []).map(commentFrom)
  },
  async addComment(postId, { text, mediaUrl = null, mediaType = null }) {
    return commentFrom(await http.post(`/api/v1/posts/${postId}/comments`, { text, mediaUrl, mediaType }))
  },
  async replies(commentId, { pageSize = 20 } = {}) {
    const rows = await http.get(`/api/v1/posts/comments/${commentId}/replies`, { pageSize })
    return (rows || []).map(commentFrom)
  },
  async addReply(commentId, { text, mediaUrl = null }) {
    // ReplyResponse shares CommentResponse's fields → adapt the same way (§14.3)
    return commentFrom(await http.post(`/api/v1/posts/comments/${commentId}/replies`, { text, mediaUrl }))
  },
  editComment(commentId, text) { return http.patch(`/api/v1/posts/comments/${commentId}`, { text }) },
  deleteComment(commentId)     { return http.del(`/api/v1/posts/comments/${commentId}`) },
  toggleCommentReaction(postId, commentId) {
    return http.post(`/api/v1/posts/${postId}/comments/${commentId}/reactions`, {})
  },
  // §12.2 — explicit comment unlike (idempotent; no-op if not liked)
  unreactComment(postId, commentId) {
    return http.del(`/api/v1/posts/${postId}/comments/${commentId}/reactions`)
  },

  /* ---- Saves / shares / views ---- */
  toggleSave(id, collection)  { return http.post(`/api/v1/posts/${id}/saves`, {}, { query: { collection } }) },
  unsave(id)                  { return http.del(`/api/v1/posts/${id}/saves`) },
  savedByMe(id)               { return http.get(`/api/v1/posts/${id}/saves/me`) },
  async savedPosts(userId, { cursor, pageSize = 20 } = {}) {
    const rows = await http.get(`/api/v1/posts/users/${userId}/saves`, { cursor, pageSize })
    return (rows || []).map(postFromResponse)
  },
  share(id, caption)  { return http.post(`/api/v1/posts/${id}/shares`, caption ? { caption } : {}) },
  sharesList(id, pageSize = 20) { return http.get(`/api/v1/posts/${id}/shares`, { pageSize }) },   // §16.2 recent shares
  recordView(id)      { return http.post(`/api/v1/posts/${id}/views`, {}) },

  /* ---- Friend suggestions (FEED_API §7) ---- */
  suggestions(userId, limit = 20) { return http.get('/api/v1/posts/suggestions', { userId, limit }) },
  // POST /suggestions/recompute — forces an immediate recompute → 202 Accepted
  recomputeSuggestions(userId)    { return http.post('/api/v1/posts/suggestions/recompute', {}, { query: { userId } }) },
}
