/* =========================================================
   Security service — /api/v1/security + /api/v1/auth/otp
   Sessions & devices, TOTP 2FA + recovery codes, login
   history, step-up re-auth, phone binding, public OTP.

   Step-up contract: guarded actions (disable 2FA, regenerate
   recovery codes) answer 403 with errorCode STEP_UP_REQUIRED
   when the short-lived marker isn't armed. Arm it with
   security.stepUp({password}) or ({code}), then retry —
   `withStepUp` below packages that dance for the panels.
   ========================================================= */
import { http } from './http.js'

const page = (res, map = (x) => x) => ({
  items: (res?.content || res || []).map(map),
  total: res?.totalElements ?? null,
  hasMore: res ? !res.last : false,
})

export const OTP_PURPOSES = ['LOGIN', 'PHONE_VERIFY', 'PHONE_CHANGE', 'EMAIL_CHANGE', 'PASSWORD_RESET', 'STEP_UP']

export const security = {
  /* ---- sessions (Active Sessions = refresh_tokens) ---- */
  sessions: {
    list() { return http.get('/api/v1/security/sessions') },                    // [{sid,deviceName,platform,ip,lastSeenAt,createdAt,trusted}]
    revoke(sid) { return http.del(`/api/v1/security/sessions/${sid}`) },        // 204; 404 SESSION_NOT_FOUND (incl. not-yours)
    trust(sid, days = 30) { return http.post(`/api/v1/security/sessions/${sid}/trust`, { days }) },  // 204, clamps 1..90
  },

  /* ---- two-factor (RFC 6238 TOTP) ---- */
  twofa: {
    setup() { return http.post('/api/v1/security/2fa/setup') },                 // {provisioningUri, secret} — shown ONCE; 409 TWO_FA_ALREADY_ON
    verify(code) { return http.post('/api/v1/security/2fa/verify', { code }) }, // {codes:[…10]} on first enable, [] on re-verify
    disable() { return http.post('/api/v1/security/2fa/disable') },             // 204 — STEP-UP REQUIRED
    status() { return http.get('/api/v1/security/2fa/status') },                // {enabled, recoveryCodesRemaining}
    regenerateRecovery() { return http.post('/api/v1/security/recovery-codes/regenerate') },  // {codes} — STEP-UP REQUIRED
  },

  /* ---- login history (Spring Page, ts DESC) ---- */
  async loginHistory(opts) {
    return page(await http.get('/api/v1/security/login-history', opts))         // [{ip,userAgent,method,outcome,ts}]
  },

  /* ---- step-up ---- */
  /** Arm the step-up window with a fresh password OR a TOTP code.
   *  Success → 204. Wrong password → 400 STEP_UP_BAD_PASSWORD; a bad code or
   *  empty body comes back as a BARE 400 (no error envelope). */
  stepUp({ password, code } = {}) {
    return http.post('/api/v1/security/step-up', { password: password || undefined, code: code || undefined })
  },

  /** Run a step-up-guarded action: try it, and when the server answers
   *  403 STEP_UP_REQUIRED, ask the caller to collect credentials (via
   *  `challenge()` → {password} | {code} | null to abort), arm, retry once.
   *  Panels pass a small prompt-dialog as `challenge`. */
  async withStepUp(action, challenge) {
    try { return await action() }
    catch (e) {
      if (e?.status !== 403 || e?.code !== 'STEP_UP_REQUIRED') throw e
      const cred = await challenge()
      if (!cred) { const err = new Error('Cancelled'); err.cancelled = true; throw err }
      await security.stepUp(cred)                                              // wrong credential throws out of here
      return action()
    }
  },

  /* ---- phone binding (logged-in) ---- */
  phone: {
    request(phone) { return http.post('/api/v1/security/phone/request', { phone }) },          // 202; 400 PHONE_INVALID; 429
    verify(phone, code) { return http.post('/api/v1/security/phone/verify', { phone, code }) },// {verified:true, phone:E.164}; 400 OTP_INVALID
  },

  /* ---- public OTP (/api/v1/auth/otp, permitAll) ---- */
  otp: {
    /** Enumeration-safe: ALWAYS 202 {status:'ACCEPTED'}, even on rate limit. */
    request(phone, purpose = 'LOGIN') { return http.post('/api/v1/auth/otp/request', { phone, purpose }) },
    verify(phone, code, purpose = 'LOGIN') { return http.post('/api/v1/auth/otp/verify', { phone, code, purpose }) },  // {verified,phone}
  },
}
