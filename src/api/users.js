/* =========================================================
   Users service — /api/v1/users  (full USER_API.md coverage)
   Identity, public profiles + stats, social graph, suggestions,
   close friends, links / contacts / specializations, avatar /
   cover, email preferences.
   ========================================================= */
import { http } from './http.js'
import { userFrom, followSuggestionFrom, userStatsFrom } from './adapters.js'

const page = (res, map) => ({
  items: (res?.content || res || []).map(map),
  total: res?.totalElements ?? null,
  hasMore: res ? !res.last : false,
})

export const users = {
  /* ---- identity (§9) ---- */
  async get(id)            { return userFrom(await http.get(`/api/v1/users/${id}`)) },                                  // §9.2
  async getByUsername(un)  { return userFrom(await http.get(`/api/v1/users/username/${un}`)) },                         // §9.3
  async getByEmail(email)  { return userFrom(await http.get(`/api/v1/users/email/${encodeURIComponent(email)}`)) },    // §9.4
  async search(q, { page: p = 0, size = 20, eligibleContributor } = {}) {                                              // §9.6
    const res = await http.get('/api/v1/users/search', { q, page: p, size, eligibleContributor: eligibleContributor || undefined })
    return (res?.content || res || []).map(userFrom)
  },
  async updateIdentity(body){ return userFrom(await http.patch('/api/v1/users/me', body)) },                           // §9.5
  deleteAccount()           { return http.del('/api/v1/users/me') },                                                    // §9.13 (soft)
  async stats(id)           { return userStatsFrom(await http.get(`/api/v1/users/${id}/stats`)) },                      // §9.14

  /* ---- profile (§10) ---- */
  async profile(id)         { return userFrom(await http.get(`/api/v1/users/${id}/profile`)) },                        // §10.1
  async updateProfile(body) { return userFrom(await http.patch('/api/v1/users/me/profile', body)) },                   // §10.3
  uploadAvatar(file) { const fd = new FormData(); fd.append('image', file); return http.upload('/api/v1/users/me/profile/avatar', fd) },  // §10.4
  removeAvatar()     { return http.del('/api/v1/users/me/profile/avatar') },                                            // §10.5
  uploadCover(file)  { const fd = new FormData(); fd.append('image', file); return http.upload('/api/v1/users/me/profile/cover', fd) },   // §10.6
  removeCover()      { return http.del('/api/v1/users/me/profile/cover') },                                             // §10.7
  // §10.8 — replaces the whole list: [{ topicId, displayOrder }]
  async updateSpecializations(specializations) { return userFrom(await http.patch('/api/v1/users/me/profile/specializations', { specializations })) },

  /* ---- profile links (§9.7-9.9) ---- */
  addLink(body)            { return http.post('/api/v1/users/me/links', body) },               // { platform, description, url, isPublic, displayOrder }
  editLink(linkId, body)   { return http.patch(`/api/v1/users/me/links/${linkId}`, body) },
  removeLink(linkId)       { return http.del(`/api/v1/users/me/links/${linkId}`) },

  /* ---- profile contacts (§9.10-9.12) ---- */
  addContact(body)          { return http.post('/api/v1/users/me/contacts', body) },           // { platform, value, isPublic }
  editContact(contactId, b) { return http.patch(`/api/v1/users/me/contacts/${contactId}`, b) },
  removeContact(contactId)  { return http.del(`/api/v1/users/me/contacts/${contactId}`) },

  /* ---- social graph (§11) ---- */
  follow(id)        { return http.post(`/api/v1/users/${id}/follow`, {}) },                     // §11.1 → SocialActionResponse
  unfollow(id)      { return http.del(`/api/v1/users/${id}/follow`) },                          // §11.2
  block(id)         { return http.post(`/api/v1/users/${id}/block`, {}) },                      // §11.5
  unblock(id)       { return http.del(`/api/v1/users/${id}/block`) },                           // §11.6
  restrict(id)      { return http.post(`/api/v1/users/${id}/restrict`, {}) },                   // §11.8
  unrestrict(id)    { return http.del(`/api/v1/users/${id}/restrict`) },                        // §11.9
  socialStatus(id)  { return http.get(`/api/v1/users/${id}/social-status`) },                   // §11.11 → SocialStatusResponse
  async followers(id, opts) { return page(await http.get(`/api/v1/users/${id}/followers`, opts), userFrom) },   // §11.3
  async following(id, opts) { return page(await http.get(`/api/v1/users/${id}/following`, opts), userFrom) },   // §11.4
  async blocked(opts)       { const r = await http.get('/api/v1/users/me/blocked', opts); return (r?.content || r || []).map(userFrom) },     // §11.7
  async restricted(opts)    { const r = await http.get('/api/v1/users/me/restricted', opts); return (r?.content || r || []).map(userFrom) },  // §11.10

  /* ---- people suggestions (§11.12-11.14) — hydrated, self-excluded, carry isFollowing ---- */
  async suggestions({ limit = 20 } = {}) {                                                      // §11.12 (auto-falls back to who-to-follow)
    const rows = await http.get('/api/v1/users/me/suggestions', { limit })
    return (rows || []).map(followSuggestionFrom)
  },
  dismissSuggestion(candidateId) { return http.del(`/api/v1/users/me/suggestions/${candidateId}`) },             // §11.13
  async whoToFollow({ limit = 20 } = {}) {                                                      // §11.14 (auth optional)
    const rows = await http.get('/api/v1/users/who-to-follow', { limit })
    return (rows || []).map(followSuggestionFrom)
  },

  /* ---- email preferences (§16) ---- */
  emailPrefs()              { return http.get('/api/v1/users/me/email-preferences') },          // §16.1
  updateEmailPrefs(body)    { return http.patch('/api/v1/users/me/email-preferences', body) },  // §16.2
  testEmail()               { return http.post('/api/v1/users/me/email-preferences/test', {}) },             // §16.3
  unsubscribeAll()          { return http.post('/api/v1/users/me/email-preferences/unsubscribe-all', {}) },   // §16.4
}

/* Close friends — /api/v1/users/me/close-friends (§13, returns UserResponse rows). */
export const closeFriends = {
  async list(opts)   { const r = await http.get('/api/v1/users/me/close-friends', opts); return (r?.content || r || []).map(userFrom) },   // §13.1
  add(userId)        { return http.post(`/api/v1/users/me/close-friends/${userId}`, {}) },      // §13.2
  remove(userId)     { return http.del(`/api/v1/users/me/close-friends/${userId}`) },           // §13.3
}
