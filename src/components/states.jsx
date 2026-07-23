/* =========================================================
   Tiny shared state components — loader, empty, error.
   Warm Archive: quiet warm-paper empty states, navy medallion
   icon, gentle loader bar. Visuals live in
   styles/warm/core.css (.t-loader / .t-empty / .t-error).
   ========================================================= */
import { Icon } from './ui.jsx'

export function Loader({ label = 'Loading…' }) {
  return (
    <div className="card card-pad t-loader">
      {label}
      <span className="t-loader-bar" aria-hidden="true"/>
    </div>
  )
}

export function EmptyState({ icon = 'feed', title = 'Nothing here yet', sub }) {
  return (
    <div className="card t-empty">
      <div className="t-empty-ic">
        <Icon name={icon} className="lg"/>
      </div>
      <div className="t-empty-title">{title}</div>
      {sub && <p className="t-empty-sub">{sub}</p>}
    </div>
  )
}

export function ErrorState({ message = 'Something went wrong', onRetry }) {
  return (
    <div className="card t-error">
      <p>{message}</p>
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
