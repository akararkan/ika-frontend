/* =========================================================
   Desktop notifications — the DESKTOP column of the matrix,
   actually delivered.
   ---------------------------------------------------------
   NotificationChannel.DESKTOP defaults to ON server-side, but
   nothing server-side sends it: there is no desktop transport.
   The channel means "this client raises an OS notification
   while it is running", so the whole decision lives here.

   The gate has four parts, cheapest first:
     1. the browser supports Notification and permission is
        'granted' (a page can only ask from a user gesture, so
        Settings owns the prompt — see ensurePermission),
     2. the tab is NOT the one the user is looking at (an alert
        for something already on screen is just noise),
     3. the DESKTOP cell of the notification matrix for that
        type is not explicitly off,
     4. the user is not inside quiet hours / a hard mute.

   Steps 3–4 read `api.settings.notifications.prefs()`, one
   cached matrix + DND pair shared by every delivery path, so
   an SSE burst costs no extra requests.

   Failure is OPEN: an unreachable settings endpoint means the
   notification is shown. Nothing here is a privacy decision —
   the content is already in the user's own inbox — and a
   silent client is indistinguishable from a broken one.

   The DND math is a port of the server's DndEvaluator; both
   halves (this file and the settings panel) must agree, so
   `wallClockIn` lives here and the panel imports it.
   ========================================================= */
import { api, LOCKED_NOTIFICATION_TYPES } from '../api/index.js'

/** Dispatched instead of a hard navigation when a notification is clicked, so
 *  the router handles it in-place. Listeners: whoever owns navigation. */
export const NAVIGATE_EVENT = 'ika:navigate'

const ICON = '/ika-logo.png'

/* ---------- permission ---------- */

/** 'unsupported' | 'default' (never asked) | 'granted' | 'denied'. */
export function permissionState() {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  return Notification.permission
}

/** True when an OS notification would actually appear right now. */
export function canNotify() {
  return permissionState() === 'granted'
}

/** Ask for permission — MUST be called from a user gesture (Chrome and Safari
 *  both drop the prompt otherwise). Resolves to the resulting state; never
 *  throws, including on the older callback-only Safari signature. */
export async function ensurePermission() {
  const state = permissionState()
  if (state !== 'default') return state
  try {
    const res = await Notification.requestPermission()
    return res || permissionState()
  } catch {
    return permissionState()
  }
}

/* ---------- quiet hours (client-side port of DndEvaluator) ---------- */

const WALL_OPTS = {
  hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
}

/** A Date instant rendered as wall-clock time in `tz`, in the EXACT shape the
 *  backend's LocalDateTime deserializer accepts.
 *
 *  The server registers one strict global formatter for every LocalDateTime,
 *  `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'` (config/JacksonConfig.java), on BOTH the
 *  read and the write side. A bare 19-character 'YYYY-MM-DDTHH:mm:ss' fails to
 *  parse and the whole request 400s — so the `.000Z` tail is mandatory. The Z
 *  there is a LITERAL in the pattern, not a zone conversion: the value stays
 *  wall-clock in the DND timezone, which is how the server evaluates it. */
export function wallClockIn(date, tz) {
  let parts
  try { parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...WALL_OPTS }).formatToParts(date) }
  catch { parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', ...WALL_OPTS }).formatToParts(date) }
  const p = {}
  for (const { type, value } of parts) p[type] = value
  const hour = p.hour === '24' ? '00' : p.hour   // some engines emit 24 at midnight with hour12:false
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}.000Z`
}

/** The browser's IANA zone, or UTC when the engine won't say. */
export function detectedZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

/** Is `at` inside the user's quiet hours? Mirrors DndEvaluator.inQuietHours:
 *  the hard mute wins first and ignores `enabled`, a window with a missing
 *  bound is inactive, daysMask 0 means every day, and a start after the end is
 *  a window that crosses midnight. Everything is compared as wall clock in the
 *  DND timezone — muteUntil is stored that way, never as an instant. */
export function inQuietHours(dnd, at = new Date()) {
  if (!dnd) return false
  const tz = dnd.timezone || 'UTC'
  const nowWall = wallClockIn(at, tz)                       // 'YYYY-MM-DDTHH:mm:ss.000Z'
  const mute = (dnd.muteUntil || '').slice(0, 19)
  if (mute && nowWall.slice(0, 19) < mute) return true      // like shapes → lexicographic compare is safe
  const start = (dnd.startTime || '').slice(0, 5)
  const end = (dnd.endTime || '').slice(0, 5)
  if (!dnd.enabled || !start || !end) return false
  const mask = dnd.daysMask || 0
  if (mask) {
    /* Bit 0 = Monday … bit 6 = Sunday, matching java.time.DayOfWeek. Read the
       day from the wall-clock string, not from the local Date, or a user whose
       DND zone is a day ahead gets the wrong bit. */
    const [y, m, d] = nowWall.slice(0, 10).split('-').map(Number)
    const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
    if ((mask & (1 << dow)) === 0) return false
  }
  const t = nowWall.slice(11, 16)
  return start <= end ? (t >= start && t < end) : (t >= start || t < end)
}

/* ---------- delivery policy ---------- */

/** Should an OS notification be raised for this notification type right now?
 *  The one call the app needs before `notify()`:
 *
 *    if (await shouldDeliver(n.type)) notify({ title: n.title, … })
 *
 *  Resolves false (never rejects) when the answer is no. */
export async function shouldDeliver(type) {
  if (!canNotify()) return false
  /* Nothing to add when the user is already looking at the app — the in-app
     row and the chime cover it. */
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return false
  let prefs
  try { prefs = await api.settings.notifications.prefs() } catch { return true }   // fail open
  const cell = type ? prefs?.matrix?.[type]?.DESKTOP : undefined
  if (cell === false) return false
  if (type && LOCKED_NOTIFICATION_TYPES.has(type)) return true                     // BYPASS_ALL ignores DND
  return !inQuietHours(prefs?.dnd)
}

/** Raise the OS notification. Deliberately does NOT re-check `shouldDeliver`,
 *  so Settings can fire a test one on demand; callers reacting to real traffic
 *  must gate on it themselves. Returns the Notification, or null when the
 *  browser refused. */
export function notify({ title, body, tag, deepLink, onClick } = {}) {
  if (!canNotify()) return null
  try {
    const n = new Notification(title || 'IKA', {
      body: body || undefined,
      tag: tag || undefined,          // same tag replaces, so a re-delivered row can't stack
      icon: ICON,
    })
    n.onclick = () => {
      try { window.focus() } catch { /* some browsers forbid it — the click still counts */ }
      n.close()
      if (onClick) onClick()
      else if (deepLink) window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: deepLink }))
    }
    return n
  } catch {
    /* iOS Safari exposes `Notification` but throws on construction outside an
       installed PWA — treat it as "no desktop notifications here". */
    return null
  }
}
