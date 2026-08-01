/* =========================================================
   PostCard + PostMedia — presentational, live-data.
   Author comes from the adapter-attached `_author`.
   ========================================================= */
import React from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Icon, Verify, Avatar, linkify, fmt, showToast } from './ui.jsx'
import { openShare } from './ShareSheet.jsx'
import { openReport } from './ReportDialog.jsx'
import { uiPrompt } from './Dialog.jsx'
import OrbitPlayer from './OrbitPlayer.jsx'
import { PlayableVideo } from './PlayableVideo.jsx'
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

  const itemCount = 2 + (owner ? 0 : 1) + (owner && onEdit ? 1 : 0) + (owner && onDelete ? 1 : 0)
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
            {!owner && <button style={item} onClick={() => { close(); openReport({ targetType:'POST', targetId:post.id, targetLabel:'this post' }) }}><Icon name="flag" className="sm"/>Report post</button>}
            {owner && onEdit && <button style={item} onClick={() => { close(); onEdit(post.id) }}><Icon name="compose" className="sm"/>Edit post</button>}
            {owner && onDelete && <button style={{ ...item, color:'var(--rose, #b3453e)' }} onClick={() => { close(); onDelete(post.id) }}><Icon name="close" className="sm"/>Delete post</button>}
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

  if (orig === undefined) return <div className="post-repost is-note"><p className="rp-body muted">Loading original…</p></div>
  if (!orig) return <div className="post-repost is-note"><p className="rp-body muted">Original post is unavailable.</p></div>
  const u = orig._author || authorOf(orig)
  const media = (orig.media || []).filter(x => x.url)
  const m = media[0]
  const extra = media.length - 1
  const isReel = orig.type === 'REEL'
  const isVoice = orig.type === 'VOICE_POST'
  const go = () => navigate(`/posts/${orig.id}`)
  return (
    <div
      className="post-repost"
      role="button"
      tabIndex={0}
      aria-label={`View the original post by ${u.full}`}
      onClick={go}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go() } }}
    >
      <div className="rp-head">
        <Avatar initials={u.initials} color={u.avc} size={20} src={u.profileImage}/>
        <span className="rp-name">{u.full}</span>
        {u.verified && <Verify scholar={u.role === 'SCHOLAR'}/>}
        <span className="rp-handle">@{u.handle}</span>
        <span className="rp-time">· {orig.time}</span>
        {/* names the box: this is the ORIGINAL a repost is carrying */}
        <Icon name="repost" className="rp-mark xs"/>
      </div>
      {orig.body && <p className="rp-body">{linkify(orig.body)}</p>}
      {isVoice ? (
        <span className="rp-chip"><Icon name="mic" className="xs"/>Voice note</span>
      ) : m && (
        /* The REAL media, not a tinted placeholder: an image shows itself, a
           video shows its poster (or its own first frame via preload=metadata
           when no poster exists). Play/Reel badges + a +N flag for albums. */
        <div className="rp-media" style={{ aspectRatio: m.ratio || '16/10' }}>
          {m.type === 'VIDEO'
            ? <video className="rp-thumb" src={m.url} poster={m.poster || undefined} preload="metadata" muted playsInline tabIndex={-1} aria-hidden="true"/>
            : <img className="rp-thumb" src={m.url} alt="" loading="lazy"/>}
          {m.type === 'VIDEO' && <span className="rp-play" aria-hidden="true"><Icon name="play"/></span>}
          {isReel && <span className="rp-flag"><Icon name="reels" className="xs"/>Reel</span>}
          {extra > 0 && <span className="rp-more">+{extra}</span>}
        </div>
      )}
    </div>
  )
}

/* Voice post → the user's OrbitPlayer, VERBATIM (see OrbitPlayer.jsx). This
   wrapper only supplies what the call site owes it: feed items arrive without
   the audio URL, so it is resolved on mount (OrbitPlayer fetches+decodes its
   src up front), and the fixed-width mock card (size+100) is centered in the
   post. `title=""` keeps the mock's card top-padding without an "Untitled"
   heading — the post header above already names the author. */
function VoicePostOrbit({ post }) {
  const [url, setUrl] = React.useState(post.audioUrl || null)
  React.useEffect(() => {
    if (post.audioUrl) { setUrl(post.audioUrl); return undefined }
    let alive = true
    api.posts.get(post.id).then(p => { if (alive && p?.audioUrl) setUrl(p.audioUrl) }).catch(() => {})
    return () => { alive = false }
  }, [post.id, post.audioUrl])
  return (
    <div style={{ margin: '0 16px 14px' }}>
      {url
        // flush: the player IS part of the post — no inner card border, full
        // width, times at the post edges (the user's original mock layout).
        ? <OrbitPlayer src={url} title="" size={300} flush/>
        // Same footprint while the URL resolves, so the card doesn't jump.
        : <div style={{ height: 345 }}/>}
    </div>
  )
}

function PostMedia({ post, onOpenReel, onOpenImage }) {
  if (post.type === 'VOICE_POST') {
    return <VoicePostOrbit post={post}/>
  }
  if (post.type === 'REPOST') {
    return <RepostEmbed post={post}/>
  }
  // REEL → a tappable cover that opens the full-screen reels viewer for THIS reel
  if (post.type === 'REEL' && post.media?.length) {
    const m = post.media[0]
    return (
      <figure className="pc-plate">
      <div className="post-media count-1">
        <button className="pm-cell pm-reel" onClick={onOpenReel} aria-label="Watch reel">
          {m.url
            ? <PlayableVideo src={m.url} poster={m.poster} muted controls={false} autoPlay={false} className="pm-reel-cover" wrapperClassName="pm-reel-video" style={{ borderRadius:0 }} modal />
            : <span className="pm-reel-bg" style={{ background: m.bg }}/>}
          <span className="pm-play"><Icon name="play" className="lg"/></span>
          <span className="pm-reel-badge"><Icon name="reels" className="xs"/>Reel</span>
        </button>
      </div>
      </figure>
    )
  }
  if (post.media?.length) {
    return (
      <figure className="pc-plate">
      <div className={'post-media count-' + post.media.length}>
        {post.media.map((m, i) => (
          m.type === 'VIDEO' && m.url ? (
            <div key={i} className="pm-cell" style={{ aspectRatio: m.ratio || '16/10', background:'#000' }}>
              <PlayableVideo src={m.url} poster={m.poster} controls preload="metadata" style={{ width:'100%', height:'100%', objectFit:'cover', display:'block' }} modal />
            </div>
          ) : (
            <div key={i} className="pm-cell ph-bg" data-label={m.label} style={{ background: m.bg, aspectRatio: m.ratio || '16/10', cursor: m.type === 'IMAGE' && m.url ? 'zoom-in' : undefined }}
              onClick={m.type === 'IMAGE' && m.url ? () => onOpenImage(m.url) : undefined}>
              {m.type === 'VIDEO' && <button className="pm-play"><Icon name="play"/></button>}
            </div>
          )
        ))}
      </div>
      </figure>
    )
  }
  return null
}

/* "Suggested for you" — the ranked feed's EXPLORE slice (guide §2).
   These are the ~5-10% of the page from authors the viewer does NOT follow, so
   the caption is not decoration: without it the row reads as "someone I
   follow posted this", which is the one thing it is not. The Follow button is
   the whole point of the slice, so it lives on the caption rather than making
   the reader walk to the profile.

   Follow state starts at false BY CONSTRUCTION — an EXPLORE candidate is
   filtered server-side to non-followed authors — so nothing is fetched to seed
   it, and a failed call rolls the button back rather than lying. */
function ExploreCaption({ authorId, authorName }) {
  const [following, setFollowing] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  if (!authorId) return null
  const toggle = (e) => {
    e.stopPropagation()
    if (busy) return
    const next = !following
    setFollowing(next); setBusy(true)
    ;(next ? api.users.follow(authorId) : api.users.unfollow(authorId))
      .then(() => showToast(next ? `Following ${authorName}` : `Unfollowed ${authorName}`))
      .catch(() => { setFollowing(!next); showToast('Could not update following') })
      .finally(() => setBusy(false))
  }
  return (
    <div className="pc-src">
      <Icon name="trending" className="xs"/>
      <span>Suggested for you</span>
      <button className={'btn btn-sm ' + (following ? 'btn-secondary' : 'btn-primary')} disabled={busy} onClick={toggle}>
        {following ? 'Following' : 'Follow'}
      </button>
    </div>
  )
}

export function PostCard({ post, onLike, onSave, index = 0, onOpenComments, owner = false, onEdit, onDelete, observeView = true }) {
  const [shares, setShares] = React.useState(post.shares)
  const u = authorOf(post)
  const navigate = useNavigate()
  const goAuthor = () => post.author && navigate(`/u/${post.author}`)
  const [lightbox, setLightbox] = React.useState(null)
  const imgs = React.useMemo(() => (post.media || []).filter(m => m.type === 'IMAGE' && m.url).map(m => m.url), [post.media])
  const openImage = (url) => setLightbox(Math.max(0, imgs.indexOf(url)))
  const openReel = () => navigate(`/reels/${post.id}`)

  // Record a view once the card is meaningfully visible (≥50% for ~1s),
  // then seed the count from the authoritative viewCount (POST_ENGAGEMENT §2).
  // Views render as a quiet muted line above the action buttons.
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

  // Inline comments + comment reactions — expand under the card (lazy-loaded).
  const [showC, setShowC] = React.useState(false)
  const [comments, setComments] = React.useState(null)     // null = not loaded yet
  const [cText, setCText] = React.useState('')
  const [cBusy, setCBusy] = React.useState(false)
  const [cCount, setCCount] = React.useState(post.comments || 0)
  React.useEffect(() => { setCCount(post.comments || 0) }, [post.comments])
  const toggleComments = () => {
    setShowC(s => !s)
    if (comments == null) api.posts.comments(post.id, { pageSize: 20 }).then(r => setComments(r || [])).catch(() => setComments([]))
  }
  const postComment = () => {
    const v = cText.trim(); if (!v || cBusy) return
    setCBusy(true)
    api.posts.addComment(post.id, { text: v })
      .then(saved => { setComments(cs => [saved, ...(cs || [])]); setCText(''); setCCount(n => n + 1) })
      .catch(() => showToast('Could not post comment'))
      .finally(() => setCBusy(false))
  }
  const reactComment = (cid) => {
    const flip = () => setComments(cs => (cs || []).map(c => c.id === cid ? { ...c, liked: !c.liked, likes: (c.likes || 0) + (c.liked ? -1 : 1) } : c))
    flip(); api.posts.toggleCommentReaction(post.id, cid).catch(flip)
  }

  return (
    <article ref={cardRef} className={'post-card rise' + (post.source === 'EXPLORE' ? ' is-explore' : '')} style={{ animationDelay: `${index * 60}ms` }}>
      {post.source === 'EXPLORE' && <ExploreCaption authorId={post.author} authorName={u.full}/>}
      <header className="pc-head">
        <span role="button" onClick={goAuthor} style={{ cursor:'pointer' }}>
          <Avatar initials={u.initials} color={u.avc} size={40} src={u.profileImage}/>
        </span>
        <div className="pc-who">
          <div className="pc-line" role="button" onClick={goAuthor} style={{ cursor:'pointer' }}>
            <b>{u.full}</b>
            {u.verified && <Verify scholar={u.role === 'SCHOLAR'}/>}
          </div>
          <div className="pc-meta">
            <span>{u.role === 'SCHOLAR' ? 'Scholar' : u.role === 'RESEARCHER' ? 'Researcher' : 'Member'}</span>
            <span className="pc-dot"/>
            <span className="pc-handle" role="button" onClick={goAuthor} style={{ cursor:'pointer' }}>@{u.handle}</span>
          </div>
        </div>
        <div className="pc-side">
          <span className="pc-time">{post.time}</span>
          <Icon name={post.visibility === 'PUBLIC' ? 'globe' : post.visibility === 'FOLLOWERS' ? 'users' : 'lock'} className="xs"/>
          <PostMenu post={post} owner={owner} onEdit={onEdit} onDelete={onDelete}/>
        </div>
      </header>

      {post.body && <div className="pc-body" dir="auto">{linkify(post.body)}</div>}
      {post.location && (
        <div className="pc-loc"><Icon name="pin" className="xs"/>{post.location}</div>
      )}

      <PostMedia post={post} onOpenReel={openReel} onOpenImage={openImage}/>

      <div className="pc-actions">
        <button className={'pca ' + (post.liked ? 'on' : '')} onClick={() => onLike?.(post.id)} aria-label="Like">
          <Icon name="heart"/><span>{fmt(post.likes)}</span>
        </button>
        <button className={'pca ' + (showC ? 'active' : '')} onClick={toggleComments}>
          <Icon name="comment"/><span>{fmt(cCount)}</span>
        </button>
        <button className="pca" onClick={() => doRepost(post)} aria-label="Repost">
          <Icon name="repost"/>
        </button>
        <button className="pca" onClick={() => openShare({ kind:'post', id:post.id, title: post.body ? post.body.slice(0, 90) : 'this post', count: shares, onShared: setShares })}>
          <Icon name="share"/><span>Share</span>
        </button>
        {views > 0 && (
          <span className="pc-views" title={`${fmt(views)} views`}><Icon name="eye" className="xs"/><span>{fmt(views)}</span></span>
        )}
        <button className={'pca pca-end ' + (post.saved ? 'saved' : '')} onClick={() => onSave?.(post.id)}>
          <Icon name="bookmark"/><span>Save</span>
        </button>
      </div>

      {showC && (
        <div className="pc-comments t-stagger">
          <div className="pc-clabel">Comments — {fmt(cCount)}</div>
          {comments == null ? <div className="muted text-sm" style={{ padding:'10px 2px' }}>Loading comments…</div>
            : !comments.length ? <div className="muted text-sm" style={{ padding:'10px 2px' }}>No comments yet — be the first.</div>
            : comments.map(c => {
              const cu = authorOf(c)
              return (
                <div key={c.id} className="cmt">
                  <span role="button" style={{ cursor:'pointer' }} onClick={() => c.author && navigate(`/u/${c.author}`)}>
                    <Avatar initials={cu.initials} color={cu.avc} size={32} src={cu.profileImage}/>
                  </span>
                  <div className="cmt-col">
                    <div className="cmt-bubble">
                      <div className="cmt-name"><b>{cu.full}</b>{cu.verified && <Verify scholar={cu.role === 'SCHOLAR'}/>}</div>
                      <p>{linkify(c.body)}</p>
                    </div>
                    <div className="cmt-meta">
                      <button onClick={() => reactComment(c.id)} style={c.liked ? { color:'var(--rubric)' } : undefined}>
                        <Icon name="heart" className="xs" style={c.liked ? { fill:'var(--rubric)', stroke:'var(--rubric)' } : undefined}/>{c.likes || 0}
                      </button>
                      <button onClick={() => onOpenComments?.(post.id)}>Reply</button>
                      <span className="cmt-when">{c.time}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          {comments && cCount > comments.length && (
            <button className="pc-viewall" onClick={() => onOpenComments?.(post.id)}>View all {fmt(cCount)} comments</button>
          )}
          <div className="cmt-box">
            <input className="field" placeholder="Write a comment…" value={cText}
              onChange={e => setCText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') postComment() }}/>
            <button className="icon-btn tint" disabled={cBusy || !cText.trim()} onClick={postComment} aria-label="Post comment"><Icon name="send" className="sm"/></button>
          </div>
        </div>
      )}

      {lightbox !== null && <Lightbox images={imgs} index={lightbox} onClose={() => setLightbox(null)}/>}
    </article>
  )
}
