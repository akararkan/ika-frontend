/* =========================================================
   PostCard + PostMedia — presentational, live-data.
   Author comes from the adapter-attached `_author`.
   ========================================================= */
import React from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Icon, Verify, Avatar, linkify, fmt, showToast } from './ui.jsx'
import { uiPrompt } from './Dialog.jsx'
import { VoicePlayer } from './VoicePlayer.jsx'
import { authorOf } from '../lib/userView.js'
import { api } from '../api/index.js'

/* REPOST = a new post referencing the original (POST_API §6.1); self-repost
   allowed (§28). Optional caption. Shared by the card button + ⋯ menu. */
async function doRepost(post) {
  const caption = await uiPrompt({ title:'Repost to your profile', label:'Add a note (optional)', placeholder:'Why is this worth sharing?', multiline:true, icon:'repost', confirmLabel:'Repost' })
  if (caption === null) return
  api.posts.create({ postType: 'REPOST', visibility: 'PUBLIC', sharedPostId: post.id, textContent: caption || '', mediaUrls: [], mediaTypes: [] })
    .then(() => showToast('Reposted to your profile'))
    .catch(() => showToast('Could not repost'))
}

/* ⋯ menu — Copy link (anyone) + Edit/Delete (author-only, per the
   🟡 author-only rule on PATCH §6.4 / DELETE §6.5). Rendered through
   a portal into <body> so the post card's `overflow:hidden` (rounded
   media clip) and any ancestor transforms (`.rise` animation) cannot
   crop the dropdown. Position is computed from the trigger's bounding
   rect and flips above when room below is tight. */
function PostMenu({ post, owner, onEdit, onDelete }) {
  const [open, setOpen] = React.useState(false)
  const [pos, setPos] = React.useState(null)   // { top, right } in viewport coords
  const btnRef = React.useRef(null)
  const item = { display:'flex', alignItems:'center', gap:10, width:'100%', padding:'9px 12px', borderRadius:9, background:'transparent', color:'var(--ink)', fontSize:14, textAlign:'left', cursor:'pointer', border:0 }

  const itemCount = 2 + (owner && onEdit ? 1 : 0) + (owner && onDelete ? 1 : 0)
  const ESTIMATED_H = 8 + 36 * itemCount   // padding + row count

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const vh = window.innerHeight, gap = 6
    const below = vh - r.bottom
    const dropUp = below < ESTIMATED_H + gap && r.top > below
    setPos({
      top: dropUp ? Math.max(8, r.top - ESTIMATED_H - gap) : r.bottom + gap,
      right: Math.max(8, window.innerWidth - r.right),
    })
  }

  const toggle = (e) => {
    e.stopPropagation()
    if (open) { setOpen(false); return }
    place(); setOpen(true)
  }
  const close = () => setOpen(false)

  React.useEffect(() => {
    if (!open) return
    const reposition = () => place()
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const copyLink = () => {
    navigator.clipboard?.writeText(`${window.location.origin}/posts/${post.id}`).catch(() => {})
    showToast('Link copied'); close()
  }

  return (
    <div style={{ position:'relative' }}>
      <button ref={btnRef} className="icon-btn" onClick={toggle} aria-label="Post options" aria-haspopup="menu" aria-expanded={open}>
        <Icon name="more"/>
      </button>
      {open && pos && createPortal(
        <>
          <div onClick={close} style={{ position:'fixed', inset:0, zIndex:1000, background:'transparent' }}/>
          <div role="menu" style={{
            position:'fixed', top:pos.top, right:pos.right, zIndex:1001,
            minWidth:184, background:'var(--card)', border:'1px solid var(--line)',
            borderRadius:12, boxShadow:'0 14px 34px rgba(0,0,0,.28)', padding:4,
          }}>
            <button style={item} onClick={copyLink}><Icon name="link" className="sm"/>Copy link</button>
            <button style={item} onClick={() => { close(); doRepost(post) }}><Icon name="repost" className="sm"/>Repost</button>
            {owner && onEdit && <button style={item} onClick={() => { close(); onEdit(post.id) }}><Icon name="compose" className="sm"/>Edit post</button>}
            {owner && onDelete && <button style={{ ...item, color:'var(--rose, #c2453f)' }} onClick={() => { close(); onDelete(post.id) }}><Icon name="close" className="sm"/>Delete post</button>}
          </div>
        </>,
        document.body
      )}
    </div>
  )
}

/* Full-screen image viewer — opens on tapping a post image. Arrow keys /
   on-screen chevrons cycle multi-image posts; click backdrop or Esc closes. */
function Lightbox({ images, index, onClose }) {
  const [i, setI] = React.useState(index)
  React.useEffect(() => setI(index), [index])
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') setI(x => (x + 1) % images.length)
      else if (e.key === 'ArrowLeft') setI(x => (x - 1 + images.length) % images.length)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [images.length, onClose])
  if (!images.length) return null
  const step = (d, e) => { e.stopPropagation(); setI(x => (x + d + images.length) % images.length) }
  return (
    <div className="lightbox" onClick={onClose}>
      <button className="lb-close" onClick={onClose} aria-label="Close"><Icon name="close"/></button>
      {images.length > 1 && <button className="lb-nav lb-prev" onClick={e => step(-1, e)} aria-label="Previous"><Icon name="chevleft"/></button>}
      <img src={images[i]} alt="" className="lb-img" onClick={e => e.stopPropagation()}/>
      {images.length > 1 && <button className="lb-nav lb-next" onClick={e => step(1, e)} aria-label="Next"><Icon name="chevright"/></button>}
      {images.length > 1 && <div className="lb-count">{i + 1} / {images.length}</div>}
    </div>
  )
}

/* Embed the ORIGINAL post under a repost (POST_ENGAGEMENT §4). Feed items
   don't carry sharedPostId, so resolve it from the full post when missing,
   then hydrate the original. Tapping opens the original. */
function RepostEmbed({ post }) {
  const navigate = useNavigate()
  const [orig, setOrig] = React.useState(undefined)   // undefined = loading, null = unavailable
  React.useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        let sid = post.sharedPostId
        if (!sid) { const full = await api.posts.get(post.id); sid = full.sharedPostId }
        if (!sid) { if (alive) setOrig(null); return }
        const o = await api.posts.get(sid)
        if (alive) setOrig(o)
      } catch { if (alive) setOrig(null) }
    })()
    return () => { alive = false }
  }, [post.id, post.sharedPostId])

  if (orig === undefined) return <div className="post-repost"><p className="rp-body muted">Loading original…</p></div>
  if (!orig) return <div className="post-repost"><p className="rp-body muted">Original post is unavailable.</p></div>
  const u = orig._author || authorOf(orig)
  const m = orig.media?.[0]
  return (
    <div className="post-repost" role="button" style={{ cursor:'pointer' }} onClick={() => navigate(`/posts/${orig.id}`)}>
      <div className="rp-head">
        <Avatar initials={u.initials} color={u.avc} size={28} src={u.profileImage}/>
        <span className="rp-name">{u.full}</span>
        {u.verified && <Verify scholar={u.role === 'SCHOLAR'}/>}
        <span className="rp-time">· {orig.time}</span>
      </div>
      {orig.body && <p className="rp-body">{linkify(orig.body)}</p>}
      {m && (m.type === 'IMAGE' || m.type === 'VIDEO') && (
        <div className="rp-media ph-bg" style={{ background: m.bg }}>{m.type === 'VIDEO' && <span className="pm-play"><Icon name="play"/></span>}</div>
      )}
    </div>
  )
}

function PostMedia({ post, onOpenReel, onOpenImage }) {
  if (post.type === 'VOICE_POST') {
    return <VoicePlayer src={post.audioUrl} duration={post.media?.[0]?.duration}/>
  }
  if (post.type === 'REPOST') {
    return <RepostEmbed post={post}/>
  }
  // REEL → a tappable cover that opens the full-screen reels viewer for THIS reel
  if (post.type === 'REEL' && post.media?.length) {
    const m = post.media[0]
    return (
      <div className="post-media count-1">
        <button className="pm-cell pm-reel" onClick={onOpenReel} aria-label="Watch reel">
          {m.url
            ? <video src={m.url} muted preload="metadata" playsInline className="pm-reel-cover"/>
            : <span className="pm-reel-bg" style={{ background: m.bg }}/>}
          <span className="pm-play"><Icon name="play" className="lg"/></span>
          <span className="pm-reel-badge"><Icon name="reels" className="xs"/>Reel</span>
        </button>
      </div>
    )
  }
  if (post.media?.length) {
    return (
      <div className={'post-media count-' + post.media.length}>
        {post.media.map((m, i) => (
          m.type === 'VIDEO' && m.url ? (
            <div key={i} className="pm-cell" style={{ aspectRatio: m.ratio || '16/10', background:'#000' }}>
              <video src={m.url} controls playsInline preload="metadata"
                style={{ width:'100%', height:'100%', objectFit:'cover', display:'block' }}/>
            </div>
          ) : (
            <div key={i} className="pm-cell ph-bg" data-label={m.label} style={{ background: m.bg, aspectRatio: m.ratio || '16/10', cursor: m.type === 'IMAGE' && m.url ? 'zoom-in' : undefined }}
              onClick={m.type === 'IMAGE' && m.url ? () => onOpenImage(m.url) : undefined}>
              {m.type === 'VIDEO' && <button className="pm-play"><Icon name="play"/></button>}
            </div>
          )
        ))}
      </div>
    )
  }
  return null
}

export function PostCard({ post, onLike, onSave, onShare, index = 0, onOpenComments, owner = false, onEdit, onDelete, observeView = true }) {
  const u = authorOf(post)
  const navigate = useNavigate()
  const goAuthor = () => post.author && navigate(`/u/${post.author}`)
  const [lightbox, setLightbox] = React.useState(null)
  const imgs = React.useMemo(() => (post.media || []).filter(m => m.type === 'IMAGE' && m.url).map(m => m.url), [post.media])
  const openImage = (url) => setLightbox(Math.max(0, imgs.indexOf(url)))
  const openReel = () => navigate(`/reels/${post.id}`)

  // Record a view once the card is meaningfully visible (≥50% for ~1s),
  // then seed the label from the authoritative viewCount (POST_ENGAGEMENT §2).
  const [views, setViews] = React.useState(post.views || 0)
  React.useEffect(() => { setViews(post.views || 0) }, [post.views])
  const cardRef = React.useRef(null)
  const viewedRef = React.useRef(false)
  React.useEffect(() => {
    if (!observeView) return
    const el = cardRef.current
    if (!el || viewedRef.current) return
    let timer
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && e.intersectionRatio >= 0.5) {
        timer = setTimeout(() => {
          if (viewedRef.current) return
          viewedRef.current = true; io.disconnect()
          api.posts.recordView(post.id).then(r => { if (r?.viewCount != null) setViews(r.viewCount) }).catch(() => {})
        }, 1000)
      } else clearTimeout(timer)
    }, { threshold: [0, 0.5, 1] })
    io.observe(el)
    return () => { clearTimeout(timer); io.disconnect() }
  }, [post.id, observeView])
  return (
    <article ref={cardRef} className="post-card rise" style={{ animationDelay: `${index * 60}ms` }}>
      <header className="pc-head">
        <span role="button" onClick={goAuthor} style={{ cursor:'pointer' }}>
          <Avatar initials={u.initials} color={u.avc} size={42} src={u.profileImage}/>
        </span>
        <div className="pc-who">
          <div className="pc-line" role="button" onClick={goAuthor} style={{ cursor:'pointer' }}>
            <b>{u.full}</b>
            {u.verified && <Verify scholar={u.role === 'SCHOLAR'}/>}
            {u.role === 'SCHOLAR' && <span className="pill scholar">Scholar</span>}
            {u.role === 'RESEARCHER' && <span className="pill role">Researcher</span>}
          </div>
          <div className="pc-meta">
            <span role="button" onClick={goAuthor} style={{ cursor:'pointer' }}>@{u.handle}</span>
            <span className="pc-dot"/>
            <span>{post.time}</span>
            <span className="pc-dot"/>
            <span className="pc-vis">
              <Icon name={post.visibility === 'PUBLIC' ? 'globe' : post.visibility === 'FOLLOWERS' ? 'users' : 'lock'} className="xs"/>
              {post.visibility === 'PUBLIC' ? 'Public' : post.visibility === 'FOLLOWERS' ? 'Followers' : 'Only me'}
            </span>
          </div>
        </div>
        <PostMenu post={post} owner={owner} onEdit={onEdit} onDelete={onDelete}/>
      </header>

      {post.body && <div className="pc-body">{linkify(post.body)}</div>}
      {post.location && (
        <div className="pc-loc"><Icon name="pin" className="xs"/>{post.location}</div>
      )}

      <PostMedia post={post} onOpenReel={openReel} onOpenImage={openImage}/>

      <div className="pc-stats">
        <span className="ps-likes">
          <span className="ps-heart"><Icon name="heart" className="xs"/></span>
          <span>{fmt(post.likes)}</span>
        </span>
        <span className="ps-right">
          <span>{fmt(post.comments)} comments</span>
          <span>{fmt(views)} views</span>
          <span>{fmt(post.shares)} shares</span>
        </span>
      </div>

      <div className="pc-actions">
        <button className={'pca ' + (post.liked ? 'on' : '')} onClick={() => onLike?.(post.id)}>
          <Icon name="heart"/><span>Like</span>
        </button>
        <button className="pca" onClick={() => onOpenComments?.(post.id)}>
          <Icon name="comment"/><span>Comment</span>
        </button>
        <button className="pca" onClick={() => doRepost(post)}>
          <Icon name="repost"/><span>Repost</span>
        </button>
        <button className="pca" onClick={() => onShare?.(post.id)}>
          <Icon name="share"/><span>Share</span>
        </button>
        <button className={'pca ' + (post.saved ? 'saved' : '')} onClick={() => onSave?.(post.id)}>
          <Icon name="bookmark"/><span>Save</span>
        </button>
      </div>

      {lightbox !== null && <Lightbox images={imgs} index={lightbox} onClose={() => setLightbox(null)}/>}
    </article>
  )
}
