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
import { renderSafeHtml, renderByFormat } from '../lib/richtext.js'

export function RichText({ html, source, format = 'PLAIN', className = '', as: As = 'div' }) {
  const out = React.useMemo(() => {
    if (source) return renderByFormat(source, format)   // faithful: keeps class-based formatting
    if (html) return renderSafeHtml(html)               // legacy fallback (no source stored)
    return ''
  }, [html, source, format])
  if (!out) return null
  return <As className={'prose ' + className} dangerouslySetInnerHTML={{ __html: out }}/>
}
