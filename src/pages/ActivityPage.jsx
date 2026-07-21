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
  POST_CREATED:['compose','#b3271e'], POST_REACTION:['heart','#c2453f'], POST_COMMENT:['comment','#b3271e'],
  POST_COMMENT_REACTION:['heart','#c2453f'], POST_SHARE:['share','#1f3a6e'], POST_SAVED:['bookmark','#b3271e'],
  REEL_WATCH:['reels','#c2453f'],
  GLOBAL_SEARCH:['search','#9b948e'], HASHTAG_SEARCH:['hash','#b3271e'], MENTION_LOOKUP:['at','#b3271e'],
  USER_MENTIONED:['at','#b3271e'], PROFILE_VIEW:['eye','#1f3a6e'], FOLLOWED_USER:['follow','#1f3a6e'],
  QNA_QUESTION_CREATED:['qna','#c9382f'], QNA_QUESTION_SAVED:['bookmark','#b3271e'], QNA_ANSWER_CREATED:['reply','#b3271e'],
  QNA_REANSWER_CREATED:['reply','#b3271e'], QNA_ANSWER_REACTION:['heart','#c2453f'],
  RESEARCH_PUBLISHED:['research','#b3271e'], RESEARCH_SAVED:['bookmark','#b3271e'], RESEARCH_REACTION:['heart','#c2453f'],
  RESEARCH_COMMENT:['comment','#b3271e'], RESEARCH_COMMENT_REACTION:['heart','#c2453f'],
  STORY_VIEWED:['eye','#1f3a6e'], STORY_REACTED:['heart','#c2453f'], STORY_REPLIED:['reply','#b3271e'], STORY_POLL_VOTED:['qna','#c9382f'],
  SOUND_USED:['music','#b3271e'],
}

// Tabs → the activity `types` they request from the server.
const FILTERS = [
  ['ALL', 'All', null],
  ['POSTS', 'Posts', ['POST_CREATED','POST_REACTION','POST_COMMENT','POST_COMMENT_REACTION','POST_SHARE','POST_SAVED','REEL_WATCH']],
  ['QNA', 'Q&A', ['QNA_QUESTION_CREATED','QNA_QUESTION_SAVED','QNA_ANSWER_CREATED','QNA_REANSWER_CREATED','QNA_ANSWER_REACTION']],
  ['RESEARCH', 'Research', ['RESEARCH_PUBLISHED','RESEARCH_SAVED','RESEARCH_REACTION','RESEARCH_COMMENT','RESEARCH_COMMENT_REACTION']],
  ['SOCIAL', 'Social', ['FOLLOWED_USER','PROFILE_VIEW','USER_MENTIONED','MENTION_LOOKUP']],
  ['SEARCH', 'Searches', ['GLOBAL_SEARCH','HASHTAG_SEARCH']],
]
const TYPES_OF = Object.fromEntries(FILTERS.map(([k, , t]) => [k, t]))

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
  const me = user || { initials:'Y', avc:'linear-gradient(135deg,#c9382f,#8f1f18)' }
  const [filter, setFilter] = React.useState('ALL')
  const [items, setItems] = React.useState([])
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    let alive = true
    setLoading(true)
    api.activity.list({ types: TYPES_OF[filter] || undefined })
      .then(rows => { if (alive) setItems(rows || []) })
      .catch(() => { if (alive) setItems([]) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [filter])

  // Live: prepend new activity rows that fit the active filter (dedupe by id).
  const filterRef = React.useRef(filter); React.useEffect(() => { filterRef.current = filter }, [filter])
  React.useEffect(() => api.activity.stream({
    onActivity: (a) => {
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
            {items.length > 0 && <button className="btn btn-secondary" onClick={clearAll}><Icon name="trash" className="sm"/>Clear all</button>}
          </div>
        </div>

        <div className="tabs">
          {FILTERS.map(([k, lab]) => <button key={k} className={'tab ' + (filter === k ? 'on' : '')} onClick={() => setFilter(k)}>{lab}</button>)}
        </div>

        {loading ? <Loader label="Loading activity…"/>
          : !items.length ? <EmptyState icon="list" title="No activity yet" sub="Your actions across IKA will appear here."/>
          : (
            <div className="card t-stagger" style={{ overflow:'hidden' }}>
              {grouped.map(({ a, head }) => {
                const [icon, tint] = META[a.type] || ['bell', '#5e574b']
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
      </div>
    </div>
  )
}
