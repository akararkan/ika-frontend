/* =========================================================
   Rich text — client-side renderer that mirrors the backend's
   contract (BodyFormat: PLAIN | MARKDOWN | HTML).

   - Reads use the server-rendered `*Html` field when available
     (already sanitised by the backend's OWASP whitelist).
   - Edits use this renderer for the live "Preview" tab so the
     author sees the same intent without a round-trip.
   - Markdown engine: marked (GFM: tables, strikethrough, autolink).
   - Sanitiser: DOMPurify with the same whitelist the backend uses
     (no <script>/<iframe>/<style>, http(s) URLs only, no on*).
   - Helper `detectFormat` matches the server's heuristic so an
     omitted format is auto-classified consistently on both sides.
   ========================================================= */
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: false, pedantic: false })

/* OWASP-equivalent whitelist — tags / attrs we render verbatim. */
const PURIFY_CFG = {
  ALLOWED_TAGS: [
    'h1','h2','h3','h4','h5','h6','p','br','hr',
    'strong','em','s','del','u','a','code','pre','blockquote',
    'ul','ol','li','table','thead','tbody','tr','th','td',
    'img','span','div',
  ],
  ALLOWED_ATTR: ['href','title','alt','src','width','height','class','target','rel'],
  // only http(s) + mailto on hrefs/srcs — strip javascript:, data:, vbscript:
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|\/|#|\?)/i,
}

/* DOMPurify hook: harden <a> with rel="nofollow noopener" + target="_blank". */
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('rel', 'nofollow noopener')
    node.setAttribute('target', '_blank')
  }
})

/** Escape raw text → safe HTML (PLAIN format renderer). */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** PLAIN → HTML (escape + preserve line breaks). */
export function renderPlain(src) {
  if (!src) return ''
  return escapeHtml(src).replace(/\r\n|\n/g, '<br/>')
}

/** Markdown source → sanitised HTML (GFM). */
export function renderMarkdown(src) {
  if (!src) return ''
  let html
  try { html = marked.parse(src) } catch { html = escapeHtml(src) }
  return DOMPurify.sanitize(html, PURIFY_CFG)
}

/** Raw HTML → sanitised HTML. */
export function renderSafeHtml(html) {
  if (!html) return ''
  return DOMPurify.sanitize(html, PURIFY_CFG)
}

/** Dispatch by format. Anything unknown falls back to PLAIN. */
export function renderByFormat(src, format) {
  switch (String(format || '').toUpperCase()) {
    case 'MARKDOWN': return renderMarkdown(src)
    case 'HTML':     return renderSafeHtml(src)
    case 'PLAIN':
    default:         return renderPlain(src)
  }
}

/** Server-side heuristic, mirrored on the client (RichTextService.detectFormat). */
export function detectFormat(src) {
  if (!src) return 'PLAIN'
  if (/<\w+(\s[^>]*)?>/.test(src)) return 'HTML'
  if (/(?:^|\n)#{1,6}\s|(?:^|\n)[-*+]\s|(?:^|\n)\d+\.\s|(?:^|\n)>\s|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|\[[^\]]+\]\([^)]+\)|!\[[^\]]*\]\([^)]+\)|(?:^|\n)```/m.test(src)) return 'MARKDOWN'
  return 'PLAIN'
}

/** Plain-text projection — used by previews of long bodies (e.g. cards). */
export function toPlainText(html) {
  if (!html) return ''
  const tmp = document.createElement('div')
  tmp.innerHTML = renderSafeHtml(html)
  return tmp.textContent || tmp.innerText || ''
}
