/* =========================================================
   Reels — full-screen vertical viewer (live).
   • For you  → global reels discover feed   (FEED_API §6, reels_by_day)
   • Following → home timeline, reels only    (FEED_API §4, feed_by_user)
   Plays the actual reel <video> with a bottom playback progress bar,
   records reel-watch views, toggles reactions/saves through the API.
   ========================================================= */
import React from 'react'
import { useNavigate, NavLink } from 'react-router-dom'
import { Icon, Avatar, Verify, linkify, fmt, showToast } from './ui.jsx'
import { uiPrompt } from './Dialog.jsx'
import { authorOf } from '../lib/userView.js'
import { useAuth } from '../context/AuthContext.jsx'
import { api } from '../api/index.js'

export function Reels({ onClose, initialId }) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [followed, setFollowed] = React.useState({})   // authorId → following?
  const [tab, setTab] = React.useState('FOR_YOU')   // FOR_YOU | FOLLOWING
  const [reels, setReels] = React.useState([])
  const [idx, setIdx] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [muted, setMuted] = React.useState(true)    // autoplay policy → start muted
  const [playing, setPlaying] = React.useState(true)
  const [videoErr, setVideoErr] = React.useState(false)
  const [progress, setProgress] = React.useState(0) // 0..1 of the active clip
  const videoRef = React.useRef(null)

  // Load the list for the active tab. Prefer the dedicated ranked / following
  // endpoints, but ALWAYS fall back so existing reels never read "No reels yet":
  //   For you   → ranked /reels/for-you, else walk the day-bucket discover feed
  //   Following → /reels/following, else home-feed filtered to reels
  React.useEffect(() => {
    let alive = true
    setLoading(true); setIdx(0)
    ;(async () => {
      // deep-linked reel (/reels/:id) → fetch it and show it first
      let head = []
      if (initialId) { try { const r = await api.posts.get(initialId); if (r) head = [r] } catch { /* fall back to feed */ } }

      let list = []
      if (tab === 'FOLLOWING') {
        try { list = await api.reels.following() } catch { /* fall through */ }
        if (!list?.length) {
          try { const feed = await api.posts.feed({ limit: 50 }); list = (feed || []).filter(r => r.type === 'REEL') } catch { /* ignore */ }
        }
      } else {
        try { list = await api.reels.forYou() } catch { /* fall through */ }
        if (!list?.length) {
          // FEED_API §6 — no cross-day cursor, so walk UTC day buckets back.
          const day = new Date()
          for (let back = 0; back <= 14 && alive && !list?.length; back++) {
            const iso = day.toISOString().slice(0, 10)
            try { const r = await api.reels.feed({ day: iso }); if (r?.length) list = r } catch { /* try previous day */ }
            day.setUTCDate(day.getUTCDate() - 1)
          }
        }
      }
      const seen = new Set(head.map(x => x.id))
      if (alive) { setReels([...head, ...(list || []).filter(x => !seen.has(x.id))]); setLoading(false) }
    })()
    return () => { alive = false }
  }, [tab, initialId])

  const reel = reels[idx]
  const m0 = reel?.media?.[0]
  const videoUrl = m0 && m0.type === 'VIDEO' ? m0.url : null
  const u = reel ? authorOf(reel) : null

  // Old rows have no videoUrl and may carry an image cover → on load error,
  // hydrate the full post once (mediaUrls/mediaTypes have the real VIDEO).
  const hydrated = React.useRef(new Set())
  const onVideoError = () => {
    if (reel && !hydrated.current.has(reel.id)) {
      hydrated.current.add(reel.id)
      api.posts.get(reel.id)
        .then(full => {
          const vid = (full.media || []).find(m => m.type === 'VIDEO' && m.url)
          if (vid) patch(r => ({ ...r, media: [vid] }))   // re-renders → video retries
          else setVideoErr(true)
        })
        .catch(() => setVideoErr(true))
    } else setVideoErr(true)
  }

  // Reel-watch view (§13.1/§26) + reset transient video state on reel change.
  const seenAt = React.useRef(0)
  React.useEffect(() => {
    seenAt.current = Date.now()
    setVideoErr(false); setPlaying(true); setProgress(0)
    if (reel) api.posts.recordView(reel.id).catch(() => {})   // counts the view (§11) — watch ≠ view
    return () => {
      if (reel) {
        const watched = Math.round((Date.now() - seenAt.current) / 1000)
        api.reels.recordWatch(reel.id, watched).catch(() => {})   // watch-history session (§12.1)
      }
    }
  }, [reel?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // keep the element's muted prop authoritative (React's `muted` attr is flaky)
  React.useEffect(() => { if (videoRef.current) videoRef.current.muted = muted }, [muted, reel?.id])

  const togglePlay = () => {
    const v = videoRef.current; if (!v) return
    if (v.paused) v.play().then(() => setPlaying(true)).catch(() => {})
    else { v.pause(); setPlaying(false) }
  }
  const toggleMute = () => setMuted(m => !m)
  const onTime = (e) => { const v = e.target; if (v.duration) setProgress(v.currentTime / v.duration) }
  const seek = (e) => {
    const v = videoRef.current; if (!v || !v.duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    try { v.currentTime = frac * v.duration } catch { /* needs a buffered/range-capable source */ }
  }

  const patch = (fn) => setReels(rs => rs.map((r, i) => i === idx ? fn(r) : r))
  const like = () => {
    const was = reel.liked
    patch(r => ({ ...r, liked: !r.liked, likes: r.likes + (r.liked ? -1 : 1) }))
    api.posts.toggleReaction(reel.id).catch(() => patch(r => ({ ...r, liked: was, likes: r.likes + (was ? 1 : -1) })))   // roll back
  }
  const save = () => {
    const was = reel.saved
    patch(r => ({ ...r, saved: !r.saved, saves: r.saves + (r.saved ? -1 : 1) }))
    showToast(was ? 'Removed from saved' : 'Saved')
    api.posts.toggleSave(reel.id)
      .then(res => { if (res && typeof res.saved === 'boolean') patch(r => ({ ...r, saved: res.saved })) })
      .catch(() => { patch(r => ({ ...r, saved: was, saves: r.saves + (was ? 1 : -1) })); showToast('Could not update saved') })
  }
  // §16 — append-only share ledger + copy the reel link
  const share = () => {
    patch(r => ({ ...r, shares: r.shares + 1 }))
    navigator.clipboard?.writeText(`${window.location.origin}/posts/${reel.id}`).catch(() => {})
    showToast('Link copied & shared')
    api.posts.share(reel.id).catch(() => {})
  }
  // REPOST — a new post that references this reel (§6.1); self-repost allowed (§28)
  const repost = async () => {
    const caption = await uiPrompt({ title:'Repost to your profile', label:'Add a note (optional)', placeholder:'Why is this worth sharing?', multiline:true, icon:'repost', confirmLabel:'Repost' })
    if (caption === null) return   // cancelled
    api.posts.create({ postType: 'REPOST', visibility: 'PUBLIC', sharedPostId: reel.id, textContent: caption || '', mediaUrls: [], mediaTypes: [] })
      .then(() => showToast('Reposted to your profile'))
      .catch(() => showToast('Could not repost'))
  }
  const step = (d) => setIdx(i => Math.max(0, Math.min(reels.length - 1, i + d)))
  // Vertical swipe → next/prev (the chevron .rv-nav is hidden on phones). A small
  // delta is a tap (handled by the video's togglePlay), so only act past ~44px.
  const touchY = React.useRef(null)
  const onTouchStart = (e) => { touchY.current = e.touches[0]?.clientY ?? null }
  const onTouchEnd = (e) => {
    if (touchY.current == null) return
    const dy = (e.changedTouches[0]?.clientY ?? touchY.current) - touchY.current
    touchY.current = null
    if (dy < -44) step(1)            // swipe up → next reel
    else if (dy > 44) step(-1)       // swipe down → previous reel
  }
  const isSelf = !!(reel && user?.id && String(reel.author) === String(user.id))
  const goAuthor = () => { if (reel?.author) { navigate(`/u/${reel.author}`); onClose?.() } }
  const followAuthor = () => {
    const id = reel.author, now = !followed[id]
    setFollowed(f => ({ ...f, [id]: now }))
    ;(now ? api.users.follow(id) : api.users.unfollow(id)).catch(() => setFollowed(f => ({ ...f, [id]: !now })))
  }

  return (
    <div className="reels-view">
      <div className="rv-top">
        <button className={'rv-tab ' + (tab === 'FOR_YOU' ? 'on' : '')} onClick={() => setTab('FOR_YOU')}>For you</button>
        <button className={'rv-tab ' + (tab === 'FOLLOWING' ? 'on' : '')} onClick={() => setTab('FOLLOWING')}>Following</button>
        <button className="rv-close" onClick={onClose}><Icon name="close"/></button>
      </div>

      {loading ? (
        <div className="rv-stage" style={{ color:'#fff' }}>Loading reels…</div>
      ) : !reel ? (
        <div className="rv-stage" style={{ color:'#fff' }}>
          <div style={{ textAlign:'center' }}>{tab === 'FOLLOWING' ? 'No reels from people you follow yet.' : 'No reels yet.'}</div>
        </div>
      ) : (
        <div className="rv-stage" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          <div className="rv-card">
            {videoUrl && !videoErr ? (
              <video
                key={reel.id} ref={videoRef} className="rv-video" src={videoUrl} poster={m0?.poster || undefined}
                autoPlay loop playsInline muted={muted} preload="auto" onClick={togglePlay}
                onTimeUpdate={onTime} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
                onError={onVideoError}
                style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover', background:'#000', cursor:'pointer' }}
              />
            ) : (
              <>
                <div className="rv-bg" style={{ background: m0?.bg || 'linear-gradient(160deg,#1f3a4a,#070d0b)' }}/>
                <div className="rv-center">{reel.body?.slice(0, 80)}</div>
              </>
            )}

            {/* paused glyph — non-interactive so it never blocks the rail */}
            {videoUrl && !videoErr && !playing && (
              <div style={{ position:'absolute', inset:0, display:'grid', placeItems:'center', zIndex:2, pointerEvents:'none' }}>
                <span style={{ width:64, height:64, borderRadius:'50%', background:'rgba(0,0,0,.55)', display:'grid', placeItems:'center', color:'#fff' }}><Icon name="play" className="lg"/></span>
              </div>
            )}

            {/* mute toggle */}
            {videoUrl && !videoErr && (
              <button className="rv-mute" onClick={toggleMute} title={muted ? 'Unmute' : 'Mute'}>
                <Icon name={muted ? 'mute' : 'volume'} className="sm"/>
              </button>
            )}

            <div className="rv-meta">
              <div className="rvm-author">
                <span role="button" style={{ cursor:'pointer' }} onClick={goAuthor}><Avatar initials={u.initials} color={u.avc} size={40}/></span>
                <div role="button" style={{ cursor:'pointer' }} onClick={goAuthor}>
                  <div className="rvm-name"><b>@{u.handle}</b>{u.verified && <Verify scholar={u.role==='SCHOLAR'}/>}</div>
                  <div className="rvm-time">{reel.time} · {fmt(reel.views)} views</div>
                </div>
                {!isSelf && <button className="rvm-follow" onClick={followAuthor}>{followed[reel.author] ? 'Following' : 'Follow'}</button>}
              </div>
              <p className="rvm-caption">{linkify(reel.body)}</p>
              <div className="rvm-sound"><Icon name="music" className="xs"/>Original audio</div>
            </div>

            <div className="rv-rail">
              <button className={'rvr ' + (reel.liked ? 'on' : '')} onClick={like}>
                <span><Icon name="heart" className="lg"/></span><small className="font-mono">{fmt(reel.likes)}</small>
              </button>
              <button className="rvr">
                <span><Icon name="comment" className="lg"/></span><small className="font-mono">{fmt(reel.comments)}</small>
              </button>
              <button className={'rvr ' + (reel.saved ? 'sv' : '')} onClick={save}>
                <span><Icon name="bookmark" className="lg"/></span><small className="font-mono">{fmt(reel.saves)}</small>
              </button>
              <button className="rvr" onClick={repost}>
                <span><Icon name="repost" className="lg"/></span><small>Repost</small>
              </button>
              <button className="rvr" onClick={share}>
                <span><Icon name="share" className="lg"/></span><small className="font-mono">{fmt(reel.shares)}</small>
              </button>
            </div>

            {/* playback timeline — pinned to the bottom of the reel */}
            {videoUrl && !videoErr && (
              <div className="rv-seek" onClick={seek}>
                <div className="rv-seek-track"><div className="rv-seek-fill" style={{ width:`${Math.round(progress * 100)}%` }}/></div>
              </div>
            )}
          </div>

          <div className="rv-nav">
            <button onClick={() => step(-1)} disabled={idx===0}><Icon name="chevup"/></button>
            <button onClick={() => step(1)} disabled={idx===reels.length-1}><Icon name="chevdown"/></button>
          </div>
        </div>
      )}

      {/* Mobile-only glass tab bar — the real botnav is covered by this overlay,
          so mirror it here so reels is never a navigational dead-end. */}
      <nav className="rv-mtabbar">
        <NavLink to="/" end aria-label="Home"><Icon name="home"/><small>Home</small></NavLink>
        <NavLink to="/explore" aria-label="Explore"><Icon name="search"/><small>Explore</small></NavLink>
        <a className="mid" onClick={() => window.dispatchEvent(new CustomEvent('ika:compose', { detail:'TEXT' }))} aria-label="Create">
          <span className="plus"><Icon name="compose"/></span>
        </a>
        <NavLink to="/qna" aria-label="Q&A"><Icon name="qna"/><small>Q&amp;A</small></NavLink>
        <NavLink to="/profile" aria-label="Profile"><Icon name="user"/><small>You</small></NavLink>
      </nav>
    </div>
  )
}
