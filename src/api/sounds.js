/* =========================================================
   Sounds service — /api/v1/sounds (TikTok-style audio library)
   ========================================================= */
import { http } from './http.js'

export const sounds = {
  get(id)                       { return http.get(`/api/v1/sounds/${id}`) },
  byCategory(category, { cursor, pageSize = 20 } = {}) {
    return http.get(`/api/v1/sounds/by-category/${category}`, { cursor, pageSize })
  },
  posts(id, pageSize = 20)      { return http.get(`/api/v1/sounds/${id}/posts`, { pageSize }) },
  usage(id)                     { return http.get(`/api/v1/sounds/${id}/usage`) },
  upload(req)                   { return http.post('/api/v1/sounds', req) },   // autoApprove:false for regular users
}
