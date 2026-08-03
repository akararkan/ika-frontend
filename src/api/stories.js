/* =========================================================
   Stories service — /api/v1/stories (24h ephemeral) + Close Friends
   ========================================================= */
import { http } from './http.js'
import { mockEnabled } from '../mock/flag.js'
import { API_BASE, session } from './config.js'

// Author-scoped story-tray live stream. The backend pushes StoryTrayEvents here
// (POLL_VOTE_CAST carries { pollId, voteA, voteB, voteTotal }). NOTE: the tray
// stream path is not yet documented by the backend — if the server uses a
// different route, change TRAY_PATH (this one constant) to match.
const TRAY_PATH = '/api/v1/stories/tray/stream'

/* Shared skeleton for both story streams (tray + per-story): casing-agnostic
   listeners (backends have shipped both lower_snake `event:` names and raw
   UPPER_SNAKE enums; EventSource dispatches each event to exactly one
   listener, so double-registering never double-fires), the unnamed `message`
   fallback routed by payload type, and the overview.md §3 watchdog: server
   beats every ~25s, so >60s of total silence is a wedged proxy the browser
   never declared dead → ONE fresh socket. The token is re-read on every dial
   WE make (initial, watchdog, heal) — but the browser's own auto-reconnects
   reuse the ORIGINAL url, so after the ~hourly token rotation the first
   auto-reconnect 401s and the EventSource dies CLOSED with no retry; the
   onerror heal below re-dials with a fresh token. Returns an unsubscribe fn. */
function hardenedStoryStream(path, eventNames, route, onError) {

  /* Mock mode: EventSource does not pass through request(), so nothing can
     intercept it — opening one only retry-loops against a server that is not
     running. Report connected and stay silent. */
  if (mockEnabled()) {
    const t = setTimeout(() => onError?.({ mock: true }), 0)
    return () => clearTimeout(t)
  }
  const parse = (e) => { try { return JSON.parse(e.data) } catch { return {} } }
  let es = null
  let lastBeat = Date.now()
  let closed = false
  const connect = () => {
    if (closed) return
    const token = session.getToken()
    const url = `${API_BASE}${path}` + (token ? `?token=${encodeURIComponent(token)}` : '')
    es = new EventSource(url, { withCredentials: true })
    es.onerror = () => {
      onError?.(es.readyState)
      // CLOSED never retries by itself (stale ?token after rotation is the
      // usual cause). Re-dial with a fresh token; the delay bounds any loop
      // and the readyState re-check skips if a newer socket is already live.
      if (closed || es.readyState !== 2) return
      setTimeout(() => {
        if (!closed && es?.readyState === 2) { lastBeat = Date.now(); connect() }
      }, 3000)
    }
    eventNames.forEach(n => {
      es.addEventListener(n,               (e) => { lastBeat = Date.now(); route(n, parse(e)) })
      es.addEventListener(n.toUpperCase(), (e) => { lastBeat = Date.now(); route(n, parse(e)) })
    })
    es.addEventListener('message', (e) => { lastBeat = Date.now(); route(null, parse(e)) })
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
}

export const stories = {
  byAuthor(authorId) { return http.get(`/api/v1/stories/by-author/${authorId}`) },
  create(req)        { return http.post('/api/v1/stories', req) },
  createMultipart(formData) { return http.upload('/api/v1/stories', formData) },
  remove(storyId)    { return http.del(`/api/v1/stories/${storyId}`) },
  recordView(storyId){ return http.post(`/api/v1/stories/${storyId}/views`, {}) },
  viewers(storyId, pageSize = 50) { return http.get(`/api/v1/stories/${storyId}/views`, { pageSize }) },

  /* polls */
  getPoll(storyId)        { return http.get(`/api/v1/stories/${storyId}/poll`) },
  attachPoll(storyId, req){ return http.post(`/api/v1/stories/${storyId}/poll`, req) },
  vote(pollId, choice)    { return http.post(`/api/v1/polls/${pollId}/vote`, {}, { query: { choice } }) },
  myVote(pollId)          { return http.get(`/api/v1/polls/${pollId}/vote/me`) },
  results(pollId)         { return http.get(`/api/v1/polls/${pollId}/results`) },
  // author-only: who voted for a given choice (backed by the poll_by_id reverse index)
  voters(pollId, choice)  { return http.get(`/api/v1/polls/${pollId}/voters/${choice}`) },

  /** Open the story-tray SSE stream. Fires:
        onNewStory(ev)     — a followed/close-friend posted → light the ring
        onStoryRemoved(ev) — author deleted / all expired → grey the ring
        onPollVote(ev)     — author-only live poll tally { pollId, voteA, voteB, voteTotal }
      Returns an unsubscribe fn.

      Casing-agnostic by design: backends differ on whether the SSE `event:`
      name is the lower_snake or the raw UPPER_SNAKE StoryTrayEventType enum, so
      we register BOTH casings and also route the unnamed `message` event by its
      payload type. EventSource dispatches an event to exactly one listener
      (named if the server set `event:`, else `message`), so nothing double-fires
      — and a casing change on the server can never silently kill live updates. */
  trayStream({ onNewStory, onStoryRemoved, onPollVote, onConnected, onError } = {}) {
    const route = (name, data) => {
      switch ((name || data.eventType || data.type || '').toUpperCase()) {
        case 'NEW_STORY':      return onNewStory?.(data)
        case 'STORY_REMOVED':  return onStoryRemoved?.(data)
        case 'POLL_VOTE_CAST': return onPollVote?.(data)
        case 'CONNECTED':      return onConnected?.(data)
        default:               return                 // HEARTBEAT / unknown → beat only
      }
    }
    return hardenedStoryStream(TRAY_PATH,
      ['new_story', 'story_removed', 'poll_vote_cast', 'connected', 'heartbeat'],
      route, onError)
  },

  /** Per-story live stream (realtime overview stream 4 —
   *  `/api/v1/stories/{id}/stream`, 5-min server timeout, page-scoped: open
   *  while THIS story is on screen, close on advance/unmount). Fires:
   *    onViewed(ev)    — someone saw it (server dedupes per viewer)
   *    onEngaged(ev)   — a reaction/reply landed (or a count event)
   *    onPollVoted(ev) — StoryRealtimeEvent tallies: OPTIONAL
   *      `pollVoteACount`/`pollVoteBCount` + `pollChoice` (NOT the tray's
   *      voteA/voteB shape; there is no pollId — the stream is story-scoped).
   *      One of the documented delta-model EXCEPTIONS — apply, don't ±1.
   *    onRemoved(ev)   — expired or deleted mid-view → skip past it
   *  NOTE: emit-side the backend currently sends only connected/heartbeat on
   *  this stream (the broadcast call sites are not wired yet) — this client
   *  path is forward-compatible and the tray stream covers removals today.
   *  Returns an unsubscribe fn. */
  storyStream(storyId, { onViewed, onEngaged, onPollVoted, onRemoved, onConnected, onError } = {}) {
    const route = (name, data) => {
      switch ((name || data.eventType || data.type || '').toUpperCase()) {
        case 'STORY_VIEWED':
        case 'VIEW_COUNT_UPDATED':     return onViewed?.(data)
        case 'STORY_REACTED':
        case 'STORY_UNREACTED':
        case 'STORY_REPLIED':
        case 'REACTION_COUNT_UPDATED':
        case 'REPLY_COUNT_UPDATED':    return onEngaged?.(data)
        case 'STORY_POLL_VOTED':       return onPollVoted?.(data)
        case 'STORY_EXPIRED':
        case 'STORY_DELETED':          return onRemoved?.(data)
        case 'CONNECTED':              return onConnected?.(data)
        default:                       return
      }
    }
    return hardenedStoryStream(`/api/v1/stories/${storyId}/stream`, [
      'story_viewed', 'story_reacted', 'story_unreacted', 'story_replied',
      'story_poll_voted', 'story_expired', 'story_deleted',
      'view_count_updated', 'reaction_count_updated', 'reply_count_updated',
      'connected', 'heartbeat',
    ], route, onError)
  },
}

/* Story-scoped close-friends circle — /api/v1/close-friends. This is the list
   the backend enforces for CLOSE_FRIENDS story visibility. (The hydrated
   management list lives at /users/me/close-friends — see users.closeFriends.) */
export const closeCircle = {
  list()                { return http.get('/api/v1/close-friends') },                                 // [{ ownerId, friendId, addedAt }]
  add(friendId)         { return http.post('/api/v1/close-friends', {}, { query: { friendId } }) },    // 204
  remove(friendId)      { return http.del('/api/v1/close-friends', { query: { friendId } }) },         // 204
  isMember(candidateId) { return http.get('/api/v1/close-friends/is-member', { candidateId }) },       // true/false
}

export const highlights = {
  byAuthor(authorId)  { return http.get(`/api/v1/highlights/by-author/${authorId}`) },
  create(req)         { return http.post('/api/v1/highlights', req) },
  stories(highlightId){ return http.get(`/api/v1/highlights/${highlightId}/stories`) },
  // §23.3 snapshot a story into a highlight (requesterId must be the story author)
  addStory(highlightId, storyId, requesterId) {
    return http.post(`/api/v1/highlights/${highlightId}/stories/${storyId}`, {}, { query: { requesterId } })
  },
  // §23.5 remove a snapshot (createdAt is the snapshot's clustering key)
  removeStory(highlightId, storyId, createdAt) {
    return http.del(`/api/v1/highlights/${highlightId}/stories/${storyId}`, { query: { createdAt } })
  },
  // reorder the caller's highlights to match the given id sequence (foreign/missing ids skipped)
  reorder(order)      { return http.patch('/api/v1/highlights/order', { order }) },
}
