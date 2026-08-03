/* =========================================================
   Integration gaps — routes no domain claimed.
   ---------------------------------------------------------
   Registered LAST, so nothing here can shadow a domain
   handler. When a route in this file properly belongs to a
   domain, move it there and delete it from here.

   Each entry says WHY it ended up homeless, because "nobody
   claimed it" is usually a sign the ownership boundary is in
   the wrong place, not that the endpoint is unimportant.
   ========================================================= */
import { NO_CONTENT } from '../util.js'

/* Email preferences (USER_API §16) sit on /users/me/* but are rendered by the
   Settings > Emails tab, so the users agent read them as settings and the
   settings agent read them as users. They are a real, separate backend from
   the notification matrix — which is exactly the confusion the Settings copy
   now explains. */
function emailPrefs(db) {
  if (!db._emailPrefs) {
    db._emailPrefs = { master: true, social: true, mentions: true, system: true, trending: false }
  }
  return db._emailPrefs
}

export const routes = [
  {
    m: 'GET',
    p: /^\/api\/v1\/users\/me\/email-preferences$/,
    fn: (db) => emailPrefs(db),
  },
  {
    m: 'PATCH',
    p: /^\/api\/v1\/users\/me\/email-preferences$/,
    fn: (db, { body }) => Object.assign(emailPrefs(db), body || {}),
  },
  {
    m: 'POST',
    p: /^\/api\/v1\/users\/me\/email-preferences\/test$/,
    fn: (db) => ({ queued: true, to: db.me?.email || 'you@example.org' }),
  },
  {
    m: 'POST',
    p: /^\/api\/v1\/users\/me\/email-preferences\/unsubscribe-all$/,
    fn: (db) => {
      const p = emailPrefs(db)
      for (const k of Object.keys(p)) p[k] = false
      return NO_CONTENT
    },
  },
]
