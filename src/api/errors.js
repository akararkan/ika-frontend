/* =========================================================
   Error taxonomy — the client half of frontend-error-handling.md.

   The three rules (§1.1):
     1. Branch on `err.code`, never on message text.
     2. 4xx messages are complete, user-safe sentences — display them.
     3. Keep the traceId — log it, quote it in support flows.

   Everything here is pure and dependency-free so any layer
   (api modules, components, hooks) can import it without
   cycles. http.js calls logApiError() at its throw sites, so
   every failed request self-reports once, with its traceId —
   callers never need their own console line.
   ========================================================= */

/** Machine code of any thrown error ('' when absent, so endsWith is safe).
 *  Treat this — never message text — as the switch input. */
export function codeOf(e) { return String(e?.code || '') }

/** details map of the envelope (retryAfterSeconds, maxSize, field, hint, …). */
export function detailsOf(e) { return e?.details || e?.payload?.details || null }

/* ---------- families (suffix contracts, §2.5 / §2.6) ---------- */

/** 404 family — the entity is gone (deleted, or the link is stale).
 *  Render a quiet "no longer available" state, NOT an error toast. */
export function isNotFound(e) { return e?.status === 404 || codeOf(e).endsWith('_NOT_FOUND') }

/** 409 uniqueness family (USER_DUPLICATE, EMAIL_DUPLICATE, …) —
 *  mark the offending input inline, don't toast. */
export function isDuplicate(e) { return codeOf(e).endsWith('_DUPLICATE') }

/** Which input collided ('username', 'email', …) — from details.field. */
export function duplicateField(e) { return detailsOf(e)?.field || null }

/** 409 concurrent-edit family — someone changed the same row. The recovery is
 *  re-fetch fresh state, then retry the mutation or ask the user to review.
 *  Not a server fault, and the server's message is written to be shown. */
export function isConflict(e) {
  const c = codeOf(e)
  return c === 'OPTIMISTIC_LOCK_CONFLICT' || c === 'RESOURCE_CONFLICT' || c === 'DATA_INTEGRITY_VIOLATION'
}

/** 429 — both RATE_LIMITED (burst) and MEDIA_QUOTA_EXCEEDED (daily budget). */
export function isRateLimited(e) { return e?.status === 429 }

/** 403 STEP_UP_REQUIRED — NOT a permission failure: the user is allowed, they
 *  just have to re-prove presence. http.js + <StepUpHost/> handle this
 *  globally (arm → replay), so most callers never see it. */
export function isStepUp(e) { return e?.status === 403 && codeOf(e) === 'STEP_UP_REQUIRED' }

/** 503s that are transient BY CONTRACT (§2.9) — the datastore / object storage
 *  didn't answer. "Temporary problem, try again"; one delayed automatic retry
 *  is reasonable for reads. */
export function isTransient(e) {
  const c = codeOf(e)
  return e?.status === 503 || c === 'DATASTORE_UNAVAILABLE' || c === 'STORAGE_UNAVAILABLE'
}

/** fetch() itself failed — offline, DNS, CORS. There is no envelope to read. */
export function isNetworkError(e) { return !!e && e.status == null && e.name !== 'AbortError' }

/** The request never happened right — OUR bug, not the user's (§2.4 tail).
 *  Log loudly, show a generic apology, and fix the call site. */
const CLIENT_BUG_CODES = new Set(['MALFORMED_JSON', 'MISSING_PARAMETER', 'MISSING_REQUEST_PART', 'TYPE_MISMATCH', 'ENDPOINT_NOT_FOUND'])
export function isClientBug(e) { return CLIENT_BUG_CODES.has(codeOf(e)) }

/** TYPE_MISMATCH whose value was the literal 'undefined' / 'null' — a
 *  component templated an unhydrated variable into a URL
 *  (/api/v1/posts/undefined). The fix is a guard at the call site. */
export function isUnhydratedParam(e) {
  return codeOf(e) === 'TYPE_MISMATCH' && detailsOf(e)?.hint === 'frontend_path_param_unhydrated'
}

/** 400 fat-finger guard on admin announcements (§2.7). Flow: show a confirm
 *  dialog quoting err.message (it interpolates the audience size), and on
 *  confirm resend the IDENTICAL body with confirmLargeAudience:true. Never
 *  set the flag by default — that defeats the guard. */
export function needsLargeAudienceConfirm(e) { return codeOf(e) === 'LARGE_AUDIENCE_CONFIRMATION_REQUIRED' }

/* ---------- rate-limit countdowns (§2.3) ---------- */

/** Seconds a surface should disable its submit control after a 429.
 *  RATE_LIMITED carries details.retryAfterSeconds; MEDIA_QUOTA_EXCEEDED
 *  carries details.resetsAt (midnight UTC). 0 when not rate-limited.
 *  UI contract: countdown + kept draft — never a dead end, never auto-retry. */
export function cooldownSecondsFrom(e) {
  if (!isRateLimited(e)) return 0
  if (typeof e?.retryAfterSeconds === 'number' && e.retryAfterSeconds > 0) return Math.ceil(e.retryAfterSeconds)
  const resetsAt = detailsOf(e)?.resetsAt
  if (resetsAt) {
    const ms = Date.parse(resetsAt) - Date.now()
    if (Number.isFinite(ms) && ms > 0) return Math.ceil(ms / 1000)
  }
  return 5
}

/* ---------- validation (§2.4) ---------- */

/** fieldErrors[] → { field: message } for inline form rendering. `rename`
 *  maps server DTO field names onto the form's own input keys. Always safe:
 *  {} when the envelope carried no fieldErrors (one Spring variant doesn't —
 *  fall back to the top-level message as a form-level error). */
export function fieldErrorMap(e, rename = {}) {
  const out = {}
  for (const fe of e?.fieldErrors || []) {
    const key = rename[fe.field] ?? fe.field
    if (key && fe.message && !out[key]) out[key] = fe.message
  }
  return out
}

/* ---------- display + logging (§1.1, §2.9) ---------- */

export function traceRef(e) { return e?.traceId || null }

const OFFLINE_COPY = 'Could not reach the server — check your connection and try again.'

/** The generic display policy: 4xx → the server's message (guaranteed
 *  user-safe); 5xx → the message is deliberately generic, pair it with a short
 *  trace ref; no response at all → offline copy. Use this as the default arm
 *  of any error switch instead of hardcoding copy the backend already sends. */
export function errorText(e, fallback = 'Something went wrong. Please try again.') {
  if (!e) return fallback
  if (isNetworkError(e)) return OFFLINE_COPY
  const msg = e.message || fallback
  if (e.status >= 500 && e.traceId) return `${msg} (ref ${String(e.traceId).slice(0, 8)})`
  return msg
}

/** One structured console line per failed request — the greppable half of the
 *  server's own trace-id log line. http.js calls this at every throw site;
 *  client-bug families get an extra, actionable line. */
export function logApiError(e, method = '', path = '') {
  if (!e || e.name === 'AbortError' || typeof console === 'undefined') return
  const where = [method, path || e?.payload?.path].filter(Boolean).join(' ')
  console.error(`[api] ${e.status ?? 'network'} ${codeOf(e) || 'UNKNOWN'}${e.traceId ? ` trace=${e.traceId}` : ''} ${where}`.trim())
  if (isUnhydratedParam(e)) {
    const d = detailsOf(e) || {}
    console.error(`[api] BUG: parameter '${d.parameter || '?'}' was the JS literal '${d.receivedValue}' — a component fetched before its variable was hydrated. Guard the call site (e.g. \`if (!id) return\`).`)
  } else if (isClientBug(e)) {
    console.error('[api] BUG: this code family (MALFORMED_JSON / MISSING_PARAMETER / MISSING_REQUEST_PART / TYPE_MISMATCH / ENDPOINT_NOT_FOUND) means the frontend built a bad request — fix the call site, don\'t surface it to the user.')
  }
}
