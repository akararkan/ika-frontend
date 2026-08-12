/* =========================================================
   Auth service — /api/v1/auth  (per USER_API.md)
   Dual-channel tokens: the backend sets HttpOnly cookies AND
   returns accessToken/refreshToken in the body. We keep the
   accessToken for the Bearer header + SSE ?token= fallback.

   LOGIN IS TWO LEGS when the account has 2FA on:

     POST /auth/login       → {mfaRequired:true, mfaToken, expiresIn}
                              …and NOTHING else. No session, no
                              cookies, not even the user object.
     POST /auth/login/2fa   → {mfaToken, code} → the ordinary pair.

   `mfaRequired` is omitted entirely (never false) on an ordinary
   login, so presence is the branch. `code` takes EITHER the
   6-digit authenticator code or a single-use recovery code — the
   server tries TOTP first, then recovery, and the client must not
   pre-classify what was typed.

   The mfaToken is a credential: it lives in memory for the length
   of the sign-in and is never written to storage. It also cannot
   authenticate anything (the JWT filter rejects MFA_CHALLENGE),
   is single-use, and burns after 5 attempts — so a challenge that
   comes back MFA_CHALLENGE_INVALID / MFA_TOO_MANY_ATTEMPTS is
   gone for good and the user restarts from the password screen.
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
    /* Second factor owed: nothing to store. Hand the challenge back so the
       caller can collect a code — storeAuth here would persist a null token
       and leave the app half-signed-in. */
    if (res?.mfaRequired) {
      return { mfaRequired: true, mfaToken: res.mfaToken || '', expiresIn: res.expiresIn ?? 300, token: '', user: null }
    }
    return storeAuth(res)
  },

  /**
   * Second leg of a 2FA login (§3 of two-factor-authentication.md).
   * @param code the 6-digit authenticator code **or** a recovery code — send it
   *             as typed; the server decides which it is.
   * Throws with `code` MFA_CODE_INVALID (retryable, challenge survives),
   * MFA_TOO_MANY_ATTEMPTS / MFA_CHALLENGE_INVALID (challenge gone → password
   * screen). All three arrive as 401s, and http.js never refresh-retries an
   * /api/v1/auth/ path, so they surface here intact.
   */
  async loginTwoFactor({ mfaToken, code }) {
    const res = await http.post('/api/v1/auth/login/2fa', {
      mfaToken, code: String(code || '').trim(),
    })
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
