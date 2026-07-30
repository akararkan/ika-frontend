/* =========================================================
   Activity page — /activity (the caller's own activity, live).
   Backed by /api/v1/users/me/activity (history + SSE). Rows render
   the server's `label` / `subtitle` / `timeAgo`, group by date, deep-link
   to the referenced content, and support per-row + bulk delete.
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, Avatar, showToast } from '../components/ui.jsx'
import { uiConfirm } from '../components/Dialog.jsx'
import { Loader, EmptyState } from '../components/states.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { api } from '../api/index.js'

// Per-activity-type glyph + tint for the row badge (the title text comes from
// the server's `label`, so this is purely the icon).
const META = {
  POST_CREATED:['compose','#426a5a'], POST_REACTION:['heart','#b3453e'], POST_COMMENT:['comment','#1f4e7e'],
  POST_COMMENT_REACTION:['heart','#b3453e'], POST_SHARE:['share','#1f4e7e'], POST_SAVED:['bookmark','#1f4e7e'],
  REEL_WATCH:['reels','#6b5b8a'],
  GLOBAL_SEARCH:['search','#8a93a3'], HASHTAG_SEARCH:['hash','#1f4e7e'], MENTION_LOOKUP:['at','#6b5b8a'],
  USER_MENTIONED:['at','#6b5b8a'], PROFILE_VIEW:['eye','#1f4e7e'], FOLLOWED_USER:['follow','#426a5a'],
  QNA_QUESTION_CREATED:['qna','#8a93a3'], QNA_QUESTION_SAVED:['bookmark','#1f4e7e'], QNA_ANSWER_CREATED:['reply','#1f4e7e'],
  QNA_REANSWER_CREATED:['reply','#1f4e7e'], QNA_ANSWER_REACTION:['heart','#b3453e'],
  RESEARCH_PUBLISHED:['research','#426a5a'], RESEARCH_SAVED:['bookmark','#1f4e7e'], RESEARCH_REACTION:['heart','#b3453e'],
  RESEARCH_COMMENT:['comment','#1f4e7e'], RESEARCH_COMMENT_REACTION:['heart','#b3453e'],
  STORY_VIEWED:['eye','#1f4e7e'], STORY_REACTED:['heart','#b3453e'], STORY_REPLIED:['reply','#1f4e7e'], STORY_POLL_VOTED:['qna','#6b5b8a'],
  SOUND_USED:['music','#1f4e7e'],
}

// Tabs → the activity `types` they request from the server. MENTIONS is the
// odd one out: it renders the unified mentions-OF-me feed (GET /mentions/me —
// every surface, actor-hydrated, keyset-paged), not activity rows.
const FILTERS = [
  ['ALL', 'All', null],
  ['POSTS', 'Posts', ['POST_CREATED','POST_REACTION','POST_COMMENT','POST_COMMENT_REACTION','POST_SHARE','POST_SAVED','REEL_WATCH']],
  ['QNA', 'Q&A', ['QNA_QUESTION_CREATED','QNA_QUESTION_SAVED','QNA_ANSWER_CREATED','QNA_REANSWER_CREATED','QNA_ANSWER_REACTION']],
  ['RESEARCH', 'Research', ['RESEARCH_PUBLISHED','RESEARCH_SAVED','RESEARCH_REACTION','RESEARCH_COMMENT','RESEARCH_COMMENT_REACTION']],
  ['SOCIAL', 'Social', ['FOLLOWED_USER','PROFILE_VIEW','USER_MENTIONED','MENTION_LOOKUP']],
  ['MENTIONS', 'Mentions', null],
  ['SEARCH', 'Searches', ['GLOBAL_SEARCH','HASHTAG_SEARCH']],
]
const TYPES_OF = Object.fromEntries(FILTERS.map(([k, , t]) => [k, t]))

// Where the mention happened — suffix for "…mentioned you in a post".
const MENTION_SOURCE = {
  POST: 'in a post', POST_COMMENT: 'in a comment',
  RESEARCH: 'in a research publication', RESEARCH_COMMENT: 'in a research comment',
  QUESTION: 'in a question', QUESTION_ANSWER: 'in an answer',
}
const MENTIONS_PAGE = 20

function bucketOf(createdAt) {
  if (!createdAt) return 'Earlier'
  const d = new Date(createdAt).getTime()
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (d >= startToday) return 'Today'
  if (d >= startToday - 6 * 86400000) return 'This week'
  return 'Earlier'
}

export function ActivityPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const me = user || { initials:'Y', avc:'linear-gradient(135deg,#1f4e7e,#00172f)' }
  const [filter, setFilter] = React.useState('ALL')
  const [items, setItems] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const isMentions = filter === 'MENTIONS'
  // Mentions-of-me is keyset-paged: the cursor is the last row's mentionedAt.
  const [mMore, setMMore] = React.useState(false)
  const [mLoadingMore, setMLoadingMore] = React.useState(false)

  React.useEffect(() => {
    let alive = true
    setLoading(true)
    const load = filter === 'MENTIONS'
      ? api.mentions.me({ limit: MENTIONS_PAGE }).then(rows => {
          if (!alive) return
          setItems(rows || [])
          setMMore((rows || []).length >= MENTIONS_PAGE)
        })
      : api.activity.list({ types: TYPES_OF[filter] || undefined })
          .then(rows => { if (alive) setItems(rows || []) })
    load.catch(() => { if (alive) { setItems([]); setMMore(false) } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [filter])

  const loadMoreMentions = () => {
    const last = items[items.length - 1]
    if (!last?.mentionedAt || mLoadingMore) return
    setMLoadingMore(true)
    api.mentions.me({ limit: MENTIONS_PAGE, cursor: last.mentionedAt })
      .then(rows => {
        setMMore((rows || []).length >= MENTIONS_PAGE)
        setItems(arr => {
          const have = new Set(arr.map(x => x.key))
          return [...arr, ...(rows || []).filter(x => !have.has(x.key))]
        })
      })
      .catch(() => setMMore(false))
      .finally(() => setMLoadingMore(false))
  }

  // Live: prepend new activity rows that fit the active filter (dedupe by id).
  const filterRef = React.useRef(filter); React.useEffect(() => { filterRef.current = filter }, [filter])
  React.useEffect(() => api.activity.stream({
    onActivity: (a) => {
      // The MENTIONS tab holds /mentions/me rows, not activity rows — a live
      // activity frame prepended there would corrupt the list.
      if (filterRef.current === 'MENTIONS') return
      const types = TYPES_OF[filterRef.current]
      if (types && !types.includes(a.type)) return
      setItems(arr => arr.some(x => x.id === a.id) ? arr : [a, ...arr])
    },
  }), [])

  const open = (a) => { if (a.deepLink) navigate(a.deepLink) }
  const del = (id) => { setItems(arr => arr.filter(x => x.id !== id)); api.activity.remove(id).catch(() => {}) }
  const clearAll = async () => {
    const ok = await uiConfirm({ title:'Clear all activity?', message:'This permanently deletes your entire activity history. This cannot be undone.', confirmLabel:'Clear all', danger:true, icon:'trash' })
    if (!ok) return
    setItems([]); api.activity.clear().then(() => showToast('Activity cleared')).catch(() => showToast('Could not clear activity'))
  }

  // Precompute date-group headers (Today / This week / Earlier) before render.
  const grouped = []
  let prevBucket = null
  for (const a of items) { const b = bucketOf(a.createdAt); grouped.push({ a, head: b !== prevBucket ? b : null }); prevBucket = b }

  return (
    <div className="main center">
      <div className="col-main ntf-page">
        <div className="phead">
          <div>
            <h1>Your <em>activity</em> <span className="phead-ar" lang="ar" dir="rtl">النشاط</span></h1>
            <p className="sub">Everything you’ve posted, liked, saved, shared, watched, asked, and searched.</p>
          </div>
          <div className="flex gap-8" style={{ flexWrap:'wrap' }}>
            <button className="btn btn-secondary" onClick={() => navigate('/reels/watched')}><Icon name="reels" className="sm"/>Watch history</button>
            {/* Clear-all erases ACTIVITY history — the mentions feed is not
                activity rows and is not deletable, so don't offer it there. */}
            {items.length > 0 && !isMentions && <button className="btn btn-secondary" onClick={clearAll}><Icon name="trash" className="sm"/>Clear all</button>}
          </div>
        </div>

        <div className="tabs">
          {FILTERS.map(([k, lab]) => <button key={k} className={'tab ' + (filter === k ? 'on' : '')} onClick={() => setFilter(k)}>{lab}</button>)}
        </div>

        {loading ? <Loader label={isMentions ? 'Loading your mentions…' : 'Loading activity…'}/>
          : !items.length ? (isMentions
            ? <EmptyState icon="at" title="No mentions yet" sub="When someone @mentions you in a post, comment, research, or Q&A, it will appear here."/>
            : <EmptyState icon="list" title="No activity yet" sub="Your actions across IKA will appear here."/>)
          : (
            <div className="card t-stagger" style={{ overflow:'hidden' }}>
              {grouped.map(({ a, head }) => {
                if (isMentions) {
                  // A /mentions/me row: the ACTOR's face, where it happened,
                  // the snippet captured at mention time, and the deep link.
                  const u = a._actor
                  return (
                    <React.Fragment key={a.key}>
                      {head && <div className="ntf-group">{head}</div>}
                      <div className={'ntf-row' + (a.deepLink ? '' : ' static')} style={{ cursor: a.deepLink ? 'pointer' : 'default' }} onClick={() => open(a)}>
                        <div className="ntf-avatar" role={u?.id ? 'button' : undefined}
                          onClick={(e) => { if (u?.id) { e.stopPropagation(); navigate(`/u/${u.id}`) } }}>
                          <Avatar initials={u.initials} color={u.avc} size={42} src={u.profileImage}/>
                          <span className="ntf-badge" style={{ background:'#6b5b8a' }}><Icon name="at" className="xs"/></span>
                        </div>
                        <div className="ntf-body">
                          <p><b>{u.full}</b> <span className="muted">mentioned you {MENTION_SOURCE[a.sourceType] || ''}</span></p>
                          {a.snippet && <p className="muted" dir="auto" style={{ marginTop:3 }}>“{a.snippet}”</p>}
                          <small className="muted">{a.time} ago</small>
                        </div>
                      </div>
                    </React.Fragment>
                  )
                }
                const [icon, tint] = META[a.type] || ['bell', '#8a93a3']
                return (
                  <React.Fragment key={a.id}>
                    {head && <div className="ntf-group">{head}</div>}
                    <div className={'ntf-row' + (a.deepLink ? '' : ' static')} style={{ cursor: a.deepLink ? 'pointer' : 'default' }} onClick={() => open(a)}>
                      <div className="ntf-avatar">
                        <Avatar initials={me.initials} color={me.avc} size={42} src={me.profileImage}/>
                        <span className="ntf-badge" style={{ background: tint }}><Icon name={icon} className="xs"/></span>
                      </div>
                      <div className="ntf-body">
                        <p><b>{a.label}</b>{a.subtitle && <> <span className="muted">{a.subtitle}</span></>}</p>
                        <small className="muted">{a.time}</small>
                      </div>
                      <button className="icon-btn" title="Remove" onClick={(e) => { e.stopPropagation(); del(a.id) }}><Icon name="close" className="sm"/></button>
                    </div>
                  </React.Fragment>
                )
              })}
            </div>
          )}

        {!loading && isMentions && mMore && (
          <button className="btn btn-secondary ntf-more" style={{ marginTop:14 }} onClick={loadMoreMentions} disabled={mLoadingMore}>
            {mLoadingMore ? 'Loading…' : 'Show more'}
          </button>
        )}
      </div>
    </div>
  )
}
