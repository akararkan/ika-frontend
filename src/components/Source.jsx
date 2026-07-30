/* Source / reference row — used by Q&A answers and Research.
   Every source is made accessible: URL/BOOK/ARTICLE rows link out,
   MEDIA_FILE rows open/download the file (with name + size), ISBN
   and MANUAL rows show their citation text in full.
   Mirrors the backend SourceType enum: URL | BOOK | ARTICLE |
   MEDIA_FILE | ISBN | MANUAL. */
import { Icon } from './ui.jsx'

const ICON_MAP  = { URL:'link', BOOK:'book', ARTICLE:'doc', ISBN:'book', MEDIA_FILE:'doc', MANUAL:'cite' }
const COLOR_MAP = { URL:'#1f4e7e', BOOK:'#4e6580', ARTICLE:'#002147', ISBN:'#4e6580', MEDIA_FILE:'#6b5b8a', MANUAL:'#8a93a3' }

function bytes(n) {
  if (n == null || n < 0) return ''
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1; let v = n
  do { v /= 1024; i++ } while (v >= 1024 && i < u.length - 1)
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}

export function SourceRow({ s }) {
  const icon = ICON_MAP[s.type] || 'book'
  const color = COLOR_MAP[s.type] || '#232b3a'
  const isFile = s.type === 'MEDIA_FILE' || !!s.fileUrl
  // The descriptive line: prefer a full citation, then the URL / ISBN / file name.
  const desc = isFile
    ? [s.fileName, bytes(s.fileSize)].filter(Boolean).join(' · ')
    : (s.citationText || s.url || (s.isbn ? `ISBN ${s.isbn}` : '') || s.sub || '')

  const inner = (
    <>
      <span className="src-ic" style={{ background: color }}><Icon name={icon} className="sm"/></span>
      <div className="src-info">
        <b dir="auto">{s.title || s.fileName || s.url || 'Source'}</b>
        {desc && <small className="muted" dir="auto">{desc}</small>}
      </div>
      {s.href
        ? <span className="src-action" title={isFile ? 'Open file' : 'Open link'}><Icon name={isFile ? 'download' : 'link'} className="sm"/></span>
        : <span className="src-tag">{(s.type || '').replace('_', ' ').toLowerCase() || 'source'}</span>}
    </>
  )

  return s.href
    ? <a className="src-row" href={s.href} target="_blank" rel="noreferrer">{inner}</a>
    : <div className="src-row">{inner}</div>
}
