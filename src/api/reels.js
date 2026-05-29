/* =========================================================
   Reels service — the reel-SPECIFIC slice of the post API.

   A reel is a post (postType=REEL), so CREATION is NOT here —
   reels are created through the generic post create with
   postType=REEL (see posts.create / posts.createMultipart;
   the backend additionally fans REELs into reels_by_day, §6.1).

   These are the endpoints that are reel-only and therefore kept
   separate from the generic post handling:
     - global reels discover feed   → POST_API §7.3
     - reel-watch view (REEL_WATCH) → POST_API §13.1 / §26
   ========================================================= */
import { http } from './http.js'
import { assetUrl } from './config.js'
import { postFromFeedItem, authorFrom, timeAgo } from './adapters.js'

/** ReelViewResponse (watch-history entry) → view shape. */
function reelViewFrom(dto) {
  const r = dto.reel || {}
  return {
    id: dto.id,                                  // reelViewId (for delete)
    reelId: r.id,
    watchedSeconds: dto.watchedSeconds || 0,
    title: r.textPreview || '',
    mediaUrl: assetUrl(r.mediaUrl),
    thumb: assetUrl(r.thumbnailUrl || r.mediaUrl),
    durationSeconds: r.durationSeconds || null,
    _author: authorFrom(r.author, r.author?.id),
    time: dto.timeAgo || timeAgo(dto.watchedAt),
  }
}

export const reels = {
  /* GET /api/v1/posts/reels/for-you — ranked discover feed (engagement ×
     recency-decay × follow-boost). Auth optional; anon gets global ranking. */
  async forYou({ pageSize = 20 } = {}) {
    const rows = await http.get('/api/v1/posts/reels/for-you', { pageSize })
    return (rows || []).map(postFromFeedItem)
  },

  /* GET /api/v1/posts/reels/following — reels from accounts the viewer
     follows, newest first. Auth required; anon → empty list. Cursor = the
     createdAt of the last item from the previous page. */
  async following({ cursor, pageSize = 20 } = {}) {
    const rows = await http.get('/api/v1/posts/reels/following', { cursor, pageSize })
    return (rows || []).map(postFromFeedItem)
  },

  /* REELS_API §17.2  GET /api/v1/posts/reels/by-author/{authorId}
     Reel-only slice of an author's posts, newest first, cursor-paginated —
     the profile Reels tab. Pairs with reelCount from /users/{id}/stats so the
     tab count and list always agree (don't client-filter the mixed by-author
     feed — a 20-row page can contain zero reels). */
  async byAuthor(authorId, { cursor, pageSize = 20 } = {}) {
    const rows = await http.get(`/api/v1/posts/reels/by-author/${authorId}`, { cursor, pageSize })
    return (rows || []).map(postFromFeedItem)
  },

  /* §7.3  GET /api/v1/posts/reels   (alias: GET /api/v1/posts/feed/reels)
     Global, day-bucketed by UTC date, chronological within a day.
     `day` = 'YYYY-MM-DD' (UTC); omit for today. Anonymous-safe. Legacy
     discover — prefer for-you/following above. */
  async feed({ day, pageSize = 20 } = {}) {
    const rows = await http.get('/api/v1/posts/reels', { day, pageSize })
    return (rows || []).map(postFromFeedItem)
  },

  /* REELS_API §12.1  POST /api/v1/posts/{postId}/reels/view
     Records a watch SESSION (not deduped) carrying `watchedSeconds` in the
     JSON body → drives the "Watched reels" history. It does NOT bump the
     post's view_count — call posts.recordView (§11) separately for that.
     Fire-and-forget after a dwell threshold. */
  recordWatch(postId, watchedSeconds = 0) {
    return http.post(`/api/v1/posts/${postId}/reels/view`, { watchedSeconds })
  },

  /* REELS_API §12.2-12.4  reel-specific watch history */
  async watched({ page = 0, size = 20 } = {}) {
    const res = await http.get('/api/v1/users/me/reels/watched', { page, size })
    return {
      items: (res?.content || []).map(reelViewFrom),
      total: res?.totalElements ?? null,
      hasMore: res ? !(res.last ?? (res.number + 1 >= res.totalPages)) : false,
      page: res?.number ?? page,
    }
  },
  deleteWatched(reelViewId) { return http.del(`/api/v1/users/me/reels/watched/${reelViewId}`) },
  clearWatched()            { return http.del('/api/v1/users/me/reels/watched') },
}
