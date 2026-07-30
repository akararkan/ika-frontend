/* =========================================================
   Channel art + small shared formatters
   ---------------------------------------------------------
   A channel MAY now carry a real avatar and cover (multipart
   upload → R2 proxy URLs), but most do not, so the derived art
   is still the floor rather than a placeholder: `tintOf` picks
   one of the six discipline-spine tints deterministically from
   the id, which means the same channel wears the same colour on
   every device and every reload — never a render-order palette.
   `crestOf` is the first letter of the title.

   Both are pure and id-keyed on purpose: the avatar can appear
   or disappear (an admin uploads or clears a photo) and the
   fallback underneath must not shift when it does.
   ========================================================= */

export function tintOf(id) {
  const s = String(id || '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 997
  return h % 6
}

/** First letter of the title, for the crest. Falls back to the handle. */
export function crestOf(ch) {
  const src = (ch?.title || ch?.handle || '#').trim()
  return [...src][0]?.toUpperCase() || '#'
}

/** 1 234 → "1.2k". Counts only; never used on an id. */
export function nfmt(n) {
  const v = Number(n) || 0
  if (v < 1000) return String(v)
  if (v < 1000000) return `${(v / 1000).toFixed(v < 10000 ? 1 : 0).replace('.0', '')}k`
  return `${(v / 1000000).toFixed(1).replace('.0', '')}M`
}

/** "128 subscribers" / "1 subscriber" — the plural every panel needs. */
export function plural(n, one, many = `${one}s`) {
  return `${nfmt(n)} ${Number(n) === 1 ? one : many}`
}

/** "24 Jul 2026" — absolute, for rows where "3d" would be ambiguous. */
export function dateLabel(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** "in 6h" / "in 3d" / "expired" — for invite-link expiries. */
export function untilLabel(iso) {
  if (!iso) return ''
  const ms = new Date(iso).getTime() - Date.now()
  if (Number.isNaN(ms)) return ''
  if (ms <= 0) return 'expired'
  const m = Math.floor(ms / 60000)
  if (m < 60) return `in ${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `in ${h}h`
  return `in ${Math.floor(h / 24)}d`
}
