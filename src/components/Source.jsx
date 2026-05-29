/* Source / reference row — used by Q&A answers and Research.
   When the source carries a resolvable link (`href` = url / file),
   the row becomes a clickable anchor; otherwise it stays a plain div.
   Mirrors the backend SourceType enum: URL | ISBN | MEDIA_FILE | MANUAL. */
import { Icon } from './ui.jsx'

const ICON_MAP  = { URL:'link', ISBN:'book', MEDIA_FILE:'doc', MANUAL:'cite' }
const COLOR_MAP = { URL:'#0e6b54', ISBN:'#7a5a1a', MEDIA_FILE:'#15302a', MANUAL:'#3c4f49' }

export function SourceRow({ s }) {
  const icon  = ICON_MAP[s.type]  || 'book'
  const color = COLOR_MAP[s.type] || '#15302a'
  const inner = (
    <>
      <span className="src-ic" style={{ background: color }}><Icon name={icon} className="sm"/></span>
      <div className="src-info">
        <b>{s.title}</b>
        <small className="muted">{s.sub}</small>
      </div>
      <span className="src-tag">{s.type}</span>
    </>
  )
  return s.href
    ? <a className="src-row" href={s.href} target="_blank" rel="noreferrer" style={{ textDecoration:'none' }}>{inner}</a>
    : <div className="src-row">{inner}</div>
}
