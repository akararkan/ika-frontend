/* =========================================================
   Sounds service — /api/v1/sounds (TikTok-style audio library)
   ---------------------------------------------------------
   Two ways in, and they are not the same thing (SEARCH: sounds.md):

     · search()     — ES BM25 over title^3 / artistName^2 with
                      fuzziness AUTO and a phrase-prefix typeahead
                      layer, scored × (1 + log1p(useCount)) so the
                      most-used sounds win TIES without drowning an
                      exact title match. APPROVED sounds only: the
                      ranked ids hydrate from Cassandra IN RANK ORDER
                      and re-check approval, so a stale index row
                      cannot surface an unapproved sound.
     · byCategory() — Cassandra browsing, cursor-paged. Not search:
                      no query, no ranking, just the catalogue.

   If ES is unavailable the search endpoint returns `[]` rather than
   a 5xx — the picker is expected to fall back to browsing.
   ========================================================= */
import { http } from './http.js'
import { soundFrom } from './adapters.js'

export const sounds = {
  async get(id)                 { return soundFrom(await http.get(`/api/v1/sounds/${id}`)) },

  /** Text search over the approved library. Blank `q` → `[]`: that is the
   *  endpoint's own contract ("use the category browser for listing"), not a
   *  client-side shortcut. */
  async search(q, { category, limit = 20 } = {}) {
    const term = String(q || '').trim()
    if (!term) return []
    const rows = await http.get('/api/v1/sounds/search', {
      q: term,
      category: category || undefined,
      limit: Math.max(1, Math.min(100, Number(limit) || 20)),
    })
    return (rows || []).map(soundFrom)                 // relevance-ordered — render in order
  },

  async byCategory(category, { cursor, pageSize = 20 } = {}) {
    const rows = await http.get(`/api/v1/sounds/by-category/${category}`, { cursor, pageSize })
    return (rows || []).map(soundFrom)
  },

  posts(id, pageSize = 20)      { return http.get(`/api/v1/sounds/${id}/posts`, { pageSize }) },
  usage(id)                     { return http.get(`/api/v1/sounds/${id}/usage`) },
  upload(req)                   { return http.post('/api/v1/sounds', req) },   // autoApprove:false for regular users
}
