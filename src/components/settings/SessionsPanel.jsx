/* =========================================================
   Settings v2 — sessions & sign-in activity.
   SessionsPanel: active refresh-token sessions with the
   current device marked (sid decoded from the JWT), trust
   (skips 2FA for a window) and per-session sign-out.
   LoginHistoryPanel: paged login-history table.
   ========================================================= */
import React from 'react'
import { Icon, showToast } from '../ui.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { EmptyState, ErrorState } from '../states.jsx'
import { api, session } from '../../api/index.js'
import { SetCard, fmtWhen } from './shared.jsx'

/* sid of the session this browser is running on — read from the access
   token's payload. Null when the token is absent or unreadable. */
function currentSid() {
  try {
    return JSON.parse(atob(session.getToken().split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sid || null
  } catch { return null }
}

function platformIcon(platform) {
  const p = (platform || '').toLowerCase()
  if (p.includes('ios') || p.includes('android')) return 'phone'
  if (p.includes('web') || p.includes('browser')) return 'globe'
  return 'screen'
}

export function SessionsPanel() {
  const [rows, setRows] = React.useState(null)
  const [error, setError] = React.useState(false)
  const mySid = React.useMemo(() => currentSid(), [])

  const load = React.useCallback(() => {
    setError(false); setRows(null)
    let alive = true
    api.security.sessions.list()
      .then(list => { if (alive) setRows(list || []) })
      .catch(() => { if (alive) { setError(true); setRows([]) } })
    return () => { alive = false }
  }, [])
  React.useEffect(load, [load])

  const trust = (row) => {
    setRows(rs => rs.map(r => r.sid === row.sid ? { ...r, trusted: true } : r))
    api.security.sessions.trust(row.sid, 30)
      .then(() => showToast('Device trusted for 30 days'))
      .catch(() => {
        setRows(rs => rs.map(r => r.sid === row.sid ? { ...r, trusted: row.trusted } : r))
        showToast('Could not trust this device')
      })
  }

  const revoke = async (row) => {
    const ok = await uiConfirm({
      title: 'Sign out this session?',
      message: `${row.deviceName || row.platform || 'This device'} will be signed out immediately and will need to sign in again.`,
      confirmLabel: 'Sign out',
      icon: 'logout',
    })
    if (!ok) return
    setRows(rs => rs.filter(r => r.sid !== row.sid))
    api.security.sessions.revoke(row.sid)
      .then(() => showToast('Session signed out'))
      .catch(e => {
        if (e?.status === 404) { showToast('Session was already signed out'); return }
        setRows(rs => rs.some(r => r.sid === row.sid) ? rs : [...rs, row])
        showToast('Could not sign out that session')
      })
  }

  const sub = 'Everywhere you are signed in. Trusting a device skips two-factor prompts on it for 30 days; signing a session out ends it immediately.'

  if (rows === null) {
    return (
      <SetCard icon="shield" title="Active sessions" sub={sub}>
        <p className="muted text-sm">Loading…</p>
      </SetCard>
    )
  }
  return (
    <SetCard icon="shield" title="Active sessions" sub={sub}>
      {error ? (
        <ErrorState message="Could not load your sessions" onRetry={load}/>
      ) : rows.length === 0 ? (
        <EmptyState icon="shield" title="No active sessions" sub="Sessions appear here when you sign in on a device."/>
      ) : rows.map(row => {
        const current = mySid != null && row.sid === mySid
        const small = [row.platform, row.ip, row.lastSeenAt && 'active ' + fmtWhen(row.lastSeenAt)].filter(Boolean).join(' · ')
        return (
          <div key={row.sid} className={'stx-sess' + (current ? ' current' : '')}>
            <div className="stx-sess-ic"><Icon name={platformIcon(row.platform)}/></div>
            <div className="stx-sess-info">
              <b>{row.deviceName || row.platform || 'Unknown device'}</b>
              {small && <small title={small}>{small}</small>}
            </div>
            <div className="flex gap-8" style={{ alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {row.trusted && <span className="stx-chip ok"><Icon name="check"/>Trusted</span>}
              {current ? (
                <span className="stx-chip info"><Icon name="dot"/>This device</span>
              ) : (
                <>
                  {!row.trusted && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => trust(row)}>Trust 30 days</button>
                  )}
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => revoke(row)}>Sign out</button>
                </>
              )}
            </div>
          </div>
        )
      })}
    </SetCard>
  )
}

const PAGE_SIZE = 15
const METHOD_LABELS = { PASSWORD: 'Password', OTP: 'OTP', REFRESH: 'Refresh', TWO_FA: '2FA' }
const OUTCOME_CHIP = { SUCCESS: 'ok', FAILED: 'err', LOCKED: 'warn' }
const OUTCOME_LABELS = { SUCCESS: 'Success', FAILED: 'Failed', LOCKED: 'Locked' }

export function LoginHistoryPanel() {
  const [items, setItems] = React.useState(null)
  const [hasMore, setHasMore] = React.useState(false)
  const [error, setError] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const pageRef = React.useRef(0)

  const loadFirst = React.useCallback(() => {
    setError(false); setItems(null)
    let alive = true
    api.security.loginHistory({ page: 0, size: PAGE_SIZE })
      .then(r => { if (alive) { pageRef.current = 0; setItems(r.items); setHasMore(r.hasMore) } })
      .catch(() => { if (alive) { setError(true); setItems([]) } })
    return () => { alive = false }
  }, [])
  React.useEffect(loadFirst, [loadFirst])

  const loadMore = () => {
    if (busy) return
    setBusy(true)
    const next = pageRef.current + 1
    api.security.loginHistory({ page: next, size: PAGE_SIZE })
      .then(r => { pageRef.current = next; setItems(cur => [...cur, ...r.items]); setHasMore(r.hasMore) })
      .catch(() => showToast('Could not load more history'))
      .finally(() => setBusy(false))
  }

  const sub = 'Recent sign-ins to your account. A sign-in from a new location triggers a security alert.'

  if (items === null) {
    return (
      <SetCard icon="clock" title="Login history" sub={sub}>
        <p className="muted text-sm">Loading…</p>
      </SetCard>
    )
  }
  return (
    <SetCard icon="clock" title="Login history" sub={sub}>
      {error ? (
        <ErrorState message="Could not load your login history" onRetry={loadFirst}/>
      ) : items.length === 0 ? (
        <EmptyState icon="clock" title="No sign-ins recorded yet"/>
      ) : (
        <>
          <div className="stx-scroll">
            <table className="stx-table">
              <thead>
                <tr><th>When</th><th>Method</th><th>Outcome</th><th>IP</th><th>Device</th></tr>
              </thead>
              <tbody>
                {items.map((row, i) => {
                  const ua = row.userAgent || ''
                  const shortUa = ua.length > 40 ? ua.slice(0, 40) + '…' : ua
                  return (
                    <tr key={i}>
                      <td>{fmtWhen(row.ts)}</td>
                      <td>{METHOD_LABELS[row.method] || row.method || '—'}</td>
                      <td>
                        <span className={'stx-chip ' + (OUTCOME_CHIP[row.outcome] || 'plain')}>
                          {OUTCOME_LABELS[row.outcome] || row.outcome || '—'}
                        </span>
                      </td>
                      <td>{row.ip || '—'}</td>
                      <td title={ua || undefined}>{shortUa || '—'}</td>
                    </tr>
                  )
                })}
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
