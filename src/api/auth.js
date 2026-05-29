/* =========================================================
   Auth service — /api/v1/auth  (per USER_API.md)
   Dual-channel tokens: the backend sets HttpOnly cookies AND
   returns accessToken/refreshToken in the body. We keep the
   accessToken for the Bearer header + SSE ?token= fallback.
   ========================================================= */
import { http } from './http.js'
import { session } from './config.js'
import { meFrom } from './adapters.js'

export const auth = {
  /**
   * Login (§8.2). The login identifier is the account's **username OR email** —
   * these are two distinct fields and the server resolves whichever is supplied.
   * We pass the raw identifier the user typed into the API's `username` field and
   * never coerce email→username or username→email.
   */
  async login({ identifier, username, email, password }) {
    const loginId = (identifier || username || email || '').trim()
    const res = await http.post('/api/v1/auth/login', { username: loginId, password })
    return storeAuth(res)
  },

  /** Register — splits a full name into fname/lname when needed. */
  async register({ fname, lname, full, handle, username, email, password }) {
    if ((!fname || !lname) && full) {
      const parts = full.trim().split(/\s+/)
      fname = fname || parts[0] || ''
      lname = lname || parts.slice(1).join(' ') || parts[0] || ''
    }
    const res = await http.post('/api/v1/auth/register', {
      fname, lname, username: username || handle, email, password,
    })
    return storeAuth(res)
  },

  /** Rotate tokens (cookie or stored refresh token). */
  async refresh() {
    const res = await http.post('/api/v1/auth/refresh', {})
    if (res?.accessToken) session.setToken(res.accessToken)
    return res
  },

  async me() {
    const raw = await http.get('/api/v1/users/me')
    if (raw) session.setUser(raw)
    return meFrom(raw)
  },

  async logout() {
    try { await http.post('/api/v1/auth/logout', {}) } catch { /* best-effort */ }
    session.clear()
  },

  /** Revoke EVERY session/device (§8.5) — used by "log out everywhere". */
  async logoutAll() {
    try { await http.post('/api/v1/auth/logout-all', {}) } catch { /* best-effort */ }
    session.clear()
  },

  async changePassword(currentPassword, newPassword) {
    const res = await http.post('/api/v1/auth/change-password', { currentPassword, newPassword })
    if (res?.accessToken) session.setToken(res.accessToken)
    return res
  },
}

/** Persist an AuthResponse (accessToken + user) and return the view user + token TTL. */
function storeAuth(res) {
  const token = res?.accessToken || res?.token || ''
  if (token) session.setToken(token)
  const user = res?.user || null
  if (user) session.setUser(user)
  return { token, user: meFrom(user), expiresIn: res?.expiresIn ?? null }   // expiresIn → proactive refresh scheduling (§18.2)
}
