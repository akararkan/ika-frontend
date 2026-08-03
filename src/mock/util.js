/* =========================================================
   Mock helpers — the shapes the real backend answers with.
   ---------------------------------------------------------
   Handlers must return WIRE shapes (the Java DTO), never UI
   shapes: every response still passes through src/api/adapters.js
   exactly as a real one does. That is the whole point — mock
   mode exercises the real parsing path, so a fixture that is
   wrong in the same way a backend change would be wrong still
   breaks the screen, and you find out here instead of in prod.
   ========================================================= */

/** Spring `Page<T>` — what every paged endpoint on this backend returns. */
export function page(items, { page: p = 0, size = 20 } = {}) {
  const start = p * size
  const content = items.slice(start, start + size)
  return {
    content,
    totalElements: items.length,
    totalPages: Math.max(1, Math.ceil(items.length / size)),
    number: p,
    size,
    first: p === 0,
    last: start + size >= items.length,
    numberOfElements: content.length,
    empty: content.length === 0,
  }
}

/** Read Spring's paging params off a query object (page/size, or limit). */
export function paging(query = {}) {
  const size = Number(query.size ?? query.limit ?? query.pageSize ?? 20) || 20
  return { page: Number(query.page ?? 0) || 0, size }
}

/** A cursor page (the search / feed stream shape). */
export function cursorPage(items, query = {}, key = 'id') {
  const size = Number(query.limit ?? query.size ?? 20) || 20
  const cursor = query.cursor && query.cursor !== 'head' ? query.cursor : null
  const from = cursor ? items.findIndex(i => String(i[key]) === String(cursor)) + 1 : 0
  const slice = items.slice(from, from + size)
  const next = from + size < items.length ? String(slice[slice.length - 1]?.[key] ?? '') : null
  return { items: slice, hits: slice, content: slice, nextCursor: next, hasMore: !!next }
}

/** 204 No Content — `request()` returns null for these. */
export const NO_CONTENT = null

/** Throw the same envelope the real client parses (see ApiError in http.js). */
export function mockError(status, code, message) {
  const err = new Error(message || code)
  err.__mockStatus = status
  err.__mockBody = { errorCode: code, message: message || code, traceId: 'mock-trace' }
  return err
}

/** Deterministic pseudo-random in [0,1) from a string — stable across reloads,
 *  so counts and orderings do not jitter every time a component re-renders. */
export function seeded(str) {
  let h = 2166136261
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

/** An ISO instant N minutes ago, in the backend's strict LocalDateTime shape
 *  (`yyyy-MM-dd'T'HH:mm:ss.SSS'Z'` — see JacksonConfig; the Z is a literal). */
export function agoIso(minutes) {
  const d = new Date(Date.now() - minutes * 60_000)
  return d.toISOString().replace(/\.(\d{3})Z$/, '.$1Z')
}

/** Resolve `{ en, ar, ku, tr }` to a single string for the active locale,
 *  falling back to English. Fixtures store all four; the wire carries one. */
export function loc(value, lang = 'en') {
  if (value == null) return value
  if (typeof value === 'string') return value
  return value[lang] ?? value.en ?? Object.values(value)[0] ?? ''
}

/** Deep-resolve every {en,ar,ku,tr} node in a fixture object. */
export function localize(node, lang = 'en') {
  if (node == null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(n => localize(n, lang))
  const keys = Object.keys(node)
  if (keys.length && keys.every(k => ['en', 'ar', 'ku', 'tr'].includes(k))) return loc(node, lang)
  const out = {}
  for (const k of keys) out[k] = localize(node[k], lang)
  return out
}
