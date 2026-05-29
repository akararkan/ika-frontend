/* =========================================================
   Notifications service — /api/v1/notifications  (per USER_API.md)
   Inbox list (by category/unread), counts, mark-read, delete,
   and a realtime SSE stream.
   ========================================================= */
import { http } from './http.js'
import { API_BASE, session } from './config.js'
import { timeAgo, authorFrom } from './adapters.js'

export function notifFrom(dto) {
  return {
    id: dto.id,
    type: dto.type,
    category: dto.category,
    title: dto.title,
    body: dto.body,
    _actor: authorFrom({ id: dto.actorId, username: dto.actorUsername, fullName: dto.actorFullName, profileImage: dto.actorProfileImage }),
    aggregateCount: dto.aggregateCount || 1,
    resourceId: dto.resourceId,
    resourceType: dto.resourceType,
    deepLink: dto.deepLink || null,
    unread: dto.isRead === false,
    time: timeAgo(dto.createdAt),
  }
}

export const notifications = {
  async list({ category, unread, page = 0, size = 30 } = {}) {
    const res = await http.get('/api/v1/notifications', { category, unread, page, size })
    return (res?.content || res || []).map(notifFrom)
  },
  async unreadCount(category) {
    const res = await http.get('/api/v1/notifications/unread/count', { category })
    return res?.count ?? 0
  },
  markAllRead()      { return http.patch('/api/v1/notifications/read-all', {}) },                          // §12.5
  markRead(id)       { return http.patch(`/api/v1/notifications/${id}/read`, {}) },                        // §12.6
  markReadBulk(ids)  { return http.patch('/api/v1/notifications/read', { ids }) },                         // §12.7 → { updated }
  markCategoryRead(c){ return http.patch(`/api/v1/notifications/category/${c}/read`, {}) },                // §12.8
  remove(id)         { return http.del(`/api/v1/notifications/${id}`) },                                   // §12.9
  deleteRead()       { return http.del('/api/v1/notifications/read') },                                    // §12.10

  /** Open the notification SSE stream (NOTIFICATIONS_API §8). Returns an
      unsubscribe fn. Named events; `read`/`deleted` carry {ids, allRead} for
      cross-tab sync. `onError(readyState)` fires on drops — readyState 2 (CLOSED)
      means a hard close (likely an expired token) that won't auto-reconnect. */
  stream({ onNotification, onUnreadCount, onConnected, onRead, onDeleted, onError } = {}) {
    const token = session.getToken()
    const url = `${API_BASE}/api/v1/notifications/stream` + (token ? `?token=${encodeURIComponent(token)}` : '')
    const es = new EventSource(url, { withCredentials: true })
    const parse = (e) => { try { return JSON.parse(e.data) } catch { return {} } }
    es.addEventListener('connected', (e) => onConnected?.(parse(e)))
    es.addEventListener('notification', (e) => onNotification?.(notifFrom(parse(e))))
    es.addEventListener('unread-count', (e) => onUnreadCount?.(parse(e).count ?? 0))
    es.addEventListener('read', (e) => onRead?.(parse(e)))
    es.addEventListener('deleted', (e) => onDeleted?.(parse(e)))
    es.addEventListener('heartbeat', () => {})
    es.onerror = () => onError?.(es.readyState)
    return () => es.close()
  },
}
