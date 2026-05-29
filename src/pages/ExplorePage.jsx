/* =========================================================
   Explore page — /explore       (SEARCH_API.md, May 2026)
   ---------------------------------------------------------
   Renders results directly from the expanded GlobalSearchHit
   (titlePreview / authorUsername / authorName / createdAt) so
   the list page loads with ZERO follow-up hydration calls
   (§8.2 typeahead pattern). Hydration only happens on tap, in
   the detail page. Uses cursor-mode paging — stable across
   mid-scroll inserts. When ES is degraded (§5) we still surface
   trending tags + featured content as a recovery affordance so
   the user is never left with a dead-end empty state.
   ========================================================= */
import React from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Icon, Avatar, fmt } from '../components/ui.jsx'
import { initialsOf, handleOf } from '../api/adapters.js'
import { api } from '../api/index.js'

const SIZE = 12
const TYPES = [['ALL','All'], ['POST','Posts'], ['REEL','Reels'], ['QUESTION','Questions'], ['RESEARCH','Research']]
const typesArg = (f) => (f === 'ALL' ? undefined : [f])   // SEARCH_API §2 ?types=

const TYPE_META = {
  POST:     { icon:'feed',     label:'Post',     color:'var(--ink-2)' },
  REEL:     { icon:'reels',    label:'Reel',     color:'var(--rose)' },
  QUESTION: { icon:'qna',      label:'Question', color:'var(--emerald)' },
  RESEARCH: { icon:'research', label:'Research', color:'var(--brass)' },
}
const TYPE_ORDER = ['POST','REEL','QUESTION','RESEARCH']

/* Trending strip scope follows the search filter so the chips stay relevant. */
const SCOPE_OF = { ALL:'ALL', POST:'POST', REEL:'REEL', QUESTION:'QUESTION', RESEARCH:'RESEARCH' }

const detailHref = (h) => {
  if (h.contentType === 'POST' || h.contentType === 'REEL') return `/posts/${h.contentId}`
  if (h.contentType === 'QUESTION') return `/qna/${h.contentId}`
  if (h.contentType === 'RESEARCH') return `/research/${h.contentId}`
  return null
}

/* Stable colour from username so the avatar matches the one on the detail page. */
const AVATAR_GRADIENTS = [
  'linear-gradient(135deg,#159a76,#0a4a3c)',
  'linear-gradient(135deg,#bd9344,#7a5a1a)',
  'linear-gradient(135deg,#3f6a8a,#16302a)',
  'linear-gradient(135deg,#5a2a1a,#160a06)',
  'linear-gradient(135deg,#3c5a4a,#0a2a1f)',
]
function gradientFor(seed = '') {
  let h = 0
  for (let i = 0; i < String(seed).length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return AVATAR_GRADIENTS[h % AVATAR_GRADIENTS.length]
}

/* One row, rendered straight from the inline expand=true fields. Avatar /
   gradient / initials are derived deterministically from the username so
   the row looks consistent with the entity's detail page. */
function HitRow({ hit, onOpen }) {
  const meta = TYPE_META[hit.contentType] || { icon:'feed', label:hit.contentType, color:'var(--muted)' }
  const display = hit.authorName || hit.authorUsername || 'Member'
  const handle = handleOf(hit.authorUsername || '')
  const avc = gradientFor(hit.authorUsername || hit.authorName || hit.contentId)
  return (
    <article className="qna-card" onClick={onOpen} style={{ cursor:'pointer', position:'relative' }}>
      <header>
        <Avatar initials={initialsOf(display)} color={avc} size={40}/>
        <div>
          <div className="qna-name">
            <b>{display}</b>
            {handle && <span className="muted text-xs" style={{ marginLeft:6 }}>@{handle}</span>}
          </div>
          <div className="qna-sub">
            <span style={{ display:'inline-flex', alignItems:'center', gap:5 }}>
              <Icon name={meta.icon} className="xs" style={{ color:meta.color }}/>{meta.label}
            </span>
            {hit.time && <> · {hit.time}</>}
          </div>
        </div>
        <span className="status" style={{ marginLeft:'auto', background:'transparent', color:meta.color, fontWeight:700 }}>
          {meta.label}
        </span>
      </header>
      {hit.titlePreview && <h3>{hit.titlePreview}</h3>}
    </article>
  )
}

/* Skeleton card during in-flight search — feels faster than a "Searching…" line. */
function HitSkeleton() {
  return (
    <article className="qna-card" style={{ opacity:.55 }}>
      <header>
        <span className="src-ic" style={{ background:'var(--card-2)' }}/>
        <div style={{ flex:1 }}>
          <div style={{ height:14, width:'40%', background:'var(--card-2)', borderRadius:4 }}/>
          <div style={{ height:12, width:'28%', background:'var(--card-2)', borderRadius:4, marginTop:6 }}/>
        </div>
      </header>
      <div style={{ height:18, width:'85%', background:'var(--card-2)', borderRadius:4, marginTop:10 }}/>
      <div style={{ height:18, width:'62%', background:'var(--card-2)', borderRadius:4, marginTop:6 }}/>
    </article>
  )
}

/* Trending tag chip strip — reused on the empty-state landing AND as a
   recovery surface under a degraded / empty search. */
function TrendingStrip({ trending, navigate, title = 'Trending tags', scope = 'ALL' }) {
  if (!trending.length) return null
  return (
    <section className="card card-pad">
      <h3 className="title">
        <Icon name="hash" className="sm"/>{title}
        {scope !== 'ALL' && <small className="muted" style={{ marginLeft:8, fontWeight:500 }}>in {scope.toLowerCase()}</small>}
      </h3>
      <div className="chips" style={{ marginBottom: 0 }}>
        {trending.map(t => (
          <button key={t.tag} className="chip" onClick={() => navigate(`/tags/${encodeURIComponent(t.tag)}`)} title={`${fmt(t.usageCount)} uses`}>
            <span style={{ color:'var(--brass)' }}>#</span>{t.tag}
            <i className="muted text-xs" style={{ fontStyle:'normal', marginLeft:4 }}>{fmt(t.usageCount)}</i>
          </button>
        ))}
      </div>
    </section>
  )
}

export function ExplorePage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const initialQ = params.get('q') || ''
  const [q, setQ] = React.useState(initialQ)
  const [hits, setHits] = React.useState(null)             // null = idle, [] = empty result
  const [searching, setSearching] = React.useState(false)
  const [filter, setFilter] = React.useState('ALL')
  const [cursor, setCursor] = React.useState('')           // opaque server token (§8.2)
  const [hasMore, setHasMore] = React.useState(false)
  const [more, setMore] = React.useState(false)
  const [degraded, setDegraded] = React.useState(false)    // §5 ES-down banner
  const [sounds, setSounds] = React.useState([])
  const [featured, setFeatured] = React.useState([])
  const [reels, setReels] = React.useState([])
  const [trending, setTrending] = React.useState([])       // §7.3 — scope follows the filter

  const run = async (term, f = filter) => {
    if (!term.trim()) { setHits(null); setDegraded(false); return }
    setSearching(true); setCursor(''); setHasMore(false)
    try {
      const res = await api.search.query(term, { types: typesArg(f), size: SIZE })   // cursor mode (initial)
      setHits(res.results)
      setDegraded(res.degraded)
      setCursor(res.nextCursor)
      setHasMore(!!res.nextCursor || res.results.length >= SIZE)
    } catch {
      // Network failures don't surface `degraded` — show as an empty state
      // since the user can still recover via the trending strip below.
      setHits([]); setDegraded(false)
    } finally { setSearching(false) }
  }

  const loadMore = async () => {
    if (more || !hasMore) return
    setMore(true)
    try {
      const res = await api.search.query(q, { types: typesArg(filter), cursor: cursor || undefined, size: SIZE })
      setHits(prev => [...(prev || []), ...res.results])
      setCursor(res.nextCursor)
      setHasMore(!!res.nextCursor || res.results.length >= SIZE)
      setDegraded(res.degraded)
    } finally { setMore(false) }
  }

  const lastTerm = React.useRef('')
  const doSearch = (term, f = filter) => {
    lastTerm.current = term
    setParams(term ? { q: term } : {}, { replace: true })
    if (term) run(term, f); else { setHits(null); setDegraded(false) }
  }
  const pickFilter = (f) => { setFilter(f); if (q.trim()) doSearch(q.trim(), f) }

  // debounced live search — results update ~350ms after you stop typing
  React.useEffect(() => {
    const term = q.trim()
    if (term === lastTerm.current) return
    const t = setTimeout(() => doSearch(term), 350)
    return () => clearTimeout(t)
  }, [q]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch trending whenever the filter changes so the strip is relevant
  // to the current scope (§7.3 supports POST / REEL / QUESTION / RESEARCH).
  React.useEffect(() => {
    api.tags.trending({ scope: SCOPE_OF[filter] || 'ALL', limit: 12 })
      .then(setTrending).catch(() => {})
  }, [filter])

  React.useEffect(() => {
    api.sounds.byCategory('NASHEED').then(rows => setSounds((rows || []).map(s => ({ id:s.soundId, title:s.title, artist:s.artistName, category:s.category })))).catch(() => {})
    api.research.feed({ size: 2 }).then(setFeatured).catch(() => {})
    ;(async () => {
      let r = []
      try { r = await api.reels.forYou({ pageSize: 6 }) } catch { /* not deployed */ }
      if (!r?.length) { try { r = await api.reels.feed({ pageSize: 6 }) } catch { /* ignore */ } }
      setReels(r || [])
    })()
  }, [])

  const onKey = (e) => { if (e.key === 'Enter') doSearch(q.trim()) }
  const clear = () => { setQ(''); setHits(null); setDegraded(false); setFilter('ALL'); lastTerm.current = ''; setParams({}, { replace: true }) }

  // Per-type counts — drive the badges shown on each tab button.
  const counts = React.useMemo(() => {
    const c = { ALL: hits?.length || 0, POST:0, REEL:0, QUESTION:0, RESEARCH:0 }
    for (const h of hits || []) c[h.contentType] = (c[h.contentType] || 0) + 1
    return c
  }, [hits])

  // Group hits by type — shown when the filter is ALL so the page reads
  // like a tabbed table of contents; flat when a specific type is picked.
  const grouped = React.useMemo(() => {
    const g = { POST:[], REEL:[], QUESTION:[], RESEARCH:[] }
    for (const h of hits || []) (g[h.contentType] ||= []).push(h)
    return g
  }, [hits])

  return (
    <div className="main center">
      <div className="col-main">
        <div className="phead">
          <div>
            <h1>Explore</h1>
            <p className="sub">Search posts, reels, research, questions, and sounds across the IKA community.</p>
          </div>
        </div>

        <div className="explore-search">
          <Icon name="search" className="sm"/>
          <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey} placeholder="Search posts, research, questions, sounds…"/>
          {hits !== null ? <button className="kbd" onClick={clear}>Clear</button> : <span className="kbd">⏎</span>}
        </div>

        {hits !== null ? (
          <>
            {/* Type tabs with counts (only meaningful when current scope = ALL;
                for a single-type filter the count IS the page length). */}
            <div className="tabs" style={{ marginTop: 4 }}>
              {TYPES.map(([k, lab]) => {
                const n = filter === 'ALL' ? counts[k] : (k === filter ? counts.ALL : null)
                return (
                  <button key={k} className={'tab ' + (filter === k ? 'on' : '')} onClick={() => pickFilter(k)}>
                    {lab}{n != null && n > 0 && <i className="muted text-xs" style={{ fontStyle:'normal', marginLeft:6 }}>{n}</i>}
                  </button>
                )
              })}
            </div>

            {degraded && (
              <div className="card card-pad" style={{ background:'rgba(194,69,63,.06)', borderColor:'rgba(194,69,63,.25)', marginBottom:12 }}>
                <div className="flex gap-8" style={{ alignItems:'center' }}>
                  <Icon name="shield" className="sm" style={{ color:'var(--rose)' }}/>
                  <div>
                    <b style={{ color:'var(--rose)' }}>Search is degraded</b>
                    <div className="muted text-sm">Results may be incomplete — try the trending tags below, or try again in a moment.</div>
                  </div>
                </div>
              </div>
            )}

            {searching ? (
              <div className="qna-list">
                {[0,1,2].map(i => <HitSkeleton key={i}/>)}
              </div>
            ) : !hits.length ? (
              <>
                <div className="card card-pad" style={{ textAlign:'center', padding:'28px 20px' }}>
                  <div style={{ display:'grid', placeItems:'center', margin:'0 auto 10px', width:48, height:48, borderRadius:'50%', background:'var(--card-2)', color:'var(--muted)' }}>
                    <Icon name="search"/>
                  </div>
                  <div className="font-serif" style={{ fontSize:18, fontWeight:600, color:'var(--ink)' }}>No results for "{q}"</div>
                  <p className="muted text-sm" style={{ marginTop:6 }}>Try different keywords, or pick a trending tag below.</p>
                </div>
                <div style={{ marginTop:14 }}>
                  <TrendingStrip trending={trending} navigate={navigate} title="Try a trending tag" scope={SCOPE_OF[filter] || 'ALL'}/>
                </div>
              </>
            ) : (
              <>
                {/* Filter = ALL → group hits per type (Posts header + rows, Reels header + rows…)
                    Filter = single type → flat list, no inner headers (the tab itself is the header) */}
                {filter === 'ALL' ? (
                  TYPE_ORDER.map(t => {
                    const rows = grouped[t] || []
                    if (!rows.length) return null
                    const meta = TYPE_META[t]
                    return (
                      <React.Fragment key={t}>
                        <div className="section-label">
                          <span style={{ display:'inline-flex', alignItems:'center', gap:7 }}>
                            <Icon name={meta.icon} className="sm" style={{ color:meta.color }}/>{meta.label}s
                          </span>
                          <i>{rows.length}</i>
                        </div>
                        <div className="qna-list">
                          {rows.map(h => <HitRow key={`${h.contentType}:${h.contentId}`} hit={h} onOpen={() => { const href = detailHref(h); if (href) navigate(href) }}/>)}
                        </div>
                      </React.Fragment>
                    )
                  })
                ) : (
                  <div className="qna-list">
                    {(hits || []).map(h => <HitRow key={`${h.contentType}:${h.contentId}`} hit={h} onOpen={() => { const href = detailHref(h); if (href) navigate(href) }}/>)}
                  </div>
                )}
                {hasMore && (
                  <button className="btn btn-secondary btn-block mt-12" disabled={more} onClick={loadMore}>
                    {more ? 'Loading…' : 'Load more'}
                  </button>
                )}
                {/* Always offer the trending strip as a discovery surface below
                    results — gives the user another path if these results miss. */}
                {!searching && !!trending.length && (
                  <div style={{ marginTop:18 }}>
                    <TrendingStrip trending={trending} navigate={navigate} title="More to explore" scope={SCOPE_OF[filter] || 'ALL'}/>
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          <div className="explore-grid">
            {!!trending.length && (
              <section className="card card-pad" style={{gridColumn:'1 / -1'}}>
                <h3 className="title"><Icon name="hash" className="sm"/>Trending tags</h3>
                <div className="chips" style={{ marginBottom: 0 }}>
                  {trending.map(t => (
                    <button key={t.tag} className="chip" onClick={() => navigate(`/tags/${encodeURIComponent(t.tag)}`)} title={`${fmt(t.usageCount)} uses`}>
                      <span style={{ color:'var(--brass)' }}>#</span>{t.tag}
                      <i className="muted text-xs" style={{ fontStyle:'normal', marginLeft:4 }}>{fmt(t.usageCount)}</i>
                    </button>
                  ))}
                </div>
              </section>
            )}
            <section className="card card-pad" style={{gridColumn:'1 / -1'}}>
              <h3 className="title"><Icon name="research" className="sm"/>Featured research</h3>
              <div className="r-list">
                {featured.length ? featured.map(r => (
                  <article key={r.id} className="r-card" onClick={() => navigate(`/research/${r.id}`)}>
                    <div className="r-cover" style={{ background:r.cover }}><span className="r-irc font-mono">{r.irc}</span></div>
                    <div className="r-body"><h3>{r.title}</h3><p className="r-abs">{r.abstract}</p></div>
                  </article>
                )) : <p className="muted text-sm">No research yet.</p>}
              </div>
            </section>

            <section className="card card-pad">
              <h3 className="title"><Icon name="music" className="sm"/>Trending sounds</h3>
              <div className="rail-list">
                {sounds.length ? sounds.map(s => (
                  <div key={s.id} className="rail-row">
                    <span className="src-ic" style={{ background:'var(--emerald-deep)' }}><Icon name="music" className="sm"/></span>
                    <div className="rail-info"><div className="rail-name"><b>{s.title}</b></div><div className="rail-sub">{s.artist}</div></div>
                    <button className="icon-btn tint"><Icon name="play" className="sm"/></button>
                  </div>
                )) : <p className="muted text-sm">No sounds yet.</p>}
              </div>
            </section>

            <section className="card card-pad">
              <h3 className="title"><Icon name="reels" className="sm"/>Trending reels</h3>
              <div className="explore-reels">
                {reels.length ? reels.map(r => (
                  <button key={r.id} className="reel-tile" style={{ background:r.media?.[0]?.bg || 'linear-gradient(160deg,#1f3a4a,#070d0b)' }} onClick={() => navigate('/reels')}>
                    <span className="rt-plays font-mono">▶ {fmt(r.views)}</span>
                    <span className="rt-cap">{(r.body || '').slice(0, 60)}…</span>
                  </button>
                )) : <p className="muted text-sm">No reels yet.</p>}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}
