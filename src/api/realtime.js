/* =========================================================
   Realtime — Server-Sent Events (SSE)
   ---------------------------------------------------------
   The backend exposes ONE live stream per entity:
     posts      → GET /api/v1/posts/{id}/stream
     questions  → GET /api/v1/questions/{id}/stream
     researches → GET /api/v1/researches/{id}/stream

   - SSE auth is via ?token=<jwt> (EventSource cannot set headers).
   - The browser EventSource auto-reconnects; the server sends a
     reconnectTime hint of 3s.
   - On connect the server emits `connected`; a `heartbeat` arrives
     ~every 25s. The actor's OWN action is filtered server-side
     (no echo) so optimistic UI updates are safe.
   - POSTS carry NO counter values on events → we apply +1/-1
     locally by event type (see POST_DELTAS).
   - QnA / RESEARCH wrap an authoritative `data` payload.
   ========================================================= */
import { API_BASE, session } from './config.js'

/* All event names we subscribe to, per domain (named SSE events). */
const POST_EVENTS = [
  'REACTION_ADDED', 'REACTION_REMOVED', 'REACTION_CHANGED',
  'COMMENT_CREATED', 'COMMENT_EDITED', 'COMMENT_DELETED', 'REPLY_CREATED',
  'COMMENT_REACTION_ADDED', 'COMMENT_REACTION_REMOVED', 'COMMENT_REACTION_CHANGED',
  'VIEW_COUNT_UPDATED', 'SAVE_COUNT_UPDATED', 'SHARE_COUNT_UPDATED',
  'POST_UPDATED', 'POST_DELETED',
]
const QUESTION_EVENTS = [
  'ANSWER_CREATED', 'REANSWER_CREATED', 'ANSWER_EDITED', 'ANSWER_DELETED',
  'ANSWER_REACTION_ADDED', 'ANSWER_REACTION_REMOVED', 'ANSWER_REACTION_CHANGED',
  'ANSWER_ACCEPTED', 'ANSWER_UNACCEPTED',
  'QUESTION_UPDATED', 'QUESTION_DELETED', 'QUESTION_LOCKED', 'QUESTION_UNLOCKED',
  'VIEW_COUNT_UPDATED', 'SAVE_COUNT_UPDATED', 'SHARE_COUNT_UPDATED',
]
const RESEARCH_EVENTS = [
  'REACTION_ADDED', 'REACTION_REMOVED', 'REACTION_CHANGED',
  'COMMENT_CREATED', 'COMMENT_EDITED', 'COMMENT_DELETED', 'REPLY_CREATED',
  'COMMENT_REACTION_ADDED', 'COMMENT_REACTION_REMOVED', 'COMMENT_REACTION_CHANGED',
  'VIEW_COUNT_UPDATED', 'DOWNLOAD_COUNT_UPDATED', 'SHARE_COUNT_UPDATED',
  'SAVE_COUNT_UPDATED', 'CITATION_COUNT_UPDATED', 'REACTION_COUNT_UPDATED', 'COMMENT_COUNT_UPDATED',
  'RESEARCH_UPDATED', 'RESEARCH_DELETED', 'RESEARCH_PUBLISHED',
]

const DOMAIN = {
  posts:      { base: '/api/v1/posts',      events: POST_EVENTS },
  questions:  { base: '/api/v1/questions',  events: QUESTION_EVENTS },
  researches: { base: '/api/v1/researches', events: RESEARCH_EVENTS },
}

/**
 * Open an SSE stream for one entity.
 * @param {'posts'|'questions'|'researches'} domain
 * @param {string} id   entity UUID
 * @param {object} handlers { onEvent(evt), onConnected(data), onError(e) }
 * @returns {() => void} unsubscribe — call on unmount.
 */
export function openStream(domain, id, handlers = {}) {
  const cfg = DOMAIN[domain]
  if (!cfg || !id) return () => {}

  const token = session.getToken()
  const url = `${API_BASE}${cfg.base}/${id}/stream` + (token ? `?token=${encodeURIComponent(token)}` : '')
  const es = new EventSource(url, { withCredentials: true })

  const parse = (e) => { try { return JSON.parse(e.data) } catch { return { raw: e.data } } }

  es.addEventListener('connected', (e) => handlers.onConnected?.(parse(e)))
  es.addEventListener('heartbeat', () => { /* keep-alive; ignore */ })

  for (const name of cfg.events) {
    es.addEventListener(name, (e) => {
      const data = parse(e)
      handlers.onEvent?.({ eventType: name, ...data })
    })
  }
  // generic fallback (events without an explicit `event:` line)
  es.onmessage = (e) => {
    const data = parse(e)
    if (data?.eventType) handlers.onEvent?.(data)
  }
  es.onerror = (err) => handlers.onError?.(err)   // EventSource auto-reconnects

  return () => es.close()
}

/* ---------------------------------------------------------
   POST counter deltas — events carry NO counts, so the client
   applies the +/-1 locally. `post` is the VIEW-shaped object
   (likes/comments/views/saves/shares). Returns a patched copy.
   --------------------------------------------------------- */
export function applyPostDelta(post, evt) {
  if (!post) return post
  const p = { ...post }
  switch (evt.eventType) {
    case 'REACTION_ADDED':        p.likes = (p.likes || 0) + 1; break
    case 'REACTION_REMOVED':      p.likes = Math.max(0, (p.likes || 0) - 1); break
    case 'COMMENT_CREATED':
    case 'REPLY_CREATED':         p.comments = (p.comments || 0) + 1; break
    case 'COMMENT_DELETED':       p.comments = Math.max(0, (p.comments || 0) - 1); break
    case 'VIEW_COUNT_UPDATED':    p.views = (p.views || 0) + 1; break
    // SAVE direction is ambiguous on the wire (fires for save AND unsave) — do
    // NOT guess. Your own toggle already applied the delta; for others' saves
    // the viewer debounce-re-reads the true count (POST_ENGAGEMENT §7).
    case 'SAVE_COUNT_UPDATED':    break
    // SHARE is the exception: it carries the absolute count → set, don't add.
    case 'SHARE_COUNT_UPDATED':   p.shares = (evt.postShareCount != null) ? evt.postShareCount : (p.shares || 0) + 1; break
    default: break
  }
  return p
}
