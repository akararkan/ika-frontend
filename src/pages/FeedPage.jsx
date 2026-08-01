/* =========================================================
   Feed page — the RANKED home screen.
   ---------------------------------------------------------
   One request renders the whole thing (HOME_FEED guide §1):

     GET /api/v1/posts/feed/home
       → { items, liveNow, nextCursor, ranked }

   Four candidate sources land in `items`, already scored,
   safety-filtered and diversity-re-ranked server-side, each
   labelled with its provenance in `source`:

     FOLLOWING / SELF  the social graph (posts, research, Q&A)
     CHANNEL           fresh broadcasts from subscribed channels
     EXPLORE           trending reels from people you DON'T follow

   Three rules follow from that and are load-bearing here:

   1. RENDER IN ORDER. The server ranked and diversified the page;
      re-sorting it client-side would undo the diversity pass.
   2. PAGINATE ON `nextCursor`, never on item order — a ranked page
      is not chronological, so `items.at(-1).createdAt` would skip
      and loop. (The legacy bare-array `/feed` is the one place
      that derivation is still valid, which is why the server
      tail-pins its oldest row there. This page doesn't use it.)
   3. CURSOR PAGES CARRY ONLY ITEMS. The live rail, the channel
      digest and the explore slice are FIRST-PAGE injections, so a
      later page having none of them is normal, and an empty
      `liveNow` on a cursor page must never blank the rail.
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, Avatar, fmt, showToast } from '../components/ui.jsx'
import { uiConfirm } from '../components/Dialog.jsx'
import { PostCard } from '../components/PostCard.jsx'
import { FeedResearchCard, FeedQuestionCard, FeedChannelCard } from '../components/FeedCards.jsx'
import { StoryViewer } from '../components/StoryViewer.jsx'
import { StoriesRail } from '../components/StoriesRail.jsx'
import { PymkCarousel, PymkRail } from '../components/PeopleYouMayKnow.jsx'
import { LiveRow } from '../components/LiveRow.jsx'
import { Loader, EmptyState } from '../components/states.jsx'
import { authorOf } from '../lib/userView.js'
import { useStoryTray, invalidateTray } from '../lib/storyTray.js'
import { useFeedChannelViews } from '../lib/feedChannelViews.js'
import { openCompose, openComposeEdit } from '../lib/openCompose.js'
import { useAuth } from '../context/AuthContext.jsx'
import { api } from '../api/index.js'

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
  const [questions, setQuestions] = React.useState([])
  React.useEffect(() => {
    let alive = true
    api.qna.feed({ limit: 4 }).then(r => { if (alive) setQuestions((r.items || []).filter(q => q.status === 'OPEN').slice(0, 3)) }).catch(() => {})
    return () => { alive = false }
  }, [])
  return (
    <div className="col-side">
      <TrendingCard navigate={navigate}/>

      {/* The friend-suggestion engine, not a "who to follow" list: every row
          carries the WHY the engine computed it (mutual follows, contacts,
          shared groups, institution…), which is the difference between a
          recommendation and a random user. */}
      <PymkRail limit={5}/>

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

/* The three tabs, and what each one actually ASKS FOR:

     FOR_YOU   the ranked pipeline (`ranked` defaults to true) — engagement ×
               affinity × freshness, plus the channel/explore injections.
     LATEST    `ranked=false`: the exact pre-ranking chronological read of the
               social graph. Same response shape, no injections, newest first.
               It is labelled by its ORDER rather than by its source because
               that is the only thing a reader can tell apart from "For you".
     SCHOLARS  not a feed mode at all — a client-side aggregation of globally
               sourced scholar content (see loadScholars). */
const TABS = [
  ['FOR_YOU',  'For you',  'Ranked for you — engagement, interests and freshness'],
  ['LATEST',   'Latest',   'Newest first, from the people you follow'],
  ['SCHOLARS', 'Scholars', 'Research, questions and posts from verified scholars'],
]
const isFeedTab = (t) => t === 'FOR_YOU' || t === 'LATEST'

/* Where the "People you may know" strip sits in the timeline (0-based). Third
   card: past the fold's first read, before the reader has committed to a
   scroll. A short page simply never reaches it — which is correct, a two-post
   feed should not be mostly suggestions. */
const PYMK_SLOT = 3

export function FeedPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const me = user || { id:'me', full:'You', handle:'you', initials:'Y', avc:'linear-gradient(135deg,#1f4e7e,#00172f)' }
  const [posts, setPosts] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(false)
  const [myStories, setMyStories] = React.useState([])
  const [storyOpen, setStoryOpen] = React.useState(null)
  const [more, setMore] = React.useState(false)
  const [end, setEnd] = React.useState(false)
  const [cursor, setCursor] = React.useState(null)    // server's nextCursor — the ONLY cursor
  const [liveNow, setLiveNow] = React.useState(null)  // null = first page hasn't landed yet
  const [fresh, setFresh] = React.useState(0)         // FEED_NEW_POST hints since the last load
  const [feedTab, setFeedTab] = React.useState('FOR_YOU')
  const [scholarExtra, setScholarExtra] = React.useState(null)   // research + scholar Q&A (null = not loaded yet)
  const [scholarBusy, setScholarBusy] = React.useState(false)
  const observeChannelView = useFeedChannelViews()
  /* Followed accounts with a live story. Assembled client-side because the
     backend exposes no tray LIST endpoint — see lib/storyTray.js. */
  const tray = useStoryTray(me.id)

  // Scholars tab. The home feed is social-graph-first — its one non-followed
  // source is the ~5-10% explore slice — so filtering it misses nearly every
  // scholar you don't follow (why the tab looked empty). Instead aggregate
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

  /* `ranked=false` is only put on the wire for the Latest tab; For you leaves
     it off so the server's default (ranked) applies.

     Held as its OWN state rather than derived from `feedTab`, because Scholars
     is not a feed mode: it re-reads the already-loaded feed, and deriving the
     flag from the tab would make a hop through Scholars silently re-fetch the
     timeline in the other mode and back again. */
  const [feedMode, setFeedMode] = React.useState('RANKED')      // RANKED | LATEST
  const rankedParam = feedMode === 'LATEST' ? false : undefined
  const pickTab = (k) => {
    setFeedTab(k)
    if (k === 'FOR_YOU') setFeedMode('RANKED')
    else if (k === 'LATEST') setFeedMode('LATEST')
  }

  // Feed responses are authoritative for textPreview / mediaUrl —
  // PostHydrator bulk-loads posts_by_id at read time and overlays the live
  // preview/cover onto each FeedItemResponse. An edit lands on the next
  // page load with no fanout-on-edit and no client-side N+1.
  const load = React.useCallback(() => {
    setLoading(true); setError(false); setEnd(false); setFresh(0)
    api.posts.home({ pageSize: 20, ranked: rankedParam })
      .then(res => {
        setPosts(res.items || [])
        setLiveNow(res.liveNow || [])          // first page only — see rule 3 in the header
        setCursor(res.nextCursor || null)
        if (!res.nextCursor) setEnd(true)
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [rankedParam])

  /* Pagination is the server's cursor verbatim. Two independent end
     conditions, because either can come first: a null `nextCursor` (the
     timeline window ran out) and an empty page (everything in the window was
     dropped by hydration or the block filter). */
  const loadMore = () => {
    if (more || end || !cursor) return
    setMore(true)
    api.posts.home({ pageSize: 20, cursor, ranked: rankedParam })
      .then(res => {
        setPosts(ps => [...ps, ...(res.items || [])])
        setCursor(res.nextCursor || null)
        if (!res.nextCursor || !(res.items || []).length) setEnd(true)
      })
      .catch(() => {}).finally(() => setMore(false))
  }

  React.useEffect(() => { load() }, [load])

  /* "New posts" pill (guide §3). The notification stream's FEED_NEW_POST is a
     HINT, not content: a ranked feed cannot blindly prepend a row — its slot
     is decided by the score and the diversity pass — so the arrival is
     counted, shown as a pill, and only a tap refetches page 1. Hints that
     arrive while the Latest tab is open are just as valid (a new post is a new
     post), so the pill is shared by both feed modes. */
  React.useEffect(() => api.notifications.subscribe({
    onFeedNewPost: () => setFresh(n => n + 1),
  }), [])

  const showFresh = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
    load()
  }
  const loadStories = React.useCallback(() => {
    if (me.id) api.stories.byAuthor(me.id).then(s => setMyStories(s || [])).catch(() => {})
  }, [me.id])
  React.useEffect(() => { loadStories() }, [loadStories])
  // A freshly-added story shows up immediately (no reload). The shared tray
  // cache is dropped too — my own post doesn't change other people's rows, but
  // deleting my last frame does change whether MY tile belongs in the rail.
  React.useEffect(() => {
    const refresh = () => { invalidateTray(); loadStories() }
    window.addEventListener('ika:story-created', refresh)
    window.addEventListener('ika:story-deleted', refresh)
    return () => { window.removeEventListener('ika:story-created', refresh); window.removeEventListener('ika:story-deleted', refresh) }
  }, [loadStories])
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

  // Feed segmented control. For you / Latest are two modes of the SAME
  // endpoint (ranked vs chronological); Scholars merges globally-sourced
  // scholar content (research + scholar Q&A) with scholar posts already in the
  // loaded feed, newest first.
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
          {TABS.map(([k, label, hint]) => (
            <button key={k} className={feedTab === k ? 'on' : ''} title={hint} onClick={() => pickTab(k)}>{label}</button>
          ))}
        </div>
        <div className="folio rise">
          <span className="folio-d">{new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' })}</span>
          <span className="folio-ar" lang="ar" dir="rtl">الصفحة الرئيسية</span>
        </div>

        {/* Live rail — seeded by the same response that carried the items, so
            the first paint costs no second request. It hides itself when
            nobody is live, and refreshes off the messaging socket + the cheap
            dedicated /feed/live-now. */}
        {liveNow && <LiveRow source="feed" seed={liveNow} title="Live now" sub="Tap to watch"/>}

        <StoriesRail
          me={me}
          myStories={myStories}
          tray={tray}
          onCreate={() => openCompose('STORY')}
          onOpen={(authorId, author) => setStoryOpen({ authorId, author })}
          openFor={storyOpen?.authorId || null}
        />

        <ComposerBar me={me}/>

        {/* A ranked feed can't prepend — see the effect that counts these. */}
        {fresh > 0 && isFeedTab(feedTab) && !loading && (
          <button className="feed-fresh rise" onClick={showFresh}>
            <Icon name="chevup" className="xs"/>
            {fresh === 1 ? 'New post' : `${fmt(fresh)} new posts`}
          </button>
        )}

        {(loading || scholarLoading) ? <Loader label={feedTab === 'SCHOLARS' ? 'Loading scholars…' : 'Loading your feed…'}/>
          : error ? <EmptyState icon="feed" title="Couldn’t load the feed" sub="Check your connection to the backend and try again."/>
          : !shown.length ? <EmptyState icon="feed" title={feedTab === 'SCHOLARS' ? 'No scholar content yet' : 'Your feed is quiet'} sub={feedTab === 'SCHOLARS' ? 'Research, questions, and posts from verified scholars will appear here.' : 'Follow scholars and creators, or create the first post.'}/>
          : (
            <div className="feed-list t-stagger">
              {shown.map((p, i) => {
                const key = (p.kind || 'POST') + ':' + p.id
                /* People you may know, injected a few cards down — far enough
                   in that the reader has met real content first, near enough
                   that they reach it without scrolling for it. Only on the
                   feed tabs, and only once: the component renders nothing
                   while loading or when the engine returned no one. */
                const pymk = i === PYMK_SLOT && isFeedTab(feedTab)
                  ? <PymkCarousel key="pymk" limit={12}/>
                  : null
                // Mixed feed: dispatch on entityType (carried as `kind`) FIRST.
                let card
                if (p.kind === 'RESEARCH') card = <FeedResearchCard key={key} item={p} navigate={navigate}/>
                else if (p.kind === 'QUESTION') card = <FeedQuestionCard key={key} item={p} navigate={navigate}/>
                else if (p.kind === 'CHANNEL_POST') {
                  card = <FeedChannelCard key={key} item={p} navigate={navigate} observeView={observeChannelView}/>
                } else {
                  card = (
                    <PostCard key={key} post={p} index={i} onLike={like} onSave={save} onShare={share}
                      onOpenComments={() => navigate(`/posts/${p.id}`)}
                      owner={p.source === 'SELF' || (!!me.id && p.author === me.id)}
                      onEdit={() => openComposeEdit(p)} onDelete={del}/>
                  )
                }
                return pymk ? <React.Fragment key={key}>{pymk}{card}</React.Fragment> : card
              })}
            </div>
          )}

        {/* `end` is the server's answer (null nextCursor / empty page), never a
            guess from how many rows came back. */}
        {!loading && !error && isFeedTab(feedTab) && posts.length > 0 && !end && (
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
