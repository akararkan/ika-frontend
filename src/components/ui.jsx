/* =========================================================
   Shared icons & UI atoms
   ========================================================= */
/* eslint-disable react-refresh/only-export-components */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/index.js'

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
  heart:  '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/>',  /* real heart — fills via .ico when the reaction is active */
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
  menu:   '<path d="M4 6h16M4 12h16M4 18h16"/>',
  feather:'<path d="M19.5 4.5c-3.5 0-9 1.5-12 7.5L6 16.5l1.5 1.5 4.5-1.5c6-3 7.5-9 7.5-12z"/><path d="M15 9 4.5 19.5"/>',

  /* ---- view-mode switcher glyphs ---- */
  vfeed:    '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/>',
  vgrid:    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  vcompact: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  vgrouped: '<path d="M4 6h16M7 12h13M10 18h10"/>',

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

  /* ---- chat module glyphs ---- */
  chat:      '<path d="M21 11.5a8.4 8.4 0 0 1-12 7.6L3 21l1.9-6A8.4 8.4 0 1 1 21 11.5z"/><path d="M8 12h.01M12 12h.01M16 12h.01"/>',
  smile:     '<circle cx="12" cy="12" r="9"/><path d="M8 14a5 5 0 0 0 8 0"/><path d="M9 9h.01M15 9h.01"/>',
  forward:   '<path d="M14 5l7 7-7 7M21 12H3a4 4 0 0 0-4 4"/>',
  edit:      '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  archive:   '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>',
  unarchive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M12 18v-6M9 15l3-3 3 3"/>',
  bell_off:  '<path d="M18 8a6 6 0 0 0-9.3-5M6 8c0 7-3 9-3 9h13"/><path d="M13.7 21a2 2 0 0 1-3.4 0M3 3l18 18"/>',
  checks:    '<path d="M2 12l4 4 8-8M11 16l1 1 8-8"/>',
  clock:     '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  stop:      '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  info:      '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  crown:     '<path d="M3 7l4 5 5-7 5 7 4-5-2 12H5z"/>',
  userminus: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M16 11h6"/>',
  pinoff:    '<path d="M12 21s7-5.6 7-11a7 7 0 0 0-11.6-5.3M5.2 8.8A7 7 0 0 0 5 10c0 5.4 7 11 7 11"/><path d="M3 3l18 18"/>',
  copy:      '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  camera:    '<path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="4"/>',
  sparkle:   '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',

  /* ---- calls · channels · live · scheduling ---- */
  phone:     '<path d="M6.5 3h3l1.5 5-2.2 1.6a12.5 12.5 0 0 0 5.6 5.6L16 13l5 1.5v3a2.5 2.5 0 0 1-2.7 2.5A17.5 17.5 0 0 1 3 5.7 2.5 2.5 0 0 1 5.5 3z"/>',
  phoneoff:  '<path d="M9.4 4.6 9.9 8l-2 1.5a12.5 12.5 0 0 0 4.7 4.7L14 12l5 1.5v3a2.5 2.5 0 0 1-2.7 2.5 17.4 17.4 0 0 1-9.5-4M4.6 9.6A17.3 17.3 0 0 1 3 5.7 2.5 2.5 0 0 1 5.5 3h3"/><path d="M3 3l18 18"/>',
  videooff:  '<path d="M17 9.5V8a2 2 0 0 0-2-2H9.5M5.2 6.2A2 2 0 0 0 3 8v8a2 2 0 0 0 2 2h10a2 2 0 0 0 1.8-1.2"/><path d="M17 10l4-2v8l-4-2"/><path d="M3 3l18 18"/>',
  micoff:    '<path d="M9 9V6a3 3 0 0 1 5.9-.7M15 12V9M5 11a7 7 0 0 0 10.6 6M19 11a7 7 0 0 1-.6 2.8M12 18v3"/><path d="M3 3l18 18"/>',
  minimize:  '<path d="M4 14h6v6M20 10h-6V4"/>',
  broadcast: '<circle cx="12" cy="12" r="2.5"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 16.2a6 6 0 0 0 0-8.4"/><path d="M4.9 4.9a10 10 0 0 0 0 14.2M19.1 19.1a10 10 0 0 0 0-14.2"/>',
  megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h3l7 5V5L7 10H4a1 1 0 0 0-1 1z"/><path d="M18 8a5 5 0 0 1 0 8"/>',
  hourglass: '<path d="M7 3h10M7 21h10"/><path d="M8 3v3.5a4 4 0 0 0 1.7 3.3L12 12l-2.3 2.2A4 4 0 0 0 8 17.5V21M16 3v3.5a4 4 0 0 1-1.7 3.3L12 12l2.3 2.2a4 4 0 0 1 1.7 3.3V21"/>',
  calendar:  '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  dot:       '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
  staroff:   '<path d="M8.6 8.6 2 8.9l5.8 4.3-2.2 7 6.4-4.6 6.4 4.6-1.2-3.8M12 2l2.4 6.9H22l-4 3"/><path d="M3 3l18 18"/>',
  external:  '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  eyeoff:    '<path d="M4.5 7.2A15.9 15.9 0 0 0 2 12s4 7 10 7a10.6 10.6 0 0 0 4.3-.9M9.9 5.2A11.4 11.4 0 0 1 12 5c6 0 10 7 10 7a17.6 17.6 0 0 1-3 3.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/>',

  /* ---- media players (voice notes · the in-chat video player) ----
     Every glyph here is drawn at the same 24×24 gauge as the set above and
     relies on `currentColor`, so one rule can tint a whole control bar. The
     transport pair (`skipback`/`skipfwd`) carries its jump size as text
     INSIDE the path list: a separate <span> would wrap on a narrow bar and
     the two would drift apart on a scrubbing gesture. */
  skipback:  '<path d="M11.5 5V2.5L7 6l4.5 3.5V7a6 6 0 1 1-6 6"/><text x="12" y="17.6" font-size="8" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">10</text>',
  skipfwd:   '<path d="M12.5 5V2.5L17 6l-4.5 3.5V7a6 6 0 1 0 6 6"/><text x="12" y="17.6" font-size="8" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">10</text>',
  speed:     '<path d="M3.6 17a9 9 0 1 1 16.8 0"/><path d="M12 13l4.2-3.6"/><circle cx="12" cy="14" r="1.4" fill="currentColor" stroke="none"/>',
  expand:    '<path d="M9 3H3v6M15 3h6v6M9 21H3v-6M15 21h6v-6"/>',
  collapse:  '<path d="M3 9h6V3M21 9h-6V3M3 15h6v6M21 15h-6v6"/>',
  pip:       '<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><rect x="12" y="11" width="8" height="7" rx="1.5" fill="currentColor" stroke="none"/>',
  volumelow: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 9.5a4 4 0 0 1 0 5"/>',

  /* ---- calls, part two: direction glyphs + link quality ----
     A call card has to say WHICH WAY it went before it says anything else, so
     direction is the arrow and the handset is constant. `signal` is drawn as
     four bars and dimmed per-bar from CSS, so one glyph serves every grade. */
  phonein:   '<path d="M6.5 3h3l1.5 5-2.2 1.6a12.5 12.5 0 0 0 5.6 5.6L16 13l5 1.5v3a2.5 2.5 0 0 1-2.7 2.5A17.5 17.5 0 0 1 3 5.7 2.5 2.5 0 0 1 5.5 3z"/><path d="M21 3l-6 6M15 3.6V9h5.4"/>',
  phoneout:  '<path d="M6.5 3h3l1.5 5-2.2 1.6a12.5 12.5 0 0 0 5.6 5.6L16 13l5 1.5v3a2.5 2.5 0 0 1-2.7 2.5A17.5 17.5 0 0 1 3 5.7 2.5 2.5 0 0 1 5.5 3z"/><path d="M15 9l6-6M21 8.4V3h-5.4"/>',
  phonemiss: '<path d="M6.5 3h3l1.5 5-2.2 1.6a12.5 12.5 0 0 0 5.6 5.6L16 13l5 1.5v3a2.5 2.5 0 0 1-2.7 2.5A17.5 17.5 0 0 1 3 5.7 2.5 2.5 0 0 1 5.5 3z"/><path d="M15 3l6 6M21 3l-6 6"/>',
  signal:    '<path d="M4 20v-3M9.3 20v-6M14.7 20v-9M20 20V8"/>',
  screen:    '<rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M8 20.5h8M12 16.5v4"/><path d="M12 7.5v5M9.6 9.9L12 7.5l2.4 2.4"/>',
  screenoff: '<path d="M21.5 14.4V6a2 2 0 0 0-2-2H8.6M4.6 4.6A2 2 0 0 0 2.5 6v8.5a2 2 0 0 0 2 2h13"/><path d="M8 20.5h8M12 16.5v4"/><path d="M3 3l18 18"/>',
  swapcam:   '<circle cx="12" cy="13" r="3.2"/><path d="M3 9.5A2 2 0 0 1 5 7.5h1.6L8 5.2h4.6"/><path d="M21 14.5a2 2 0 0 1-2 2h-1.6L16 18.8h-4.6"/><path d="M11 3.6L12.8 5.2 11 6.8M13 15.2L11.2 16.8 13 18.4"/>',
  wifioff:   '<path d="M5 12.5a11 11 0 0 1 4.2-2.5M2 8.8A16 16 0 0 1 7.4 5.6M22 8.8a16 16 0 0 0-8.6-3.7M19 12.5a11 11 0 0 0-3-1.9"/><path d="M9.2 16.1a5.4 5.4 0 0 1 5.6 0"/><circle cx="12" cy="19.6" r="1" fill="currentColor" stroke="none"/><path d="M3 3l18 18"/>',
  refresh:   '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4.5V10H15"/>',
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
  const bg = color || 'linear-gradient(135deg,#2d5f97,#16283f)'
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

/* ----- Brand mark: the IKA logo image (public/ika-logo.png), with the
   geometric mark as a graceful fallback until the file is in place. ----- */
export function BrandMark() {
  const [ok, setOk] = React.useState(true)
  if (ok) return <img className="brand-img" src="/ika-logo.png" alt="" aria-hidden="true" onError={() => setOk(false)}/>
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3l2.2 2.2h3v3L19.4 10.5 17.2 12.7v3h-3L12 18l-2.2-2.3h-3v-3L4.6 10.5 6.8 8.2v-3h3z"/>
      <circle cx="12" cy="10.5" r="1.6" fill="currentColor" stroke="none"/>
    </svg>
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

/* ----- Clickable hashtag → tag feed ----- */
export function TagLink({ tag }) {
  const navigate = useNavigate()
  const slug = tag.replace(/^#/, '')
  return (
    <a className="tk-tag" role="button" tabIndex={0}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigate(`/tags/${encodeURIComponent(slug)}`) }}>{tag}</a>
  )
}

/* ----- Clickable @mention → resolves the handle to a profile on click ----- */
export function MentionLink({ handle }) {
  const navigate = useNavigate()
  const un = handle.replace(/^@/, '')
  const go = async (e) => {
    e.preventDefault(); e.stopPropagation()
    try { const u = await api.users.getByUsername(un); if (u?.id) return navigate(`/u/${u.id}`) } catch { /* fall through */ }
    navigate(`/explore?q=${encodeURIComponent(un)}`)   // unknown handle → search
  }
  return (
    <a className="tk-mention" role="button" tabIndex={0} onClick={go}
      onKeyDown={(e) => { if (e.key === 'Enter') go(e) }}>{handle}</a>
  )
}

/* ----- Linkify body text (clickable hashtags + mentions) ----- */
export function linkify(text) {
  if (!text) return null
  const parts = text.split(/(\s|^)(#[\w]+|@[\w.]+)/g)
  return parts.map((p, i) => {
    if (/^#/.test(p)) return <TagLink key={i} tag={p}/>
    if (/^@/.test(p)) return <MentionLink key={i} handle={p}/>
    return <React.Fragment key={i}>{p}</React.Fragment>
  })
}

/* Segmented view-mode switcher (Feed / Grid / Compact / Grouped) for list
   pages. Icon + label, accessible: a roving toolbar of aria-pressed buttons
   with ArrowLeft/Right moving both selection and focus. */
const VIEW_SEG_OPTS = [
  { id:'feed',    label:'Feed',    icon:'vfeed'    },
  { id:'grid',    label:'Grid',    icon:'vgrid'    },
  { id:'compact', label:'Compact', icon:'vcompact' },
  { id:'grouped', label:'Grouped', icon:'vgrouped' },
]
export function ViewSeg({ value, onChange }) {
  const btnRefs = React.useRef([])
  // Roving toolbar: Arrow keys move BOTH selection and DOM focus to the next
  // button so the focused control and the pressed (aria-pressed) control never
  // desync for keyboard / assistive-tech users.
  const onKey = (e) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!dir) return
    e.preventDefault()
    const i = Math.max(0, VIEW_SEG_OPTS.findIndex(o => o.id === value))
    const ni = (i + dir + VIEW_SEG_OPTS.length) % VIEW_SEG_OPTS.length
    onChange(VIEW_SEG_OPTS[ni].id)
    btnRefs.current[ni]?.focus()
  }
  return (
    <div className="view-seg" role="toolbar" aria-label="View mode">
      {VIEW_SEG_OPTS.map((o, idx) => (
        <button
          key={o.id}
          ref={el => { btnRefs.current[idx] = el }}
          type="button"
          className={'vseg' + (value === o.id ? ' on' : '')}
          aria-pressed={value === o.id}
          aria-label={o.label + ' view'}
          title={o.label + ' view'}
          tabIndex={value === o.id ? 0 : -1}
          onClick={() => onChange(o.id)}
          onKeyDown={onKey}
        >
          <Icon name={o.icon} className="sm"/><span className="vseg-tx">{o.label}</span>
        </button>
      ))}
    </div>
  )
}

/* Lightweight token/chip input for free-text lists (e.g. research keywords).
   Adds a chip on comma / Enter / paste-with-commas; Backspace on an empty field
   removes the last. No tag-catalogue autocomplete or normalisation — keywords
   keep their case. value/onChange are plain string arrays. Reuses the .tag-input
   chip styling so it matches the Tags field. */
const CHIP_SEP = /[,،؛\n]+/   // ASCII "," + Arabic comma «،» + Arabic semicolon «؛» + newline
export function ChipInput({ value = [], onChange, placeholder = 'Type and press Enter', max = 40 }) {
  const [draft, setDraft] = React.useState('')
  // add() SPLITS on the separator set, so a multi-term blob (typed, pasted, or left
  // in the field on blur) becomes independent chips — including Arabic/Kurdish input
  // that uses the Arabic comma «،» (U+060C) or semicolon «؛» (U+061B), not ASCII ",".
  const add = (raw) => {
    const parts = String(raw || '').split(CHIP_SEP).map(s => s.trim().replace(/^#+/, '')).filter(Boolean)
    if (!parts.length) { setDraft(''); return }
    const next = [...value]
    for (const v of parts) {
      if (next.length >= max) break
      if (!next.some(x => x.toLowerCase() === v.toLowerCase())) next.push(v)
    }
    onChange?.(next)
    setDraft('')
  }
  const onKey = (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === '،' || e.key === '؛') { if (draft.trim()) { e.preventDefault(); add(draft) } }
    else if (e.key === 'Backspace' && !draft && value.length) onChange?.(value.slice(0, -1))
  }
  const onPaste = (e) => {
    const t = e.clipboardData?.getData('text') || ''
    if (!CHIP_SEP.test(t)) return
    e.preventDefault()
    add(t)
  }
  return (
    <div className="tag-input">
      <div className="tag-chips">
        {value.map((t, i) => (
          <span key={i} className="chip on" style={{ paddingRight: 6 }}>
            {t}
            <button type="button" onClick={() => onChange?.(value.filter((_, j) => j !== i))} title="Remove"
              style={{ background:'transparent', border:0, color:'inherit', display:'inline-flex', padding:0, marginLeft:4, cursor:'pointer' }}>
              <Icon name="close" className="xs"/>
            </button>
          </span>
        ))}
        <input className="field" style={{ flex:1, minWidth:140, border:0, padding:'6px 8px', background:'transparent' }}
          value={draft} placeholder={value.length ? '' : placeholder}
          onChange={e => setDraft(e.target.value)} onKeyDown={onKey} onPaste={onPaste}
          onBlur={() => { if (draft.trim()) add(draft) }}/>
      </div>
    </div>
  )
}
