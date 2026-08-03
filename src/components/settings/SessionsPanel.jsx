/* =========================================================
   Settings v2 — sessions & sign-in activity.
   SessionsPanel: active refresh-token sessions, per-session
   trust + sign-out, and the bulk "sign out everywhere".
   LoginHistoryPanel: paged login-history table.

   WHAT THE SERVER ACTUALLY SENDS (SecurityDtos.SessionResponse
   is sid/deviceName/platform/ip/lastSeenAt/createdAt/trusted):
   the login path persists a refresh token with only user/token/
   expiresAt, so every field except `createdAt` and `trusted`
   comes back null today — INCLUDING `sid`, the id both
   per-session endpoints are addressed by. Everything below is
   written to survive that: rows are identified by INDEX, and
   the two sid-addressed actions hide themselves rather than
   sending the literal "undefined" and 400-ing.
   ========================================================= */
import React from 'react'
import { Icon, showToast } from '../ui.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { EmptyState, ErrorState } from '../states.jsx'
import { api, session } from '../../api/index.js'
import { useAuth } from '../../context/AuthContext.jsx'
import { SetCard, Skeleton, fmtWhen } from './shared.jsx'

/* sid of the session this browser is running on — read from the access
   token's payload. Null when the token is absent or unreadable, and null in
   practice on every token: JwtTokenProvider.buildClaims() mints email,
   username, fullName, role, tokenType and authorities, but no `sid`. Kept
   because the marker below costs nothing and lights up the day it does. */
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

/* The server clamps the window to 1..90 days (SessionService.trustDevice), so
   the choice is the user's — a hardcoded 30 was the client inventing a policy.
   Local state per row: the pick only matters until Trust is pressed. */
function TrustPicker({ onTrust }) {
  const [days, setDays] = React.useState(30)
  return (
    <>
      <select className="field" style={{ width: 'auto', minWidth: 104 }} aria-label="How long to trust this device"
        value={days} onChange={e => setDays(+e.target.value)}>
        <option value={7}>7 days</option>
        <option value={30}>30 days</option>
        <option value={90}>90 days</option>
      </select>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onTrust(days)}>Trust</button>
    </>
  )
}

export function SessionsPanel() {
  const { logoutEverywhere } = useAuth()
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

  /* Optimistic updates match on the row's INDEX, never on r.sid: with every sid
     null, `r.sid === row.sid` matches every row — one Trust would flip the whole
     list and one Sign out would empty it. */
  const trust = (row, i, days) => {
    setRows(rs => rs.map((r, j) => j === i ? { ...r, trusted: true } : r))
    api.security.sessions.trust(row.sid, days)
      .then(() => showToast(`Device trusted for ${days} days`))
      .catch(() => {
        setRows(rs => rs.map((r, j) => j === i ? { ...r, trusted: row.trusted } : r))
        showToast('Could not trust this device', 'err')
      })
  }

  const revoke = async (row, i) => {
    const ok = await uiConfirm({
      title: 'Sign out this session?',
      /* No sid claim in the access token means we genuinely cannot tell which
         row is this browser — say so rather than let it come as a surprise. */
      message: 'This session will be signed out immediately. We can’t tell which session is this browser, so this may sign you out here.',
      confirmLabel: 'Sign out',
      icon: 'logout',
    })
    if (!ok) return
    setRows(rs => rs.filter((_, j) => j !== i))
    api.security.sessions.revoke(row.sid)
      .then(() => showToast('Session signed out'))
      .catch(e => {
        /* SessionService throws ResourceNotFoundException for an unknown AND
           for a not-yours sid — either way the row is gone for good. */
        if (e?.status === 404) { showToast('Session was already signed out', 'warn'); return }
        setRows(rs => [...rs.slice(0, i), row, ...rs.slice(i)])
        showToast('Could not sign out that session', 'err')
      })
  }

  const signOutEverywhere = async () => {
    const ok = await uiConfirm({
      title: 'Sign out everywhere?',
      message: 'Every active session ends immediately — on every browser, phone and tablet, including this one. You will need to sign in again.',
      confirmLabel: 'Sign out everywhere', danger: true, icon: 'logout',
    })
    if (ok) logoutEverywhere()     // clears the local session; RequireAuth handles the redirect
  }

  /* No auth path reads trusted_until yet (RefreshToken.isTrustedNow() is only
     read back out into this list), so trusting cannot be sold as skipping a
     prompt — it is a label you put on a device you recognise. */
  const sub = 'Everywhere you are signed in. Mark a device as trusted to remember that you recognise it; signing a session out ends it immediately.'

  return (
    <SetCard id="sessions" icon="shield" title="Active sessions" sub={sub}>
      {rows === null ? (
        <Skeleton rows={3}/>
      ) : error ? (
        <ErrorState message="Could not load your sessions" onRetry={load}/>
      ) : (
        <>
          {rows.length === 0 && (
            <EmptyState icon="shield" title="No active sessions" sub="Sessions appear here when you sign in on a device."/>
          )}
          {rows.map((row, i) => {
            const current = mySid != null && row.sid === mySid
            /* createdAt is the one field the server really fills in; without it
               every row reads "Unknown device" with an empty subtitle and the
               screen looks broken. Jackson omits nulls, hence the guards. */
            const small = [
              row.platform,
              row.ip,
              row.lastSeenAt && 'active ' + fmtWhen(row.lastSeenAt),
              row.createdAt && 'signed in ' + fmtWhen(row.createdAt),
            ].filter(Boolean).join(' · ')
            return (
              <div key={row.sid || 'sess-' + i} className={'stx-sess' + (current ? ' current' : '')}>
                <div className="stx-sess-ic"><Icon name={platformIcon(row.platform)}/></div>
                <div className="stx-sess-info">
                  <b>{row.deviceName || row.platform || (row.createdAt ? 'Session from ' + fmtWhen(row.createdAt) : 'Unknown device')}</b>
                  {small && <small title={small}>{small}</small>}
                </div>
                <div className="flex gap-8" style={{ alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {row.trusted && <span className="stx-chip ok"><Icon name="check"/>Trusted</span>}
                  {current ? (
                    <span className="stx-chip info"><Icon name="dot"/>This device</span>
                  ) : row.sid ? (
                    <>
                      {!row.trusted && <TrustPicker onTrust={(days) => trust(row, i, days)}/>}
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => revoke(row, i)}>Sign out</button>
                    </>
                  ) : null /* both endpoints are /security/sessions/{sid}/… — see the note below the list */}
                </div>
              </div>
            )
          })}
          {/* Explained ONCE under the list, not repeated on every row: with sid
              null everywhere, a per-row line would print the same sentence N
              times. It sits directly above the action that still works. */}
          {rows.some(r => !r.sid) && (
            <div className="stx-note info">
              <Icon name="info"/>
              <span>Some of these sessions can’t be identified one at a time yet, so they have no individual controls. Signing out everywhere still ends them.</span>
            </div>
          )}
          {/* The bulk revoke lives on the Security tab too, but this is the screen
              someone lands on after a suspicious sign-in — and while per-session
              sign-out is unavailable it is the only action that works here. */}
          <div className="set-actions" style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-danger btn-sm" onClick={signOutEverywhere}>
              <Icon name="logout" className="xs"/>Sign out everywhere
            </button>
          </div>
        </>
      )}
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
      .catch(() => showToast('Could not load more history', 'err'))
      .finally(() => setBusy(false))
  }

  /* The read path is real and paged, but nothing writes rows yet —
     LoginEventService.record()/recordSuccessAndAlertIfNew() have no callers, so
     the login itself records nothing and no new-location alert is sent. Neither
     the sub nor the empty state may imply otherwise. */
  const sub = 'Recent sign-ins to your account.'

  return (
    <SetCard id="login-history" icon="clock" title="Login history" sub={sub}>
      {items === null ? (
        <Skeleton rows={4}/>
      ) : error ? (
        <ErrorState message="Could not load your login history" onRetry={loadFirst}/>
      ) : items.length === 0 ? (
        <EmptyState icon="clock" title="No sign-ins recorded yet" sub="Sign-in activity will appear here as it is recorded."/>
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
