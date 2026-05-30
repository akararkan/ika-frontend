/* =========================================================
   Shared icons & UI atoms
   ========================================================= */
/* eslint-disable react-refresh/only-export-components */
import React from 'react'

/* Inline-SVG icon component, paths registry */
export const ICON_PATHS = {
  home:   '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
  feed:   '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
  reels:  '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M3 8h18M9 3l2 5M15 3l2 5"/><path d="M11 11l4 2.5-4 2.5z" fill="currentColor" stroke="none"/>',
  qna:    '<path d="M21 12a9 9 0 1 1-3.6-7.2L21 4v5h-5"/><path d="M9 11h6M9 14h4"/>',
  research:'<path d="M4 4h11l5 5v11H4z"/><path d="M15 4v5h5M8 13h8M8 17h6"/>',
  bookmark:'<path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  bell:   '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  user:   '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  users:  '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><circle cx="17" cy="9" r="3"/><path d="M22 19a5 5 0 0 0-7-4.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  compose:'<path d="M12 5v14M5 12h14"/>',
  send:   '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
  message:'<path d="M21 11.5a8.4 8.4 0 0 1-12 7.6L3 21l1.9-6A8.4 8.4 0 1 1 21 11.5z"/>',
  comment:'<path d="M21 11.5a8.4 8.4 0 0 1-12 7.6L3 21l1.9-6A8.4 8.4 0 1 1 21 11.5z"/>',
  heart:  '<path d="M12 21C5 15 3 12 3 8.5A4.5 4.5 0 0 1 12 6a4.5 4.5 0 0 1 9 2.5C21 12 19 15 12 21z"/>',
  share:  '<path d="M4 12v8h16v-8M16 6l-4-4-4 4M12 2v14"/>',
  more:   '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  close:  '<path d="M6 6l12 12M18 6L6 18"/>',
  check:  '<path d="M20 6L9 17l-5-5"/>',
  chevdown:'<path d="M6 9l6 6 6-6"/>',
  chevright:'<path d="M9 6l6 6-6 6"/>',
  chevleft:'<path d="M15 6l-6 6 6 6"/>',
  chevup: '<path d="M6 15l6-6 6 6"/>',
  image:  '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M21 16l-5-5L5 20"/>',
  video:  '<rect x="3" y="6" width="14" height="12" rx="2"/><path d="M17 10l4-2v8l-4-2z"/>',
  mic:    '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  music:  '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  volume: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14"/>',
  mute:   '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/>',
  pin:    '<path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  hash:   '<path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"/>',
  trending:'<path d="M3 17l6-6 4 4 8-8"/><path d="M17 7h4v4"/>',
  at:     '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  link:   '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  download:'<path d="M12 3v12M8 11l4 4 4-4M4 21h16"/>',
  eye:    '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  lock:   '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  globe:  '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18"/>',
  star:   '<path d="M12 2l2.4 6.9H22l-5.8 4.3 2.2 7-6.4-4.6L5.6 20l2.2-7L2 8.9h7.6z"/>',
  award:  '<circle cx="12" cy="9" r="6"/><path d="M8.5 14L7 22l5-3 5 3-1.5-8"/>',
  shield: '<path d="M12 3l8 4v6c0 5-8 8-8 8s-8-3-8-8V7z"/>',
  book:   '<path d="M4 4h13a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2z"/><path d="M8 4v14"/>',
  doc:    '<path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5"/>',
  cite:   '<path d="M7 7h4v4H7zM13 7h4v4h-4z"/><path d="M7 11c0 3 1 4 4 4M13 11c0 3 1 4 4 4"/>',
  play:   '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
  pause:  '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/>',
  settings:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  filter: '<path d="M4 5h16M7 12h10M10 19h4"/>',
  grid:   '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  list:   '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  follow: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M19 8v6M16 11h6"/>',
  followed:'<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M17 11l2 2 4-4"/>',
  block:  '<circle cx="12" cy="12" r="9"/><path d="M5 5l14 14"/>',
  reply:  '<path d="M9 17l-5-5 5-5M4 12h12a4 4 0 0 1 4 4v4"/>',
  repost: '<path d="M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"/>',
  flag:   '<path d="M4 21V4M4 4h12l-2 4 2 4H4"/>',
  bell_a: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><circle cx="18" cy="6" r="3" fill="currentColor" stroke="none"/>',
  google: '<path d="M21.6 12.2c0-.7-.1-1.5-.2-2.2H12v4.2h5.4c-.2 1.3-.9 2.4-2 3.1v2.6h3.2c1.9-1.7 3-4.3 3-7.7z" fill="#4285F4" stroke="none"/><path d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z" fill="#34A853" stroke="none"/><path d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1A10 10 0 0 0 2 12c0 1.6.4 3.1 1.1 4.6L6.4 14z" fill="#FBBC05" stroke="none"/><path d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.8-2.8C16.9 2.9 14.7 2 12 2A10 10 0 0 0 3.1 7.4L6.4 10c.8-2.3 3-4.1 5.6-4.1z" fill="#EA4335" stroke="none"/>',
  scholar:'<path d="M12 2L2 7l10 5 10-5z"/><path d="M6 9v5a8 8 0 0 0 12 0V9"/><path d="M12 12v9"/>',
  paperclip:'<path d="M21 12l-8.5 8.5a5 5 0 0 1-7-7L13 5a3.5 3.5 0 0 1 5 5l-8 8a1.5 1.5 0 0 1-2-2l7.5-7.5"/>',
  trash:  '<path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6"/>',

  /* ---- rich-text editor glyphs ---- */
  bold:        '<path d="M7 5h6.5a3 3 0 0 1 0 6H7zM7 11h7.5a3.5 3.5 0 0 1 0 7H7z"/>',
  italic:      '<path d="M19 5h-7M12 19H5M15 5L9 19"/>',
  underline:   '<path d="M7 4v9a5 5 0 0 0 10 0V4M5 20h14"/>',
  strike:      '<path d="M4 12h16M8 7a3 3 0 0 1 3-3h2a3 3 0 0 1 3 3M16 17a3 3 0 0 1-3 3h-2a3 3 0 0 1-3-3"/>',
  ulist:       '<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r="1.6" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.6" fill="currentColor" stroke="none"/>',
  olist:       '<path d="M10 6h11M10 12h11M10 18h11M3 4v4M2 8h2.4M2 13h3l-3 4h3"/>',
  quote2:      '<path d="M5 7h4v4c0 3-1.6 4.6-4 5M14 7h4v4c0 3-1.6 4.6-4 5"/>',
  hr:          '<path d="M3 12h18"/>',
  table:       '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 16h18M10 4v16M16 4v16"/>',
  codeblock:   '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 10l-3 2 3 2M15 10l3 2-3 2"/>',
  code:        '<path d="M16 6l6 6-6 6M8 6l-6 6 6 6"/>',
  help:        '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4.5 1.5c-1 1-2 1.5-2 3M12 17h.01"/>',
  alignLeft:   '<path d="M4 6h16M4 12h10M4 18h16"/>',
  alignCenter: '<path d="M4 6h16M7 12h10M4 18h16"/>',
  alignRight:  '<path d="M4 6h16M10 12h10M4 18h16"/>',
  alignJustify:'<path d="M4 6h16M4 12h16M4 18h16"/>',
  erase:       '<path d="M16 4l4 4-9 9H6v-5zM4 21h9"/>',
  indent:      '<path d="M4 6h16M10 12h10M10 18h10M4 12l3 3-3 3"/>',
  outdent:     '<path d="M4 6h16M14 12h6M14 18h6M7 12l-3 3 3 3"/>',
  audio:       '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
}

export function Icon({ name, className = '', style }) {
  const path = ICON_PATHS[name] || ''
  return (
    <svg
      className={'ico ' + className}
      viewBox="0 0 24 24"
      style={style}
      dangerouslySetInnerHTML={{ __html: path }}
    />
  )
}

/* ----- Verify badge (derived single mark — used where only an author summary
   is available, e.g. posts/comments, which don't carry the full badges array) ----- */
export function Verify({ scholar }) {
  return (
    <span className={'verify' + (scholar ? ' scholar' : '')} title={scholar ? 'Verified scholar' : 'Verified'}>
      <svg className="ico" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>
    </span>
  )
}

/* ----- Badges (API-driven, USER_API §5.2 / §17.3) — render the server's
   pre-computed badges[] verbatim: sorted by priority, colour from colorKey,
   glyph mapped from the badge type. Never derive these client-side.
   May 2026 simplification: BadgeType is now just VERIFIED_SCHOLAR /
   VERIFIED_RESEARCHER (auto-derived from role). PLATFORM_OFFICIAL,
   INSTITUTION, SENIOR_SCHOLAR, MEDIA, EMAIL_VERIFIED were retired. ----- */
const BADGE_COLOR = { green:'var(--emerald)', blue:'var(--blue)', gold:'var(--brass)', brass:'var(--brass)', red:'var(--rose)', gray:'var(--muted)', teal:'var(--emerald)' }
const BADGE_ICON = {
  VERIFIED_SCHOLAR:'scholar', VERIFIED_RESEARCHER:'research',
}
export function Badges({ items, max }) {
  if (!Array.isArray(items) || !items.length) return null
  const sorted = [...items].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
  const shown = max ? sorted.slice(0, max) : sorted
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:4, verticalAlign:'middle' }}>
      {shown.map((b, i) => (
        <span key={b.type || i} className="verify" title={b.label || b.type}
          style={{ background: BADGE_COLOR[b.colorKey] || 'var(--emerald)' }}>
          <Icon name={BADGE_ICON[b.type] || 'check'}/>
        </span>
      ))}
    </span>
  )
}

/* ----- Avatar ----- */
export function Avatar({ initials, color, size = 38, square, className = '', src }) {
  const bg = color || 'linear-gradient(135deg,#159a76,#0a4a3c)'
  const fontSize = Math.max(11, Math.round(size * 0.36))
  return (
    <span
      className={'avatar ' + (square ? 'sq ' : '') + className}
      style={{ width: size, height: size, background: bg, fontSize }}
    >
      {src
        ? <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={e => { e.currentTarget.style.display = 'none' }}/>
        : initials}
    </span>
  )
}

/* ----- Toast ----- */
let toastTimer
export function showToast(msg) {
  const el = document.getElementById('toast')
  if (!el) return
  el.querySelector('.tmsg').textContent = msg
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200)
}

/* ----- Format helper ----- */
export function fmt(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace('.0','') + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1).replace('.0','') + 'k'
  return String(n)
}

/* ----- Linkify body text (hashtags + mentions) ----- */
export function linkify(text) {
  if (!text) return null
  const parts = text.split(/(\s|^)(#[\w]+|@[\w.]+)/g)
  return parts.map((p, i) => {
    if (/^#/.test(p)) return <span key={i} className="tk-tag">{p}</span>
    if (/^@/.test(p)) return <span key={i} className="tk-mention">{p}</span>
    return <React.Fragment key={i}>{p}</React.Fragment>
  })
}
