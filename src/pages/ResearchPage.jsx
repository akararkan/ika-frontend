/* =========================================================
   Research list page — /research
   Owners (MINE tab) can update each item's status inline
   (publish / unpublish / archive / retract / delete) with the
   card patched in place from the server's authoritative response.
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, Verify, Avatar, fmt, showToast, ViewSeg } from '../components/ui.jsx'
import { uiConfirm } from '../components/Dialog.jsx'
import { Loader, EmptyState } from '../components/states.jsx'
import { ResearchComposeModal } from '../components/ResearchComposeModal.jsx'
import { authorOf } from '../lib/userView.js'
import { useViewMode } from '../lib/useViewMode.js'
import { useAuth } from '../context/AuthContext.jsx'
import { api, adapters } from '../api/index.js'

// Filter chip metadata (icon + contextual subtitle for the hint card)
const FILTER_META = {
  ALL:       { icon:'list',     label:'All your research',  desc:'Everything you authored, across every status.' },
  DRAFT:     { icon:'doc',      label:'Drafts',             desc:'Private — only you can see these. Publish when ready to mint an IRC ID.' },
  PUBLISHED: { icon:'check',    label:'Published work',     desc:'Live in the public feed with a minted IRC ID.' },
  ARCHIVED:  { icon:'bookmark', label:'Archived papers',    desc:'Hidden from public feeds but still readable by direct link — for superseded works that should remain citable.' },
  RETRACTED: { icon:'flag',     label:'Retracted papers',   desc:'Kept publicly readable with a retraction banner — preserves citation integrity.' },
}
const STATUS_ICON = { DRAFT:'doc', ARCHIVED:'lock', RETRACTED:'flag', PUBLISHED:'check' }
const ACTION_TOAST = { publish:'Published', unpublish:'Moved to drafts', archive:'Archived', retract:'Retracted', unretract:'Retraction lifted' }

export function ResearchPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const meId = user?.id
  const canPublish = ['SCHOLAR','RESEARCHER','ADMIN'].includes(user?.role)
  const [view, setView] = useViewMode('research')
  const [tab, setTab] = React.useState('DISCOVER')
  const [filter, setFilter] = React.useState('ALL')
  const [items, setItems] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const [composing, setComposing] = React.useState(false)
  const [editing, setEditing] = React.useState(null)

  React.useEffect(() => {
    let alive = true
    setLoading(true); setFilter('ALL')
    const req = tab === 'FOLLOWING' ? api.research.following() : tab === 'MINE' ? api.research.myAll() : api.research.feed()
    req.then(list => { if (alive) setItems(list || []) }).catch(() => { if (alive) setItems([]) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [tab])

  // Reflect in-place edits from the detail page (title / abstract / tags etc.)
  // without a full reload. The detail page broadcasts the canonical fetch.
  React.useEffect(() => {
    const onUpdated = (e) => {
      const dto = e.detail
      if (!dto?.id) return
      const fresh = adapters.researchFrom(dto)
      setItems(prev => prev.map(it => it.id === dto.id ? { ...it, ...fresh, metrics: it.metrics } : it))
    }
    window.addEventListener('ika:research-updated', onUpdated)
    return () => window.removeEventListener('ika:research-updated', onUpdated)
  }, [])

  // status filter only applies on the "My research" dashboard (§13.2 returns all statuses)
  const list = tab === 'MINE' && filter !== 'ALL' ? items.filter(r => r.status === filter) : items

  // Lifecycle — patch the card from the server response (no refetch). Confirm
  // before retract / delete; show a friendly error toast if the transition is
  // rejected (e.g. INVALID_STATE_TRANSITION) so the UI never goes silent.
  const lifecycle = async (id, action, confirmMsg) => {
    if (confirmMsg) {
      const ok = await uiConfirm({ title:'Retract this research?', message:confirmMsg, confirmLabel:'Retract', danger:true, icon:'flag' })
      if (!ok) return
    }
    const fn = api.research[action]
    if (!fn) return
    try {
      const updated = await fn(id)
      if (updated?.id) {
        const fresh = adapters.researchFrom(updated)
        setItems(prev => prev.map(it => it.id === id ? { ...it, ...fresh, metrics: it.metrics } : it))
      }
      showToast(ACTION_TOAST[action] || 'Updated')
    } catch (e) { showToast(e?.message || 'Action failed') }
  }

  const removeR = async (id) => {
    const ok = await uiConfirm({ title:'Delete this research permanently?', message:'This cannot be undone. Drafts, sources, contributors, media and comments will all be removed.', confirmLabel:'Delete forever', danger:true, icon:'close' })
    if (!ok) return
    const prevList = items
    setItems(prev => prev.filter(it => it.id !== id))                       // optimistic
    try { await api.research.remove(id); showToast('Deleted') }
    catch (e) { setItems(prevList); showToast(e?.message || 'Could not delete') }
  }

  // Editing from the list — fetch full detail so the composer has every field
  // (sources, contributors, cover, video) populated and doesn't lose data.
  const openEdit = async (r) => {
    try { const full = await api.research.get(r.id); setEditing(adapters.researchDetailFrom(full)) }
    catch (e) { showToast(e?.message || 'Could not open editor') }
  }
  const closeEdit = () => setEditing(null)
  const onEdited = (updated) => {
    closeEdit()
    if (!updated?.id) return
    // refetch once to capture the cover/video/contributor uploads done after the PATCH
    api.research.get(updated.id).then(full => {
      const fresh = adapters.researchFrom(full)
      setItems(prev => prev.map(it => it.id === updated.id ? fresh : it))
    }).catch(() => {})
  }

  const onCreated = (created) => {
    // a freshly-saved draft shows up at the top of "All / Drafts" immediately
    if (created?.id) {
      const fresh = adapters.researchFrom(created)
      setItems(prev => prev.some(it => it.id === created.id) ? prev : [fresh, ...prev])
    }
  }

  const hint = tab === 'MINE' && filter !== 'ALL' && FILTER_META[filter]

  // Owner lifecycle bar — shared by the full card and the compact row.
  const ownerBar = (r) => (
    <div className="r-owner-bar" onClick={e => e.stopPropagation()}>
      <button onClick={() => openEdit(r)}><Icon name="compose" className="xs"/>Edit</button>
      {r.status === 'DRAFT'     && <button className="primary" onClick={() => lifecycle(r.id, 'publish')}><Icon name="upload" className="xs"/>Publish</button>}
      {r.status === 'PUBLISHED' && <button onClick={() => lifecycle(r.id, 'unpublish')}><Icon name="download" className="xs"/>To draft</button>}
      {r.status === 'ARCHIVED'  && <button className="primary" onClick={() => lifecycle(r.id, 'publish')}><Icon name="check" className="xs"/>Restore</button>}
      {r.status !== 'ARCHIVED' && r.status !== 'RETRACTED' && <button onClick={() => lifecycle(r.id, 'archive')}><Icon name="bookmark" className="xs"/>Archive</button>}
      {r.status !== 'RETRACTED' && <button className="danger" onClick={() => lifecycle(r.id, 'retract', 'It stays publicly readable with a retraction banner — citations to it remain valid.')}><Icon name="flag" className="xs"/>Retract</button>}
      {r.status === 'RETRACTED' && <button className="primary" onClick={() => lifecycle(r.id, 'unretract')}><Icon name="check" className="xs"/>Unretract</button>}
      <span className="spacer"/>
      <button className="danger" title="Delete permanently" onClick={() => removeR(r.id)}><Icon name="close" className="xs"/></button>
    </div>
  )

  // Full card — Feed, Grid and Grouped modes.
  const RCard = (r, i) => {
    const u = authorOf(r)
    const sLower = r.status.toLowerCase()
    const isOwner = tab === 'MINE' && r.author === meId
    return (
      <article key={r.id} className={`r-card rise is-${sLower}`} style={{ animationDelay:`${i*60}ms` }} onClick={() => navigate(`/research/${r.id}`)}>
        <div className="r-cover" style={{ background:r.cover }}>
          <span className="r-irc font-mono">{r.irc || (r.status === 'DRAFT' ? 'DRAFT' : '')}</span>
          {r.hasVideo && <button className="r-play" onClick={e => { e.stopPropagation(); navigate(`/research/${r.id}`) }}><Icon name="play"/></button>}
          {r.status !== 'PUBLISHED' && (
            <span className={'r-status-ribbon ' + sLower}>
              <Icon name={STATUS_ICON[r.status]} className="xs"/>{sLower}
            </span>
          )}
        </div>
        <div className="r-body">
          <div className="r-top">
            <Avatar initials={u.initials} color={u.avc} size={30} src={u.profileImage}/>
            <div>
              <div className="rail-name"><b>{u.full}</b> {u.verified && <Verify scholar/>}</div>
              <small className="muted">{r.time}{r.irc ? <> · <span className="font-mono">{r.irc}</span></> : null}</small>
            </div>
            <span className={'status ' + sLower} style={{marginLeft:'auto'}}>{sLower}</span>
          </div>
          <h3>{r.title}</h3>
          <p className="r-abs">{r.abstract}</p>
          {!!r.tags?.length && <div className="qna-tags">{r.tags.map(t => <a key={t}>#{t}</a>)}</div>}
          <footer className="r-foot">
            <span><Icon name="eye" className="xs"/>{fmt(r.metrics.views)}</span>
            <span><Icon name="download" className="xs"/>{r.metrics.downloads}</span>
            <span><Icon name="heart" className="xs"/>{fmt(r.metrics.reactions)}</span>
            <span><Icon name="cite" className="xs"/>{r.metrics.citations} cited</span>
          </footer>
        </div>
        {isOwner && ownerBar(r)}
      </article>
    )
  }

  // Dense horizontal row — Compact mode (owner bar wraps to a full-width line).
  const RRow = (r, i) => {
    const u = authorOf(r)
    const sLower = r.status.toLowerCase()
    const isOwner = tab === 'MINE' && r.author === meId
    return (
      <article key={r.id} className={`rrow rise is-${sLower}`} style={{ animationDelay:`${i*35}ms` }} onClick={() => navigate(`/research/${r.id}`)}>
        <div className="rrow-cover" style={{ background:r.cover }}>
          {r.hasVideo && <span className="rrow-play"><Icon name="play"/></span>}
        </div>
        <div className="rrow-mid">
          <div className="rrow-head"><b className="rrow-name">{u.full}</b>{u.verified && <Verify scholar/>}<span className="rrow-meta">{r.time}{r.irc ? <> · <span className="font-mono">{r.irc}</span></> : null}</span></div>
          <h3 className="rrow-title">{r.title}</h3>
          <p className="rrow-body">{r.abstract}</p>
          {!!r.tags?.length && <div className="qna-tags">{r.tags.map(t => <a key={t}>#{t}</a>)}</div>}
        </div>
        <div className="rrow-right">
          <span className={'status ' + sLower}>{sLower}</span>
          <div className="rrow-metrics">
            <span><Icon name="eye" className="xs"/>{fmt(r.metrics.views)}</span>
            <span><Icon name="cite" className="xs"/>{r.metrics.citations}</span>
          </div>
        </div>
        {isOwner && ownerBar(r)}
      </article>
    )
  }

  // Grouped mode buckets — by lifecycle status.
  const R_GROUPS = [
    { key:'PUBLISHED', label:'Published', dot:'var(--emerald-bright)' },
    { key:'DRAFT',     label:'Drafts',    dot:'var(--brass)' },
    { key:'ARCHIVED',  label:'Archived',  dot:'var(--muted)' },
    { key:'RETRACTED', label:'Retracted', dot:'var(--rose)' },
  ]

  return (
    <div className="main center">
      <div className="col-main">
        <div className="phead">
          <div>
            <span className="phead-kicker">Islamic Knowledge Archive</span>
            <h1>Scholarly <em>Research</em></h1>
            <p className="sub">Peer-reviewed publications with minted IRC IDs, contributors, sources, and tracked citations.</p>
          </div>
          {canPublish && (
            <div style={{textAlign:'right'}}>
              <button className="btn btn-primary btn-lg" onClick={() => setComposing(true)}><Icon name="upload" className="sm"/>Publish research</button>
              <div className="muted text-xs mt-8 flex-c gap-6" style={{justifyContent:'flex-end'}}><Icon name="award" className="xs"/>Scholar / Researcher role</div>
            </div>
          )}
        </div>

        <div className="tabs">
          <button className={'tab ' + (tab==='DISCOVER'?'on':'')} onClick={() => setTab('DISCOVER')}>Discover</button>
          <button className={'tab ' + (tab==='FOLLOWING'?'on':'')} onClick={() => setTab('FOLLOWING')}>Following</button>
          {canPublish && <button className={'tab ' + (tab==='MINE'?'on':'')} onClick={() => setTab('MINE')}>My research</button>}
        </div>

        {tab === 'MINE' ? (
          <>
            <div className="list-toolbar">
              <ViewSeg value={view} onChange={setView}/>
              <div className="chips statuses">
                {Object.entries(FILTER_META).map(([key, meta]) => (
                  <button key={key} className={'chip ' + (filter===key ? 'on' : '')} onClick={() => setFilter(key)}>
                    <Icon name={meta.icon} className="xs"/>{key === 'ALL' ? 'All' : key[0]+key.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>
            </div>
            {hint && (
              <div className={'r-section-hint ' + filter.toLowerCase()}>
                <div className="ico-wrap"><Icon name={hint.icon}/></div>
                <div>
                  <b>{hint.label}</b>
                  <p>{hint.desc}</p>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="list-toolbar">
            <ViewSeg value={view} onChange={setView}/>
          </div>
        )}

        {loading ? <Loader label="Loading research…"/>
          : !list.length ? (
            <EmptyState
              icon={(hint?.icon) || 'research'}
              title={tab==='MINE' ? (filter === 'ALL' ? 'No research here yet' : `No ${filter.toLowerCase()} research`) : 'No research published yet'}
              sub={tab==='MINE' && filter === 'ALL' ? 'Publish your first paper — it starts as a draft.' : undefined}
            />
          ) : view === 'grouped' ? (
            <div className="list-groups">
              {R_GROUPS.map(g => {
                const items = list.filter(r => r.status === g.key)
                if (!items.length) return null
                return (
                  <section className="lg-group" key={g.key}>
                    <div className="lg-head">
                      <span className="lg-dot" style={{ background:g.dot }}/>
                      <h2>{g.label}</h2>
                      <span className="lg-count">{items.length}</span>
                      <span className="lg-line"/>
                    </div>
                    <div className="r-list" data-view="feed">{items.map((r, i) => RCard(r, i))}</div>
                  </section>
                )
              })}
            </div>
          ) : view === 'compact' ? (
            <div className="r-list" data-view="compact">{list.map((r, i) => RRow(r, i))}</div>
          ) : (
            <div className="r-list" data-view={view}>{list.map((r, i) => RCard(r, i))}</div>
          )}
      </div>
      {composing && <ResearchComposeModal onClose={() => setComposing(false)} onCreated={onCreated}/>}
      {editing && <ResearchComposeModal editResearch={editing} onClose={closeEdit} onEdited={onEdited}/>}
    </div>
  )
}
