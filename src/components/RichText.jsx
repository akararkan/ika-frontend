/* =========================================================
   <RichText> — render a backend rich-text body safely.

   Prefers the server-rendered, pre-sanitised `html` (the
   *Html field on the response). Falls back to client-side
   rendering of `source` + `format` for legacy rows or live
   previews. Output sits inside a .prose container with the
   scholarly typography defined in styles-richtext.css.
   ========================================================= */
import React from 'react'
import { renderSafeHtml, renderByFormat } from '../lib/richtext.js'

export function RichText({ html, source, format = 'PLAIN', className = '', as: As = 'div' }) {
  const out = React.useMemo(() => {
    if (html) return renderSafeHtml(html)
    return renderByFormat(source, format)
  }, [html, source, format])
  if (!out) return null
  return <As className={'prose ' + className} dangerouslySetInnerHTML={{ __html: out }}/>
}
