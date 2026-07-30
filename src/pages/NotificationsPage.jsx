/* =========================================================
   Notifications page — /notifications  (per NOTIFICATIONS_API)
   Real inbox: category tabs, unread, mark-read, deep links,
   paged "show more" (bounded by the server's 200-row scan
   window), purge-read, and the chime preference.
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, Avatar, showToast } from '../components/ui.jsx'
import { Loader, EmptyState } from '../components/states.jsx'
import { uiConfirm } from '../components/Dialog.jsx'
import { authorOf } from '../lib/userView.js'
import { soundEnabled, setSoundEnabled, subscribeSound, playChime } from '../lib/chime.js'
import { api } from '../api/index.js'

// 7-category inbox (NOTIFICATIONS_API §4) + All. "Unread only" is a composable
// toggle (§7.1 — unread ANDs with category) rather than a separate tab. CHAT
// gathers everything that lives in the messenger: messages, requests, group
// adds, missed calls, channel activity.
const TABS = [
  ['ALL', 'All', null],
  ['POSTS', 'Posts', 'POSTS'],
  ['QNA', 'Q&A', 'QNA'],
  ['RESEARCH', 'Research', 'RESEARCH'],
  ['MENTIONS', 'Mentions', 'MENTIONS'],
  ['SOCIAL', 'Social', 'SOCIAL'],
  ['CHAT', 'Chat', 'CHAT'],
  ['SYSTEM', 'System', 'SYSTEM'],
]
const CAT_OF = Object.fromEntries(TABS.map(([k, , c]) => [k, c]))
const CAT_ICON = { POSTS:'heart', QNA:'qna', RESEARCH:'research', MENTIONS:'at', SOCIAL:'follow', CHAT:'chat', SYSTEM:'bell' }
const CAT_TINT = { POSTS:'#b3453e', QNA:'#1f4e7e', RESEARCH:'#1f4e7e', MENTIONS:'#6b5b8a', SOCIAL:'#426a5a', CHAT:'#163e66', SYSTEM:'#8a93a3' }

/* Every notification kind gets its own badge glyph — the category icon alone
   cannot tell a missed call from a channel post (both CHAT), and the
   uncategorized kinds (stories, sound approval, contributor adds — category
   null on the wire, §4) would otherwise all render as a generic bell. */
const TYPE_ICON = {
  NEW_FOLLOWER:'follow', UNBLOCKED:'user',
  POST_NEW:'feather', POST_REACTED:'heart', POST_COMMENTED:'comment',
  POST_COMMENT_REPLIED:'reply', POST_COMMENT_REACTED:'heart', POST_SHARED:'share',
  POST_MENTIONED:'at', USER_MENTIONED:'at',
  STORY_PUBLISHED:'camera', STORY_REACTED:'heart', STORY_REPLIED:'reply',
  PUBLICATION_LIKED:'heart', PUBLICATION_COMMENTED:'comment',
  PUBLICATION_COMMENT_REACTED:'heart', PUBLICATION_CITED:'cite',
  RESEARCH_CONTRIBUTOR_ADDED:'users',
  QUESTION_NEW:'qna', QUESTION_ANSWERED:'message', ANSWER_REPLIED:'reply',
  ANSWER_REACTED:'heart', ANSWER_ACCEPTED:'check',
  SOUND_APPROVED:'music', SYSTEM_MESSAGE:'info', SYSTEM_ANNOUNCEMENT:'megaphone',
  ACCOUNT_WARNING:'alert', TRENDING_DIGEST:'trending',
  NEW_MESSAGE:'chat', MESSAGE_MENTION:'at', MESSAGE_REQUEST:'mail', ADDED_TO_GROUP:'users',
  CALL_MISSED:'phonemiss', CHANNEL_NEW_POST:'broadcast',
  CHANNEL_JOIN_REQUEST:'hourglass', CHANNEL_JOIN_APPROVED:'check',
  STREAM_STARTED:'megaphone',
  // Legacy kinds — old rows only, no live trigger (§2 note).
  UNFOLLOWED:'userminus', BLOCKED:'block', RESTRICTED:'lock',
  CONNECTION_REQUEST:'follow', CONNECTION_ACCEPTED:'check',
}
/* Tints for the kinds whose category is null on the wire. MESSAGE_MENTION
   officially lands in MENTIONS (its CAT_TINT wins); the entry here is only a
   fallback for a deploy whose category table predates the kind. */
const TYPE_TINT = {
  STORY_PUBLISHED:'#6b5b8a', STORY_REACTED:'#b3453e', STORY_REPLIED:'#6b5b8a',
  SOUND_APPROVED:'#426a5a', PUBLICATION_COMMENT_REACTED:'#1f4e7e',
  RESEARCH_CONTRIBUTOR_ADDED:'#1f4e7e', ACCOUNT_WARNING:'#8a5a17',
  MESSAGE_MENTION:'#6b5b8a',
}

// The daily trending digest (§5) has no actor and its body is a comma-joined
// hashtag list. Parse the #tags so each can route to its tag feed.
const TAG_RE = /#[\p{L}\p{N}_-]+/gu
const trendingTags = (body) => body?.match(TAG_RE) ?? []

// Group the (newest-first) inbox into friendly date sections.
const DAY = 864e5
function bucketOf(createdAt) {
  if (!createdAt) return 'Earlier'
  const t = new Date(createdAt).getTime()
  if (Number.isNaN(t)) return 'Earlier'
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (t >= startToday) return 'Today'
  if (t >= startToday - DAY) return 'Yesterday'
  if (t >= startToday - 6 * DAY) return 'Earlier this week'
  return 'Earlier'
}
function groupByBucket(items) {
  const order = ['Today', 'Yesterday', 'Earlier this week', 'Earlier']
  const map = {}
  for (const n of items) { const b = bucketOf(n.createdAt); (map[b] ||= []).push(n) }
  return order.filter(l => map[l]?.length).map(l => [l, map[l]])
}

const PAGE_SIZE = 30

export function NotificationsPage() {
  const navigate = useNavigate()
  const [tab, setTab] = React.useState('ALL')
  const [unreadOnly, setUnreadOnly] = React.useState(false)
  const [items, setItems] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [hasMore, setHasMore] = React.useState(false)
  const pageRef = React.useRef(0)

  const sound = React.useSyncExternalStore(subscribeSound, soundEnabled, () => true)

  const load = React.useCallback((tabKey, unread) => {
    setLoading(true)
    pageRef.current = 0
    api.notifications.list({ category: CAT_OF[tabKey] || undefined, unread: unread || undefined, size: PAGE_SIZE })   // §7.1 filters compose (AND)
      .then(({ items: rows, hasMore: hm }) => { setItems(rows || []); setHasMore(hm && (rows || []).length > 0) })
      .catch(() => { setItems([]); setHasMore(false) })
      .finally(() => setLoading(false))
  }, [])

  React.useEffect(() => { load(tab, unreadOnly) }, [tab, unreadOnly, load])

  /* "Show more" pages deeper — but the server filters over a bounded scan of
     the newest 200 rows (§the-bounded-scan-window), so a page past the window
     comes back EMPTY even when older rows exist. An empty page is therefore
     "the end", never an error. */
  const loadMore = () => {
    if (loading || loadingMore || !hasMore) return
    setLoadingMore(true)
    const next = pageRef.current + 1
    api.notifications.list({ category: CAT_OF[tab] || undefined, unread: unreadOnly || undefined, page: next, size: PAGE_SIZE })
      .then(({ items: more, hasMore: hm }) => {
        pageRef.current = next
        setHasMore(hm && more.length > 0)
        setItems(arr => {
          const have = new Set(arr.map(x => x.id))
          return [...arr, ...more.filter(x => !have.has(x.id))]
        })
      })
      .catch(() => setHasMore(false))
      .finally(() => setLoadingMore(false))
  }

  // live inbox: upsert by id (aggregation re-delivers under the SAME id →
  // replace + float to top), sync read/deleted across tabs. This joins the
  // ONE shared app stream (Layout holds it open) — a second EventSource here
  // would count against the server's 5-emitter LRU cap and could evict our
  // own older tab. Subscribe once; read current filters via refs.
  const tabRef = React.useRef(tab); React.useEffect(() => { tabRef.current = tab }, [tab])
  const unreadRef = React.useRef(unreadOnly); React.useEffect(() => { unreadRef.current = unreadOnly }, [unreadOnly])
  React.useEffect(() => api.notifications.subscribe({
    /* Fires only on a real (re)connect — the shared socket is already open
       when this page mounts, so this is purely the "reconcile what the dead
       socket missed" signal, not a mount-time double fetch. */
    onConnected: () => load(tabRef.current, unreadRef.current),
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
    /* Two forms: per-id deletes carry ids; the purge-read echo carries EMPTY
       ids + allRead:true, meaning "drop every READ row from your cache". */
    onDeleted: ({ ids, allRead }) => setItems(arr => allRead ? arr.filter(x => x.unread) : arr.filter(x => !ids?.includes(x.id))),
  }), [load])

  const open = (n) => {
    if (n.unread) { api.notifications.markRead(n.id).catch(() => {}); setItems(arr => unreadOnly ? arr.filter(x => x.id !== n.id) : arr.map(x => x.id === n.id ? { ...x, unread: false } : x)) }
    if (n.deepLink) navigate(n.deepLink)
  }
  const markAll = () => {
    const cat = CAT_OF[tab]
    ;(cat ? api.notifications.markCategoryRead(cat) : api.notifications.markAllRead()).catch(() => {})
    setItems(arr => unreadOnly ? [] : arr.map(n => ({ ...n, unread: false })))   // only the current tab's rows are shown
  }
  const clearRead = async () => {
    const ok = await uiConfirm({
      title: 'Clear read notifications?',
      message: 'Every notification you have already read will be deleted. Unread ones are kept.',
      confirmLabel: 'Clear', danger: true, icon: 'trash',
    })
    if (!ok) return
    try {
      const n = await api.notifications.deleteRead()
      setItems(arr => arr.filter(x => x.unread))
      showToast(n > 0 ? `Cleared ${n} read notification${n === 1 ? '' : 's'}` : 'Nothing to clear')
    } catch { showToast('Could not clear read notifications') }
  }
  const toggleSound = () => {
    const next = !sound
    setSoundEnabled(next)
    // The click IS the unlock gesture — preview the chime so "on" is audible.
    if (next) playChime('notification')
  }

  const unreadCount = items.reduce((a, n) => a + (n.unread ? 1 : 0), 0)
  const readCount = items.length - unreadCount
  const groups = groupByBucket(items)

  return (
    <div className="main center">
      <div className="col-main ntf-page">
        <div className="phead ntf-head">
          <div>
            <h1>Notifications {unreadCount > 0 && <span className="ntf-count">{unreadCount}</span>} <span className="phead-ar" lang="ar" dir="rtl">الإشعارات</span></h1>
            <p className="sub">{unreadCount > 0 ? `You have ${unreadCount} unread notification${unreadCount > 1 ? 's' : ''}.` : 'Latest activity across your posts, research, and community.'}</p>
          </div>
          <div className="ntf-head-acts">
            <button className="btn btn-secondary" onClick={clearRead} disabled={!readCount} title="Delete every already-read notification"><Icon name="trash" className="sm"/>Clear read</button>
            <button className="btn btn-secondary" onClick={markAll} disabled={!unreadCount}><Icon name="check" className="sm"/>Mark all read</button>
          </div>
        </div>

        <div className="ntf-toolbar">
          <div className="tabs ntf-tabs">
            {TABS.map(([k, label]) => (
              <button key={k} className={'tab ' + (tab === k ? 'on' : '')} onClick={() => setTab(k)}>
                {CAT_OF[k] && <Icon name={CAT_ICON[CAT_OF[k]]} className="xs"/>}{label}
              </button>
            ))}
          </div>
          <button className={'ntf-unread-toggle ' + (unreadOnly ? 'on' : '')} onClick={() => setUnreadOnly(v => !v)} title="Show only unread (composes with the selected tab)">
            <span className="ntf-dot"/>Unread only
          </button>
          <button className={'ntf-unread-toggle ntf-sound ' + (sound ? 'on' : '')} onClick={toggleSound}
            title={sound ? 'Chime on new notifications — on' : 'Chime on new notifications — off'}
            aria-pressed={sound} aria-label="Notification sound">
            <Icon name={sound ? 'volume' : 'mute'} className="xs"/>Sound
          </button>
        </div>

        {loading ? <Loader label="Loading notifications…"/>
          : !items.length ? <EmptyState icon="bell" title={unreadOnly ? 'No unread notifications' : 'You’re all caught up'} sub="New activity will appear here."/>
          : groups.map(([label, rows]) => (
            <section key={label} className="ntf-section">
              <div className="ntf-group">{label}</div>
              <div className="card ntf-list t-stagger">
                {rows.map(n => {
                  const u = n._actor || authorOf(n)
                  // TRENDING_DIGEST: no actor — system tile + tag chips instead of a user avatar (§5)
                  const isTrending = n.type === 'TRENDING_DIGEST'
                  const tags = isTrending ? trendingTags(n.body) : []
                  const tint = isTrending ? '#1f4e7e' : (CAT_TINT[n.category] || TYPE_TINT[n.type] || '#8a93a3')
                  const hasActor = !isTrending && !!n._actor?.id
                  const goActor = (e) => { e.stopPropagation(); if (hasActor) navigate(`/u/${u.id}`) }
                  // Aggregated rows name the NEWEST contributor when the wire
                  // says who that was (the avatar stays the primary actor's —
                  // lastActor carries no image).
                  const others = n.aggregateCount > 1
                  const latest = others && n.lastActorUsername && n.lastActorUsername !== u.username
                    ? n.lastActorUsername : null
                  return (
                    <div key={n.id} className={'ntf-row ' + (n.unread ? 'unread' : '')} style={{ cursor: n.deepLink ? 'pointer' : 'default', '--cat': tint }} onClick={() => open(n)}>
                      <div className="ntf-avatar" role={hasActor ? 'button' : undefined} onClick={goActor}>
                        {hasActor
                          ? <Avatar initials={u.initials} color={u.avc} size={44} src={u.profileImage}/>
                          : <span className="ntf-tile" style={{ background: tint }}><Icon name={TYPE_ICON[n.type] || 'bell'}/></span>}
                        <span className="ntf-badge" style={{ background: tint }}><Icon name={TYPE_ICON[n.type] || CAT_ICON[n.category] || 'bell'} className="xs"/></span>
                      </div>
                      <div className="ntf-body">
                        {isTrending && tags.length ? (
                          <>
                            <p><b>{n.title || 'Trending in scholarship'}</b></p>
                            <div className="chips" style={{ margin:'7px 0 2px' }}>
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
                        <small className="ntf-meta">
                          <span>{n.time} ago</span>
                          {others && <span className="ntf-agg"><Icon name="follow" className="xs"/>{n.aggregateCount} people{latest ? ` · latest @${latest}` : ''}</span>}
                        </small>
                      </div>
                      <button className="ntf-x" title="Dismiss" onClick={(e) => { e.stopPropagation(); api.notifications.remove(n.id).catch(() => {}); setItems(arr => arr.filter(x => x.id !== n.id)) }}><Icon name="close" className="sm"/></button>
                    </div>
                  )
                })}
              </div>
            </section>
          ))}

        {!loading && hasMore && (
          <button className="btn btn-secondary ntf-more" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Show more'}
          </button>
        )}
      </div>
    </div>
  )
}
