/* =========================================================
   App shell layout — topbar, sidebar, mobile bottom nav.
   Uses the router (NavLink/useNavigate) and renders <Outlet/>.
   ========================================================= */
import React from 'react'
import { NavLink, useNavigate, Outlet, useLocation } from 'react-router-dom'
import { Icon, Avatar, BrandMark } from './ui.jsx'
import { ToastHost, Loader } from './states.jsx'
import { DialogHost } from './Dialog.jsx'
import { ShareHost } from './ShareSheet.jsx'
import { ComposeModal } from './ComposeModal.jsx'
import { SearchTypeahead } from './SearchTypeahead.jsx'
import { CallOverlay } from './chat/CallOverlay.jsx'
import { useAuth, isPlatformAdmin } from '../context/AuthContext.jsx'
import { useChat } from '../context/ChatContext.jsx'
import { initChime, playChime } from '../lib/chime.js'
import { api } from '../api/index.js'

const NAV = [
  { to:'/',              icon:'home',      label:'Home', end:true },
  { to:'/explore',       icon:'search',    label:'Explore' },
  { to:'/people',        icon:'users',     label:'People' },
  { to:'/reels',         icon:'reels',     label:'Reels' },
  { to:'/qna',           icon:'qna',       label:'Q&A' },
  { to:'/research',      icon:'research',  label:'Research' },
  { to:'/notifications', icon:'bell',      label:'Notifications' },
  { to:'/chat',          icon:'chat',      label:'Messages' },
  { to:'/channels',      icon:'broadcast', label:'Channels' },
  { to:'/live',          icon:'megaphone', label:'Live' },
  { to:'/activity',      icon:'list',      label:'Activity' },
  { to:'/saved',         icon:'bookmark',  label:'Saved' },
  { to:'/profile',       icon:'user',      label:'Profile' },
  { to:'/settings',      icon:'settings',  label:'Settings' },
]

/* Shown only to ROLE_ADMIN / SUPER_ADMIN (search-index maintenance). */
const ADMIN_NAV = { to:'/admin/search', icon:'shield', label:'Search admin' }

/* Main pages → bottom tab bar; every page (incl. these) → the sidebar drawer.
   Messages is a first-class tab here, not just a topbar icon: on a phone the
   topbar shortcut competes with the search field for the same row, and chat
   is the one surface people return to on a loop. It carries the same live
   `totalUnread` badge the sidebar and topbar read. */
const BOTTOM_TABS = [
  { to:'/',        icon:'home',  label:'Home', end:true },
  { to:'/reels',   icon:'reels', label:'Reels' },
  { to:'/chat',    icon:'chat',  label:'Chats', badge:'chat' },
  { to:'/profile', icon:'user',  label:'You' },
]

export function Layout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { user, logout } = useAuth()
  // Layout renders inside <ChatProvider> (App.jsx), so the chat badge reads the
  // same live socket every chat surface uses — no second stream for the shell.
  const { totalUnread } = useChat()
  /* No invented identity: Layout renders behind RequireAuth, so `user` is
     effectively always present — and when it briefly isn't (corrupt cache
     race), the me-chip and you-card simply don't render rather than
     showing a fabricated "You / @you" account. */
  const me = user
  const [composeType, setComposeType] = React.useState(null)
  const [editPost, setEditPost] = React.useState(null)
  const [unread, setUnread] = React.useState(0)
  const [navOpen, setNavOpen] = React.useState(false)
  const [desktopNavOpen, setDesktopNavOpen] = React.useState(() => {
    try { return window.localStorage.getItem('ika:sidebar') !== 'closed' }
    catch { return true }
  })

  React.useEffect(() => {
    try { window.localStorage.setItem('ika:sidebar', desktopNavOpen ? 'open' : 'closed') }
    catch { /* storage may be unavailable in private contexts */ }
  }, [desktopNavOpen])

  // On mobile the full sidebar slides in as a left drawer (the topbar hamburger
  // opens it); the bottom bar carries the main pages.
  // Close the drawer on navigation and on Escape.
  React.useEffect(() => { setNavOpen(false) }, [location.pathname])
  React.useEffect(() => {
    if (!navOpen) return
    const onKey = (e) => { if (e.key === 'Escape') setNavOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navOpen])

  // any page can open the composer by dispatching window 'ika:compose'.
  // detail is a postType string (create) OR { editPost } (edit, §6.4).
  // CRITICAL: when opening EDIT mode, always re-fetch the canonical post
  // before showing the modal. Feed items only carry `textPreview` (truncated
  // to 280 chars by POST_API §5), so if we let the modal pre-fill its
  // textarea from a feed-shape post, saving without retyping would overwrite
  // the full body with the truncated preview — silent data loss.
  React.useEffect(() => {
    const h = async (e) => {
      const d = e.detail
      if (d && typeof d === 'object' && d.editPost) {
        const seed = d.editPost
        let full = seed
        try { full = await api.posts.get(seed.id) } catch { /* fall back to seed */ }
        setEditPost(full); setComposeType('EDIT')
      } else {
        setEditPost(null); setComposeType(d || 'TEXT')
      }
    }
    window.addEventListener('ika:compose', h)
    return () => window.removeEventListener('ika:compose', h)
  }, [])

  // live unread badge: seed from /unread/count, then SET from `unread-count` SSE
  // events (absolute — never hand-increment; aggregated rows wouldn't add up).
  // ONE shared stream app-wide (api.notifications.subscribe fans a single
  // hardened socket out — watchdog + expired-token heal live in there, not
  // here). The chime rides this subscription; the 1.2s throttle in chime.js
  // absorbs coalesced bursts. `onConnected` fires on EVERY (re)connect and is
  // the reconcile signal — a badge event missed while the socket was dead is
  // recovered by re-reading the exact O(1) counter.
  React.useEffect(() => {
    initChime()                                  // arm the autoplay unlock on the first gesture
    const reseed = () => api.notifications.unreadCount().then(setUnread).catch(() => {})
    reseed()
    return api.notifications.subscribe({
      onUnreadCount: setUnread,
      onNotification: (n) => { if (n?.unread) playChime('notification') },
      onConnected: reseed,
    })
  }, [])

  const onPublished = (post) => {
    window.dispatchEvent(new CustomEvent('ika:post-created', { detail: post }))
    navigate('/')
  }
  // edit (PATCH §6.4): patch in place, stay on the current page
  const onEdited = (post) => window.dispatchEvent(new CustomEvent('ika:post-updated', { detail: post }))
  const closeCompose = () => { setComposeType(null); setEditPost(null) }
  const signOut = async () => { await logout(); navigate('/login') }

  return (
    <div className={'app' + (desktopNavOpen ? '' : ' sidebar-collapsed')}>
      <header className="topbar">
        <button className="topbar-menu" onClick={() => setNavOpen(true)} aria-label="Open menu"><Icon name="menu"/></button>
        <button className="sidebar-toggle" onClick={() => setDesktopNavOpen(open => !open)}
          aria-label={desktopNavOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          aria-expanded={desktopNavOpen} aria-controls="app-sidebar"
          title={desktopNavOpen ? 'Collapse sidebar' : 'Expand sidebar'}>
          <Icon name="chevleft"/>
        </button>
        <div className="brand" onClick={() => navigate('/')} style={{ cursor:'pointer' }}>
          <div className="mark"><BrandMark/></div>
          <div className="word">IKA<b> ·</b> Archive</div>
        </div>

        {/* The field owns its own state and its own network life-cycle — the
            shell renders on every route, so a search box that fetched from
            here would fetch everywhere. See SearchTypeahead. */}
        <SearchTypeahead/>

        <div className="tb-actions">
          <button className="icon-btn" style={{ position:'relative' }} onClick={() => navigate('/chat')}
            aria-label={totalUnread > 0 ? `Messages, ${totalUnread} unread` : 'Messages'} title="Messages">
            <Icon name="chat"/>
            {totalUnread > 0 && (
              /* keyed on the value: a changed count remounts the bubble and
                 restarts its pop animation — the badge beats in realtime */
              <span key={totalUnread} className={'count' + (totalUnread > 9 ? ' wide' : '')} aria-hidden="true">
                {totalUnread > 99 ? '99+' : totalUnread}
              </span>
            )}
          </button>
          <button className="icon-btn" style={{ position:'relative' }} onClick={() => navigate('/notifications')}
            aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'} title="Notifications">
            <Icon name="bell"/>{unread > 0 && <span className="dot"/>}
          </button>
          <button className="icon-btn tint" onClick={() => setComposeType('TEXT')}><Icon name="feather"/></button>
          {me && (
            <button className="me-chip" onClick={() => navigate('/profile')}>
              <Avatar initials={me.initials} color={me.avc} size={30} src={me.profileImage}/>
              <span className="nm">{(me.full || '').split(' ')[0]}</span>
            </button>
          )}
        </div>
      </header>

      <aside id="app-sidebar" className={'sidebar' + (navOpen ? ' open' : '')}>
        <div className="sidebar-head">
          <div className="brand">
            <div className="mark"><BrandMark/></div>
            <div><div className="word">IKA<b>.</b></div><small>Islamic Knowledge Archive</small></div>
          </div>
          <button className="icon-btn" aria-label="Close menu" onClick={() => setNavOpen(false)}><Icon name="close"/></button>
        </div>
        <nav className="nav">
          {/* Platform admins get one extra entry. Appended to the sidebar only —
              the bottom tab bar is a curated four and stays that way. */}
          {(isPlatformAdmin(me) ? [...NAV, ADMIN_NAV] : NAV).map(n => (
            <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setNavOpen(false)}
              className={({ isActive }) => 'nav-item ' + (isActive ? 'active' : '')}>
              <Icon name={n.icon}/><span>{n.label}</span>
              {n.to === '/notifications' && unread > 0 && <span className="badge">{unread}</span>}
              {n.to === '/chat' && totalUnread > 0 && (
                <span className="badge">{totalUnread > 99 ? '99+' : totalUnread}</span>
              )}
            </NavLink>
          ))}
        </nav>

        <button className="cta-compose" onClick={() => { setNavOpen(false); setComposeType('TEXT') }}>
          <Icon name="compose" className="sm"/><span>Create</span>
        </button>

        {me && (
          <div className="side-section" style={{ marginTop:'auto' }}>
            <div className="you-card">
              <Avatar initials={me.initials} color={me.avc} size={40} src={me.profileImage}/>
              <div className="who">
                <div className="nm">{me.full}</div>
                <small>@{me.handle}</small>
              </div>
              <button className="icon-btn" title="Sign out" onClick={signOut}><Icon name="logout" className="sm"/></button>
            </div>
          </div>
        )}
      </aside>

      <main style={{ minWidth:0 }}>
        {/* lazy page chunks resolve here → the shell stays, only content shows the loader */}
        <React.Suspense fallback={<div className="main center"><div className="col-main"><Loader label="Loading…"/></div></div>}>
          <Outlet/>
        </React.Suspense>
      </main>

      <nav className="botnav">
        {/* Rendered from the table rather than four hand-written links so the
            create button can sit in the middle without the tabs drifting out
            of sync with BOTTOM_TABS. */}
        {BOTTOM_TABS.map((t, i) => (
          <React.Fragment key={t.to}>
            {i === 2 && (
              <a className="mid" onClick={() => setComposeType('TEXT')} aria-label="Create">
                <span className="plus"><Icon name="feather"/></span>
              </a>
            )}
            <NavLink to={t.to} end={t.end}
              className={({ isActive }) => isActive ? 'active' : ''}
              aria-label={t.badge === 'chat' && totalUnread > 0
                ? `${t.label}, ${totalUnread} unread`
                : undefined}>
              <span className="botnav-ico">
                <Icon name={t.icon}/>
                {t.badge === 'chat' && totalUnread > 0 && (
                  <span key={totalUnread} className="botnav-dot" aria-hidden="true">
                    {totalUnread > 9 ? '9+' : totalUnread}
                  </span>
                )}
              </span>
              <small>{t.label}</small>
            </NavLink>
          </React.Fragment>
        ))}
      </nav>

      {composeType && (
        <ComposeModal
          type={composeType === 'EDIT' ? undefined : composeType}
          editPost={composeType === 'EDIT' ? editPost : null}
          onClose={closeCompose} onPublished={onPublished} onEdited={onEdited}/>
      )}
      <div className={'nav-scrim' + (navOpen ? ' open' : '')} aria-hidden={!navOpen} onClick={() => setNavOpen(false)}/>
      {/* App-wide: a call has to be answerable from wherever you are, and its
          <video> elements must survive route changes mid-negotiation. */}
      <CallOverlay/>
      <ToastHost/>
      <DialogHost/>
      <ShareHost/>
    </div>
  )
}
