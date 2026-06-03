/* =========================================================
   Stories service — /api/v1/stories (24h ephemeral) + Close Friends
   ========================================================= */
import { http } from './http.js'
import { API_BASE, session } from './config.js'

// Author-scoped story-tray live stream. The backend pushes StoryTrayEvents here
// (POLL_VOTE_CAST carries { pollId, voteA, voteB, voteTotal }). NOTE: the tray
// stream path is not yet documented by the backend — if the server uses a
// different route, change TRAY_PATH (this one constant) to match.
const TRAY_PATH = '/api/v1/stories/tray/stream'

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
    const token = session.getToken()
    const url = `${API_BASE}${TRAY_PATH}` + (token ? `?token=${encodeURIComponent(token)}` : '')
    const es = new EventSource(url, { withCredentials: true })
    const parse = (e) => { try { return JSON.parse(e.data) } catch { return {} } }
    const route = (name, data) => {
      switch ((name || data.eventType || data.type || '').toUpperCase()) {
        case 'NEW_STORY':      return onNewStory?.(data)
        case 'STORY_REMOVED':  return onStoryRemoved?.(data)
        case 'POLL_VOTE_CAST': return onPollVote?.(data)
        case 'CONNECTED':      return onConnected?.(data)
        default:               return                 // HEARTBEAT / unknown → ignore
      }
    }
    ;['new_story','story_removed','poll_vote_cast','connected','heartbeat'].forEach(n => {
      es.addEventListener(n,             (e) => route(n, parse(e)))
      es.addEventListener(n.toUpperCase(), (e) => route(n, parse(e)))
    })
    es.addEventListener('message', (e) => route(null, parse(e)))   // unnamed events → route by payload type
    es.onerror = () => onError?.(es.readyState)
    return () => es.close()
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
