/* =========================================================
   Watched reels — /reels/watched
   Per-user reel watch history (REELS_API §12.2-12.4): list,
   remove one entry, clear all. Newest first, paginated.
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, Avatar, showToast } from '../components/ui.jsx'
import { uiConfirm } from '../components/Dialog.jsx'
import { Loader, EmptyState } from '../components/states.jsx'
import { api } from '../api/index.js'

const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : null)

export function WatchedReelsPage() {
  const navigate = useNavigate()
  const [items, setItems] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const [page, setPage] = React.useState(0)
  const [hasMore, setHasMore] = React.useState(false)
  const [more, setMore] = React.useState(false)

  React.useEffect(() => {
    let alive = true
    api.reels.watched({ page: 0, size: 24 }).then(res => {
      if (!alive) return
      setItems(res.items); setHasMore(res.hasMore); setPage(0)
    }).catch(() => {}).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  const loadMore = () => {
    const next = page + 1
    setMore(true)
    api.reels.watched({ page: next, size: 24 })
      .then(res => { setItems(xs => [...xs, ...res.items]); setHasMore(res.hasMore); setPage(next) })
      .catch(() => {}).finally(() => setMore(false))
  }
  const remove = (id) => { setItems(xs => xs.filter(x => x.id !== id)); api.reels.deleteWatched(id).catch(() => {}) }
  const clearAll = async () => {
    const ok = await uiConfirm({ title:'Clear your watch history?', message:'Every reel you\'ve watched will be removed from this list. This cannot be undone.', confirmLabel:'Clear history', danger:true, icon:'close' })
    if (!ok) return
    setItems([]); setHasMore(false)
    api.reels.clearWatched().then(() => showToast('Watch history cleared')).catch(() => showToast('Could not clear history'))
  }

  return (
    <div className="main center">
      <div className="col-main">
        <div className="phead">
          <div>
            <h1>Watched <em>reels</em></h1>
            <p className="sub">Reels you’ve watched recently, newest first.</p>
          </div>
          {!!items.length && <button className="btn btn-secondary btn-sm" onClick={clearAll}><Icon name="close" className="sm"/>Clear all</button>}
        </div>

        {loading ? <Loader label="Loading watch history…"/>
          : !items.length ? <EmptyState icon="reels" title="No watch history yet" sub="Reels you watch will show up here."/>
          : (
            <>
              <div className="watched-grid">
                {items.map(w => (
                  <div key={w.id} className="watched-card">
                    <div className="watched-thumb" onClick={() => navigate(`/posts/${w.reelId}`)}>
                      {w.mediaUrl
                        ? <video src={w.mediaUrl} muted preload="metadata" playsInline/>
                        : <div className="watched-fallback"/>}
                      <span className="watched-play"><Icon name="play" className="lg"/></span>
                      {fmtDur(w.watchedSeconds) && <span className="watched-dur font-mono">{fmtDur(w.watchedSeconds)}</span>}
                      <button className="watched-x" title="Remove from history" onClick={(e) => { e.stopPropagation(); remove(w.id) }}><Icon name="close" className="xs"/></button>
                    </div>
                    <div className="watched-meta">
                      <Avatar initials={w._author.initials} color={w._author.avc} size={26} src={w._author.profileImage}/>
                      <div className="watched-info">
                        <div className="watched-title">{w.title || 'Reel'}</div>
                        <small className="muted">@{w._author.handle} · {w.time}</small>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {hasMore && <button className="btn btn-secondary btn-block mt-12" disabled={more} onClick={loadMore}>{more ? 'Loading…' : 'Load more'}</button>}
            </>
          )}
      </div>
    </div>
  )
}
