/* =========================================================
   Share sheet — one beautiful, consistent share surface for
   posts · research · Q&A. Opened imperatively:

     openShare({ kind, id, title, count, onShared })

   On open it previews the real ShareLinkInfo (GET share-link,
   no counter bump): { shortUrl, canonicalUrl, token, shareCount }.
   The first explicit copy/share action records the share
   (POST → bumps shareCount, notifies the author, broadcasts)
   and reports the new count back through onShared(newCount).
   ========================================================= */
/* eslint-disable react-refresh/only-export-components */
import React from 'react'
import { Icon, fmt, showToast } from './ui.jsx'
import { api } from '../api/index.js'

const PATH = { post: 'posts', research: 'research', question: 'qna' }
const SVC = {
  post:     { link: (id) => api.posts.shareLink(id),    record: (id, c) => api.posts.recordShare(id, c) },
  research: { link: (id) => api.research.shareLink(id), record: (id) => api.research.recordShare(id) },
  question: { link: (id) => api.qna.shareLink(id),      record: (id) => api.qna.recordShare(id) },
}

let openFn = null
let seq = 0

/** Open the share sheet. Falls back to a clipboard copy if no host is mounted.
 *  Pass `url` for surfaces whose response already carries a ready-to-share
 *  link (channels' /c/{handle}, live's /live/{id}) — no share-link API is
 *  fetched and no share is recorded for those. */
export function openShare(opts = {}) {
  if (openFn) openFn({ id: ++seq, ...opts })
  else {
    const url = opts.url || `${window.location.origin}/${PATH[opts.kind] || 'posts'}/${opts.id}`
    navigator.clipboard?.writeText(url).then(() => showToast('Link copied')).catch(() => {})
  }
}

export function ShareHost() {
  const [sheet, setSheet] = React.useState(null)
  React.useEffect(() => { openFn = (s) => setSheet(s); return () => { openFn = null } }, [])
  if (!sheet) return null
  return <ShareModal key={sheet.id} sheet={sheet} onClose={() => setSheet(null)}/>
}

function ShareModal({ sheet, onClose }) {
  const { kind, id, title, onShared } = sheet
  /* A DIRECT url (channels /c/{handle}, live /live/{id}) arrives ready-made
     on the response — there is no share-link service to consult and no share
     counter to record for those surfaces. */
  const direct = sheet.url || null
  const svc = SVC[kind] || SVC.post
  const [info, setInfo] = React.useState(null)
  const [count, setCount] = React.useState(typeof sheet.count === 'number' ? sheet.count : null)
  const [caption, setCaption] = React.useState('')
  const recorded = React.useRef(false)

  React.useEffect(() => {
    let alive = true
    if (!direct) {
      svc.link(id).then(r => { if (alive && r) { setInfo(r); if (typeof r.shareCount === 'number') setCount(r.shareCount) } }).catch(() => {})
    }
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => { alive = false; window.removeEventListener('keydown', onKey) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const url = direct || info?.canonicalUrl || info?.shortUrl || `${window.location.origin}/${PATH[kind] || 'posts'}/${id}`
  const shown = direct || info?.shortUrl || url

  // Record the share once per sheet (first explicit action), then sync the count.
  const record = () => {
    if (direct || recorded.current) return
    recorded.current = true
    svc.record(id, kind === 'post' ? (caption.trim() || undefined) : undefined)
      .then(r => {
        const c = r?.shareCount
        if (typeof c === 'number') { setCount(c); onShared?.(c) }
        else setCount(n => { const nx = (n ?? 0) + 1; onShared?.(nx); return nx })
      })
      .catch(() => {})
  }

  const copy = () => { navigator.clipboard?.writeText(url).then(() => showToast('Link copied')).catch(() => {}); record() }
  const nativeShare = () => {
    record()
    if (typeof navigator !== 'undefined' && navigator.share) navigator.share({ title: title || 'IKA', url }).catch(() => {})
    else copy()
  }
  const social = (href) => { record(); window.open(href, '_blank', 'noopener,noreferrer') }

  const enc = encodeURIComponent(url)
  const encT = encodeURIComponent(title || 'Shared from IKA')
  const SOCIAL = [
    { key: 'wa', label: 'WhatsApp', color: '#1faf54', icon: 'message', href: `https://wa.me/?text=${encT}%20${enc}` },
    { key: 'tg', label: 'Telegram', color: '#229ED9', icon: 'send',    href: `https://t.me/share/url?url=${enc}&text=${encT}` },
    { key: 'x',  label: 'X',        color: '#1c2330', icon: 'share',   href: `https://twitter.com/intent/tweet?url=${enc}&text=${encT}` },
    { key: 'em', label: 'Email',    color: '#8a93a3', icon: 'at',      href: `mailto:?subject=${encT}&body=${enc}` },
  ]
  const canNative = typeof navigator !== 'undefined' && !!navigator.share

  return (
    <div className="dlg-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dlg share-sheet" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <div className="dlg-head">
          <div className="dlg-ic"><Icon name="share"/></div>
          <h3 id="share-title">Share</h3>
          <button type="button" className="dlg-x" onClick={onClose} aria-label="Close"><Icon name="close" className="sm"/></button>
        </div>

        <div className="dlg-body">
          {title && <p className="share-title">{title}</p>}
          {count != null && <div className="share-count"><Icon name="share" className="xs"/>{fmt(count)} share{count === 1 ? '' : 's'}</div>}

          {kind === 'post' && (
            <textarea className="field share-caption" placeholder="Add a note (optional)…" value={caption} onChange={e => setCaption(e.target.value)}/>
          )}

          <div className="share-grid">
            <button type="button" className="share-act" onClick={copy}>
              <span className="sa-ic" style={{ background: 'var(--emerald)' }}><Icon name="link"/></span>Copy link
            </button>
            {canNative && (
              <button type="button" className="share-act" onClick={nativeShare}>
                <span className="sa-ic" style={{ background: 'var(--ink-2)' }}><Icon name="share"/></span>Share…
              </button>
            )}
            {SOCIAL.map(s => (
              <button type="button" key={s.key} className="share-act" onClick={() => social(s.href)}>
                <span className="sa-ic" style={{ background: s.color }}><Icon name={s.icon}/></span>{s.label}
              </button>
            ))}
          </div>

          <div className="share-link-row">
            <input className="field share-url" readOnly value={shown} onFocus={e => e.target.select()} aria-label="Share link"/>
            <button type="button" className="btn btn-primary" onClick={copy}><Icon name="check" className="sm"/>Copy</button>
          </div>
        </div>
      </div>
    </div>
  )
}
