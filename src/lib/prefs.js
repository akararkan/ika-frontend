/* =========================================================
   Preference applier — the client half of the cosmetic settings.
   ---------------------------------------------------------
   The backend stores `appearance` / `accessibility` verbatim and
   never interprets them (probe: settings core is opaque except
   media.uploadQuality). Applying them is therefore entirely a
   client job: this module translates the two blocks into a small,
   stable set of attributes and custom properties on <html>, and
   styles/warm/prefs.css turns those into actual rendering.

   The contract with the stylesheet (do not widen it casually):
     data-density="compact"        appearance.density
     data-contrast="high"          accessibility.highContrast
     data-reduced-motion="on"      appearance|accessibility.reducedMotion
     --ui-font-scale:<number>      fontSize × largeText × interfaceScale
     --user-accent:#rrggbb         appearance.accentColor

   Every default resolves to "attribute absent / property removed",
   so a user on defaults gets the untouched stylesheet — no rule in
   prefs.css can bite until something is deliberately non-default.

   Wiring (the caller decides — importing this file applies nothing):
     applyCachedPrefs()                      // sync, at boot, pre-render
     loadAndApplyPrefs()                     // after the session is known
     window.dispatchEvent(new Event(PREFS_EVENT))   // after a cosmetic write
   with one listener on PREFS_EVENT calling loadAndApplyPrefs again.
   ========================================================= */
import { api } from '../api/index.js'

/** Dispatch this on `window` after writing `appearance` / `accessibility`
 *  so whoever owns the applier can re-run it. */
export const PREFS_EVENT = 'ika:prefs-changed'

const CACHE_KEY = 'ika_prefs_cache'

/* AppearanceSettings.fontSize is a free string server-side (SMALL | MEDIUM |
   LARGE | XLARGE, default MEDIUM) — anything unknown falls back to 1. */
const FONT_SCALE = { SMALL: 0.92, MEDIUM: 1, LARGE: 1.09, XLARGE: 1.18 }
const LARGE_TEXT_BOOST = 1.08
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/** interfaceScale is a Double, documented range 0.8–1.4. Null / absent
 *  (Jackson NON_NULL drops it) and junk both mean "no scaling". */
function clampScale(n) {
  if (n == null || n === '') return 1
  const v = Number(n)
  if (!Number.isFinite(v)) return 1
  return Math.min(1.4, Math.max(0.8, v))
}

const round4 = (n) => Math.round(n * 1e4) / 1e4

/** Apply one settings object ({appearance, accessibility, …}) to <html>.
 *  Any part may be missing; unknown values degrade to the default. */
export function applyPrefs(settings) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const app = settings?.appearance || {}
  const acc = settings?.accessibility || {}

  /* density */
  if (String(app.density || '').toUpperCase() === 'COMPACT') root.setAttribute('data-density', 'compact')
  else root.removeAttribute('data-density')

  /* high contrast */
  if (acc.highContrast) root.setAttribute('data-contrast', 'high')
  else root.removeAttribute('data-contrast')

  /* reduced motion — either block can ask for it */
  if (app.reducedMotion || acc.reducedMotion) root.setAttribute('data-reduced-motion', 'on')
  else root.removeAttribute('data-reduced-motion')

  /* one number for all three sizing inputs; exactly 1 removes the property so
     the base stylesheet is left completely alone */
  const base = FONT_SCALE[String(app.fontSize || '').toUpperCase()] ?? 1
  const scale = round4(base * (acc.largeText ? LARGE_TEXT_BOOST : 1) * clampScale(app.interfaceScale))
  if (scale === 1) root.style.removeProperty('--ui-font-scale')
  else root.style.setProperty('--ui-font-scale', String(scale))

  /* accent — nothing in the Oxford theme reads it yet; it exists so a future
     accent surface has a single source instead of re-deriving it */
  const accent = typeof app.accentColor === 'string' ? app.accentColor.trim() : ''
  if (HEX.test(accent)) root.style.setProperty('--user-accent', accent)
  else root.style.removeProperty('--user-accent')
}

/** Apply the last cached blocks synchronously, before any network round trip,
 *  so a reload does not flash the default sizing. Returns the cached object
 *  (or null when there is nothing usable cached). Never throws. */
export function applyCachedPrefs() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const cached = JSON.parse(raw)
    if (!cached || typeof cached !== 'object') return null
    applyPrefs(cached)
    return cached
  } catch { return null }
}

/* An older in-flight response must never stomp a newer one's application
   (two PREFS_EVENTs in quick succession can overlap). */
let seq = 0

/** Fetch the live settings and apply them. Resolves to the settings object,
 *  or null on any failure — in which case the DOM is left exactly as it was
 *  (a failed refresh should never revert the user to defaults). Safe to call
 *  as often as you like. */
export async function loadAndApplyPrefs() {
  const mine = ++seq
  try {
    const res = await api.settings.all()
    if (!res || typeof res !== 'object') return null
    if (mine !== seq) return res            // a newer load already applied
    applyPrefs(res)
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        appearance: res.appearance || null,
        accessibility: res.accessibility || null,
        settingsVersion: res.settingsVersion ?? null,
      }))
    } catch { /* private mode / quota — the applier still worked */ }
    return res
  } catch {
    return null
  }
}
