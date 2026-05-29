/* =========================================================
   Activity service — per-user activity feed.
   ---------------------------------------------------------
   NOTE: the activity feed lives in USER_ACTIVITY_API.md (not
   provided). The path below follows the platform convention;
   if your backend differs, edit ONLY this file.
   ========================================================= */
import { http } from './http.js'
import { timeAgo } from './adapters.js'

function activityFrom(dto) {
  return {
    id: dto.id || dto.activityId,
    type: dto.type || dto.activityType,
    time: timeAgo(dto.createdAt),
    target: dto.target || dto.summary || '',
    snippet: dto.snippet || null,
    meta: dto.meta || dto.postType || null,
  }
}

export const activity = {
  async forUser(userId, { cursor, pageSize = 20 } = {}) {
    const rows = await http.get(`/api/v1/users/${userId}/activity`, { cursor, pageSize })
    return (rows?.items || rows || []).map(activityFrom)
  },
}
