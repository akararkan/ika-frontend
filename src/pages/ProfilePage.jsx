/* =========================================================
   Profile page — /profile (current user, live).
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, Avatar, Badges, fmt, showToast } from '../components/ui.jsx'
import { ProfileDetails } from '../components/ProfileDetails.jsx'
import { uiConfirm, uiPrompt } from '../components/Dialog.jsx'
import { PostCard } from '../components/PostCard.jsx'
import { HighlightViewer } from '../components/HighlightViewer.jsx'
import { Loader, EmptyState } from '../components/states.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { openComposeEdit } from '../lib/openCompose.js'
import { api, assetUrl } from '../api/index.js'

export function ProfilePage() {
  const navigate = useNavigate()
  const { user, refreshUser } = useAuth()
  const me = user || { id:'me', full:'You', handle:'you', initials:'Y', avc:'linear-gradient(135deg,#159a76,#0a4a3c)', role:'MEMBER', bio:'', field:'', followers:0, following:0, posts:0, contributions:0 }
  const coverRef = React.useRef(null)
  const pickCover = (e) => { const f = e.target.files?.[0]; e.target.value=''; if (!f) return; api.users.uploadCover(f).then(() => { showToast('Cover updated'); refreshUser?.() }).catch(() => showToast('Could not upload cover')) }   // §10.6
  const [hlOpen, setHlOpen] = React.useState(null)   // open highlight archive viewer
  const [tab, setTab] = React.useState('POSTS')
  const [posts, setPosts] = React.useState([])
  const [research, setResearch] = React.useState([])
  const [questions, setQuestions] = React.useState([])
  const [reels, setReels] = React.useState([])      // reel-only list (§17.2 by-author)
  const [highlights, setHighlights] = React.useState([])
  const [stats, setStats] = React.useState(null)   // §9.14 live cross-store counts
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    if (!me.id) return
    let alive = true
    Promise.allSettled([
      api.posts.byAuthor(me.id),
      api.research.byResearcher(me.id),
      api.highlights.byAuthor(me.id),
      api.users.stats(me.id),
      api.qna.mine({ size: 30 }),
      api.reels.byAuthor(me.id),
    ]).then(([p, r, h, s, q, rl]) => {
      if (!alive) return
      if (p.status === 'fulfilled') setPosts(p.value || [])
      if (r.status === 'fulfilled') setResearch(r.value || [])
      if (h.status === 'fulfilled') setHighlights(h.value || [])
      if (s.status === 'fulfilled') setStats(s.value)
      if (q.status === 'fulfilled') setQuestions(q.value || [])
      if (rl.status === 'fulfilled') setReels(rl.value || [])
    }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [me.id])

  // keep an edited post fresh in place (PATCH §6.4 broadcasts ika:post-updated)
  React.useEffect(() => {
    const onUpdated = (e) => { if (e.detail) setPosts(ps => ps.map(p => p.id === e.detail.id ? e.detail : p)) }
    window.addEventListener('ika:post-updated', onUpdated)
    return () => window.removeEventListener('ika:post-updated', onUpdated)
  }, [])

  // DELETE /api/v1/posts/{id} (§6.5, author-only)
  const del = async (id) => {
    const ok = await uiConfirm({ title:'Delete this post?', message:'This cannot be undone.', confirmLabel:'Delete', danger:true, icon:'close' })
    if (!ok) return
    setPosts(ps => ps.filter(p => p.id !== id))
    api.posts.remove(id).then(() => showToast('Post deleted')).catch(() => showToast('Could not delete post'))
  }
  const cardOwnership = (p) => ({ owner: !!me.id && p.author === me.id, onEdit: () => openComposeEdit(p), onDelete: del })

  // Highlights: create + drag-to-reorder (persisted via PATCH /highlights/order)
  const hid = (h) => h.highlightId || h.id
  const dragIx = React.useRef(null)
  const addHighlight = async () => {
    const title = (await uiPrompt({ title:'New highlight', label:'Name', initial:'' }))?.trim()
    if (!title) return
    try { const h = await api.highlights.create({ authorId: me.id, title }); setHighlights(hs => [...hs, h]); showToast('Highlight created') }   // §17 authorId is read from the body
    catch { showToast('Could not create highlight') }
  }
  const dropHighlight = (toIx) => {
    const from = dragIx.current; dragIx.current = null
    if (from == null || from === toIx) return
    setHighlights(hs => {
      const next = [...hs]; const [moved] = next.splice(from, 1); next.splice(toIx, 0, moved)
      api.highlights.reorder(next.map(hid)).catch(() => showToast('Could not save order'))   // foreign/missing ids skipped server-side
      return next
    })
  }
  // POSTS tab excludes reels (reels come from the dedicated §17.2 list); counts from stats
  const onlyPosts = posts.filter(p => p.type !== 'REEL')

  return (
    <div className="main center">
      <div className="col-main">
        <div className="prof-cover">
          <div className="prof-cover-grad" style={me.coverImage ? { background:`center/cover no-repeat url("${me.coverImage}")` } : undefined}/>
          {!me.coverImage && <div className="prof-cover-pattern"/>}
          <input ref={coverRef} type="file" hidden accept="image/*" onChange={pickCover}/>
          <button className="prof-cover-edit" onClick={() => coverRef.current?.click()} title="Change cover photo">
            <Icon name="image" className="sm"/><span>{me.coverImage ? 'Change cover' : 'Add cover'}</span>
          </button>
        </div>
        <div className="prof-head">
          <Avatar initials={me.initials} color={me.avc} size={132} className="prof-avatar" src={me.profileImage}/>
          <div className="prof-actions">
            <button className="btn btn-secondary" onClick={() => navigate('/activity')}><Icon name="list" className="sm"/>Activity</button>
            <button className="btn btn-secondary" onClick={() => navigate('/settings')}><Icon name="settings" className="sm"/>Edit profile</button>
            <button className="btn btn-secondary"><Icon name="share" className="sm"/>Share</button>
          </div>
        </div>
        <div className="prof-meta">
          <h1>{me.full} {me.badges?.length ? <Badges items={me.badges}/> : null}</h1>
          <div className="prof-handle">@{me.handle} · <span className="pill role">{(me.role||'member').toLowerCase()}</span>{me.isForHire && <span className="pill hire"><Icon name="award" className="xs"/>Available for hire</span>}{me.profileLocked && <span className="pill locked"><Icon name="lock" className="xs"/>Private</span>}</div>
          {me.selfDescriber && <p className="prof-tagline">{me.selfDescriber}</p>}
          {me.bio && <p className="prof-bio">{me.bio}</p>}
          <div className="prof-counts">
            <button onClick={() => setTab('POSTS')}><b>{fmt(stats?.posts ?? onlyPosts.length)}</b><small>POSTS</small></button>
            <button onClick={() => setTab('REELS')}><b>{fmt(stats?.reels ?? reels.length)}</b><small>REELS</small></button>
            <button onClick={() => setTab('RESEARCH')}><b>{fmt(stats?.research ?? research.length)}</b><small>RESEARCH</small></button>
            <button onClick={() => setTab('QUESTIONS')}><b>{fmt(stats?.questions ?? questions.length)}</b><small>QUESTIONS</small></button>
            <button><b>{fmt(stats?.followers ?? me.followers ?? 0)}</b><small>FOLLOWERS</small></button>
            <button><b>{fmt(stats?.following ?? me.following ?? 0)}</b><small>FOLLOWING</small></button>
          </div>

          <section className="stories" style={{ marginTop:18 }}>
            <button className="story-card is-add is-new" onClick={addHighlight}>
              <span className="sc-thumb">
                <span className="sc-cover">
                  <span className="sc-plus lg"><Icon name="compose" className="sm"/></span>
                  <span className="sc-nm">New</span>
                </span>
              </span>
            </button>
            {highlights.map((h, i) => (
              <button
                key={hid(h)}
                className="story-card unseen"
                draggable
                onDragStart={() => { dragIx.current = i }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => dropHighlight(i)}
                onClick={() => setHlOpen({ id: hid(h), title: h.title })}
                title={`${h.title} — tap to view, drag to reorder`}>
                <span className="sc-thumb">
                  <span className="sc-cover" style={h.coverUrl ? { backgroundImage:`url("${assetUrl(h.coverUrl)}")` } : { background:'linear-gradient(160deg,#1fb98e,#0a4a3c)' }}>
                    <span className="sc-grad"/>
                    <span className="sc-nm">{h.title}</span>
                  </span>
                </span>
              </button>
            ))}
          </section>
        </div>

        <ProfileDetails u={me}/>

        <div className="tabs">
          {['POSTS','RESEARCH','QUESTIONS','REELS','SAVED'].map(t => (
            <button key={t} className={'tab ' + (tab===t ? 'on' : '')} onClick={() => setTab(t)}>{t[0]+t.slice(1).toLowerCase()}</button>
          ))}
        </div>

        {loading ? <Loader/> : (
          <>
            {tab==='POSTS' && (onlyPosts.length ? <div className="feed-list">{onlyPosts.map((p,i)=><PostCard key={p.id} post={p} index={i} onOpenComments={() => navigate(`/posts/${p.id}`)} {...cardOwnership(p)}/>)}</div> : <EmptyState icon="feed" title="No posts yet"/>)}
            {tab==='RESEARCH' && (research.length ? <div className="r-list">{research.map(r => (
              <article key={r.id} className="r-card" onClick={() => navigate(`/research/${r.id}`)}>
                <div className="r-cover" style={{ background:r.cover }}><span className="r-irc font-mono">{r.irc}</span></div>
                <div className="r-body"><h3>{r.title}</h3><p className="r-abs">{r.abstract}</p></div>
              </article>
            ))}</div> : <EmptyState icon="research" title="No research yet"/>)}
            {tab==='QUESTIONS' && (questions.length ? <div className="qna-list">{questions.map(q => (
              <article key={q.id} className="qna-card" onClick={() => navigate(`/qna/${q.id}`)}>
                <header><Avatar initials={me.initials} color={me.avc} size={36} src={me.profileImage}/><div><div className="qna-name"><b>{me.full}</b></div><div className="qna-sub">{q.time}</div></div>
                  {q.hasAcceptedAnswer ? <span className="status answered"><Icon name="check" className="xs"/>resolved</span> : <span className={'status ' + q.status.toLowerCase()}>{q.status.toLowerCase()}</span>}</header>
                <h3>{q.title}</h3><p className="qna-body">{q.body}</p>
              </article>
            ))}</div> : <EmptyState icon="qna" title="No questions yet" sub="Ask the community something."/>)}
            {tab==='REELS' && (reels.length
              ? <div className="feed-list">{reels.map((p,i)=><PostCard key={p.id} post={p} index={i} onOpenComments={() => navigate(`/posts/${p.id}`)} {...cardOwnership(p)}/>)}</div>
              : <EmptyState icon="reels" title="No reels yet" sub="Share a 60-second reflection."/>)}
            {tab==='SAVED' && (posts.filter(p=>p.saved).length ? <div className="feed-list">{posts.filter(p=>p.saved).map((p,i)=><PostCard key={p.id} post={p} index={i} onOpenComments={() => navigate(`/posts/${p.id}`)} {...cardOwnership(p)}/>)}</div> : <EmptyState icon="bookmark" title="Nothing saved here" sub="Open Saved from the menu to see all bookmarks."/>)}
          </>
        )}
      </div>
      {hlOpen && <HighlightViewer highlight={hlOpen} author={me} owner onClose={() => setHlOpen(null)}/>}
    </div>
  )
}
