/* =========================================================
   Q&A service — /api/v1/questions  (full QNA_API coverage)
   ========================================================= */
import { http } from './http.js'
import { questionFrom, answerFrom, sourceFrom, attachmentFrom } from './adapters.js'

export const qna = {
  /* ---- feeds / lifecycle ---- */
  async feed({ cursor, limit = 20 } = {}) {
    const page = await http.get('/api/v1/questions/feed/cursor', { cursor, limit })
    return { items: (page?.items || []).map(questionFrom), nextCursor: page?.nextCursor ?? null, hasMore: !!page?.hasMore }
  },
  async list({ page = 0, size = 20 } = {}) {
    const res = await http.get('/api/v1/questions', { page, size, sort: 'createdAt,desc' })
    return (res?.content || []).map(questionFrom)
  },
  async following({ page = 0, size = 20 } = {}) {                 // §7.3
    const res = await http.get('/api/v1/questions/feed/following', { page, size })
    return (res?.content || []).map(questionFrom)
  },
  async mine({ page = 0, size = 20 } = {}) {                      // §6.5
    const res = await http.get('/api/v1/questions/me', { page, size })
    return (res?.content || []).map(questionFrom)
  },
  async get(id)        { return questionFrom(await http.get(`/api/v1/questions/${id}`)) },
  async create(req)    { return questionFrom(await http.post('/api/v1/questions', req)) }, // mapped → list prepends in place {title,body,tags?,keywords?,answersLocked?,maxAnswers?}
  edit(id, req)        { return http.patch(`/api/v1/questions/${id}`, req) },           // §6.3
  remove(id)           { return http.del(`/api/v1/questions/${id}`) },                  // §6.4

  /* ---- answer controls (author) ---- */
  lockAnswers(id)      { return http.post(`/api/v1/questions/${id}/lock-answers`, {}) },
  unlockAnswers(id)    { return http.del(`/api/v1/questions/${id}/lock-answers`) },
  answerLimit(id, maxAnswers) { return http.patch(`/api/v1/questions/${id}/answer-limit`, {}, { query: { maxAnswers } }) },

  /* ---- answers & reanswers ---- */
  async answers(questionId, { page = 0, size = 20 } = {}) {
    const res = await http.get(`/api/v1/questions/${questionId}/answers`, { page, size })
    return (res?.content || res || []).map(answerFrom)
  },
  async postAnswer(questionId, req) { return answerFrom(await http.post(`/api/v1/questions/${questionId}/answers`, req)) },
  async postAnswerUpload(questionId, formData) { return answerFrom(await http.upload(`/api/v1/questions/${questionId}/answers/upload`, formData)) }, // §11.3
  async reanswers(questionId, answerId, { page = 0, size = 50 } = {}) {
    const res = await http.get(`/api/v1/questions/${questionId}/answers/${answerId}/reanswers`, { page, size })
    return (res?.content || res || []).map(answerFrom)
  },
  async postReanswer(questionId, answerId, req) { return answerFrom(await http.post(`/api/v1/questions/${questionId}/answers/${answerId}/reanswers`, req)) },
  async postReanswerUpload(questionId, answerId, formData) { return answerFrom(await http.upload(`/api/v1/questions/${questionId}/answers/${answerId}/reanswers/upload`, formData)) }, // §11.6
  editAnswer(questionId, answerId, body)   { return http.patch(`/api/v1/questions/${questionId}/answers/${answerId}`, { body }) },
  deleteAnswer(questionId, answerId)       { return http.del(`/api/v1/questions/${questionId}/answers/${answerId}`) },

  /* ---- reactions (single LIKE) ---- */
  react(questionId, answerId)   { return http.post(`/api/v1/questions/${questionId}/answers/${answerId}/react`, { reactionType: 'LIKE' }) },
  unreact(questionId, answerId) { return http.del(`/api/v1/questions/${questionId}/answers/${answerId}/react`) },

  /* ---- accept / best ---- */
  accept(questionId, answerId)  { return http.post(`/api/v1/questions/${questionId}/answers/${answerId}/accept`, {}) },
  unaccept(questionId, answerId){ return http.del(`/api/v1/questions/${questionId}/answers/${answerId}/accept`) },
  markBest(questionId, answerId){ return http.post(`/api/v1/questions/${questionId}/answers/${answerId}/best`, {}) },   // scholar-gated
  unvoteBest(questionId, answerId){ return http.del(`/api/v1/questions/${questionId}/answers/${answerId}/best`) },

  /* ---- answer attachments (§15) & sources (§16) ---- */
  async listAttachments(questionId, answerId) { return (await http.get(`/api/v1/questions/${questionId}/answers/${answerId}/attachments`) || []).map(attachmentFrom) },
  async addAttachment(questionId, answerId, formData, query) { return attachmentFrom(await http.upload(`/api/v1/questions/${questionId}/answers/${answerId}/attachments`, formData, { query })) },
  async editAttachment(questionId, answerId, attachmentId, req) { return attachmentFrom(await http.patch(`/api/v1/questions/${questionId}/answers/${answerId}/attachments/${attachmentId}`, req)) },
  deleteAttachment(questionId, answerId, attachmentId) { return http.del(`/api/v1/questions/${questionId}/answers/${answerId}/attachments/${attachmentId}`) },
  async listSources(questionId, answerId) { return (await http.get(`/api/v1/questions/${questionId}/answers/${answerId}/sources`) || []).map(sourceFrom) },
  async addSource(questionId, answerId, req) { return sourceFrom(await http.post(`/api/v1/questions/${questionId}/answers/${answerId}/sources`, req)) },
  async editSource(questionId, answerId, sourceId, req) { return sourceFrom(await http.patch(`/api/v1/questions/${questionId}/answers/${answerId}/sources/${sourceId}`, req)) },
  // §16.5 — MEDIA_FILE source: POST the source row first, then upload its file here (part `file`)
  async uploadSourceFile(questionId, answerId, sourceId, formData) { return sourceFrom(await http.upload(`/api/v1/questions/${questionId}/answers/${answerId}/sources/${sourceId}/file`, formData)) },
  deleteSource(questionId, answerId, sourceId) { return http.del(`/api/v1/questions/${questionId}/answers/${answerId}/sources/${sourceId}`) },

  /* ---- save / bookmark (§17) ---- */
  save(questionId, collection) { return http.post(`/api/v1/questions/${questionId}/save`, {}, { query: { collection } }) },
  unsave(questionId)           { return http.del(`/api/v1/questions/${questionId}/save`) },
  async mySaved({ page = 0, size = 20 } = {}) {
    const res = await http.get('/api/v1/questions/me/saved', { page, size })
    return (res?.content || res || []).map(questionFrom)
  },
  async mySavedCollection(name, { page = 0, size = 20 } = {}) {
    const res = await http.get('/api/v1/questions/me/saved/collection', { name, page, size })
    return (res?.content || res || []).map(questionFrom)
  },
  savedCollections()             { return http.get('/api/v1/questions/me/saved/collections') },
  renameCollection(oldName, newName) { return http.patch('/api/v1/questions/me/saved/collections', {}, { query: { oldName, newName } }) },

  /* ---- share (§18) ---- */
  shareLink(questionId)        { return http.get(`/api/v1/questions/${questionId}/share-link`) },
  recordShare(questionId)      { return http.post(`/api/v1/questions/${questionId}/share`, {}) },
}
