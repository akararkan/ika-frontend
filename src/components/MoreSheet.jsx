/* =========================================================
   MoreSheet — mobile-only slide-up nav drawer.
   Triggered from the botnav "More" slot (≤720px). Surfaces every
   NAV destination that doesn't fit the 5-cell bottom bar (Reels,
   Q&A, Research, Notifications, Activity, Saved, Settings) plus an
   Account section with sign-out — the routes + logout that are
   otherwise unreachable once the sidebar is hidden on phones.
   Driven by the NAV array (passed as `nav`) so it stays DRY.
   ========================================================= */
import { NavLink } from 'react-router-dom'
import { Icon } from './ui.jsx'

export function MoreSheet({ nav, pathname, unread, onClose, onSignOut }) {
  const isActive = (to) => to === '/' ? pathname === '/' : (pathname === to || pathname.startsWith(to + '/'))
  return (
    <div className="m-more-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="More navigation">
      <div className="m-more-sheet" onClick={e => e.stopPropagation()}>
        <div className="m-more-grab"/>
        <h5>More</h5>
        {nav.map(n => (
          <NavLink key={n.to} to={n.to} onClick={onClose}
            className={'m-more-row' + (isActive(n.to) ? ' active' : '')}>
            <Icon name={n.icon} className="ico"/>
            <span>{n.label}</span>
            {n.to === '/notifications' && unread > 0 && <span className="badge">{unread}</span>}
          </NavLink>
        ))}
        <h5>Account</h5>
        <button type="button" className="m-more-row danger" onClick={onSignOut}>
          <Icon name="logout" className="ico"/>
          <span>Sign out</span>
        </button>
      </div>
    </div>
  )
}
