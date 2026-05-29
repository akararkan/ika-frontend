/* =========================================================
   Tiny shared state components — loader, empty, error.
   Reuse existing tokens; no new visual language.
   ========================================================= */
import { Icon } from './ui.jsx'

export function Loader({ label = 'Loading…' }) {
  return (
    <div className="card card-pad" style={{ textAlign: 'center', color: 'var(--muted)' }}>
      {label}
    </div>
  )
}

export function EmptyState({ icon = 'feed', title = 'Nothing here yet', sub }) {
  return (
    <div className="card card-pad" style={{ textAlign: 'center', padding: '40px 20px' }}>
      <div style={{ display: 'grid', placeItems: 'center', margin: '0 auto 12px', width: 56, height: 56, borderRadius: '50%', background: 'var(--card-2)', color: 'var(--emerald)' }}>
        <Icon name={icon} className="lg"/>
      </div>
      <div className="font-serif" style={{ fontSize: 18, fontWeight: 600, color: 'var(--ink)' }}>{title}</div>
      {sub && <p className="muted text-sm" style={{ marginTop: 6 }}>{sub}</p>}
    </div>
  )
}

export function ErrorState({ message = 'Something went wrong', onRetry }) {
  return (
    <div className="card card-pad" style={{ textAlign: 'center', padding: '32px 20px' }}>
      <p className="text-sm" style={{ color: 'var(--rose)', fontWeight: 600 }}>{message}</p>
      {onRetry && <button className="btn btn-secondary btn-sm mt-12" onClick={onRetry}><Icon name="settings" className="xs"/>Try again</button>}
    </div>
  )
}

/** Toast host — driven by showToast() in ui.jsx. Mount once in the layout. */
export function ToastHost() {
  return (
    <div id="toast" className="toast">
      <Icon name="check" className="sm"/>
      <span className="tmsg"/>
    </div>
  )
}
