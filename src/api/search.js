/* =========================================================
   Unified search — GET /api/v1/search   (SEARCH_API.md, May 2026)
   ---------------------------------------------------------
   Hits are entity-stamped via {contentType, contentId, score} and,
   with expand=true (the default), carry enough brief data
   (titlePreview / authorUsername / authorName / createdAt) to
   render a typeahead row WITHOUT a follow-up hydration call.
   Cursor mode (?cursor=) is recommended for typeahead — stable
   across mid-scroll inserts. Offset mode (?page=) still works
   for full results pages.
   ========================================================= */
import { http } from './http.js'
import { searchHit } from './adapters.js'

export const search = {
  /**
   * @param q       free-text query
   * @param types   array subset of POST,REEL,QUESTION,RESEARCH (omit = all)
   * @param cursor  opaque token from a prior nextCursor — preferred over `page` for live feeds
   * @param page    0-indexed offset page (ignored when `cursor` is set)
   * @param size    page size (1..100, default 20)
   * @param expand  default true; pass false for the bare {contentType,contentId,score} shape
   * @returns       { query, results, page, size, degraded, nextCursor }
   */
  async query(q, { types, cursor, page = 0, size = 20, expand } = {}) {
    if (!q || !q.trim()) {
      return { query: q || '', results: [], page, size, degraded: false, nextCursor: '' }
    }
    const res = await http.get('/api/v1/search', {
      q,
      types: types?.length ? types.join(',') : undefined,
      cursor: cursor || undefined,
      page: cursor ? undefined : page,                         // server ignores page in cursor mode
      size,
      expand: expand === false ? 'false' : undefined,          // expand=true is server default
    })
    return {
      query: res?.query || q,
      page: res?.page ?? page,
      size: res?.size ?? size,
      degraded: !!res?.degraded,                               // §5 — ES-down banner trigger
      nextCursor: res?.nextCursor || '',                       // cursor mode only
      results: (res?.results || []).map(searchHit),
    }
  },
}
