/* =========================================================
   <RichText> — render a backend rich-text body safely.

   Prefers the author's RAW `source` (rendered + sanitised on
   the client). The backend's server-rendered `*Html` STRIPS the
   `class` attribute, which silently drops every class-based
   format — highlights (hl-*), text colours (tc-*), font sizes
   (fs-*), fonts (ff-*) and alignment (align-*) — so the published
   page looked unformatted next to the editor. The client
   sanitiser (renderByFormat → DOMPurify) keeps `class`, so what
   the author sees in the composer is what readers get. Falls back
   to the server `html` only when there's no source (legacy rows).
   Output sits inside a .prose container (styles-richtext.css).
   ========================================================= */
import React from 'react'
import { renderSafeHtml, renderByFormat, detectFormat, applyAutoDir } from '../lib/richtext.js'

export function RichText({ html, source, format = 'PLAIN', className = '', as: As = 'div' }) {
  const out = React.useMemo(() => {
    let rendered = ''
    if (source) {
      // Honour an explicit rich format (MARKDOWN/HTML). When the stored format
      // is PLAIN or missing but the raw source actually contains Markdown or
      // HTML — e.g. an abstract/description authored in Markdown that was saved
      // without its format flag — fall back to the SAME heuristic the backend
      // uses (detectFormat ≡ RichTextService.detectFormat). That way the body
      // renders as written instead of leaking literal `## …` / `**…**` markup.
      const fmt = String(format || '').toUpperCase()
      const eff = (fmt === 'MARKDOWN' || fmt === 'HTML') ? fmt : detectFormat(source)
      rendered = renderByFormat(source, eff)   // faithful: keeps class-based formatting
    } else if (html) {
      rendered = renderSafeHtml(html)          // legacy fallback (no source stored)
    }
    // Per-block dir="auto" so mixed Arabic/Kurdish + Latin bodies read correctly
    // line-by-line (alignment + list/quote sides), matching how they were authored.
    return applyAutoDir(rendered)
  }, [html, source, format])
  if (!out) return null
  // `dir="auto"` mirrors the composer's contenteditable surface: the rendered
  // body resolves its base direction from its first strong character, so an
  // Arabic / Kurdish abstract or description reads right-to-left in the reader
  // exactly as it was authored (instead of falling back to LTR/left).
  return <As dir="auto" className={'prose ' + className} dangerouslySetInnerHTML={{ __html: out }}/>
}
