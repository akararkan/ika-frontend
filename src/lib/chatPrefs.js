/* =========================================================
   Chat preference applier — the client half of the `messages`
   cosmetic block (MessageSettings, spec §9).
   ---------------------------------------------------------
   MessageSettings is [C] client-owned: the backend stores
   wallpaper / chatTheme / fontSize / enterToSend verbatim for
   cross-device sync and interprets none of them (its javadoc
   says so outright), so turning them into pixels is entirely a
   client job. lib/prefs.js does exactly this for `appearance` /
   `accessibility`; this module is its twin for `messages`, kept
   separate because chat is the only surface that reads it.

   The contract with the DOM (do not widen it casually):
     data-chat-theme="oxford"|"sky"   messages.chatTheme
     --chat-font-scale:<number>       messages.fontSize
     --chat-wallpaper:<colour>        messages.wallpaper
   All three follow prefs.js's rule — every default resolves to
   "attribute absent / property removed", so a user on defaults
   gets the untouched stylesheet.

   enterToSend is read by JS, not CSS: composers call
   enterToSend() rather than re-parsing the block.

   WHY THIS MODULE SHIPS ITS OWN <style>
   styles/warm/* has no rules keyed on the three hooks above, so
   publishing the hooks alone would leave the settings decorative.
   paintSheet() therefore appends ONE <style id="ika-chat-prefs">
   to <head> (last, so it wins on source order over chat.css and
   the ika-messages-theme layer at equal specificity) holding at
   most three rules, generated only for non-default values — on
   defaults the element is removed entirely. When those rules move
   into the theme layer proper, delete paintSheet(): the hooks are
   the real contract and stay.

   The theme tint deliberately touches the INCOMING bubble only.
   `.ch-row.mine .ch-bubble` is navy with a whole family of cream
   children hanging off it (.ch-meta, ticks, .ch-voice-*,
   .ch-file-ico, link colour) — repainting it light from here
   would leave every one of those illegible, and Oxford Blue own
   bubbles are the theme spec anyway.

   Wiring (importing this file applies nothing — the caller decides):
     applyCachedChatPrefs()                 // sync, at boot, pre-render
     loadAndApplyChatPrefs()                // once the session is known
     startChatPrefs()                       // re-read on PREFS_EVENT
   NOT WIRED YET: main.jsx and Layout.jsx do the equivalent for lib/prefs.js
   but not for this module, so today the only caller is SettingsPage's
   Messages card. Until those two call sites land, chat cosmetics apply from
   the moment Settings › Messages is opened rather than from boot.
   ========================================================= */
import { api } from '../api/index.js'
import { PREFS_EVENT } from './prefs.js'

const CACHE_KEY = 'ika_chat_prefs_cache'
const SHEET_ID = 'ika-chat-prefs'

/** The exact entity defaults (MessageSettings.java). A whole-block PUT nulls
 *  anything omitted, so this object has to stay complete. */
export const MESSAGE_DEFAULTS = {
  wallpaper: 'DEFAULT', chatTheme: 'DEFAULT', fontSize: 'MEDIUM', enterToSend: true,
}

/* wallpaper is "a media id, a preset key, or a hex colour" on the wire. This
   client writes the HEX (a colour we can paint without a media round trip),
   but a preset KEY written by another client must still resolve — hence both
   columns. [key, hex, label] */
export const WALLPAPER_PRESETS = [
  ['PORCELAIN', '#F2F0F0', 'Porcelain'],
  ['SKY', '#DCE9F6', 'Sky'],
  ['SAGE', '#E4EDE9', 'Sage'],
  ['PARCHMENT', '#F5EAD7', 'Parchment'],
]

/* fontSize is SMALL | MEDIUM | LARGE (a free string server-side) — anything
   unknown falls back to 1, i.e. no property at all. */
export const CHAT_FONT_SCALE = { SMALL: 0.94, MEDIUM: 1, LARGE: 1.1 }

/* chatTheme → the incoming-bubble fill. Token PAIRS only: both of these flip
   with data-theme="dark", so neither can land as a light fill under dark ink
   (--wash #e7eff8 → #152a42, --brass-soft #b9d6f2 → #2e4a68; --ink holds 11:1
   and 7.4:1 on them). DEFAULT is absent, not a value.
   NOT --gold-wash for Sky, even though the name fits: it resolves to #dce9f6
   on light — a shade off --wash — and to the SAME #152a42 as --wash on dark,
   so the two themes would have been indistinguishable in light and identical
   in dark, i.e. a picker that looks broken. */
export const CHAT_THEME_TINT = { OXFORD: 'var(--wash)', SKY: 'var(--brass-soft)' }

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
const up = (v) => String(v ?? '').trim().toUpperCase()

/** wallpaper → a paintable CSS colour, or null when there is nothing we can
 *  paint synchronously (DEFAULT, or a media id — resolving that needs a
 *  /media round trip, so it stays unpainted rather than guessing a URL). */
function wallpaperColour(raw) {
  const v = String(raw ?? '').trim()
  if (!v || up(v) === 'DEFAULT') return null
  if (HEX.test(v)) return v
  const preset = WALLPAPER_PRESETS.find(([key, hex]) => key === up(v) || hex.toLowerCase() === v.toLowerCase())
  return preset ? preset[1] : null
}

/** The whole block, normalised. Shared with MessagesPanel's preview so the
 *  sample bubble and the real thread can never disagree. */
export function resolveChatPrefs(messages) {
  const m = messages || {}
  const theme = CHAT_THEME_TINT[up(m.chatTheme)] ? up(m.chatTheme) : 'DEFAULT'
  return {
    theme,
    fontScale: CHAT_FONT_SCALE[up(m.fontSize)] ?? 1,
    wallpaper: wallpaperColour(m.wallpaper),
    /* a primitive boolean server-side, so it is always on the wire; absent
       (an empty block before the first load) keeps the platform default */
    enterToSend: m.enterToSend !== false,
  }
}

let current = resolveChatPrefs(null)

/** The last applied block, resolved. Synchronous — safe on a render path. */
export function chatPrefs() { return current }

/** messages.enterToSend — false means Enter must insert a newline instead of
 *  sending. Default-true, so an unloaded/failed fetch keeps today's behaviour. */
export function enterToSend() { return current.enterToSend }

/* ---------- painting ---------- */

function sheetText(p) {
  const rules = []
  if (p.wallpaper) rules.push(':root .ch-pane-thread{background-color:var(--chat-wallpaper)}')
  /* 15px is the resting bubble size (ika-messages-theme.css wins over
     chat.css's 14.5px). At scale 1 no rule is emitted at all. */
  if (p.fontScale !== 1) rules.push(':root .ch-bubble{font-size:calc(15px * var(--chat-font-scale,1))}')
  const tint = CHAT_THEME_TINT[p.theme]
  if (tint) {
    /* tombstones and failed sends keep their own state colours */
    rules.push(`:root[data-chat-theme="${p.theme.toLowerCase()}"] .ch-row:not(.mine) .ch-bubble:not(.deleted):not(.failed){background:${tint}}`)
  }
  return rules.join('\n')
}

function paintSheet(p) {
  const css = sheetText(p)
  let el = document.getElementById(SHEET_ID)
  if (!css) { el?.remove(); return }
  if (!el) {
    el = document.createElement('style')
    el.id = SHEET_ID
    document.head.appendChild(el)                 // last in <head> — source order wins
  }
  if (el.textContent !== css) el.textContent = css
}

function paint(p) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (p.theme === 'DEFAULT') root.removeAttribute('data-chat-theme')
  else root.setAttribute('data-chat-theme', p.theme.toLowerCase())
  if (p.fontScale === 1) root.style.removeProperty('--chat-font-scale')
  else root.style.setProperty('--chat-font-scale', String(p.fontScale))
  if (p.wallpaper) root.style.setProperty('--chat-wallpaper', p.wallpaper)
  else root.style.removeProperty('--chat-wallpaper')
  paintSheet(p)
}

/** Apply one `messages` block. Any part may be missing; unknown values degrade
 *  to the default. Returns the resolved prefs. */
export function applyChatPrefs(messages) {
  current = resolveChatPrefs(messages)
  paint(current)
  return current
}

/** Apply the last cached block synchronously, before any network round trip,
 *  so opening a conversation on a reload does not flash the default surface.
 *  Returns the cached block (or null). Never throws. */
export function applyCachedChatPrefs() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const cached = JSON.parse(raw)
    if (!cached || typeof cached !== 'object') return null
    applyChatPrefs(cached)
    return cached
  } catch { return null }
}

/* An older in-flight response must never stomp a newer one (two PREFS_EVENTs
   in quick succession can overlap). */
let seq = 0

/** Fetch the live `messages` block and apply it. Resolves to the block, or
 *  null on any failure — in which case the DOM is left exactly as it was (a
 *  failed refresh must never revert the user to defaults). */
export async function loadAndApplyChatPrefs() {
  const mine = ++seq
  try {
    const block = await api.settings.section('messages')
    if (!block || typeof block !== 'object') return null
    if (mine !== seq) return block                // a newer load already applied
    applyChatPrefs(block)
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(block)) }
    catch { /* private mode / quota — the applier still worked */ }
    return block
  } catch {
    return null
  }
}

/* One listener per document, however many callers ask for it. */
let stopWatch = null

/** Re-read the block whenever a cosmetic write fires PREFS_EVENT (useSection
 *  dispatches it after every successful PATCH). Idempotent; returns the
 *  stopper so a caller with a lifecycle can release it. */
export function startChatPrefs() {
  if (stopWatch) return stopWatch
  if (typeof window === 'undefined') return () => {}
  const onChange = () => { loadAndApplyChatPrefs() }
  window.addEventListener(PREFS_EVENT, onChange)
  stopWatch = () => {
    window.removeEventListener(PREFS_EVENT, onChange)
    stopWatch = null
  }
  return stopWatch
}
