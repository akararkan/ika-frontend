/* =========================================================
   Activity page — /activity (per-user activity feed, live).
   ========================================================= */
import React from 'react'
import { Icon, Avatar } from '../components/ui.jsx'
import { Loader, EmptyState } from '../components/states.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { api } from '../api/index.js'

const ICON = {
  POST_CREATED:'compose', POST_REACTION:'heart', POST_COMMENT:'comment', POST_COMMENT_REACTION:'heart',
  POST_SHARE:'share', POST_SAVED:'bookmark', REEL_WATCH:'reels', USER_MENTIONED:'at',
  QUESTION_CREATED:'qna', RESEARCH_REACTION:'heart', RESEARCH_COMMENT:'comment',
}
const TINT = {
  POST_CREATED:'#0e6b54', POST_REACTION:'#c2453f', POST_COMMENT:'#0e6b54', POST_COMMENT_REACTION:'#c2453f',
  POST_SHARE:'#3f6a8a', POST_SAVED:'#bd9344', REEL_WATCH:'#c2453f', USER_MENTIONED:'#bd9344',
  QUESTION_CREATED:'#159a76', RESEARCH_REACTION:'#c2453f', RESEARCH_COMMENT:'#0e6b54',
}
const VERB = {
  POST_CREATED:'You created', POST_REACTION:'You liked', POST_COMMENT:'You commented on', POST_COMMENT_REACTION:'You liked a comment on',
  POST_SHARE:'You shared', POST_SAVED:'You saved', REEL_WATCH:'You watched', USER_MENTIONED:'You were mentioned in',
  QUESTION_CREATED:'You asked', RESEARCH_REACTION:'You reacted to', RESEARCH_COMMENT:'You commented on',
}
const FILTERS = [['ALL','All'], ['POSTS','Posts'], ['QNA','Q&A'], ['RESEARCH','Research']]
const inGroup = (type='', g) =>
  g === 'ALL' ? true :
  g === 'POSTS' ? type.startsWith('POST') || type === 'REEL_WATCH' || type === 'USER_MENTIONED' :
  g === 'QNA' ? type.startsWith('QUESTION') || type.startsWith('ANSWER') :
  g === 'RESEARCH' ? type.startsWith('RESEARCH') : true

export function ActivityPage() {
  const { user } = useAuth()
  const me = user || { initials:'Y', avc:'linear-gradient(135deg,#159a76,#0a4a3c)' }
  const [filter, setFilter] = React.useState('ALL')
  const [items, setItems] = React.useState([])
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    if (!user?.id) { setLoading(false); return }
    let alive = true
    api.activity.forUser(user.id).then(rows => { if (alive) setItems(rows || []) })
      .catch(() => {}).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [user?.id])

  const list = items.filter(a => inGroup(a.type, filter))

  return (
    <div className="main center">
      <div className="col-main">
        <div className="phead">
          <div>
            <h1>Your <em>activity</em></h1>
            <p className="sub">A timeline of everything you’ve posted, liked, saved, shared, watched, and been mentioned in.</p>
          </div>
        </div>

        <div className="tabs">
          {FILTERS.map(([k, lab]) => <button key={k} className={'tab ' + (filter === k ? 'on' : '')} onClick={() => setFilter(k)}>{lab}</button>)}
        </div>

        {loading ? <Loader label="Loading activity…"/>
          : !list.length ? <EmptyState icon="list" title="No activity yet" sub="Your actions across IKA will appear here."/>
          : (
            <div className="card" style={{ overflow:'hidden' }}>
              {list.map(a => (
                <div key={a.id} className="ntf-row">
                  <div className="ntf-avatar">
                    <Avatar initials={me.initials} color={me.avc} size={42}/>
                    <span className="ntf-badge" style={{ background: TINT[a.type] || '#3c4f49' }}><Icon name={ICON[a.type] || 'bell'} className="xs"/></span>
                  </div>
                  <div className="ntf-body">
                    <p><b>{VERB[a.type] || 'Activity'}</b> <span className="muted">{a.target}</span></p>
                    {a.snippet && <div className="ntf-snippet">"{a.snippet}"</div>}
                    <small className="muted">{a.time} ago{a.meta ? ` · ${a.meta}` : ''}</small>
                  </div>
                </div>
              ))}
            </div>
          )}
      </div>
    </div>
  )
}
