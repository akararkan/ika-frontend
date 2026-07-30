/* =========================================================
   Core HTTP client
   - Attaches `Authorization: Bearer <jwt>` (and sends cookies)
   - Parses BOTH backend error-envelope shapes:
       Posts:        { errorCode, message, fieldErrors, traceId, ... }
       QnA/Research: { error, message, path, ... }  (error = code)
   - Handles "bare-body" responses (401/403/404 with no JSON)
   - Returns parsed JSON, or null for 204 No Content
   ========================================================= */
import { API_BASE, session } from './config.js'

/* ---------- big-integer-safe JSON ----------
   Message ids are Snowflakes — 18-digit longs, an order of magnitude ABOVE
   Number.MAX_SAFE_INTEGER (9007199254740991). `JSON.parse` turns them into
   doubles, and the double's shortest decimal form is a DIFFERENT integer:
   355456387759665152 comes back out of `String(n)` as 355456387759665150,
   which the backend answers with 404. Ids are identity, never arithmetic, so
   every integer too large to survive the round trip is kept as its exact
   decimal STRING and compared with the helpers in ./ids.js.

   The alternation consumes whole string literals first, so digits inside a
   string are never touched, and a number is only quoted when it is preceded
   by a JSON delimiter (`:`/`,`/`[`/space) — which is why the fractional part
   of `1.2345678901234567` can't be mistaken for an id. */
const BIG_INT_RE = /"(?:\\.|[^"\\])*"|([:,[\s])(-?\d{16,})(?![\d.eE])/g

function quoteBigInts(text) {
  return text.replace(BIG_INT_RE, (whole, lead, digits) => {
    if (digits === undefined) return whole                       // a string literal — leave it alone
    return Number.isSafeInteger(Number(digits)) ? whole : `${lead}"${digits}"`
  })
}

/** JSON.parse that never silently rounds a Snowflake. Exported because the
 *  SSE stream parses its own frames and must agree with the REST layer. */
export function parseJson(text) {
  return JSON.parse(quoteBigInts(text))
}

export class ApiError extends Error {
  constructor(status, code, message, payload) {
    super(message || code || `HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.code = code || null          // machine-readable code (errorCode OR error)
    this.payload = payload || null    // full parsed body when present
    this.fieldErrors = payload?.fieldErrors || null
    this.traceId = payload?.traceId || null
    this.retryAfterSeconds = payload?.retryAfterSeconds ?? null   // 429 rate-limit (REALTIME guide §10)
    this.action = payload?.action ?? null                         // which write path was throttled
  }
}

/* Minimal toast poke — replicated here (not imported from ui.jsx) to avoid an
   api→ui circular import. Surfaces a friendly "slow down" on 429s app-wide. */
let _toastTimer
function flashToast(msg) {
  if (typeof document === 'undefined') return
  const el = document.getElementById('toast')
  if (!el) return
  const m = el.querySelector('.tmsg'); if (m) m.textContent = msg
  el.classList.add('show')
  clearTimeout(_toastTimer)
  _toastTimer = setTimeout(() => el.classList.remove('show'), 2600)
}

function buildUrl(path, query) {
  const base = API_BASE || ''
  let url = path.startsWith('http') ? path : base + path
  if (query && Object.keys(query).length) {
    const usp = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue
      /* An array becomes a REPEATABLE param (?type=A&type=B) — the Spring
         convention for multi-value filters. append(k, array) would join with
         commas, which the server reads as one (invalid) enum value. */
      if (Array.isArray(v)) { for (const item of v) { if (item != null && item !== '') usp.append(k, item) } }
      else usp.append(k, v)
    }
    const qs = usp.toString()
    if (qs) url += (url.includes('?') ? '&' : '?') + qs
  }
  return url
}

async function parseError(res) {
  let body = null
  const text = await res.text().catch(() => '')
  if (text) { try { body = parseJson(text) } catch { /* bare / non-json body */ } }

  // 429 can arrive as a JSON envelope OR a bare proxy/edge body that only carries a
  // `Retry-After` header — handle both so the friendly message + cooldown seconds work
  // regardless of who throttled the request (REALTIME guide §10).
  if (res.status === 429) {
    const hdr = parseInt(res.headers.get('Retry-After') || '', 10)
    const retry = (body && typeof body.retryAfterSeconds === 'number') ? body.retryAfterSeconds
      : (Number.isFinite(hdr) ? hdr : null)
    const message = (body && body.message) || `Slow down — try again in ${retry ?? 5}s`
    const err = new ApiError(429, (body && (body.errorCode || body.error)) || 'RATE_LIMITED', message, body)
    if (retry != null) err.retryAfterSeconds = retry
    if (body && body.action) err.action = body.action
    return err
  }

  if (body && typeof body === 'object') {
    // Posts envelope uses `errorCode`; QnA/Research use `error` as the code.
    const code = body.errorCode || body.error || null
    const message = body.message || (typeof body.error === 'string' ? body.error : null)
    return new ApiError(res.status, code, message, body)
  }
  // Bare-body (no JSON) — common for Posts 401/403/404.
  const fallback = {
    401: 'You need to sign in to do that.',
    403: 'You do not have permission to do that.',
    404: 'Not found.',
  }[res.status] || `Request failed (${res.status})`
  return new ApiError(res.status, null, fallback, null)
}

/* ---------- 401 auto-refresh-and-retry (USER_API §18.2) ----------
   When the 1-hour access token expires, transparently rotate it via
   POST /auth/refresh and retry the original request ONCE. Concurrent
   401s share a single in-flight refresh (no stampede). A revoked token
   or a failed refresh is terminal → clear the session and signal the
   app to route to login. */
let refreshing = null

function isAuthPath(path) { return path.includes('/api/v1/auth/') }   // never refresh-retry the auth calls themselves

function refreshOnce() {
  if (!refreshing) refreshing = doRefresh().finally(() => { refreshing = null })
  return refreshing
}

async function doRefresh() {
  try {
    const res = await fetch(buildUrl('/api/v1/auth/refresh'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{}',                            // refresh token comes from the HttpOnly cookie (or this body if present)
      credentials: 'include',
    })
    if (!res.ok) return false
    const data = await res.json().catch(() => null)
    if (data?.accessToken) { session.setToken(data.accessToken); return true }   // Bearer beats cookie (§2) — must adopt the fresh one
    return false
  } catch { return false }
}

function endSession() {
  session.clear()
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('ika:auth-expired'))   // AuthProvider → setUser(null) → RequireAuth redirects
}

/** `attachment; filename="2026-07-27_09-15-03.mp4"` → the bare filename.
 *  RFC 5987's `filename*=UTF-8''…` wins when present (it is the one that can
 *  carry non-ASCII). Returns '' when the header says nothing useful. */
function filenameFrom(disposition) {
  const d = String(disposition || '')
  const ext = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(d)
  if (ext) { try { return decodeURIComponent(ext[1].trim().replace(/^"|"$/g, '')) } catch { /* fall through */ } }
  const plain = /filename="?([^";]+)"?/i.exec(d)
  return plain ? plain[1].trim() : ''
}

export async function request(method, path, opts = {}) {
  const { body, query, headers = {}, multipart = false, signal, keepalive = false, as = 'json', _retried = false } = opts

  /* `as: 'blob'` is for authed BINARY downloads (the live-stream recording).
     It must go through this function rather than an <a href> or a bare fetch:
     the download is Bearer-authed, so a plain link sends no token, and going
     around `request` would also skip the 401→refresh→retry recovery — which is
     exactly what a long-open page hitting a rotated token needs. Note the
     failure path is unchanged: a non-ok response is still parsed as an error
     envelope (a missing recording answers 404 with JSON, not with bytes). */
  const finalHeaders = { Accept: as === 'blob' ? '*/*' : 'application/json', ...headers }
  const token = session.getToken()
  if (token) finalHeaders.Authorization = `Bearer ${token}`

  let payload
  if (multipart) {
    payload = body                          // FormData — let the browser set boundary
  } else if (body !== undefined) {
    finalHeaders['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }

  const res = await fetch(buildUrl(path, query), {
    method,
    headers: finalHeaders,
    body: payload,
    credentials: 'include',                 // send the access_token cookie too
    signal,
    /* `keepalive` lets a request outlive the document — the only way to land a
       "I'm leaving" call from a `pagehide` handler, where an ordinary fetch is
       cancelled as the tab goes away. Preferred over navigator.sendBeacon
       because that cannot set an Authorization header. Browsers cap the total
       keepalive body at 64 KB, so only use it for small, fire-and-forget
       writes. A failure here is unobservable by design. */
    keepalive: keepalive || undefined,
  })

  if (res.ok) {
    if (res.status === 204) return null
    if (as === 'blob') {
      return {
        blob: await res.blob(),
        filename: filenameFrom(res.headers.get('content-disposition')),
        type: res.headers.get('content-type') || '',
      }
    }
    const text = await res.text()
    if (!text) return null
    try { return parseJson(text) } catch { return text }   // some endpoints return plain string
  }

  const err = await parseError(res)

  // 429 rate-limit (REALTIME guide §10): surface a friendly "slow down" toast with
  // the server's retry hint. Callers can still read err.retryAfterSeconds / err.action
  // to disable the submit button during the cooldown.
  if (res.status === 429) {
    const secs = err.retryAfterSeconds ?? 5
    flashToast(err.message || `Slow down — try again in ${secs}s`)
    throw err
  }

  // Only attempt recovery when we believe we're signed in, on a non-auth path, once.
  if (res.status === 401 && token && !_retried && !isAuthPath(path)) {
    if (err.code === 'TOKEN_REVOKED') { endSession(); throw err }   // terminal — logged out elsewhere / token reused
    const ok = await refreshOnce()                                  // TOKEN_EXPIRED, UNAUTHORIZED, or bare-body 401 → try a refresh
    if (ok) return request(method, path, { ...opts, _retried: true })
    endSession(); throw err                                         // refresh failed → session is dead
  }

  throw err
}

export const http = {
  get:   (path, query, opts)        => request('GET', path, { query, ...opts }),
  post:  (path, body, opts)         => request('POST', path, { body, ...opts }),
  patch: (path, body, opts)         => request('PATCH', path, { body, ...opts }),
  put:   (path, body, opts)         => request('PUT', path, { body, ...opts }),
  del:   (path, opts)               => request('DELETE', path, opts),
  upload:(path, formData, opts)     => request('POST', path, { body: formData, multipart: true, ...opts }),
  /** Authed binary GET → `{ blob, filename, type }`. See the `as: 'blob'` note
   *  in `request`; use `saveBlob` below to actually put it on disk. */
  download:(path, query, opts)      => request('GET', path, { query, as: 'blob', ...opts }),
}

/** Hand a fetched blob to the browser's downloader.
 *  Kept next to `http.download` because the two are only ever used together:
 *  the object URL MUST be revoked or the blob is pinned in memory for the life
 *  of the document, and a whole recording is not a small leak. */
export function saveBlob({ blob, filename } = {}, fallbackName = 'download') {
  if (!blob || typeof document === 'undefined') return
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename || fallbackName
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Safari needs the URL alive until the click is actually processed.
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
