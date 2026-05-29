/* =========================================================
   Mentions service — "posts mentioning me"
   GET /api/v1/users/{userId}/mentions
   ========================================================= */
import { http } from './http.js'
import { authorFrom, timeAgo } from './adapters.js'

export const mentions = {
  async forUser(userId, { pageSize = 20 } = {}) {
    const rows = await http.get(`/api/v1/users/${userId}/mentions`, { pageSize })
    return (rows || []).map(r => ({
      id: r.postId, postId: r.postId, authorId: r.authorId,
      _author: authorFrom({ id: r.authorId }),
      time: timeAgo(r.createdAt), preview: r.textPreview || '',
    }))
  },
}
