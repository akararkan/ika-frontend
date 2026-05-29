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

export const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

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
