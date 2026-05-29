/* =========================================================
   Q&A list page — /qna
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, Verify, Avatar, fmt } from '../components/ui.jsx'
import { Loader, EmptyState } from '../components/states.jsx'
import { authorOf } from '../lib/userView.js'
import { openCompose } from '../lib/openCompose.js'
import { api } from '../api/index.js'

const PAGE = 20

export function QnaPage() {
  const navigate = useNavigate()
  const [tab, setTab] = React.useState('DISCOVER')
  const [filter, setFilter] = React.useState('OPEN')
  const [items, setItems] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const [refresh, setRefresh] = React.useState(0)
  // pagination: Discover uses the cursor feed (§7.2); Following is page-based (§7.3)
  const [cursor, setCursor] = React.useState(null)
  const [page, setPage] = React.useState(0)
  const [hasMore, setHasMore] = React.useState(false)
  const [more, setMore] = React.useState(false)

  React.useEffect(() => {
    let alive = true
    setLoading(true); setItems([]); setCursor(null); setPage(0); setHasMore(false)
    const req = tab === 'FOLLOWING'
      ? api.qna.following({ page: 0, size: PAGE }).then(list => ({ list: list || [], next: null, hasMore: (list || []).length >= PAGE }))
      : api.qna.feed({ limit: PAGE }).then(r => ({ list: r.items || [], next: r.nextCursor, hasMore: !!r.hasMore }))
    req.then(({ list, next, hasMore }) => { if (!alive) return; setItems(list); setCursor(next); setHasMore(hasMore) })
      .catch(() => { if (alive) setItems([]) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [tab, refresh])

  const loadMore = () => {
    if (more || !hasMore) return
    setMore(true)
    const req = tab === 'FOLLOWING'
      ? api.qna.following({ page: page + 1, size: PAGE }).then(list => ({ list: list || [], next: null, hasMore: (list || []).length >= PAGE, nextPage: page + 1 }))
      : api.qna.feed({ cursor, limit: PAGE }).then(r => ({ list: r.items || [], next: r.nextCursor, hasMore: !!r.hasMore }))
    req.then(({ list, next, hasMore, nextPage }) => {
      setItems(prev => [...prev, ...list]); setHasMore(hasMore)
      if (tab === 'FOLLOWING') setPage(nextPage); else setCursor(next)
    }).catch(() => {}).finally(() => setMore(false))
  }

  // a freshly-asked question shows up immediately — prepend the created
  // (mapped) question rather than refetching the whole list
  React.useEffect(() => {
    const onCreated = (e) => {
      const q = e.detail
      if (q && q.id) setItems(prev => prev.some(x => x.id === q.id) ? prev : [q, ...prev])
      else setRefresh(n => n + 1)
    }
    // Reflect in-place edits (title / body / tags) without a full reload.
    const onUpdated = (e) => {
      const q = e.detail
      if (!q || !q.id) return
      setItems(prev => prev.map(x => x.id === q.id ? { ...x, ...q } : x))
    }
    window.addEventListener('ika:question-created', onCreated)
    window.addEventListener('ika:question-updated', onUpdated)
    return () => {
      window.removeEventListener('ika:question-created', onCreated)
      window.removeEventListener('ika:question-updated', onUpdated)
    }
  }, [])

  const list = items.filter(q => filter === 'ALL' ? true : filter === 'OPEN' ? q.status === 'OPEN' : q.status === 'ANSWERED')

  return (
    <div className="main center">
      <div className="col-main">
        <div className="phead">
          <div>
            <h1>Academic <em>Q&amp;A</em></h1>
            <p className="sub">Ask, answer, and verify. Scholars mark best answers; question authors accept and rate responses.</p>
          </div>
          <button className="btn btn-primary btn-lg" onClick={() => openCompose('QUESTION')}><Icon name="compose" className="sm"/>Ask a question</button>
        </div>

        <div className="tabs">
          <button className={'tab ' + (tab==='DISCOVER'?'on':'')} onClick={() => setTab('DISCOVER')}>Discover</button>
          <button className={'tab ' + (tab==='FOLLOWING'?'on':'')} onClick={() => setTab('FOLLOWING')}>Following</button>
        </div>

        <div className="chips">
          {['OPEN','ANSWERED','ALL'].map(f => (
            <button key={f} className={'chip ' + (filter===f ? 'on' : '')} onClick={() => setFilter(f)}>{f[0]+f.slice(1).toLowerCase()}</button>
          ))}
        </div>

        {loading ? <Loader label="Loading questions…"/>
          : !list.length ? <EmptyState icon="qna" title="No questions here" sub="Be the first to ask one."/>
          : (
            <div className="qna-list">
              {list.map((q, i) => {
                const u = authorOf(q)
                return (
                  <article key={q.id} className="qna-card rise" style={{ animationDelay:`${i*60}ms` }} onClick={() => navigate(`/qna/${q.id}`)}>
                    <header>
                      <Avatar initials={u.initials} color={u.avc} size={38}/>
                      <div>
                        <div className="qna-name"><b>{u.full}</b> {u.verified && <Verify scholar={u.role==='SCHOLAR'}/>}</div>
                        <div className="qna-sub">@{u.handle} · {q.time}</div>
                      </div>
                      {q.hasAcceptedAnswer
                        ? <span className="status answered" title="Has an accepted answer"><Icon name="check" className="xs"/>resolved</span>
                        : <span className={'status ' + q.status.toLowerCase()}>{q.status.toLowerCase()}</span>}
                    </header>
                    <h3>{q.title}</h3>
                    <p className="qna-body">{q.body}</p>
                    {!!q.tags?.length && <div className="qna-tags">{q.tags.map(t => <a key={t}>#{t}</a>)}</div>}
                    <footer>
                      <span className="qna-ans"><Icon name="comment" className="xs"/>{q.answers} answers</span>
                      <span><Icon name="eye" className="xs"/>{fmt(q.views)}</span>
                      <span><Icon name="bookmark" className="xs"/>{q.saves}</span>
                    </footer>
                  </article>
                )
              })}
            </div>
          )}

        {!loading && !!list.length && hasMore && (
          <button className="btn btn-secondary btn-block mt-12" disabled={more} onClick={loadMore}>{more ? 'Loading…' : 'Load more'}</button>
        )}
      </div>
    </div>
  )
}
