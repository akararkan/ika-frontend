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

/** Toast host — driven by showToast() in ui.jsx. Mount once in the layout.
 *  All three glyphs are rendered and CSS reveals the one matching the tone
 *  class, so a failure never ships with a checkmark. The node is only
 *  opacity-0 (never display:none), so it stays in the accessibility tree and
 *  the text swap is what fires the live-region announcement. */
export function ToastHost() {
  return (
    <div id="toast" className="toast" role="status" aria-live="polite" aria-atomic="true">
      <span className="tic ok" aria-hidden="true"><Icon name="check" className="sm"/></span>
      <span className="tic warn" aria-hidden="true"><Icon name="alert" className="sm"/></span>
      <span className="tic err" aria-hidden="true"><Icon name="close" className="sm"/></span>
      <span className="tmsg"/>
    </div>
  )
}
