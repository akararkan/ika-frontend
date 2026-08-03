/* =========================================================
   Activity service — /api/v1/users/me/activity (history + live SSE).
   Reads the caller's own activity (no userId in the path — the server
   uses the authenticated principal). Maps the rich UserActivityResponse
   (server-rendered `label` / `subtitle` / `timeAgo` + typed references).
   ========================================================= */
import { http } from './http.js'
import { mockEnabled } from '../mock/flag.js'
import { API_BASE, session } from './config.js'
import { timeAgo } from './adapters.js'

/* Derive a navigation target from whichever reference the row carries. */
function activityLink(d) {
  if (d.post?.id)       return d.post.postType === 'REEL' ? `/reels/${d.post.id}` : `/posts/${d.post.id}`
  if (d.question?.id)   return `/qna/${d.question.id}`
  if (d.research?.id)   return `/research/${d.research.id}`
  if (d.targetUser?.id) return `/u/${d.targetUser.id}`
  if (d.activityType === 'HASHTAG_SEARCH' && d.query) return `/tags/${encodeURIComponent(d.query.replace(/^#/, ''))}`
  if (d.query)          return `/explore?q=${encodeURIComponent(d.query)}`
  return null
}

export function activityFrom(dto) {
  return {
    id:        dto.id || dto.activityId,
    type:      dto.activityType,
    label:     dto.label || 'Activity',                 // server-rendered, never null when typed
    subtitle:  dto.subtitle || '',
    time:      dto.timeAgo || timeAgo(dto.createdAt),
    date:      dto.formattedDate || '',
    createdAt: dto.createdAt,
    deepLink:  activityLink(dto),
  }
}

export const activity = {
  /** Paged history. `types` is an array → comma-joined `types` param. */
  async list({ types, from, to, page = 0, size = 30 } = {}) {
    const res = await http.get('/api/v1/users/me/activity', {
      types: types?.length ? types.join(',') : undefined,
      from, to, page, size, sort: 'createdAt,desc',
    })
    return (res?.content || res?.items || res || []).map(activityFrom)
  },

  remove(id)   { return http.del(`/api/v1/users/me/activity/${id}`) },                  // → 204
  clear(type)  { return http.del('/api/v1/users/me/activity', { query: type ? { type } : undefined }) }, // → { deleted }

  /** Live SSE — default `message` event carrying UserActivityRealtimeEvent (its
      `.activity` is a full UserActivityResponse). Hardened per overview.md §3:
      heartbeat watchdog (25s cadence, >60s silence → one fresh socket) and the
      token re-read on every dial (it rotates; this stream has NO server
      timeout, so a wedged socket would otherwise stay dead forever). Returns
      an unsubscribe fn. */
  stream({ onActivity, onError } = {}) {

    /* Mock mode: EventSource does not pass through request(), so nothing can
       intercept it — opening one only retry-loops against a server that is not
       running. Report connected and stay silent. */
    if (mockEnabled()) {
      const t = setTimeout(() => onError?.({ mock: true }), 0)
      return () => clearTimeout(t)
    }
    let es = null
    let lastBeat = Date.now()
    let closed = false
    const connect = () => {
      if (closed) return
      const token = session.getToken()
      const url = `${API_BASE}/api/v1/users/me/activity/stream` + (token ? `?token=${encodeURIComponent(token)}` : '')
      es = new EventSource(url, { withCredentials: true })
      es.onmessage = (e) => {
        lastBeat = Date.now()
        try { const ev = JSON.parse(e.data); onActivity?.(activityFrom(ev.activity || ev)) } catch { /* ignore */ }
      }
      // Named lifecycle frames don't carry rows but DO prove the socket lives.
      es.addEventListener('connected', () => { lastBeat = Date.now() })
      es.addEventListener('heartbeat', () => { lastBeat = Date.now() })
      es.onerror = () => onError?.(es.readyState)     // transient errors auto-reconnect
    }
    connect()
    const watchdog = setInterval(() => {
      if (closed) return
      if (Date.now() - lastBeat > 60000) {
        try { es?.close() } catch { /* noop */ }
        lastBeat = Date.now()
        connect()
      }
    }, 15000)
    return () => { closed = true; clearInterval(watchdog); try { es?.close() } catch { /* noop */ } }
  },
}
