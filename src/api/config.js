/* =========================================================
   API configuration & session/token storage
   ---------------------------------------------------------
   The app always talks to the real backend.

   - Set VITE_API_BASE_URL to your backend origin (the client
     calls it directly; the backend must allow CORS), OR
   - leave it empty and use a dev proxy (set VITE_DEV_PROXY in
     vite.config) / serve the frontend behind the same gateway,
     in which case requests go to relative `/api/v1/...`.
   ========================================================= */

/* Resolve the backend origin defensively.
   Priority:
     1. An explicit VITE_API_BASE_URL — UNLESS it's a localhost value baked into
        a deployed (non-localhost) build. That combination is always a build-time
        misconfiguration (e.g. a stale `VITE_API_BASE_URL=http://localhost:8080`
        left in the Vercel project env), so we ignore it rather than ship a site
        that calls the developer's laptop.
     2. Deployed with no usable base → talk to the Railway backend directly.
        (Needs CORS for this origin on the backend; SSE uses ?token= so it works
        without cross-site cookies.)
     3. Local dev with no base → empty string = relative /api/... URLs, so the
        Vite dev proxy (VITE_DEV_PROXY) forwards them. */
const PROD_API_FALLBACK = 'https://irc-bakend-production.up.railway.app'
const isLocalHost = (h) => /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h || '')

function resolveApiBase() {
  const raw = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
  const pageIsLocal = typeof location !== 'undefined' && isLocalHost(location.hostname)
  const rawIsLocal = /localhost|127\.0\.0\.1/.test(raw)
  if (raw && !(rawIsLocal && !pageIsLocal)) return raw   // honour a real base (incl. localhost during local dev)
  if (!pageIsLocal) return PROD_API_FALLBACK             // deployed but no usable base → Railway direct
  return ''                                              // local dev → relative URLs (Vite proxy)
}

export const API_BASE = resolveApiBase()

/* Resolve a backend asset path to a URL the browser can load directly.
   The backend returns RELATIVE media URLs (e.g. "/api/v1/media/…"); used
   raw in <video>/<img> they'd resolve against the frontend origin (which
   serves index.html → "no supported video format"). Prefix API_BASE so
   they hit the backend. Absolute/data/blob URLs pass through unchanged.
   When API_BASE is empty (dev-proxy mode) the relative path is kept so
   Vite's /api proxy can forward it. */
export function assetUrl(u) {
  if (!u || /^(https?:|data:|blob:)/i.test(u)) return u
  return (API_BASE || '') + (u.startsWith('/') ? u : '/' + u)
}

/* ---------- JWT / session storage ---------- */
const TOKEN_KEY = 'ika_token'
const USER_KEY = 'ika_user'

export const session = {
  getToken() { return localStorage.getItem(TOKEN_KEY) || '' },
  setToken(t) { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY) },
  getUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null') } catch { return null }
  },
  setUser(u) { u ? localStorage.setItem(USER_KEY, JSON.stringify(u)) : localStorage.removeItem(USER_KEY) },
  clear() {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
  },
  isAuthed() { return !!localStorage.getItem(TOKEN_KEY) },
}
