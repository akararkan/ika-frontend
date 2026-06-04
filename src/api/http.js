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
      if (v !== undefined && v !== null && v !== '') usp.append(k, v)
    }
    const qs = usp.toString()
    if (qs) url += (url.includes('?') ? '&' : '?') + qs
  }
  return url
}

async function parseError(res) {
  let body = null
  const text = await res.text().catch(() => '')
  if (text) { try { body = JSON.parse(text) } catch { /* bare / non-json body */ } }

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

export async function request(method, path, opts = {}) {
  const { body, query, headers = {}, multipart = false, signal, _retried = false } = opts

  const finalHeaders = { Accept: 'application/json', ...headers }
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
  })

  if (res.ok) {
    if (res.status === 204) return null
    const text = await res.text()
    if (!text) return null
    try { return JSON.parse(text) } catch { return text }   // some endpoints return plain string
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
}
