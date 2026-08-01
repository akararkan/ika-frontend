/* =========================================================
   Settings v2 — device permissions & consent evidence (§14).
   The consent ledger is append-only: every switch writes a new
   event (scope + granted + app version) and the state endpoint
   simply reads back the latest one — it never 404s, so "no
   event yet" reads as not granted.
   Scopes are free strings uppercased server-side (max 60); the
   backend itself only ever writes CONTACTS, the rest are ours.
   Browser permissions are NOT granted here — where the
   Permissions API exists we only READ them and show a chip.
   ========================================================= */
import React from 'react'
import { Icon, showToast } from '../ui.jsx'
import { EmptyState, Loader, ErrorState } from '../states.jsx'
import { api } from '../../api/index.js'
import { SetCard, ToggleRow, fmtWhen } from './shared.jsx'

const APP_VERSION = import.meta.env.VITE_APP_VERSION || '1.0.0'
const PAGE_SIZE = 15

/* The scopes this client tracks: [scope, title, description]. */
const SCOPES = [
  ['CONTACTS', 'Contact matching', 'Uploading your address book to find people you know'],
  ['LOCATION', 'Location', 'Attaching a place to what you post'],
  ['PHOTOS', 'Photo library', 'Choosing photos and videos to upload'],
  ['ANALYTICS', 'Usage analytics', 'Anonymous product analytics'],
  ['MARKETING', 'Product emails', 'Occasional product and feature announcements'],
]
const SCOPE_LABELS = Object.fromEntries(SCOPES.map(([scope, title]) => [scope, title]))

/* Which Permissions API name (if any) describes the same thing as a scope. */
const PERM_OF_SCOPE = { LOCATION: 'geolocation' }
const PERM_CHIP = {
  granted: ['ok', 'Allowed'],
  denied: ['err', 'Blocked'],
  prompt: ['plain', 'Not asked'],
}

function PermChip({ state }) {
  const chip = PERM_CHIP[state]
  if (!chip) return null
  return <span className={'stx-chip ' + chip[0]} style={{ marginLeft: 8 }}>{chip[1]}</span>
}

/** Live browser permission states, best-effort. Unsupported engines and
 *  unsupported permission names (Safari rejects 'notifications') simply
 *  yield nothing — this never throws. */
function useBrowserPermissions() {
  const [perms, setPerms] = React.useState({})
  React.useEffect(() => {
    if (!navigator.permissions?.query) return undefined
    let alive = true
    for (const name of ['geolocation', 'notifications']) {
      try {
        Promise.resolve(navigator.permissions.query({ name }))
          .then(st => { if (alive && st?.state) setPerms(cur => ({ ...cur, [name]: st.state })) })
          .catch(() => {})
      } catch { /* older engines throw synchronously on unknown names */ }
    }
    return () => { alive = false }
  }, [])
  return perms
}

/* ---------- what you have agreed to ---------- */

function PermissionsCard({ onRecorded }) {
  const [states, setStates] = React.useState(null)      // {SCOPE: bool}
  const [busy, setBusy] = React.useState({})
  const perms = useBrowserPermissions()

  /* One read per scope, in parallel; a failed read is just "not granted". */
  React.useEffect(() => {
    let alive = true
    const fallback = Object.fromEntries(SCOPES.map(([scope]) => [scope, false]))
    Promise.all(SCOPES.map(([scope]) =>
      api.settings.consent.state(scope).catch(() => ({ granted: false }))
    ))
      .then(rows => {
        if (!alive) return
        const map = {}
        SCOPES.forEach(([scope], i) => { map[scope] = !!rows[i]?.granted })
        setStates(map)
      })
      .catch(() => { if (alive) setStates(fallback) })
    return () => { alive = false }
  }, [])

  const toggle = (scope) => {
    if (busy[scope] || !states) return
    const next = !states[scope]
    setStates(cur => ({ ...cur, [scope]: next }))
    setBusy(b => ({ ...b, [scope]: true }))
    api.settings.consent.record({ scope, granted: next, appVersion: APP_VERSION })
      .then(() => {
        showToast(next ? 'Consent recorded' : 'Consent withdrawn')
        onRecorded?.()
      })
      .catch(() => {
        setStates(cur => ({ ...cur, [scope]: !next }))
        showToast('Could not save — reverted')
      })
      .finally(() => setBusy(b => ({ ...b, [scope]: false })))
  }

  const sub = 'The app records what you have agreed to and when, so a permission can be proven and withdrawn. Camera, microphone and notification permissions themselves are granted by your browser or phone, not here.'

  return (
    <SetCard icon="shield" title="Permissions & consent" sub={sub}>
      {states === null ? (
        <Loader/>
      ) : (
        <>
          {SCOPES.map(([scope, title, desc]) => {
            const permName = PERM_OF_SCOPE[scope]
            const permState = permName ? perms[permName] : null
            /* Only decorate the title once the browser actually answered —
               a plain string keeps the switch's label clean everywhere else. */
            const heading = PERM_CHIP[permState] ? <>{title}<PermChip state={permState}/></> : title
            return (
              <ToggleRow key={scope} title={heading} desc={desc}
                on={!!states[scope]}
                disabled={!!busy[scope]}
                onToggle={() => toggle(scope)}/>
            )
          })}

          {PERM_CHIP[perms.notifications] && (
            <div className="stx-row">
              <div>
                <b>Browser notifications<PermChip state={perms.notifications}/></b>
                <small>Granted by your browser, not here. Change it in your browser’s site settings.</small>
              </div>
            </div>
          )}

          <div className="stx-note info">
            <Icon name="info"/>
            <span>
              Turning contact matching off records your withdrawal, but it does not delete the
              address-book hashes you have already uploaded. To erase those, use
              {' '}<b>Delete uploaded contacts</b> in the Discovery tab.
            </span>
          </div>
        </>
      )}
    </SetCard>
  )
}

/* ---------- the ledger ---------- */

function ConsentHistoryCard({ stamp }) {
  const [items, setItems] = React.useState(null)
  const [hasMore, setHasMore] = React.useState(false)
  const [error, setError] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [tick, setTick] = React.useState(0)
  const pageRef = React.useRef(0)

  /* Reloads on `stamp` too — a change made above belongs in the ledger
     immediately. Items are kept while refetching so the table does not flash. */
  React.useEffect(() => {
    let alive = true
    setError(false)
    api.settings.consent.history({ page: 0, size: PAGE_SIZE })
      .then(r => {
        if (!alive) return
        pageRef.current = 0
        setItems(r.items || [])
        setHasMore(!!r.hasMore)
      })
      .catch(() => { if (alive) { setError(true); setItems([]) } })
    return () => { alive = false }
  }, [tick, stamp])

  const retry = () => { setItems(null); setTick(t => t + 1) }

  const loadMore = () => {
    if (busy) return
    setBusy(true)
    const next = pageRef.current + 1
    api.settings.consent.history({ page: next, size: PAGE_SIZE })
      .then(r => {
        pageRef.current = next
        setItems(cur => [...(cur || []), ...(r.items || [])])
        setHasMore(!!r.hasMore)
      })
      .catch(() => showToast('Could not load more events'))
      .finally(() => setBusy(false))
  }

  return (
    <SetCard icon="clock" title="Consent history"
      sub="An append-only record of every change, including which app version made it.">
      {items === null ? (
        <Loader/>
      ) : error ? (
        <ErrorState message="Could not load your consent history" onRetry={retry}/>
      ) : items.length === 0 ? (
        <EmptyState icon="doc" title="No consent events yet"
          sub="Each time you grant or withdraw a permission, the change is recorded here."/>
      ) : (
        <>
          <div className="stx-scroll">
            <table className="stx-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Scope</th>
                  <th>Change</th>
                  <th>App version</th>
                </tr>
              </thead>
              <tbody>
                {items.map(ev => (
                  <tr key={ev.id}>
                    <td>{fmtWhen(ev.occurredAt)}</td>
                    <td>{SCOPE_LABELS[ev.scope] || ev.scope || '—'}</td>
                    <td>
                      <span className={'stx-chip ' + (ev.granted ? 'ok' : 'plain')}>
                        {ev.granted ? 'Granted' : 'Withdrawn'}
                      </span>
                    </td>
                    <td className="muted">{ev.appVersion || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hasMore && (
            <div className="set-actions" style={{ marginTop: 12 }}>
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={loadMore}>
                {busy ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </SetCard>
  )
}

export function ConsentPanel() {
  const [stamp, setStamp] = React.useState(0)
  return (
    <div className="set-stack">
      <PermissionsCard onRecorded={() => setStamp(s => s + 1)}/>
      <ConsentHistoryCard stamp={stamp}/>
    </div>
  )
}
