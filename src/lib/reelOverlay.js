/* =========================================================
   Reel overlay — text, emoji and moving stickers on a reel.

   WHERE IT LIVES. The post API has no field for an overlay, so
   the layer is uploaded as a second multipart part,
   `overlay.json`. The backend's classifyMedia() answers OTHER
   for application/json, so it comes back in mediaUrls with
   mediaTypes "OTHER" — a slot that means nothing else on this
   platform. The adapters lift it out into `post.overlayUrl` so
   it never reaches a media renderer.

   WHY NOT BAKE IT IN. Because it has to MOVE. Flattening onto
   the frame would freeze every sticker; re-encoding a video in
   the browser costs a full real-time pass and the audio track.
   So the overlay stays data and the viewer draws it live.

   WHAT THE NUMBERS MEAN — the one thing that has to be exact:

     x, y   fraction of the MEDIA rect, centre-anchored (0..1)
     s      size as a fraction of the media rect's WIDTH
     r      rotation in degrees

   Not the card, not the viewport: the MEDIA. The editor stage
   is 9:16, the viewer card is the phone's aspect, a clip is
   fitted `cover` and a photo `contain` — four different
   rectangles. Anchoring to the drawn media and re-deriving that
   rect on both sides (mediaRect() below) is what makes a
   sticker land where the author put it, on every screen.

   EVERYTHING IS A CLOSED TABLE. Fonts, colours and motions are
   indexes into the arrays here, never strings from the file, so
   a hand-edited overlay.json cannot inject CSS. Text is
   rendered as text; nothing is ever interpolated into a style
   string.
   ========================================================= */

export const OVERLAY_FILE = 'overlay.json'
export const OVERLAY_VERSION = 1
export const MAX_ITEMS = 12
export const MAX_TEXT = 180
export const MAX_BYTES = 32 * 1024

/* Kept deliberately small and system-safe: a reel is watched on someone else's
   phone, and a font that has to be fetched arrives after the frame does. */
export const FONTS = [
  { id: 0, label: 'Sans',   css: 'var(--sans, system-ui, sans-serif)', weight: 700 },
  { id: 1, label: 'Serif',  css: 'var(--serif, Georgia, serif)',       weight: 600 },
  { id: 2, label: 'Mono',   css: 'var(--mono, ui-monospace, monospace)', weight: 600 },
]
export const COLORS = ['#ffffff', '#0b131d', '#ffd166', '#e07a72', '#b9d6f2', '#7bd389', '#c792ea', '#ff8fab']
export const ALIGNS = ['start', 'center', 'end']

/* Motions are ids, and the CSS owns every animation property (see the
   `[data-m]` rules in styles-content.css). Never write the `animation`
   shorthand inline for these: the shorthand resets animation-play-state to
   `running`, which silently overrides the rule that pauses stickers with the
   reel — they would keep bouncing over a frozen frame.

   EVERY MOTION ENDS WHERE IT STARTS, too. The app's reduced-motion rules
   collapse animations to 0.001ms with iteration-count 1, which snaps an element
   to its 100% frame — so a motion that ended faded out or rotated would VANISH
   or sit crooked for exactly the people who asked for less movement. */
export const MOTIONS = [
  { id: 0, label: 'None' },
  { id: 1, label: 'Pulse' },
  { id: 2, label: 'Bounce' },
  { id: 3, label: 'Swing' },
  { id: 4, label: 'Pop' },
  { id: 5, label: 'Float' },
  { id: 6, label: 'Spin' },
  { id: 7, label: 'Twinkle' },
]

/** The moving stickers: a glyph plus a motion. Rendered as text, so they cost
 *  nothing to download and they animate with real CSS rather than a GIF the
 *  reduced-motion setting could not stop. */
export const STICKERS = [
  { g: '🎁', m: 2, label: 'Gift' },
  { g: '❤️', m: 1, label: 'Heart' },
  { g: '✨', m: 7, label: 'Sparkle' },
  { g: '🎉', m: 4, label: 'Party' },
  { g: '🔥', m: 1, label: 'Fire' },
  { g: '⭐', m: 6, label: 'Star' },
  { g: '🌙', m: 5, label: 'Moon' },
  { g: '👏', m: 2, label: 'Clap' },
  { g: '🌸', m: 3, label: 'Flower' },
  { g: '💎', m: 7, label: 'Gem' },
  { g: '🏆', m: 4, label: 'Trophy' },
  { g: '🕊️', m: 5, label: 'Dove' },
  { g: '📖', m: 3, label: 'Book' },
  { g: '☕', m: 1, label: 'Tea' },
  { g: '🎵', m: 5, label: 'Note' },
  { g: '💫', m: 6, label: 'Swirl' },
]

export const EMOJI = [
  '😀','😂','🥰','😍','🤩','😎','🤔','🙂','😅','😭','🥳','😴',
  '👍','🙏','👏','💪','🤲','✌️','🤝','👋','💯','✅','❗','❓',
  '❤️','🧡','💛','💚','💙','💜','🤍','💔','💕','💖','✨','⭐',
  '🌙','☀️','🌧️','🌊','🌸','🌿','🕌','📚','📖','✍️','🎓','🏆',
]

const num = (v, min, max, fallback) => {
  const n = Number(v)
  if (!isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
const idx = (v, arr) => {
  const n = Math.round(Number(v))
  return Number.isInteger(n) && n >= 0 && n < arr.length ? n : 0
}

/** Normalise one authored item into exactly what the renderer accepts. */
export function cleanItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const kind = raw.k === 't' || raw.k === 'e' || raw.k === 's' ? raw.k : null
  if (!kind) return null
  const text = String(raw.text ?? '').slice(0, MAX_TEXT)
  if (!text.trim()) return null
  return {
    k: kind,
    text,
    x: num(raw.x, 0, 1, .5),
    y: num(raw.y, 0, 1, .5),
    r: num(raw.r, -180, 180, 0),
    s: num(raw.s, .02, .6, .1),
    f: idx(raw.f, FONTS),
    c: idx(raw.c, COLORS),
    a: idx(raw.a, ALIGNS),
    m: idx(raw.m, MOTIONS),
    bg: raw.bg ? 1 : 0,
  }
}

/** Parse an overlay document. Anything malformed drops the WHOLE overlay: a
 *  half-rendered layer is worse than none, and the clip is unaffected either
 *  way. */
export function parseOverlay(doc) {
  if (!doc || typeof doc !== 'object') return null
  if (Number(doc.v) !== OVERLAY_VERSION) return null
  const items = Array.isArray(doc.items) ? doc.items.slice(0, MAX_ITEMS).map(cleanItem).filter(Boolean) : []
  if (!items.length) return null
  return { v: OVERLAY_VERSION, fit: doc.fit === 'contain' ? 'contain' : 'cover', items }
}

export function serialiseOverlay(items, fit) {
  const clean = (items || []).slice(0, MAX_ITEMS).map(cleanItem).filter(Boolean)
  if (!clean.length) return null
  return { v: OVERLAY_VERSION, fit: fit === 'contain' ? 'contain' : 'cover', items: clean }
}

/** The overlay as a file to upload beside the clip. */
export function overlayFile(doc) {
  const json = JSON.stringify(doc)
  if (json.length > MAX_BYTES) return null
  return new File([json], OVERLAY_FILE, { type: 'application/json' })
}

/** Every word an author put ON the reel, for the caption the server moderates.
 *  Sticker glyphs are not words and only add noise, so text items only. */
export function overlayText(doc) {
  return (doc?.items || []).filter(i => i.k === 't').map(i => i.text).join('\n').trim()
}

/** The same words, once, for a screen reader — the visual layer is aria-hidden. */
export function overlaySpoken(doc) {
  return (doc?.items || []).filter(i => i.k === 't').map(i => i.text).join(' · ')
}

/**
 * Where the media is actually drawn inside its box.
 * @param box    {width, height} of the container
 * @param mediaW natural/intrinsic width of the media (0 while unknown)
 * @param mediaH natural/intrinsic height
 * @param fit    'cover' (clips) or 'contain' (photo reels)
 */
export function mediaRect(box, mediaW, mediaH, fit) {
  const cw = Math.max(0, box?.width || 0), ch = Math.max(0, box?.height || 0)
  // Unknown intrinsics (metadata not in yet) → the box itself: the overlay is
  // never further out than the frame, and it snaps into place on loadedmetadata.
  if (!mediaW || !mediaH || !cw || !ch) return { left: 0, top: 0, width: cw, height: ch }
  const scale = fit === 'contain'
    ? Math.min(cw / mediaW, ch / mediaH)
    : Math.max(cw / mediaW, ch / mediaH)
  const width = mediaW * scale, height = mediaH * scale
  return { left: (cw - width) / 2, top: (ch - height) / 2, width, height }
}
