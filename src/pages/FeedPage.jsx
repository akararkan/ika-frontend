/* =========================================================
   Feed page — live home timeline, stories, composer, rail.
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, Avatar, Verify, fmt, showToast } from '../components/ui.jsx'
import { uiConfirm } from '../components/Dialog.jsx'
import { PostCard } from '../components/PostCard.jsx'
import { StoryViewer } from '../components/StoryViewer.jsx'
import { Loader, EmptyState } from '../components/states.jsx'
import { authorOf } from '../lib/userView.js'
import { openCompose, openComposeEdit } from '../lib/openCompose.js'
import { useAuth } from '../context/AuthContext.jsx'
import { api, adapters, assetUrl } from '../api/index.js'

function ComposerBar({ me }) {
  return (
    <section className="composer-bar card card-pad rise">
      <div className="cb-row1">
        <Avatar initials={me.initials} color={me.avc} size={42}/>
        <button className="cb-fake" onClick={() => openCompose('TEXT')}>Share knowledge, {me.full.split(' ')[0]}…</button>
      </div>
      <div className="cb-row2">
        <button className="cb-quick" onClick={() => openCompose('EMBEDDED')}>
          <span className="cb-q-ico" style={{ background:'rgba(63,154,107,.14)', color:'#3f9a6b' }}><Icon name="image"/></span><span>Photo</span>
        </button>
        <button className="cb-quick" onClick={() => openCompose('REEL')}>
          <span className="cb-q-ico" style={{ background:'rgba(194,69,63,.13)', color:'#c2453f' }}><Icon name="reels"/></span><span>Reel</span>
        </button>
        <button className="cb-quick" onClick={() => openCompose('VOICE_POST')}>
          <span className="cb-q-ico" style={{ background:'rgba(189,147,68,.16)', color:'#bd9344' }}><Icon name="mic"/></span><span>Voice</span>
        </button>
        <button className="cb-quick" onClick={() => openCompose('QUESTION')}>
          <span className="cb-q-ico" style={{ background:'rgba(14,107,84,.14)', color:'#0e6b54' }}><Icon name="qna"/></span><span>Ask</span>
        </button>
      </div>
    </section>
  )
}

function FeedRail({ navigate }) {
  const { user } = useAuth()
  const [questions, setQuestions] = React.useState([])
  const [people, setPeople] = React.useState([])
  const [follows, setFollows] = React.useState({})   // id → isFollowing
  React.useEffect(() => {
    let alive = true
    api.qna.feed({ limit: 4 }).then(r => { if (alive) setQuestions((r.items || []).filter(q => q.status === 'OPEN').slice(0, 3)) }).catch(() => {})
    // hydrated, self-excluded suggestions (server falls back to who-to-follow)
    api.users.suggestions({ limit: 6 }).then(list => {
      if (!alive) return
      const rows = (list || []).filter(u => u.id && String(u.id) !== String(user?.id)).slice(0, 4)   // defensive self-exclude
      setPeople(rows)
      setFollows(Object.fromEntries(rows.map(u => [u.id, u.isFollowing])))            // seed real follow state
    }).catch(() => {})
    return () => { alive = false }
  }, [user?.id])
  const toggleFollow = (id) => {
    const now = !follows[id]
    setFollows(f => ({ ...f, [id]: now }))
    ;(now ? api.users.follow(id) : api.users.unfollow(id)).catch(() => setFollows(f => ({ ...f, [id]: !now })))
  }
  const dismiss = (id) => { setPeople(ps => ps.filter(u => u.id !== id)); api.users.dismissSuggestion(id).catch(() => {}) }
  return (
    <div className="col-side">
      {!!people.length && (
        <div className="card card-pad">
          <h3 className="title"><Icon name="award" className="sm"/> Who to follow</h3>
          <div className="rail-list">
            {people.map(u => (
              <div key={u.id} className="rail-row">
                <span role="button" style={{ cursor:'pointer' }} onClick={() => navigate(`/u/${u.id}`)}>
                  <Avatar initials={u.initials} color={u.avc} size={40} src={u.profileImage}/>
                </span>
                <div className="rail-info" style={{ cursor:'pointer' }} onClick={() => navigate(`/u/${u.id}`)}>
                  <div className="rail-name"><b>{u.full}</b> {u.verified && <Verify scholar={u.role==='SCHOLAR'}/>}</div>
                  <div className="rail-sub">{u.reason || `@${u.handle}`}</div>
                </div>
                <button className={'btn btn-sm ' + (follows[u.id] ? 'btn-secondary' : 'btn-primary')} onClick={() => toggleFollow(u.id)}>{follows[u.id] ? 'Following' : 'Follow'}</button>
                <button className="icon-btn" title="Dismiss" onClick={() => dismiss(u.id)} style={{ marginLeft:2 }}><Icon name="close" className="xs"/></button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card card-pad">
        <h3 className="title"><Icon name="qna" className="sm"/> Open questions</h3>
        {questions.length ? (
          <div className="rail-list">
            {questions.map(q => (
              <button key={q.id} className="rail-q" onClick={() => navigate(`/qna/${q.id}`)}>
                <div className="status open" style={{ marginBottom:6 }}>{q.status.toLowerCase()} · {q.answers} answers</div>
                <p>{q.title}</p>
                <small className="muted">{authorOf(q).full} · {fmt(q.views)} views</small>
              </button>
            ))}
          </div>
        ) : <p className="muted text-sm">No open questions right now.</p>}
        <button className="btn btn-secondary btn-sm btn-block mt-12" onClick={() => navigate('/qna')}>Browse all questions</button>
      </div>

      <div className="card card-pad">
        <h3 className="title"><Icon name="reels" className="sm"/> Discover</h3>
        <div className="rail-list">
          <button className="rail-q" onClick={() => navigate('/reels')}><p>Watch reels</p><small className="muted">Short reflections & lessons</small></button>
          <button className="rail-q" onClick={() => navigate('/reels/watched')}><p>Your watch history</p><small className="muted">Reels you’ve watched</small></button>
          <button className="rail-q" onClick={() => navigate('/research')}><p>Browse research</p><small className="muted">Peer publications with IRC IDs</small></button>
          <button className="rail-q" onClick={() => navigate('/explore')}><p>Explore sounds & topics</p><small className="muted">Find creators and audio</small></button>
        </div>
      </div>
    </div>
  )
}

export function FeedPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const me = user || { id:'me', full:'You', handle:'you', initials:'Y', avc:'linear-gradient(135deg,#159a76,#0a4a3c)' }
  const [posts, setPosts] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(false)
  const [myStories, setMyStories] = React.useState([])
  const [tray, setTray] = React.useState([])          // followed/close-friend rings (SSE-driven)
  const [storyOpen, setStoryOpen] = React.useState(null)
  const [more, setMore] = React.useState(false)
  const [end, setEnd] = React.useState(false)

  // Feed responses are authoritative for textPreview / mediaUrl now —
  // PostHydrator bulk-loads posts_by_id at read time and overlays the live
  // preview/cover onto each FeedItemResponse. An edit lands on the next
  // page load with no fanout-on-edit and no client-side N+1. See FEED_API §9.
  const load = React.useCallback(() => {
    setLoading(true); setError(false); setEnd(false)
    api.posts.feed().then(list => setPosts(list || []))
      .catch(() => setError(true)).finally(() => setLoading(false))
  }, [])
  // cursor pagination (FEED_API §8) — cursor = createdAt of the last item
  const loadMore = () => {
    const last = posts[posts.length - 1]
    if (more || end || !last?.createdAt) return
    setMore(true)
    api.posts.feed({ cursor: last.createdAt })
      .then(list => { setPosts(ps => [...ps, ...(list || [])]); if (!list || !list.length) setEnd(true) })
      .catch(() => {}).finally(() => setMore(false))
  }

  React.useEffect(() => { load() }, [load])
  const loadStories = React.useCallback(() => {
    if (me.id) api.stories.byAuthor(me.id).then(s => setMyStories(s || [])).catch(() => {})
  }, [me.id])
  React.useEffect(() => { loadStories() }, [loadStories])
  // a freshly-added story shows up in the tray immediately (no reload)
  React.useEffect(() => {
    window.addEventListener('ika:story-created', loadStories)
    window.addEventListener('ika:story-deleted', loadStories)
    return () => { window.removeEventListener('ika:story-created', loadStories); window.removeEventListener('ika:story-deleted', loadStories) }
  }, [loadStories])
  // Live tray: a followed/close-friend posting lights a ring (new_story); a delete
  // or expiry greys it (story_removed). Tap a ring to open that author's stories.
  React.useEffect(() => api.stories.trayStream({
    onNewStory: (ev) => {
      if (!ev?.authorId || ev.authorId === me.id) return
      setTray(arr => [{ authorId: ev.authorId, username: ev.authorUsername, avatarUrl: ev.authorAvatarUrl, thumbnailUrl: ev.thumbnailUrl }, ...arr.filter(x => x.authorId !== ev.authorId)])
    },
    onStoryRemoved: (ev) => { if (ev?.authorId) setTray(arr => arr.filter(x => x.authorId !== ev.authorId)) },
  }), [me.id])
  React.useEffect(() => {
    const onCreated = (e) => { if (e.detail) setPosts(ps => [e.detail, ...ps]) }
    const onUpdated = (e) => { if (e.detail) setPosts(ps => ps.map(p => p.id === e.detail.id ? e.detail : p)) }
    window.addEventListener('ika:post-created', onCreated)
    window.addEventListener('ika:post-updated', onUpdated)
    return () => { window.removeEventListener('ika:post-created', onCreated); window.removeEventListener('ika:post-updated', onUpdated) }
  }, [])

  const patch = (id, fn) => setPosts(ps => ps.map(p => p.id === id ? fn(p) : p))
  const like = (id) => {
    const was = posts.find(p=>p.id===id)?.liked
    patch(id, p => ({ ...p, liked:!p.liked, likes:p.likes + (p.liked?-1:1) }))
    api.posts.toggleReaction(id).catch(() => patch(id, p => ({ ...p, liked:was, likes:p.likes + (was?1:-1) })))   // roll back
  }
  const save = (id) => {
    const was = posts.find(p=>p.id===id)?.saved
    patch(id, p => ({ ...p, saved:!p.saved, saves:p.saves + (p.saved?-1:1) }))
    showToast(was?'Removed from saved':'Saved to collection')
    api.posts.toggleSave(id)
      .then(r => { if (r && typeof r.saved === 'boolean') patch(id, p => ({ ...p, saved:r.saved })) })   // trust server
      .catch(() => { patch(id, p => ({ ...p, saved:was, saves:p.saves + (was?1:-1) })); showToast('Could not update saved') })   // roll back
  }
  const share = (id) => { patch(id, p => ({ ...p, shares:p.shares + 1 })); showToast('Share link copied'); api.posts.share(id).catch(() => {}) }
  // DELETE /api/v1/posts/{id} (§6.5, author-only) — optimistic remove, reload on failure
  const del = async (id) => {
    const ok = await uiConfirm({ title:'Delete this post?', message:'This cannot be undone. The post will be removed for everyone.', confirmLabel:'Delete', danger:true, icon:'close' })
    if (!ok) return
    setPosts(ps => ps.filter(p => p.id !== id))
    api.posts.remove(id).then(() => showToast('Post deleted')).catch(() => { showToast('Could not delete post'); load() })
  }

  return (
    <div className="main">
      <div className="col-main">
        <section className="stories rise">
          <button className="story-add" onClick={() => openCompose('STORY')}>
            <Avatar initials={me.initials} color={me.avc} size={48}/>
            <span>Your story</span>
            <i><Icon name="compose" className="xs"/></i>
          </button>
          {myStories.length > 0 && (
            <button className="story-item" style={{ background:'linear-gradient(160deg,#1fb98e,#0a4a3c)' }} onClick={() => setStoryOpen({ authorId: me.id, author: me })}>
              <span className="ring"><Avatar initials={me.initials} color={me.avc} size={50}/></span>
              <span className="story-nm">{me.full.split(' ')[0]}</span>
            </button>
          )}
          {tray.map(t => {
            const a = adapters.authorFrom({ id: t.authorId, username: t.username, profileImage: t.avatarUrl })
            return (
              <button key={t.authorId} className="story-item" style={{ background: t.thumbnailUrl ? `center/cover no-repeat url("${assetUrl(t.thumbnailUrl)}")` : 'linear-gradient(160deg,#1fb98e,#0a4a3c)' }} onClick={() => setStoryOpen({ authorId: t.authorId, author: a })}>
                <span className="ring"><Avatar initials={a.initials} color={a.avc} size={50} src={a.profileImage}/></span>
                <span className="story-nm">{a.handle}</span>
              </button>
            )
          })}
        </section>

        <ComposerBar me={me}/>

        {loading ? <Loader label="Loading your feed…"/>
          : error ? <EmptyState icon="feed" title="Couldn’t load the feed" sub="Check your connection to the backend and try again."/>
          : !posts.length ? <EmptyState icon="feed" title="Your feed is quiet" sub="Follow scholars and creators, or create the first post."/>
          : (
            <div className="feed-list">
              {posts.map((p, i) => (
                <PostCard key={p.id} post={p} index={i} onLike={like} onSave={save} onShare={share}
                  onOpenComments={() => navigate(`/posts/${p.id}`)}
                  owner={!!me.id && p.author === me.id} onEdit={() => openComposeEdit(p)} onDelete={del}/>
              ))}
            </div>
          )}

        {!loading && !error && posts.length > 0 && !end && (
          <button className="btn btn-secondary btn-block mt-12" disabled={more} onClick={loadMore}>
            {more ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>

      <FeedRail navigate={navigate}/>

      {storyOpen && <StoryViewer authorId={storyOpen.authorId} author={storyOpen.author} onClose={() => setStoryOpen(null)}/>}
    </div>
  )
}
