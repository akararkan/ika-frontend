/* =========================================================
   Settings v2 — device permissions & consent evidence (§14).
   The consent ledger is append-only: every switch writes a new
   event (scope + granted + app version) and the state endpoint
   simply reads back the latest one — it never 404s, so "no
   event yet" reads as not granted.
   There is NO ConsentScope enum server-side: scope is a free
   string (@NotBlank, uppercased, max 60 — ConsentDtos
   .RecordConsentRequest / ConsentEvent.scope), so the client
   owns the vocabulary. Only CONTACTS is written by the backend
   itself — POST /api/v1/contacts/sync records it true and
   DELETE records it false (ContactsController:41,50) — which is
   why a switch here can flip without anyone touching it.
   Rule for this list: a scope earns a row only if some part of
   the app actually acts on that data. Scopes we once shipped
   but never exercised are kept as WITHDRAW-ONLY rows so an old
   grant can still be revoked (see RETIRED_SCOPES).
   Browser permissions are NOT granted here — where the
   Permissions API exists we only READ them and show a chip.
   ========================================================= */
import React from 'react'
import { Link } from 'react-router-dom'
import { Icon, showToast } from '../ui.jsx'
import { EmptyState, Loader, ErrorState } from '../states.jsx'
import { api } from '../../api/index.js'
import { SetCard, ToggleRow, ControlRow, SeeAlso, useWriteStatus, fmtWhen, humanEnum } from './shared.jsx'

const APP_VERSION = import.meta.env.VITE_APP_VERSION || '1.0.0'
const PAGE_SIZE = 15

/* The scopes this client tracks: [scope, title, description]. */
const SCOPES = [
  ['CONTACTS', 'Contact matching', 'Uploading your address book to find people you know. Recording it here does not upload anything by itself.'],
  /* The ONLY thing that reads a coordinate in this client is the chat
     location message (chat/PostComposer.jsx) — posts, stories and research
     carry no place field — so the description says that and nothing more. */
  ['LOCATION', 'Location', 'Sharing where you are in a chat message. Your browser still asks for the location itself each time.'],
]

/* Scopes an earlier build offered that no feature ever read. They are gone
   from the switch list — a toggle that changes nothing is a false promise —
   but an old grant is still on someone's record, so it gets a withdraw row. */
const RETIRED_SCOPES = [
  ['PHOTOS', 'Photo library'],
  ['ANALYTICS', 'Usage analytics'],
  ['MARKETING', 'Product emails'],
]

/* Labels for the ledger, which shows retired scopes forever. */
const SCOPE_LABELS = Object.fromEntries(
  [...SCOPES, ...RETIRED_SCOPES].map(([scope, title]) => [scope, title]),
)

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
  /* Retired scopes are pinned at load: once a row is shown it stays for the
     session, so withdrawing one does not make it vanish mid-interaction. */
  const [legacy, setLegacy] = React.useState([])
  const { statusOf, track } = useWriteStatus()
  const perms = useBrowserPermissions()

  /* One read per scope, in parallel; a failed read is just "not granted". */
  React.useEffect(() => {
    let alive = true
    const all = [...SCOPES, ...RETIRED_SCOPES]
    const fallback = Object.fromEntries(all.map(([scope]) => [scope, false]))
    Promise.all(all.map(([scope]) =>
      api.settings.consent.state(scope).catch(() => ({ granted: false }))
    ))
      .then(rows => {
        if (!alive) return
        const map = {}
        all.forEach(([scope], i) => { map[scope] = !!rows[i]?.granted })
        setStates(map)
        setLegacy(RETIRED_SCOPES.filter(([scope]) => map[scope]))
      })
      .catch(() => { if (alive) setStates(fallback) })
    return () => { alive = false }
  }, [])

  /* Optimistic + reverting; the row carries its own saving/saved/failed mark,
     so no toast for a routine switch. */
  const write = (scope, next) => {
    if (statusOf(scope) === 'saving' || !states) return
    setStates(cur => ({ ...cur, [scope]: next }))
    track(scope, api.settings.consent.record({ scope, granted: next, appVersion: APP_VERSION })
      .then(() => { onRecorded?.() })
      .catch(e => { setStates(cur => ({ ...cur, [scope]: !next })); throw e }))
      .catch(() => {})
  }

  const sub = 'The app records what you have agreed to and when, so a permission can be proven and withdrawn. Camera, microphone and notification permissions themselves are granted by your browser or phone, not here.'

  return (
    <SetCard id="consent" icon="shield" title="Permissions & consent" sub={sub}>
      {states === null ? (
        <Loader/>
      ) : (
        <>
          {SCOPES.map(([scope, title, desc]) => {
            const permName = PERM_OF_SCOPE[scope]
            const permState = permName ? perms[permName] : null
            /* The chip belongs to the DESCRIPTION, not to `title` and not to
               ToggleRow's children: `title` is fed straight to the switch's
               aria-label (a node there announces as [object Object]), and a
               child lands beside the switch, where "Allowed" reads as the
               switch's own state — which it is not. One is what the browser
               permits, the other is what you have agreed to. */
            const body = PERM_CHIP[permState]
              ? <>{desc}{' '}Browser:<PermChip state={permState}/></>
              : desc
            return (
              <ToggleRow key={scope} title={title} desc={body}
                on={!!states[scope]}
                status={statusOf(scope)}
                onToggle={() => write(scope, !states[scope])}/>
            )
          })}

          {legacy.map(([scope, title]) => (
            <ControlRow key={scope} title={title}
              desc="Recorded by an earlier version of the app. Nothing reads this permission any more — you can withdraw it."
              status={statusOf(scope)}>
              <button type="button" className="btn btn-secondary btn-sm"
                disabled={!states[scope] || statusOf(scope) === 'saving'}
                onClick={() => write(scope, false)}>
                {states[scope] ? 'Withdraw' : 'Withdrawn'}
              </button>
            </ControlRow>
          ))}
          {/* Withdrawing the retired MARKETING grant changes no mail — the five
              email switches do — so say where the real control is. */}
          {legacy.some(([scope]) => scope === 'MARKETING') && (
            <SeeAlso to="/settings/emails">Email preferences — which emails you actually get</SeeAlso>
          )}

          {PERM_CHIP[perms.notifications] && (
            <ControlRow
              title={<>Browser notifications<PermChip state={perms.notifications}/></>}
              desc="Granted by your browser, not here. Change it in your browser’s site settings."/>
          )}

          <div className="stx-note info">
            <Icon name="info"/>
            <span>
              Contact matching also records itself: uploading your address book grants it and
              deleting the upload withdraws it. Turning it off here records your withdrawal, but it
              does not delete hashes you have already uploaded — for that use
              {' '}<Link to="/settings/discovery#contact-matching">Delete uploaded contacts</Link>
              {' '}in the Discovery tab.
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
      .catch(() => showToast('Could not load more events', 'err'))
      .finally(() => setBusy(false))
  }

  return (
    <SetCard id="consent-history" icon="clock" title="Consent history"
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
                    {/* Scopes are free strings: anything this build no longer
                        knows about still has to read as words, not an enum. */}
                    <td>{SCOPE_LABELS[ev.scope] || humanEnum(ev.scope) || '—'}</td>
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
