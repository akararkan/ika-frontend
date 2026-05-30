/* =========================================================
   Notifications page — /notifications  (per USER_API.md)
   Real inbox: category tabs, unread, mark-read, deep links.
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, Avatar } from '../components/ui.jsx'
import { Loader, EmptyState } from '../components/states.jsx'
import { authorOf } from '../lib/userView.js'
import { api } from '../api/index.js'

// 6-category inbox (NOTIFICATIONS_API §4) + All. "Unread only" is a composable
// toggle (§7.1 — unread now ANDs with category) rather than a separate tab.
const TABS = [
  ['ALL', 'All', null],
  ['POSTS', 'Posts', 'POSTS'],
  ['QNA', 'Q&A', 'QNA'],
  ['RESEARCH', 'Research', 'RESEARCH'],
  ['MENTIONS', 'Mentions', 'MENTIONS'],
  ['SOCIAL', 'Social', 'SOCIAL'],
  ['SYSTEM', 'System', 'SYSTEM'],
]
const CAT_OF = Object.fromEntries(TABS.map(([k, , c]) => [k, c]))
const CAT_ICON = { POSTS:'heart', QNA:'qna', RESEARCH:'research', MENTIONS:'at', SOCIAL:'follow', SYSTEM:'bell' }
const CAT_TINT = { POSTS:'#c2453f', QNA:'#159a76', RESEARCH:'#bd9344', MENTIONS:'#bd9344', SOCIAL:'#3f6a8a', SYSTEM:'#3c4f49' }

// The daily trending digest (NOTIFICATIONS_API §11.6) has no actor and its body is a
// comma-joined hashtag list. Parse the #tags so each can route to its tag feed.
const TAG_RE = /#[\p{L}\p{N}_-]+/gu
const trendingTags = (body) => body?.match(TAG_RE) ?? []

export function NotificationsPage() {
  const navigate = useNavigate()
  const [tab, setTab] = React.useState('ALL')
  const [unreadOnly, setUnreadOnly] = React.useState(false)
  const [items, setItems] = React.useState([])
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback((tabKey, unread) => {
    setLoading(true)
    api.notifications.list({ category: CAT_OF[tabKey] || undefined, unread: unread || undefined })   // §7.1 filters compose (AND)
      .then(rows => setItems(rows || []))
      .catch(() => setItems([])).finally(() => setLoading(false))
  }, [])

  React.useEffect(() => { load(tab, unreadOnly) }, [tab, unreadOnly, load])

  // live inbox (§8/§11): upsert by id (aggregation → replace + float to top),
  // sync read/deleted across tabs. Subscribe once; read current filters via refs.
  const tabRef = React.useRef(tab); React.useEffect(() => { tabRef.current = tab }, [tab])
  const unreadRef = React.useRef(unreadOnly); React.useEffect(() => { unreadRef.current = unreadOnly }, [unreadOnly])
  React.useEffect(() => api.notifications.stream({
    onNotification: (n) => {
      const t = tabRef.current
      const fits = (t === 'ALL' || n.category === t) && (!unreadRef.current || n.unread)
      if (!fits) return
      // upsert by id: aggregated re-delivery replaces the row AND floats it to the top
      setItems(arr => [n, ...arr.filter(x => x.id !== n.id)])
    },
    onRead: ({ ids, allRead }) => setItems(arr => {
      const marked = arr.map(x => (allRead || ids?.includes(x.id)) ? { ...x, unread: false } : x)
      return unreadRef.current ? marked.filter(x => x.unread) : marked   // drop now-read rows when filtering unread
    }),
    onDeleted: ({ ids, allRead }) => setItems(arr => allRead ? arr.filter(x => x.unread) : arr.filter(x => !ids?.includes(x.id))),
  }), [])

  const open = (n) => {
    if (n.unread) { api.notifications.markRead(n.id).catch(() => {}); setItems(arr => unreadOnly ? arr.filter(x => x.id !== n.id) : arr.map(x => x.id === n.id ? { ...x, unread: false } : x)) }
    if (n.deepLink) navigate(n.deepLink)
  }
  const markAll = () => {
    const cat = CAT_OF[tab]
    ;(cat ? api.notifications.markCategoryRead(cat) : api.notifications.markAllRead()).catch(() => {})   // §7.7 / §7.4
    setItems(arr => unreadOnly ? [] : arr.map(n => ({ ...n, unread: false })))   // only the current tab's rows are shown
  }

  return (
    <div className="main center">
      <div className="col-main ntf-page">
        <div className="phead">
          <div>
            <h1>Notifications</h1>
            <p className="sub">Latest activity across your posts, research, and community.</p>
          </div>
          <button className="btn btn-secondary" onClick={markAll}><Icon name="check" className="sm"/>Mark all as read</button>
        </div>

        <div className="ntf-toolbar">
          <div className="tabs">
            {TABS.map(([k, label]) => (
              <button key={k} className={'tab ' + (tab === k ? 'on' : '')} onClick={() => setTab(k)}>{label}</button>
            ))}
          </div>
          <button className={'tab ntf-unread-toggle ' + (unreadOnly ? 'on' : '')} onClick={() => setUnreadOnly(v => !v)} title="Show only unread (composes with the selected tab)">
            <Icon name="bell" className="xs"/>Unread{unreadOnly ? ' ✓' : ''}
          </button>
        </div>

        {loading ? <Loader label="Loading notifications…"/>
          : !items.length ? <EmptyState icon="bell" title="You’re all caught up" sub="New activity will appear here."/>
          : (
            <div className="card" style={{ overflow:'hidden' }}>
              {items.map(n => {
                const u = n._actor || authorOf(n)
                // TRENDING_DIGEST: no actor — render a system tile + tag chips instead of a user avatar (§11.6)
                const isTrending = n.type === 'TRENDING_DIGEST'
                const tags = isTrending ? trendingTags(n.body) : []
                return (
                  <div key={n.id} className={'ntf-row ' + (n.unread ? 'unread' : '')} style={{ cursor: n.deepLink ? 'pointer' : 'default' }} onClick={() => open(n)}>
                    <div className="ntf-avatar">
                      {isTrending
                        ? <span className="ntf-tile" style={{ background: CAT_TINT.SYSTEM }}><Icon name="trending"/></span>
                        : <Avatar initials={u.initials} color={u.avc} size={42} src={u.profileImage}/>}
                      <span className="ntf-badge" style={{ background: isTrending ? '#bd9344' : (CAT_TINT[n.category] || '#3c4f49') }}><Icon name={isTrending ? 'trending' : (CAT_ICON[n.category] || 'bell')} className="xs"/></span>
                    </div>
                    <div className="ntf-body">
                      {isTrending && tags.length ? (
                        <>
                          <p><b>{n.title || 'Trending in scholarship'}</b></p>
                          <div className="chips" style={{ margin:'6px 0 2px' }}>
                            {tags.map(t => (
                              <button key={t} className="chip" onClick={(e) => { e.stopPropagation(); navigate(`/tags/${encodeURIComponent(t.slice(1))}`) }}>
                                <span style={{ color:'var(--brass)' }}>#</span>{t.slice(1)}
                              </button>
                            ))}
                          </div>
                        </>
                      ) : (
                        <p><b>{n.title || u.full}</b> {n.body && <span className="muted">{n.body}</span>}</p>
                      )}
                      <small className="muted">{n.time} ago{n.aggregateCount > 1 ? ` · ${n.aggregateCount} people` : ''}</small>
                    </div>
                    <button className="icon-btn" onClick={(e) => { e.stopPropagation(); api.notifications.remove(n.id).catch(() => {}); setItems(arr => arr.filter(x => x.id !== n.id)) }}><Icon name="close" className="sm"/></button>
                  </div>
                )
              })}
            </div>
          )}
      </div>
    </div>
  )
}
