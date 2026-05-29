/* =========================================================
   Tag feed page — /tags/:tag    (SEARCH_API §7.4 / §8.4)
   ---------------------------------------------------------
   Posts, reels, questions, and research carrying a tag,
   newest-first. Paginated by the OPAQUE `nextCursor` token
   (composite createdAt + contentId — exact, no skips/dupes).
   Pulls all five scope counts in ONE call via `usage?scope=*`
   for the header chip line.
   ========================================================= */
import React from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Icon, fmt } from '../components/ui.jsx'
import { Loader, EmptyState } from '../components/states.jsx'
import { api } from '../api/index.js'

const PAGE_SIZE = 20

const TYPE_BADGE = {
  POST:     { icon:'feed',     label:'Post',     color:'var(--ink-2)' },
  REEL:     { icon:'reels',    label:'Reel',     color:'var(--rose)' },
  QUESTION: { icon:'qna',      label:'Question', color:'var(--emerald)' },
  RESEARCH: { icon:'research', label:'Research', color:'var(--brass)' },
}

function detailHref(row) {
  if (row.type === 'POST' || row.type === 'REEL') return `/posts/${row.id}`
  if (row.type === 'QUESTION') return `/qna/${row.id}`
  if (row.type === 'RESEARCH') return `/research/${row.id}`
  return null
}

export function TagPage() {
  const navigate = useNavigate()
  const { tag: rawTag } = useParams()
  const tag = (rawTag || '').toLowerCase()

  const [rows, setRows] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const [more, setMore] = React.useState(false)
  const [cursor, setCursor] = React.useState('')        // opaque token (§7.4)
  const [hasMore, setHasMore] = React.useState(false)
  const [scopes, setScopes] = React.useState(null)      // { ALL, QUESTION, RESEARCH, POST, REEL }

  React.useEffect(() => {
    let alive = true
    setLoading(true); setRows([]); setCursor(''); setHasMore(false); setScopes(null)
    api.tags.content(tag, { pageSize: PAGE_SIZE })
      .then(({ items, nextCursor }) => {
        if (!alive) return
        setRows(items)
        setCursor(nextCursor || '')
        setHasMore(!!nextCursor || items.length >= PAGE_SIZE)
      })
      .catch(() => { if (alive) setRows([]) })
      .finally(() => { if (alive) setLoading(false) })
    // Breakdown header — one call for all five counts (§7.5).
    api.tags.usage(tag, { scope: '*' }).then(u => { if (alive) setScopes(u.scopes || null) }).catch(() => {})
    return () => { alive = false }
  }, [tag])

  const loadMore = async () => {
    if (more || !hasMore) return
    setMore(true)
    try {
      const { items, nextCursor } = await api.tags.content(tag, { pageSize: PAGE_SIZE, cursor: cursor || undefined })
      setRows(prev => [...prev, ...items])
      setCursor(nextCursor || '')
      setHasMore(!!nextCursor || items.length >= PAGE_SIZE)
    } catch { /* ignore */ }
    finally { setMore(false) }
  }

  // "312 research · 184 questions · 12 posts · 0 reels · 508 total"
  const headerLine = React.useMemo(() => {
    if (!scopes) return `Everything tagged #${tag}, newest first.`
    const parts = []
    const push = (n, label) => { if (n > 0) parts.push(`${fmt(n)} ${label}`) }
    push(scopes.RESEARCH || 0, 'research')
    push(scopes.QUESTION || 0, 'questions')
    push(scopes.POST     || 0, 'posts')
    push(scopes.REEL     || 0, 'reels')
    const total = scopes.ALL ?? 0
    if (!parts.length) return `No content tagged #${tag} yet.`
    return `${parts.join(' · ')} · ${fmt(total)} total`
  }, [scopes, tag])

  return (
    <div className="main center">
      <div className="col-main">
        <div className="phead">
          <div>
            <h1>
              <span style={{ color:'var(--brass)' }}>#</span>{tag}
            </h1>
            <p className="sub">{headerLine}</p>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => navigate('/explore')}>
            <Icon name="chevleft" className="xs"/>Explore
          </button>
        </div>

        {loading ? <Loader label="Loading feed…"/> : !rows.length ? (
          <EmptyState icon="hash" title={`Nothing tagged #${tag} yet`} sub="Tag your post, question, or research to surface it here."/>
        ) : (
          <>
            <div className="qna-list">
              {rows.map(row => {
                const meta = TYPE_BADGE[row.type] || { icon:'feed', label:row.type, color:'var(--muted)' }
                const href = detailHref(row)
                return (
                  <article
                    key={`${row.type}:${row.id}`}
                    className="qna-card"
                    onClick={() => href && navigate(href)}
                    style={{ cursor: href ? 'pointer' : 'default' }}
                  >
                    <header>
                      <span className="src-ic" style={{ background:meta.color, color:'#fff' }}>
                        <Icon name={meta.icon} className="sm"/>
                      </span>
                      <div>
                        <div className="qna-name"><b>{meta.label}</b></div>
                        <div className="qna-sub">{row.time}</div>
                      </div>
                    </header>
                    {row.titlePreview ? <h3>{row.titlePreview}</h3> : <p className="muted text-sm">({meta.label})</p>}
                  </article>
                )
              })}
            </div>
            {hasMore && (
              <button className="btn btn-secondary btn-block mt-12" disabled={more} onClick={loadMore}>
                {more ? 'Loading…' : 'Load more'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
