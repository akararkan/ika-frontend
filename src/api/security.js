/* =========================================================
   Security service — /api/v1/security + /api/v1/auth/otp
   Sessions & devices, TOTP 2FA + recovery codes, login
   history, step-up re-auth, phone binding, public OTP.

   Step-up contract: guarded actions (ENABLE 2FA, disable 2FA,
   regenerate recovery codes) answer 403 with errorCode
   STEP_UP_REQUIRED when the short-lived marker isn't armed. Arm
   it with security.stepUp({password}) or ({code}), then retry —
   `withStepUp` below packages that dance for the panels.
   `/2fa/setup` joined that list deliberately: binding a new
   authenticator is as sensitive as removing one, so a stolen
   session cannot enrol its own device and lock the owner out.

   2FA IS NOW A LOGIN GATE, not just a step-up factor. A correct
   password on a 2FA account issues nothing and returns an
   mfaToken — see api/auth.js `login` / `loginTwoFactor` for the
   two-leg contract, and note the consequences here:
     · recovery codes are REDEEMABLE (at leg 2, in the same field
       as the TOTP code), so the "save these" copy is a promise
       the backend now keeps;
     · login_events is written for real on both success and
       failure paths, so login-history is a live audit trail
       rather than a permanently empty page.
   ========================================================= */
import { http } from './http.js'

/* login_events.method / .outcome — the exact strings AuthServiceImpl writes
   (`method` is varchar(20), which is why the recovery value is PASSWORD+RECOVERY
   and not …+RECOVERY_CODE). PASSWORD+RECOVERY is the row worth surfacing
   loudly: someone signed in without the authenticator. */
export const LOGIN_METHOD_LABELS = {
  PASSWORD: 'Password',
  'PASSWORD+TOTP': 'Password + authenticator',
  'PASSWORD+RECOVERY': 'Password + recovery code',
  'PASSWORD+2FA': 'Password + second factor',
}
export const LOGIN_OUTCOME_LABELS = {
  SUCCESS: 'Signed in',
  FAILED: 'Failed',
  MFA_REQUIRED: 'Awaiting second factor',
}
/** Sign-ins that deserve the user's attention in the history list. */
export const NOTEWORTHY_LOGIN_METHODS = new Set(['PASSWORD+RECOVERY'])

const page = (res, map = (x) => x) => ({
  items: (res?.content || res || []).map(map),
  total: res?.totalElements ?? null,
  hasMore: res ? !res.last : false,
})

export const OTP_PURPOSES = ['LOGIN', 'PHONE_VERIFY', 'PHONE_CHANGE', 'EMAIL_CHANGE', 'PASSWORD_RESET', 'STEP_UP']

export const security = {
  /* ---- sessions (Active Sessions = refresh_tokens) ----
     The login path persists only user/token/expiresAt, so of the seven
     SessionResponse fields only `createdAt` and `trusted` arrive populated —
     sid included. Callers must not key rows on sid, and must not offer the two
     sid-addressed actions when it is missing. */
  sessions: {
    list() { return http.get('/api/v1/security/sessions') },                    // [{sid,deviceName,platform,ip,lastSeenAt,createdAt,trusted}] — see above
    revoke(sid) { return http.del(`/api/v1/security/sessions/${sid}`) },        // 204; 404 SESSION_NOT_FOUND (incl. not-yours)
    trust(sid, days = 30) { return http.post(`/api/v1/security/sessions/${sid}/trust`, { days }) },  // 204, clamps 1..90; trusted_until is written but read by no auth path
  },

  /* ---- two-factor (RFC 6238 TOTP) ---- */
  twofa: {
    setup() { return http.post('/api/v1/security/2fa/setup') },                 // {provisioningUri, secret} — shown ONCE; STEP-UP REQUIRED; 409 TWO_FA_ALREADY_ON
    verify(code) { return http.post('/api/v1/security/2fa/verify', { code }) }, // {codes:[…10]} on first enable, [] on re-verify
    disable() { return http.post('/api/v1/security/2fa/disable') },             // 204 — STEP-UP REQUIRED; also clears recovery codes
    status() { return http.get('/api/v1/security/2fa/status') },                // {enabled, recoveryCodesRemaining}
    regenerateRecovery() { return http.post('/api/v1/security/recovery-codes/regenerate') },  // {codes} — STEP-UP REQUIRED; invalidates the previous set
  },

  /* ---- login history (Spring Page, ts DESC) ----
     Live: every attempt is recorded, and the FAILED rows land for real (they
     are written in their own transaction — with ordinary propagation the row
     was rolled back by the very exception it documented). Rows carry
     {ip, userAgent, method, outcome, ts} — see LOGIN_METHOD_LABELS above. */
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
   *  Panels pass a small prompt-dialog as `challenge`.
   *
   *  NOTE: http.js now runs this dance GLOBALLY via <StepUpHost/> — when that
   *  host is mounted the action just succeeds and this wrapper never fires.
   *  It survives for two cases: the host was cancelled (err.stepUpCancelled —
   *  translate to the cancel shape, never prompt a SECOND time), and callers
   *  running outside the shell where no host is registered. */
  async withStepUp(action, challenge) {
    try { return await action() }
    catch (e) {
      if (e?.stepUpCancelled) { const err = new Error('Cancelled'); err.cancelled = true; throw err }
      if (e?.status !== 403 || e?.code !== 'STEP_UP_REQUIRED') throw e
      const cred = await challenge()
      if (!cred) { const err = new Error('Cancelled'); err.cancelled = true; throw err }
      await security.stepUp(cred)                                              // wrong credential throws out of here
      return action()
    }
  },

  /* ---- phone binding (logged-in) ----
     Write-only for reads: verify stores phoneE164/phoneVerifiedAt on the User,
     but no response DTO exposes them and there is no GET here — a bound number
     cannot be read back, so panels can only show what they verified this
     session.

     What verifying now BUYS, which it did not before: clearing OTP writes the
     unkeyed IDENTITY_PHONE hash (sha256 of the E.164 without the '+'), which is
     what makes the account matchable by people who have the number in their
     address book. `users.phone_hmac` is a keyed HMAC and is NOT what matching
     joins on — a client hashes locally and can never reproduce a pepper.
     One number, one account: a number already verified elsewhere is refused
     with 409 PHONE_ALREADY_BOUND. */
  phone: {
    request(phone) { return http.post('/api/v1/security/phone/request', { phone }) },          // 202; 400 PHONE_INVALID; 429
    verify(phone, code) { return http.post('/api/v1/security/phone/verify', { phone, code }) },// {verified:true, phone:E.164}; 400 OTP_INVALID; 409 PHONE_ALREADY_BOUND
  },

  /* ---- public OTP (/api/v1/auth/otp, permitAll) ---- */
  otp: {
    /** Enumeration-safe: ALWAYS 202 {status:'ACCEPTED'}, even on rate limit. */
    request(phone, purpose = 'LOGIN') { return http.post('/api/v1/auth/otp/request', { phone, purpose }) },
    verify(phone, code, purpose = 'LOGIN') { return http.post('/api/v1/auth/otp/verify', { phone, code, purpose }) },  // {verified,phone}
  },
}
