/* =========================================================
   The mock switch, and nothing else.
   ---------------------------------------------------------
   Split out from ./index.js so a module can ask "are we
   mocking?" synchronously without dragging data.json into its
   bundle. index.js holds the fixture; this file holds only the
   three lines that decide whether to open it.
   ========================================================= */

const ENV_ON = String(import.meta.env?.VITE_USE_MOCK ?? '').toLowerCase() === 'true'

function read(key) {
  try { return localStorage.getItem(key) } catch { return null }   // private mode
}

/** Is mock mode active right now?
 *  localStorage wins over the build flag, so one person can demo against
 *  fixtures while the same deployed build serves real data to everyone else. */
export function mockEnabled() {
  const o = read('ika_mock')
  if (o === 'on' || o === 'true') return true
  if (o === 'off' || o === 'false') return false
  return ENV_ON
}

/** Fixture language: en | ar | ku | tr. */
export function mockLang() {
  const v = String(read('ika_mock_lang') || import.meta.env?.VITE_MOCK_LANG || 'en').toLowerCase()
  return ['en', 'ar', 'ku', 'tr'].includes(v) ? v : 'en'
}

/** Fake latency in ms — keeps loading and skeleton states visible in a demo. */
export const MOCK_DELAY = Number(import.meta.env?.VITE_MOCK_DELAY_MS ?? 220) || 0
