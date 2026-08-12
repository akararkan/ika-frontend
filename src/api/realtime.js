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
import { mockEnabled } from '../mock/flag.js'

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
  'SAVE_COUNT_UPDATED', 'CITATION_COUNT_UPDATED',
  // reactions/comments come via the granular events above (not *_COUNT_UPDATED) so
  // a single action is never counted twice — see applyResearchDelta.
  'RESEARCH_UPDATED', 'RESEARCH_DELETED', 'RESEARCH_PUBLISHED',
]

const DOMAIN = {
  posts:      { base: '/api/v1/posts',      events: POST_EVENTS },
  questions:  { base: '/api/v1/questions',  events: QUESTION_EVENTS },
  researches: { base: '/api/v1/researches', events: RESEARCH_EVENTS },
}

/* =========================================================
   The REALTIME MANAGER — one connection per entity, shared.

   The naive shape is one EventSource per subscribing component;
   two surfaces watching the same post then hold two sockets,
   two watchdogs, and two slots of the per-user SSE cap of 5.
   Instead every (domain, id) pair has ONE channel here, and
   openStream() only ever adds a subscriber to it:

        EventSource ──► channel ──► every subscriber's onEvent
                                      │
                                      └► state → React re-render

   The channel dials on the first subscriber, fans each event to
   all of them, and closes on the last unsubscribe. A late
   joiner is told `connected` immediately from the channel's
   cache, so its "live" affordance settles without waiting for
   the server to say it again.
   ========================================================= */
const channels = new Map()   // "domain/id" → channel

/**
 * Subscribe to one entity's live stream.
 * @param {'posts'|'questions'|'researches'} domain
 * @param {string} id   entity UUID
 * @param {object} handlers { onEvent(evt), onConnected(data), onError(e) }
 * @returns {() => void} unsubscribe — call on unmount.
 */
export function openStream(domain, id, handlers = {}) {
  const cfg = DOMAIN[domain]
  if (!cfg || !id) return () => {}

  const key = `${domain}/${id}`
  let ch = channels.get(key)
  if (!ch) {
    ch = {
      subs: new Set(),
      es: null,
      watchdog: 0,
      lastBeat: Date.now(),
      connected: null,           // the server's `connected` payload, cached for late joiners
      mock: mockEnabled(),
    }
    channels.set(key, ch)

    /* Handlers may unsubscribe from inside a callback — fan over a snapshot,
       and never let one subscriber's throw starve the others. */
    const fan = (fn, arg) => {
      for (const s of [...ch.subs]) {
        try { s[fn]?.(arg) } catch { /* a broken subscriber is its own problem */ }
      }
    }
    ch.fan = fan

    if (ch.mock) {
      /* Mock mode: an EventSource never passes through request(), so there is
         nothing for the fixture layer to intercept — opening one only produces
         a reconnect loop against a server that is not running. The channel
         still EXISTS (so pushMockEvent can drive it and every subscriber path
         stays exercised); it just holds no socket. */
      ch.connected = { mock: true }
    } else {
      const parse = (e) => { try { return JSON.parse(e.data) } catch { return { raw: e.data } } }
      const connect = () => {
        if (!channels.has(key)) return
        // Read the token (and rebuild the URL) on EVERY connect — the access
        // token rotates ~hourly via the 401 refresh, and a long-lived page may
        // reconnect after that. Capturing it once would re-dial with a dead
        // token forever.
        const token = session.getToken()
        const url = `${API_BASE}${cfg.base}/${id}/stream` + (token ? `?token=${encodeURIComponent(token)}` : '')
        const es = new EventSource(url, { withCredentials: true })
        ch.es = es
        const beat = () => { ch.lastBeat = Date.now() }
        es.addEventListener('connected', (e) => { beat(); ch.connected = parse(e); fan('onConnected', ch.connected) })
        es.addEventListener('heartbeat', beat)
        for (const name of cfg.events) {
          es.addEventListener(name, (e) => { beat(); fan('onEvent', { eventType: name, ...parse(e) }) })
        }
        // generic fallback (events without an explicit `event:` line)
        es.onmessage = (e) => { beat(); const data = parse(e); if (data?.eventType) fan('onEvent', data) }
        es.onerror = (err) => fan('onError', err)   // browser auto-reconnects on transient errors
      }
      connect()

      // Heartbeat watchdog (REALTIME_FRONTEND_GUIDE §12): the server beats
      // every ~15-25s; >60s of total silence means a wedged proxy the browser
      // hasn't declared dead → force ONE fresh socket (close before reconnect,
      // so we never hold two and trip the per-user SSE cap of 5).
      ch.watchdog = setInterval(() => {
        if (!channels.has(key)) return
        if (Date.now() - ch.lastBeat > 60000) {
          try { ch.es?.close() } catch { /* noop */ }
          ch.lastBeat = Date.now()
          connect()
        }
      }, 15000)
    }
  }

  ch.subs.add(handlers)
  // Channel already live → settle this subscriber's "connected" now.
  if (ch.connected) {
    const mine = handlers
    queueMicrotask(() => { if (ch.subs.has(mine)) mine.onConnected?.(ch.connected) })
  }

  return () => {
    ch.subs.delete(handlers)
    if (ch.subs.size === 0) {
      channels.delete(key)
      clearInterval(ch.watchdog)
      try { ch.es?.close() } catch { /* noop */ }
    }
  }
}

/** Mock mode's stand-in for the server's push: drive a channel's subscribers
 *  with a synthetic event (demo consoles, tests). No-op outside mock. */
export function pushMockEvent(domain, id, evt = {}) {
  if (!mockEnabled()) return false
  const ch = channels.get(`${domain}/${id}`)
  if (!ch) return false
  ch.fan('onEvent', { eventType: evt.eventType || evt.type || 'UNKNOWN', ...evt })
  return true
}
if (typeof window !== 'undefined') window.__ikaRealtimePush = pushMockEvent

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

/* ---------------------------------------------------------
   RESEARCH counter deltas — reactions/comments ride the
   granular events as +/-1 (they carry NO counts); the
   *_COUNT_UPDATED family carries the named ABSOLUTE counter
   (RESEARCH_BACKEND_NOTES A2) which is preferred when present
   — an absolute can never drift under coalescing or a
   reconnect replay, a blind +1 can. `metrics` is the detail
   page's { views, downloads, reactions, comments, saves,
   citations } object. Own actions are actor-skipped by the
   caller, so this only ever runs for OTHER users' events.
   --------------------------------------------------------- */
/* Monotonic counters take max(local, absolute): a straight set could revert
   an in-flight optimistic +1 (my own event is actor-skipped, so nothing would
   ever correct it) or regress on a replayed stale absolute. Falls back to +1
   when the wire omits the number. */
const monoAbs = (evt, key, cur) => (typeof evt[key] === 'number' ? Math.max(cur, evt[key]) : cur + 1)

export function applyResearchDelta(metrics, evt) {
  if (!metrics) return metrics
  const m = { ...metrics }
  switch (evt.eventType) {
    case 'REACTION_ADDED':         m.reactions = (m.reactions || 0) + 1; break
    case 'REACTION_REMOVED':       m.reactions = Math.max(0, (m.reactions || 0) - 1); break
    case 'COMMENT_CREATED':
    case 'REPLY_CREATED':          m.comments  = (m.comments || 0) + 1; break
    case 'COMMENT_DELETED':        m.comments  = Math.max(0, (m.comments || 0) - 1); break
    case 'VIEW_COUNT_UPDATED':     m.views     = monoAbs(evt, 'viewCount', m.views || 0); break
    case 'DOWNLOAD_COUNT_UPDATED': m.downloads = monoAbs(evt, 'downloadCount', m.downloads || 0); break
    case 'CITATION_COUNT_UPDATED': m.citations = monoAbs(evt, 'citationCount', m.citations || 0); break
    // SAVE fires for save AND unsave — prefer the authoritative absolute count when
    // the wire carries it, else use the `saved` direction flag (guide §4).
    case 'SAVE_COUNT_UPDATED':
      if (typeof evt.saveCount === 'number') m.saves = Math.max(0, evt.saveCount)
      else if (typeof evt.saved === 'boolean') m.saves = Math.max(0, (m.saves || 0) + (evt.saved ? 1 : -1))
      break
    // NOTE: reactions & comments are driven ONLY by the granular events above
    // (REACTION_ADDED/REMOVED, COMMENT_CREATED/REPLY_CREATED/COMMENT_DELETED) — same
    // as posts. We deliberately do NOT also handle REACTION_COUNT_UPDATED /
    // COMMENT_COUNT_UPDATED, so one logical action can never be counted twice.
    default: break
  }
  return m
}
