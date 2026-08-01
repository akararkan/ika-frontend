/* =========================================================
   Unified search — GET /api/v1/search   (SEARCH: global-search.md)
   ---------------------------------------------------------
   ONE Elasticsearch query over up to seven indices, returning a
   single score-ordered merge across EIGHT entity types:

     POST · REEL · QUESTION · ANSWER · RESEARCH · USER · CHANNEL · SOUND

   This is the only cross-entity full-text entry point — the old
   per-entity /posts/search, /questions/search, /researches/search
   are gone. The dedicated surfaces that remain (users, channels,
   sounds, chat) exist for extra semantics, not a different engine.

   Public: no token required. Because anyone can call it, the query
   enforces public visibility for everyone — non-public content is
   NEVER reachable here, not even by its owner.

   ---------------------------------------------------------
   CURSOR MODE IS ENTERED WITH A CURSOR, NOT AFTER ONE.

   Verified against the running backend: a request with no `cursor`
   runs OFFSET mode and the response omits `nextCursor` entirely —
   at any size, with any number of remaining matches. Only once a
   `cursor` is present does the server sort on (score, _doc) and
   hand back the next token; an unparseable value (`head`) starts
   cursor mode at the beginning. So a "load more" built on
     first page: no cursor  →  next page: res.nextCursor
   never advances: nextCursor is always empty and the second call
   re-runs page 0, appending the SAME rows again.

   Hence two explicit methods rather than one clever one:
     · stream() — cursor paging. Stable across mid-scroll inserts,
       O(t·log n + k) per page at any depth. Use for feeds/typeahead.
     · page()   — offset paging. Fine for shallow static pages;
       drifts on live data and degrades with depth.
   ========================================================= */
import { http } from './http.js'
import { searchHit } from './adapters.js'

/** The eight entity types `types=` accepts. Unknown tokens are silently
 *  skipped server-side; if nothing valid is left it searches ALL types. */
export const SEARCH_TYPES = ['POST', 'REEL', 'QUESTION', 'ANSWER', 'RESEARCH', 'USER', 'CHANNEL', 'SOUND']

/** Sentinel that opens cursor mode at the head of the result set. Any
 *  unparseable token does this; `head` is the documented example. */
export const CURSOR_HEAD = 'head'

const clampSize = (n) => Math.max(1, Math.min(100, Number(n) || 20))

/** Route for a hit — where a click should land. ANSWER deep-links to its
 *  OWNING QUESTION (`parentId`, always present on answer hits) because an
 *  answer has no page of its own. */
export function hitHref(hit) {
  if (!hit) return null
  switch (hit.contentType) {
    case 'POST':
    case 'REEL':     return `/posts/${hit.contentId}`
    case 'QUESTION': return `/qna/${hit.contentId}`
    case 'ANSWER':   return hit.parentId ? `/qna/${hit.parentId}#answer-${hit.contentId}` : null
    case 'RESEARCH': return `/research/${hit.contentId}`
    case 'USER':     return `/u/${hit.contentId}`
    case 'CHANNEL':  return `/channels/${hit.contentId}`
    case 'SOUND':    return `/explore?sound=${hit.contentId}`
    default:         return null
  }
}

const empty = (q, page, size) => ({
  query: q || '', types: [], results: [], page, size, degraded: false, nextCursor: '',
})

function normalize(res, { q, page, size }) {
  return {
    query: res?.query || q,
    types: res?.types || [],                                 // the server echoes what it actually searched
    page: res?.page ?? page,
    size: res?.size ?? size,
    degraded: !!res?.degraded,                               // ES unreachable → soft-fail, NOT an error toast
    nextCursor: res?.nextCursor || '',                       // cursor mode only; '' = no further page
    results: (res?.results || []).map(searchHit),
  }
}

async function run(q, { types, size, expand, cursor, page, signal }) {
  const res = await http.get('/api/v1/search', {
    q,
    types: types?.length ? types.join(',') : undefined,
    cursor: cursor || undefined,
    page: cursor ? undefined : page,                         // the server ignores page in cursor mode
    size,
    expand: expand === false ? 'false' : undefined,          // expand=true is the server default
  }, { signal })                                             // live-typing surfaces MUST abort the previous call
  return normalize(res, { q, page, size })
}

export const search = {
  SEARCH_TYPES,
  CURSOR_HEAD,
  hitHref,

  /**
   * Cursor paging — PREFERRED. Pass no cursor for the first page and this
   * still opens cursor mode (via the head sentinel), so `nextCursor` comes
   * back and the next call actually advances.
   *
   * @param q       free text; blank short-circuits to an empty result
   * @param cursor  opaque token from the previous response's nextCursor
   * @param types   subset of SEARCH_TYPES (omit = all eight)
   * @param size    1..100, default 20
   * @param expand  false → bare {contentType, contentId, score} hits
   */
  async stream(q, { types, cursor, size = 20, expand, signal } = {}) {
    const sz = clampSize(size)
    if (!q || !q.trim()) return empty(q, 0, sz)
    return run(q, { types, size: sz, expand, cursor: cursor || CURSOR_HEAD, page: 0, signal })
  },

  /**
   * Offset paging (legacy shape). `nextCursor` is absent in this mode by
   * design — page through with `page`.
   */
  async page(q, { types, page = 0, size = 20, expand, signal } = {}) {
    const sz = clampSize(size)
    if (!q || !q.trim()) return empty(q, page, sz)
    return run(q, { types, size: sz, expand, cursor: undefined, page: Math.max(0, Number(page) || 0), signal })
  },

  /**
   * The raw endpoint, for callers that want to decide the mode themselves.
   * Kept as the historical name: `query(q, {cursor})` behaves EXACTLY as the
   * server does — no cursor, no nextCursor.
   */
  async query(q, { types, cursor, page = 0, size = 20, expand, signal } = {}) {
    const sz = clampSize(size)
    if (!q || !q.trim()) return empty(q, page, sz)
    return run(q, { types, size: sz, expand, cursor, page, signal })
  },
}
