/* =========================================================
   Saved page — /saved
   Saved posts (cursor-paginated by savedAt, grouped by collection),
   plus saved research and questions. (POST_ENGAGEMENT §3.4)
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Verify, Avatar, showToast } from '../components/ui.jsx'
import { uiPrompt } from '../components/Dialog.jsx'
import { PostCard } from '../components/PostCard.jsx'
import { Loader, EmptyState } from '../components/states.jsx'
import { authorOf } from '../lib/userView.js'
import { useAuth } from '../context/AuthContext.jsx'
import { api } from '../api/index.js'

const collOf = (p) => p.savedCollectionName || 'Default'

export function SavedPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [tab, setTab] = React.useState('POSTS')
  const [posts, setPosts] = React.useState([])
  const [researches, setResearches] = React.useState([])
  const [questions, setQuestions] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const [coll, setColl] = React.useState('ALL')
  const [cursor, setCursor] = React.useState(null)
  const [more, setMore] = React.useState(false)
  const [end, setEnd] = React.useState(false)
  const [qColls, setQColls] = React.useState([])   // saved-question collection names (§18.5)
  const [qColl, setQColl] = React.useState('ALL')

  React.useEffect(() => {
    let alive = true
    Promise.allSettled([
      user?.id ? api.posts.savedPosts(user.id) : Promise.resolve([]),
      api.research.mySaved(),
      api.qna.mySaved(),
      api.qna.savedCollections(),
    ]).then(([p, r, q, qc]) => {
      if (!alive) return
      if (p.status === 'fulfilled') {
        const list = p.value || []
        setPosts(list); setCursor(list[list.length - 1]?.savedAt || null); setEnd(list.length === 0)
      }
      if (r.status === 'fulfilled') setResearches(r.value || [])
      if (q.status === 'fulfilled') setQuestions(q.value || [])
      if (qc.status === 'fulfilled') setQColls(qc.value || [])
    }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [user?.id])

  // §18.4 filter saved questions by collection / §18.6 rename a collection
  const pickQColl = (name) => {
    setQColl(name)
    const req = name === 'ALL' ? api.qna.mySaved() : api.qna.mySavedCollection(name)
    req.then(list => setQuestions(list || [])).catch(() => {})
  }
  const renameQColl = async (e, name) => {
    e.stopPropagation()
    const next = await uiPrompt({ title:`Rename "${name}"`, label:'New collection name', initial:name, icon:'bookmark', confirmLabel:'Rename' })
    if (!next || !next.trim() || next.trim() === name) return
    api.qna.renameCollection(name, next.trim()).then(() => {
      setQColls(cs => cs.map(c => c === name ? next.trim() : c)); if (qColl === name) setQColl(next.trim())
      showToast('Collection renamed')
    }).catch(() => showToast('Could not rename'))
  }

  // §3.4 — paginate by the last item's savedAt; only stop on a 0-length page
  // (deleted posts are silently dropped, so a short page can still have more).
  const loadMore = () => {
    if (!user?.id || more || end || !cursor) return
    setMore(true)
    api.posts.savedPosts(user.id, { cursor })
      .then(list => {
        const arr = list || []
        setPosts(ps => [...ps, ...arr])
        setCursor(arr[arr.length - 1]?.savedAt || cursor)
        if (!arr.length) setEnd(true)
      })
      .catch(() => {}).finally(() => setMore(false))
  }

  const collections = React.useMemo(() => ['ALL', ...Array.from(new Set(posts.map(collOf)))], [posts])
  const shown = coll === 'ALL' ? posts : posts.filter(p => collOf(p) === coll)

  // On the Saved screen the bookmark acts as "Remove" — explicit unsave (§3.3)
  const removeSaved = (id) => { setPosts(ps => ps.filter(p => p.id !== id)); api.posts.unsave(id).then(() => showToast('Removed from saved')).catch(() => {}) }
  const like = (id) => { setPosts(ps => ps.map(p => p.id === id ? { ...p, liked:!p.liked, likes:p.likes + (p.liked?-1:1) } : p)); api.posts.toggleReaction(id).catch(() => {}) }
  const share = (id) => { setPosts(ps => ps.map(p => p.id === id ? { ...p, shares:p.shares + 1 } : p)); showToast('Share link copied'); api.posts.share(id).catch(() => {}) }

  return (
    <div className="main center">
      <div className="col-main">
        <div className="phead">
          <div>
            <h1>Saved</h1>
            <p className="sub">Your bookmarked posts, research papers, and questions in one place.</p>
          </div>
        </div>
        <div className="tabs">
          {['POSTS','RESEARCH','QUESTIONS'].map(t => <button key={t} className={'tab ' + (tab===t?'on':'')} onClick={() => setTab(t)}>{t[0]+t.slice(1).toLowerCase()}</button>)}
        </div>

        {loading ? <Loader label="Loading saved…"/> : (
          <>
            {tab === 'POSTS' && (posts.length ? (
              <>
                {collections.length > 2 && (
                  <div className="tabs" style={{ marginTop:4 }}>
                    {collections.map(c => <button key={c} className={'tab ' + (coll===c?'on':'')} onClick={() => setColl(c)}>{c === 'ALL' ? 'All' : c}</button>)}
                  </div>
                )}
                <div className="feed-list">
                  {shown.map((p,i) => <PostCard key={p.id} post={p} index={i} onOpenComments={() => navigate(`/posts/${p.id}`)} onLike={like} onSave={removeSaved} onShare={share}/>)}
                </div>
                {!end && <button className="btn btn-secondary btn-block mt-12" disabled={more} onClick={loadMore}>{more ? 'Loading…' : 'Load more'}</button>}
              </>
            ) : <EmptyState icon="bookmark" title="No saved posts" sub="Tap the bookmark on any post to save it here."/>)}

            {tab === 'RESEARCH' && (researches.length
              ? <div className="r-list">{researches.map(r => (
                  <article key={r.id} className="r-card" onClick={() => navigate(`/research/${r.id}`)}>
                    <div className="r-cover" style={{ background:r.cover }}><span className="r-irc font-mono">{r.irc}</span></div>
                    <div className="r-body"><h3>{r.title}</h3><p className="r-abs">{r.abstract}</p></div>
                  </article>
                ))}</div>
              : <EmptyState icon="bookmark" title="No saved research"/>)}

            {tab === 'QUESTIONS' && (<>
              {qColls.length > 0 && (
                <div className="tabs" style={{ marginTop:4 }}>
                  <button className={'tab ' + (qColl==='ALL'?'on':'')} onClick={() => pickQColl('ALL')}>All</button>
                  {qColls.map(c => (
                    <button key={c} className={'tab ' + (qColl===c?'on':'')} onClick={() => pickQColl(c)} onDoubleClick={(e) => renameQColl(e, c)} title="Double-click to rename">{c}</button>
                  ))}
                </div>
              )}
              {questions.length
              ? <div className="qna-list">{questions.map(q => {
                  const u = authorOf(q)
                  return (
                    <article key={q.id} className="qna-card" onClick={() => navigate(`/qna/${q.id}`)}>
                      <header><Avatar initials={u.initials} color={u.avc} size={36}/><div><div className="qna-name"><b>{u.full}</b> {u.verified && <Verify scholar={u.role==='SCHOLAR'}/>}</div><div className="qna-sub">{q.savedAt ? `Saved ${new Date(q.savedAt).toLocaleDateString(undefined,{day:'numeric',month:'short'})}` : q.time}</div></div><span className={'status ' + q.status.toLowerCase()}>{q.status.toLowerCase()}</span></header>
                      <h3>{q.title}</h3><p className="qna-body">{q.body}</p>
                    </article>
                  )
                })}</div>
              : <EmptyState icon="bookmark" title="No saved questions"/>}
            </>)}
          </>
        )}
      </div>
    </div>
  )
}
