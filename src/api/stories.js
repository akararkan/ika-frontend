/* =========================================================
   Stories service — /api/v1/stories (24h ephemeral) + Close Friends
   ========================================================= */
import { http } from './http.js'

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
}
