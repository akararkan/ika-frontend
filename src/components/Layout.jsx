/* =========================================================
   App shell layout — topbar, sidebar, mobile bottom nav.
   Uses the router (NavLink/useNavigate) and renders <Outlet/>.
   ========================================================= */
import React from 'react'
import { NavLink, useNavigate, Outlet } from 'react-router-dom'
import { Icon, Avatar } from './ui.jsx'
import { ToastHost } from './states.jsx'
import { DialogHost } from './Dialog.jsx'
import { ComposeModal } from './ComposeModal.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { api } from '../api/index.js'

const NAV = [
  { to:'/',              icon:'home',     label:'Home', end:true },
  { to:'/explore',       icon:'search',   label:'Explore' },
  { to:'/reels',         icon:'reels',    label:'Reels' },
  { to:'/qna',           icon:'qna',      label:'Q&A' },
  { to:'/research',      icon:'research', label:'Research' },
  { to:'/notifications', icon:'bell',     label:'Notifications' },
  { to:'/activity',      icon:'list',     label:'Activity' },
  { to:'/saved',         icon:'bookmark', label:'Saved' },
  { to:'/profile',       icon:'user',     label:'Profile' },
  { to:'/settings',      icon:'settings', label:'Settings' },
]

function BrandMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3l2.2 2.2h3v3L19.4 10.5 17.2 12.7v3h-3L12 18l-2.2-2.3h-3v-3L4.6 10.5 6.8 8.2v-3h3z"/>
      <circle cx="12" cy="10.5" r="1.6" fill="currentColor" stroke="none"/>
    </svg>
  )
}

export function Layout() {
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const me = user || { full: 'You', handle: 'you', initials: 'Y', avc: 'linear-gradient(135deg,#159a76,#0a4a3c)' }
  const [composeType, setComposeType] = React.useState(null)
  const [editPost, setEditPost] = React.useState(null)
  const [search, setSearch] = React.useState('')
  const [unread, setUnread] = React.useState(0)

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
  // Self-heals: a hard close (readyState 2 = expired token) → refresh + reopen.
  React.useEffect(() => {
    api.notifications.unreadCount().then(setUnread).catch(() => {})
    let close = null, closed = false, healing = false
    const open = () => {
      close = api.notifications.stream({
        onUnreadCount: setUnread,
        onError: async (readyState) => {
          if (closed || readyState !== 2 || healing) return   // 2 = CLOSED; 0/CONNECTING auto-reconnects
          healing = true
          try { await api.auth.refresh() } catch { /* refresh failed → leave it; RequireAuth handles 401s */ }
          close?.(); open()
          setTimeout(() => { healing = false }, 8000)
        },
      })
    }
    open()
    return () => { closed = true; close?.() }
  }, [])

  const onSearch = (e) => {
    if (e.key === 'Enter' && search.trim()) navigate('/explore?q=' + encodeURIComponent(search.trim()))
  }
  const onPublished = (post) => {
    window.dispatchEvent(new CustomEvent('ika:post-created', { detail: post }))
    navigate('/')
  }
  // edit (PATCH §6.4): patch in place, stay on the current page
  const onEdited = (post) => window.dispatchEvent(new CustomEvent('ika:post-updated', { detail: post }))
  const closeCompose = () => { setComposeType(null); setEditPost(null) }
  const signOut = async () => { await logout(); navigate('/login') }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" onClick={() => navigate('/')} style={{ cursor:'pointer' }}>
          <div className="mark"><BrandMark/></div>
          <div>
            <div className="word">IKA<b>.</b></div>
            <small>Islamic Knowledge Archive</small>
          </div>
        </div>

        <div className="tb-search">
          <Icon name="search"/>
          <input value={search} onChange={e => setSearch(e.target.value)} onKeyDown={onSearch}
            placeholder="Search posts, research, scholars, sounds…"/>
        </div>

        <div className="tb-actions">
          <button className="icon-btn" style={{ position:'relative' }} onClick={() => navigate('/notifications')}>
            <Icon name="bell"/>{unread > 0 && <span className="dot"/>}
          </button>
          <button className="icon-btn tint" onClick={() => setComposeType('TEXT')}><Icon name="compose"/></button>
          <button className="me-chip" onClick={() => navigate('/profile')}>
            <Avatar initials={me.initials} color={me.avc} size={30} src={me.profileImage}/>
            <span className="nm">{me.full.split(' ')[0]}</span>
          </button>
        </div>
      </header>

      <aside className="sidebar">
        <nav className="nav">
          {NAV.map(n => (
            <NavLink key={n.to} to={n.to} end={n.end}
              className={({ isActive }) => 'nav-item ' + (isActive ? 'active' : '')}>
              <Icon name={n.icon}/><span>{n.label}</span>
              {n.to === '/notifications' && unread > 0 && <span className="badge">{unread}</span>}
            </NavLink>
          ))}
        </nav>

        <button className="cta-compose" onClick={() => setComposeType('TEXT')}>
          <Icon name="compose" className="sm"/><span>Create</span>
        </button>

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
      </aside>

      <main style={{ minWidth:0 }}>
        <Outlet/>
      </main>

      <nav className="botnav">
        <NavLink to="/" end className={({ isActive }) => isActive ? 'active' : ''}>
          <Icon name="home"/><small>Home</small>
        </NavLink>
        <NavLink to="/explore" className={({ isActive }) => isActive ? 'active' : ''}>
          <Icon name="search"/><small>Explore</small>
        </NavLink>
        <a className="mid" onClick={() => setComposeType('TEXT')} aria-label="Create">
          <span className="plus"><Icon name="compose"/></span>
        </a>
        <NavLink to="/qna" className={({ isActive }) => isActive ? 'active' : ''}>
          <Icon name="qna"/><small>Q&amp;A</small>
        </NavLink>
        <NavLink to="/profile" className={({ isActive }) => isActive ? 'active' : ''}>
          <Icon name="user"/><small>You</small>
        </NavLink>
      </nav>

      {composeType && (
        <ComposeModal
          type={composeType === 'EDIT' ? undefined : composeType}
          editPost={composeType === 'EDIT' ? editPost : null}
          onClose={closeCompose} onPublished={onPublished} onEdited={onEdited}/>
      )}
      <ToastHost/>
      <DialogHost/>
    </div>
  )
}
