/* =========================================================
   Feed page — live home timeline, stories, composer, rail.
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, Avatar, Verify, fmt, showToast } from '../components/ui.jsx'
import { uiConfirm } from '../components/Dialog.jsx'
import { PostCard } from '../components/PostCard.jsx'
import { FeedResearchCard, FeedQuestionCard } from '../components/FeedCards.jsx'
import { StoryViewer } from '../components/StoryViewer.jsx'
import { Loader, EmptyState } from '../components/states.jsx'
import { authorOf } from '../lib/userView.js'
import { openCompose, openComposeEdit } from '../lib/openCompose.js'
import { useAuth } from '../context/AuthContext.jsx'
import { api, adapters, assetUrl } from '../api/index.js'

function ComposerBar({ me }) {
  return (
    <section className="composer-bar card rise">
      <div className="cb-row1">
        <Avatar initials={me.initials} color={me.avc} size={38} src={me.profileImage}/>
        <button className="cb-fake" onClick={() => openCompose('TEXT')}>Share a question, note, or finding…</button>
        <div className="cb-icons">
          <button className="cb-ico" title="Photo" aria-label="Photo post" onClick={() => openCompose('EMBEDDED')}><Icon name="image"/></button>
          <button className="cb-ico" title="Reel" aria-label="Reel" onClick={() => openCompose('REEL')}><Icon name="reels"/></button>
          <button className="cb-ico" title="Voice" aria-label="Voice note" onClick={() => openCompose('VOICE_POST')}><Icon name="mic"/></button>
          <button className="cb-ico" title="Ask" aria-label="Ask a question" onClick={() => openCompose('QUESTION')}><Icon name="qna"/></button>
        </div>
      </div>
    </section>
  )
}

/* Trending topics — pre-ranked tags (TAGS_API §1). Fetches the top 20 and
   rotates through them a page (5) at a time with an animated cross-fade, so the
   card feels alive; refetches periodically since the server leaderboard rebuilds
   every ~10 min. */
const TREND_PAGE = 5
function TrendingCard({ navigate }) {
  const [tags, setTags] = React.useState([])
  const [page, setPage] = React.useState(0)
  React.useEffect(() => {
    let alive = true
    const load = () => api.tags.trending({ scope: 'ALL', limit: 20 })
      .then(rows => {
        if (!alive) return
        // Dedupe by tag: the endpoint can return the same tag twice (seen on
        // live data), and `key={t.tag}` below needs one row per tag.
        const seen = new Set()
        setTags((rows || []).filter(t => t.tag && !seen.has(t.tag) && seen.add(t.tag)))
      })
      .catch(() => {})
    load()
    const refetch = setInterval(load, 180000)   // 3 min
    return () => { alive = false; clearInterval(refetch) }
  }, [])
  const pages = Math.max(1, Math.ceil(tags.length / TREND_PAGE))
  React.useEffect(() => {
    setPage(0)
    if (tags.length <= TREND_PAGE) return
    const rot = setInterval(() => setPage(p => (p + 1) % pages), 5000)
    return () => clearInterval(rot)
  }, [tags.length, pages])
  if (!tags.length) return null
  const start = page * TREND_PAGE
  let shown = tags.slice(start, start + TREND_PAGE)
  // Wrap the tail with rows from the head — but only when there are MORE tags
  // than one page, or the pad would re-list this page's own rows (duplicate
  // keys, doubled entries) whenever fewer than TREND_PAGE tags exist at all.
  if (shown.length < TREND_PAGE && tags.length > TREND_PAGE) {
    shown = [...shown, ...tags.slice(0, TREND_PAGE - shown.length)]
  }
  return (
    <div className="card card-pad">
      <h3 className="title"><Icon name="trending" className="sm"/> Trending topics</h3>
      <div className="trends" key={page}>
        {shown.map((t, i) => (
          <button key={t.tag} className="trend-row" style={{ animationDelay: `${i * 55}ms` }}
            onClick={() => navigate(`/tags/${encodeURIComponent(t.tag)}`)}>
            <span className="trend-ico"><Icon name="trending" className="xs"/></span>
            <span className="trend-tag">#{t.tag}</span>
            <span className="trend-n">{fmt(t.usageCount)} posts</span>
          </button>
        ))}
      </div>
      {pages > 1 && (
        <div className="trend-dots">
          {Array.from({ length: pages }).map((_, i) => <i key={i} className={i === page ? 'on' : ''}/>)}
        </div>
      )}
    </div>
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
    // hydrated, self-excluded suggestions (server falls back to who-to-follow).
    // Verified scholars/researchers surface first so the card reads as "scholars
    // to follow", then everyone else — never dropping non-scholar suggestions.
    api.users.suggestions({ limit: 8 }).then(list => {
      if (!alive) return
      const rows = (list || []).filter(u => u.id && String(u.id) !== String(user?.id))   // defensive self-exclude
      const rank = (u) => (u.verified || u.role === 'SCHOLAR' || u.role === 'RESEARCHER') ? 0 : 1
      const sorted = [...rows].sort((a, b) => rank(a) - rank(b)).slice(0, 4)
      setPeople(sorted)
      setFollows(Object.fromEntries(sorted.map(u => [u.id, u.isFollowing])))            // seed real follow state
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
      <TrendingCard navigate={navigate}/>

      {!!people.length && (
        <div className="card card-pad">
          <h3 className="title"><Icon name="award" className="sm"/> Scholars to follow</h3>
          <div className="rail-list t-stagger">
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
          <div className="rail-list t-stagger">
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

// A "scholar" author = a verified contributor: SCHOLAR/RESEARCHER role, or the
// verified flag set. Drives the Scholars feed tab.
const isScholarAuthor = (a) => !!a && (a.role === 'SCHOLAR' || a.role === 'RESEARCHER' || a.verified)
const tsOf = (x) => (x?.createdAt ? new Date(x.createdAt).getTime() : 0)

export function FeedPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const me = user || { id:'me', full:'You', handle:'you', initials:'Y', avc:'linear-gradient(135deg,#1f4e7e,#00172f)' }
  const [posts, setPosts] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(false)
  const [myStories, setMyStories] = React.useState([])
  const [tray, setTray] = React.useState([])          // followed/close-friend rings (SSE-driven)
  const [storyOpen, setStoryOpen] = React.useState(null)
  const [more, setMore] = React.useState(false)
  const [end, setEnd] = React.useState(false)
  const [feedTab, setFeedTab] = React.useState('FOR_YOU')   // For you · Following · Scholars (prototype .m-seg)
  const [scholarExtra, setScholarExtra] = React.useState(null)   // research + scholar Q&A (null = not loaded yet)
  const [scholarBusy, setScholarBusy] = React.useState(false)

  // Scholars tab. The home feed is following-only, so filtering it misses
  // scholars you don't follow (why the tab looked empty). Instead aggregate
  // scholar-authored content from the GLOBAL surfaces — all research
  // (publishing is role-gated to SCHOLAR/RESEARCHER) + scholar-authored
  // questions — and merge with any scholar posts already in the home feed.
  // Loaded once, lazily, the first time the tab is opened; degrades gracefully
  // if either source fails.
  const loadScholars = React.useCallback(() => {
    setScholarBusy(true)
    Promise.allSettled([api.research.feed({ size: 20 }), api.qna.feed({ limit: 30 })])
      .then(([r, q]) => {
        const research = r.status === 'fulfilled' ? (r.value || []) : []
        const questions = (q.status === 'fulfilled' ? (q.value?.items || []) : [])
          .filter(item => isScholarAuthor(item._author))
        setScholarExtra([...research, ...questions])
      })
      .finally(() => setScholarBusy(false))
  }, [])
  React.useEffect(() => {
    if (feedTab === 'SCHOLARS' && scholarExtra == null && !scholarBusy) loadScholars()
  }, [feedTab, scholarExtra, scholarBusy, loadScholars])

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

  // Cover for your own story ring — the most recent frame that carries media.
  const myStoryCover = (() => { const s = myStories.find(x => x.mediaUrl); return s ? assetUrl(s.mediaUrl) : null })()

  // Feed segmented control. The backend exposes one home (following) timeline, so
  // For you / Following share it; Scholars merges globally-sourced scholar
  // content (research + scholar Q&A) with scholar posts from the home feed,
  // newest first.
  const shown = React.useMemo(() => {
    if (feedTab !== 'SCHOLARS') return posts
    const scholarPosts = posts.filter(p => (p.kind === 'POST' || !p.kind) && isScholarAuthor(authorOf(p)))
    // de-dupe by kind+id (ids can collide across entity types)
    const seen = new Set()
    return [...(scholarExtra || []), ...scholarPosts]
      .filter(x => {
        if (!x || x.id == null) return false
        const k = (x.kind || 'POST') + ':' + x.id
        if (seen.has(k)) return false
        seen.add(k); return true
      })
      .sort((a, b) => tsOf(b) - tsOf(a))
  }, [feedTab, posts, scholarExtra])
  const scholarLoading = feedTab === 'SCHOLARS' && scholarExtra == null

  return (
    <div className="main">
      <div className="col-main">
        <div className="seg feed-seg rise">
          {[['FOR_YOU', 'For you'], ['FOLLOWING', 'Following'], ['SCHOLARS', 'Scholars']].map(([k, label]) => (
            <button key={k} className={feedTab === k ? 'on' : ''} onClick={() => setFeedTab(k)}>{label}</button>
          ))}
        </div>
        <div className="folio rise">
          <span className="folio-d">{new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' })}</span>
          <span className="folio-ar" lang="ar" dir="rtl">الصفحة الرئيسية</span>
        </div>

        <section className="stories rise t-stagger">
          {/* Your story — opens the composer. */}
          <button className="st is-add" onClick={() => openCompose('STORY')}>
            <span className="st-ring add"><Icon name="compose" className="sm"/></span>
            <b>Your note</b>
          </button>

          {/* Your posted story — opens your viewer. */}
          {myStories.length > 0 && (
            <button className="st" onClick={() => setStoryOpen({ authorId: me.id, author: me })}>
              <span className="st-ring unseen"><Avatar initials={me.initials} color={me.avc} size={46} src={myStoryCover || me.profileImage}/></span>
              <b>{me.full.split(' ')[0]}</b>
            </button>
          )}

          {/* Followed / close-friend stories (SSE). */}
          {tray.map(t => {
            const a = adapters.authorFrom({ id: t.authorId, username: t.username, profileImage: t.avatarUrl })
            const cover = t.thumbnailUrl ? assetUrl(t.thumbnailUrl) : null
            return (
              <button key={t.authorId} className="st" onClick={() => setStoryOpen({ authorId: t.authorId, author: a })}>
                <span className="st-ring unseen"><Avatar initials={a.initials} color={a.avc} size={46} src={cover || a.profileImage}/></span>
                <b>@{a.handle}</b>
              </button>
            )
          })}
        </section>

        <ComposerBar me={me}/>

        {(loading || scholarLoading) ? <Loader label={feedTab === 'SCHOLARS' ? 'Loading scholars…' : 'Loading your feed…'}/>
          : error ? <EmptyState icon="feed" title="Couldn’t load the feed" sub="Check your connection to the backend and try again."/>
          : !shown.length ? <EmptyState icon="feed" title={feedTab === 'SCHOLARS' ? 'No scholar content yet' : 'Your feed is quiet'} sub={feedTab === 'SCHOLARS' ? 'Research, questions, and posts from verified scholars will appear here.' : 'Follow scholars and creators, or create the first post.'}/>
          : (
            <div className="feed-list t-stagger">
              {shown.map((p, i) => {
                const key = (p.kind || 'POST') + ':' + p.id
                // Mixed feed: dispatch on entityType (carried as `kind`) FIRST.
                if (p.kind === 'RESEARCH') return <FeedResearchCard key={key} item={p} navigate={navigate}/>
                if (p.kind === 'QUESTION') return <FeedQuestionCard key={key} item={p} navigate={navigate}/>
                return (
                  <PostCard key={key} post={p} index={i} onLike={like} onSave={save} onShare={share}
                    onOpenComments={() => navigate(`/posts/${p.id}`)}
                    owner={!!me.id && p.author === me.id} onEdit={() => openComposeEdit(p)} onDelete={del}/>
                )
              })}
            </div>
          )}

        {!loading && !error && feedTab !== 'SCHOLARS' && posts.length > 0 && !end && (
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
