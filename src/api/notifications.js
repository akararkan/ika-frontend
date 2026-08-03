/* =========================================================
   Notifications service — /api/v1/notifications (NOTIFICATIONS_API)
   ---------------------------------------------------------
   The whole documented surface: the filtered inbox list (category /
   type / unread compose with AND), the unread shorthand, the exact
   O(1) badge count (approximate per-category), single/bulk/category/
   all mark-read, delete-one, purge-read, and the SSE stream.

   Two server truths that shape the client:

   · THE SCAN WINDOW. Filtering, category counts and bulk marking all
     run over the newest 200 rows of the inbox partition — deeper
     pages come back EMPTY even when older matching rows exist, and
     `totalElements` counts matches within the window only. So the
     list returns `hasMore` for a "show more" affordance, and callers
     must treat an empty next page as "the end", never as an error.

   · AGGREGATION KEEPS THE ID. A coalesced re-delivery (the "and N
     others" bump) rides the SSE `notification` event with the SAME
     id, reset to unread — consumers must UPSERT BY ID and float the
     row to the top, never append. The unread counter does not move
     for a bump, which is why the badge is only ever SET from the
     `unread-count` event / the count endpoint, never hand-tallied.
   ========================================================= */
import { http } from './http.js'
import { API_BASE, session } from './config.js'
import { auth } from './auth.js'
import { timeAgo, authorFrom } from './adapters.js'
import { mockEnabled } from '../mock/flag.js'

/* ---------------------------------------------------------
   Deep links. The server's `deepLink` uses API-side resource
   paths; three differ from this client's routes and are
   rewritten, two (comments, answers) have no client route at
   all — those rows render un-clickable rather than bouncing
   off the router's catch-all redirect to Home.
   --------------------------------------------------------- */
const LINK_REWRITE = [
  [/^\/users\//, '/u/'],
  [/^\/questions\//, '/qna/'],
  [/^\/researches\//, '/research/'],
]
const UNROUTABLE = /^\/(comments|answers)\//

function linkOf(dto) {
  const d = dto.deepLink || null
  if (d) {
    if (UNROUTABLE.test(d)) return null
    for (const [re, to] of LINK_REWRITE) if (re.test(d)) return d.replace(re, to)
    return d
  }
  // No server link — derive one from the resource so the row stays clickable.
  const id = dto.resourceId
  const derived = id ? {
    Post: `/posts/${id}`,
    Question: `/qna/${id}`,
    Research: `/research/${id}`,
    User: `/u/${id}`,
    Conversation: `/chat/${id}`,
    Channel: `/channels/${id}`,
    LiveStream: `/live/${id}`,
  }[dto.resourceType] : null
  // TRENDING_DIGEST ships deepLink:null by design → the trending landing page.
  return derived || (dto.type === 'TRENDING_DIGEST' ? '/explore' : null)
}

export function notifFrom(dto) {
  return {
    id: dto.id,
    type: dto.type,
    category: dto.category,                        // null for uncategorized kinds — render generic
    title: dto.title,
    body: dto.body,
    _actor: authorFrom({ id: dto.actorId, username: dto.actorUsername, fullName: dto.actorFullName, profileImage: dto.actorProfileImage }),
    aggregateCount: dto.aggregateCount || 1,
    /* The newest contributor to a coalesced row ("Ali and 3 others" — Ali is
       lastActor). The wire carries id + username only, no image, so the UI
       keeps the primary actor's avatar and names lastActor in text. */
    lastActorId: dto.lastActorId || null,
    lastActorUsername: dto.lastActorUsername || '',
    resourceId: dto.resourceId,
    resourceType: dto.resourceType,
    deepLink: linkOf(dto),
    unread: dto.isRead === false,
    readAt: dto.readAt || null,
    time: timeAgo(dto.createdAt),
    createdAt: dto.createdAt,            // raw ISO — used for date grouping in the inbox
  }
}

const pageOf = (res, { page = 0, size = 20 } = {}) => {
  const rows = (res?.content || res || []).map(notifFrom)
  return {
    items: rows,
    /* Approximate by design — counts matches within the 200-row scan window. */
    total: res?.totalElements ?? rows.length,
    hasMore: res ? res.last === false : rows.length >= size,
    page: res?.number ?? page,
  }
}

export const notifications = {
  /** Paged inbox, newest first. Filters COMPOSE (AND). `type` accepts a string
   *  or an array (repeatable ?type=A&type=B); when both category and type are
   *  sent the server lets category win. */
  async list({ category, type, unread, page = 0, size = 30 } = {}) {
    return pageOf(await http.get('/api/v1/notifications', {
      category, type, unread, page, size,
    }), { page, size })
  },

  /** Shorthand for the unread rows (`GET /notifications/unread`). */
  async unreadList({ page = 0, size = 20 } = {}) {
    return pageOf(await http.get('/api/v1/notifications/unread', { page, size }), { page, size })
  },

  /** Without `category`: exact O(1) counter — seed/poll the badge freely.
   *  With `category`: approximate (scan-window count). */
  async unreadCount(category) {
    const res = await http.get('/api/v1/notifications/unread/count', { category })
    return res?.count ?? 0
  },

  markAllRead()      { return http.patch('/api/v1/notifications/read-all', {}) },
  /** 404 = the id doesn't exist OR belongs to someone else (owner-scoped). */
  markRead(id)       { return http.patch(`/api/v1/notifications/${id}/read`, {}) },
  /** ≤ 200 distinct ids; foreign/unknown ids are silently skipped. → { updated } */
  async markReadBulk(ids) {
    const r = await http.patch('/api/v1/notifications/read', { ids: (ids || []).slice(0, 200) })
    return r?.updated ?? 0
  },
  /** → { updated } within the scan window. */
  async markCategoryRead(c) {
    const r = await http.patch(`/api/v1/notifications/category/${c}/read`, {})
    return r?.updated ?? 0
  },
  /** Owner-scoped; a foreign/unknown id is a 204 no-op. */
  remove(id)         { return http.del(`/api/v1/notifications/${id}`) },
  /** Purge every already-read row (unread rows are never touched). → count.
   *  Its SSE echo is `deleted` with EMPTY ids + allRead:true — "drop every
   *  read row from your cache", not "nothing was deleted". */
  async deleteRead() {
    const r = await http.del('/api/v1/notifications/read')
    return r?.deleted ?? 0
  },

  /** Subscribe to the notification stream — see below. The ONLY way to
      listen; there is deliberately no per-caller EventSource. */
  subscribe(handlers) { return subscribeNotifications(handlers) },
}

/* =========================================================
   The ONE shared notification stream.
   ---------------------------------------------------------
   overview.md §3 is explicit: the per-user streams stay open in ONE
   place for the whole session — the server caps FIVE emitters per user
   with LRU eviction, so a second EventSource from another surface (the
   inbox page beside the Layout badge) silently evicts your own oldest
   tab. This manager owns a single hardened connection and fans it out
   to any number of consumers:

   · every named event counts as a heartbeat; >45s of total silence
     (3 missed 15s beats) means a wedged proxy the browser never
     declared dead → close and dial ONE fresh socket;
   · readyState 2 (hard close — usually an expired token) → refresh the
     session and re-dial; the URL is rebuilt on EVERY dial because the
     access token rotates and capturing it once re-dials dead forever;
   · `onConnected` fans out on EVERY (re)connect — including watchdog
     and heal re-dials — and is the consumer's "reconcile via REST"
     signal (re-seed the badge, re-fetch the visible list);
   · `notification` re-delivers aggregated rows under the SAME id —
     upsert, never append; `read`/`deleted` carry {ids, allRead,
     deleted} for cross-tab sync (purge-read = deleted with EMPTY ids
     + allRead:true → drop every read row);
   · `onFeedNewPost` is the home feed's own tap on this socket
     (FEED_API §5) — see the FEED_NEW_POST note in sharedConnect.
   ========================================================= */

const sharedSubs = new Set()
let sharedEs = null
let sharedWatchdog = 0
let sharedLastBeat = 0
let sharedOpen = false
let sharedHealing = false

const fan = (key, payload) => {
  for (const s of [...sharedSubs]) {
    try { s[key]?.(payload) } catch { /* one bad consumer can't stop the rest */ }
  }
}

function sharedConnect() {
  if (!sharedOpen) return
  const token = session.getToken()
  const url = `${API_BASE}/api/v1/notifications/stream` + (token ? `?token=${encodeURIComponent(token)}` : '')
  const es = new EventSource(url, { withCredentials: true })
  sharedEs = es
  const parse = (e) => { try { return JSON.parse(e.data) } catch { return {} } }
  const beat = () => { sharedLastBeat = Date.now() }
  es.addEventListener('connected', (e) => { beat(); fan('onConnected', parse(e)) })
  es.addEventListener('heartbeat', beat)
  es.addEventListener('notification', (e) => { beat(); fan('onNotification', notifFrom(parse(e))) })
  /* FEED_NEW_POST — the home feed's prepend HINT, multiplexed onto this same
     socket (FeedRealtimeSubscriber bridges the per-user `irc:feed:*` Redis
     channel onto the notification emitter and forwards the payload under its
     own event NAME). So it is a named SSE event, not a `notification` row:

       event: FEED_NEW_POST
       data:  { event, postId, authorId }

     A real inbox row is still delivered separately for the same post (the
     POST_NEW notification kind) — which is exactly why this must NOT be fanned
     to `onNotification` as well, or every new post would be counted twice and
     chimed twice. The feed takes it here and shows a quiet "New posts" pill. */
  es.addEventListener('FEED_NEW_POST', (e) => {
    beat()
    const d = parse(e)
    fan('onFeedNewPost', { postId: d?.postId || null, authorId: d?.authorId || null })
  })
  es.addEventListener('unread-count', (e) => { beat(); fan('onUnreadCount', parse(e).count ?? 0) })
  es.addEventListener('read', (e) => { beat(); fan('onRead', parse(e)) })
  es.addEventListener('deleted', (e) => { beat(); fan('onDeleted', parse(e)) })
  es.onerror = async () => {
    // readyState 0 (CONNECTING) auto-reconnects on its own (`retry: 3000`).
    if (!sharedOpen || es.readyState !== 2 || sharedHealing) return
    sharedHealing = true
    try { await auth.refresh() } catch { /* real 401s are RequireAuth's job */ }
    try { es.close() } catch { /* noop */ }
    sharedLastBeat = Date.now()
    sharedConnect()
    setTimeout(() => { sharedHealing = false }, 8000)   // one heal attempt per window
  }
}

/** Fan-out subscription to the single shared stream. Returns an unsubscribe
 *  fn; the socket opens with the first consumer and closes with the last. */
export function subscribeNotifications(handlers = {}) {
  /* Mock mode: an EventSource does not pass through request(), so there is
     nothing for the fixture layer to intercept — opening one would just
     retry-loop against a server that is not there. Hand this subscriber a
     small scripted replay instead, so the badge and the chime still have
     something to do during a demo. */
  if (mockEnabled()) {
    let stop = () => {}
    import('../mock/index.js').then(m => { stop = m.mockStream(handlers) }).catch(() => {})
    return () => stop()
  }

  sharedSubs.add(handlers)
  if (sharedSubs.size === 1) {
    sharedOpen = true
    sharedLastBeat = Date.now()
    sharedConnect()
    sharedWatchdog = setInterval(() => {
      if (!sharedOpen) return
      if (Date.now() - sharedLastBeat > 45000) {
        try { sharedEs?.close() } catch { /* noop */ }
        sharedLastBeat = Date.now()
        sharedConnect()
      }
    }, 15000)
  }
  return () => {
    sharedSubs.delete(handlers)
    if (!sharedSubs.size) {
      sharedOpen = false
      clearInterval(sharedWatchdog)
      try { sharedEs?.close() } catch { /* noop */ }
      sharedEs = null
    }
  }
}
