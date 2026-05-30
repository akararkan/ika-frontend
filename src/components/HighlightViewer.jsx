/* =========================================================
   HighlightViewer — plays a highlight's archived stories.
   Highlights are permanent snapshots (StoryInHighlightEntity) that
   survive the 24h story TTL. Reuses the .reels-view/.rv-* chrome.
   ========================================================= */
import React from 'react'
import { Icon, Avatar, showToast } from './ui.jsx'
import { uiConfirm } from './Dialog.jsx'
import { api, adapters, assetUrl } from '../api/index.js'

export function HighlightViewer({ highlight, author, owner, onClose }) {
  const [items, setItems] = React.useState(null)
  const [idx, setIdx] = React.useState(0)
  const u = author || { full: 'Member', handle: 'member', initials: '··', avc: 'linear-gradient(160deg,#1fb98e,#0a4a3c)' }

  React.useEffect(() => {
    let alive = true
    api.highlights.stories(highlight.id).then(rows => {
      if (!alive) return
      setItems((rows || []).map(r => ({
        id: r.storyId, createdAt: r.createdAt, type: r.storyType,
        bg: r.mediaUrl ? `center/cover no-repeat url("${assetUrl(r.mediaUrl)}")` : 'linear-gradient(160deg,#1fb98e,#0a4a3c)',
        text: r.textContent || '', hasMedia: !!r.mediaUrl, time: adapters.timeAgo(r.createdAt),
      })))
    }).catch(() => { if (alive) setItems([]) })
    return () => { alive = false }
  }, [highlight.id])

  const item = items?.[idx]
  // Auto-advance through the archive.
  React.useEffect(() => {
    if (!item) return
    const t = setTimeout(() => { if (idx + 1 >= items.length) onClose(); else setIdx(idx + 1) }, 6000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, items])

  if (items == null) return <div className="reels-view is-story" style={{ display:'grid', placeItems:'center', color:'#fff' }}>Loading…<button className="rv-close" onClick={onClose} style={{ position:'absolute', top:18, right:22 }}><Icon name="close"/></button></div>
  if (!items.length) { onClose(); return null }

  const step = (d) => { const n = idx + d; if (n < 0) return; if (n >= items.length) { onClose(); return } setIdx(n) }
  const removeCurrent = async () => {
    const ok = await uiConfirm({ title:'Remove from highlight?', message:'This removes this story from the highlight. The highlight itself stays.', confirmLabel:'Remove', danger:true, icon:'trash' })
    if (!ok) return
    const sid = item.id, ca = item.createdAt
    api.highlights.removeStory(highlight.id, sid, ca).then(() => showToast('Removed')).catch(() => showToast('Could not remove'))
    const remaining = items.filter(x => x.id !== sid)
    if (!remaining.length) { onClose(); return }
    setItems(remaining); setIdx(i => Math.min(i, remaining.length - 1))
  }

  return (
    <div className="reels-view is-story">
      <div className="rv-top">
        <div className="rvm-author" style={{ margin:0 }}>
          <Avatar initials={u.initials} color={u.avc} size={36} src={u.profileImage}/>
          <div>
            <div className="rvm-name"><b>{highlight.title}</b></div>
            <div className="rvm-time">{item.time} ago · highlight</div>
          </div>
        </div>
        {owner && <button className="rv-close" style={{ marginLeft:'auto' }} onClick={removeCurrent} title="Remove from highlight"><Icon name="trash"/></button>}
        <button className="rv-close" onClick={onClose}><Icon name="close"/></button>
      </div>

      <div className="rv-progress">
        {items.map((_, i) => <i key={i} className={i < idx ? 'done' : i === idx ? 'cur' : ''}/>)}
      </div>

      <div className="rv-stage">
        <div className="rv-card">
          <div className="rv-bg" style={{ background: item.bg }}/>
          {item.text && !item.hasMedia && <div className="rv-center">{item.text}</div>}
        </div>
        <div className="rv-nav">
          <button onClick={() => step(-1)} disabled={idx === 0}><Icon name="chevup"/></button>
          <button onClick={() => step(1)}><Icon name="chevdown"/></button>
        </div>
      </div>
    </div>
  )
}
