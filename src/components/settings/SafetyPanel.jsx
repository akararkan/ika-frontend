/* =========================================================
   Settings v2 — Safety Center: your reports & account standing.
   SafetyReportsPanel: paged list of reports you filed, showing
   only the coarse outcome (the action taken on someone else's
   account is never disclosed) with a one-shot appeal from
   ACTIONED/DISMISSED. StrikesPanel: active strikes (each
   expires 90 days after issue) or a good-standing note.
   ========================================================= */
import React from 'react'
import { Icon, showToast } from '../ui.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { EmptyState, ErrorState } from '../states.jsx'
import { api, REPORT_REASONS, REPORT_OUTCOME_LABELS } from '../../api/index.js'
import { SetCard, fmtWhen, fmtDate } from './shared.jsx'

const PAGE_SIZE = 15
const REASON_LABELS = Object.fromEntries(REPORT_REASONS)
const OUTCOME_CHIP = { UNDER_REVIEW: 'info', ACTION_TAKEN: 'ok', NO_ACTION: 'plain', APPEAL_UNDER_REVIEW: 'warn' }
const APPEALABLE_STATES = new Set(['ACTIONED', 'DISMISSED'])

/* 'HATE_SPEECH' → 'Hate speech' for values outside the label maps. */
const humanise = (s) => !s ? '—' : String(s).toLowerCase().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())

export function SafetyReportsPanel() {
  const [items, setItems] = React.useState(null)
  const [hasMore, setHasMore] = React.useState(false)
  const [error, setError] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [appealingId, setAppealingId] = React.useState(null)
  const pageRef = React.useRef(0)

  const loadFirst = React.useCallback(() => {
    setError(false); setItems(null)
    let alive = true
    api.settings.safety.myReports({ page: 0, size: PAGE_SIZE })
      .then(r => { if (alive) { pageRef.current = 0; setItems(r.items); setHasMore(r.hasMore) } })
      .catch(() => { if (alive) { setError(true); setItems([]) } })
    return () => { alive = false }
  }, [])
  React.useEffect(loadFirst, [loadFirst])

  const loadMore = () => {
    if (busy) return
    setBusy(true)
    const next = pageRef.current + 1
    api.settings.safety.myReports({ page: next, size: PAGE_SIZE })
      .then(r => { pageRef.current = next; setItems(cur => [...cur, ...r.items]); setHasMore(r.hasMore) })
      .catch(() => showToast('Could not load more reports'))
      .finally(() => setBusy(false))
  }

  const appeal = async (row) => {
    const ok = await uiConfirm({
      title: 'Appeal this decision?',
      message: 'A reviewer will take a fresh look at this report. Each decision can be appealed once.',
      confirmLabel: 'Submit appeal',
      icon: 'flag',
    })
    if (!ok) return
    setAppealingId(row.id)
    try {
      const updated = await api.settings.safety.appeal(row.id)
      setItems(cur => cur.map(r => r.id === row.id ? { ...r, ...updated } : r))
      showToast('Appeal submitted')
    } catch (e) {
      if (e?.code === 'REPORT_NOT_APPEALABLE' || e?.status === 409) {
        showToast('This report can no longer be appealed')
        loadFirst()
      } else {
        showToast('Could not submit the appeal')
      }
    } finally {
      setAppealingId(null)
    }
  }

  const sub = 'Reports you have filed and their outcome. To protect everyone’s privacy, the specific action taken on someone else’s account is never disclosed.'

  if (items === null) {
    return (
      <SetCard icon="flag" title="Your reports" sub={sub}>
        <p className="muted text-sm">Loading…</p>
      </SetCard>
    )
  }
  return (
    <SetCard icon="flag" title="Your reports" sub={sub}>
      {error ? (
        <ErrorState message="Could not load your reports" onRetry={loadFirst}/>
      ) : items.length === 0 ? (
        <EmptyState icon="flag" title="No reports filed" sub="Reports you file about content or people appear here."/>
      ) : (
        <>
          {items.map(row => {
            const outcomeLabel = row.coarseOutcome ? (REPORT_OUTCOME_LABELS[row.coarseOutcome] || humanise(row.coarseOutcome)) : null
            return (
              <div key={row.id} className="stx-sess">
                <div className="stx-sess-ic"><Icon name="flag"/></div>
                <div className="stx-sess-info">
                  <b>{(REASON_LABELS[row.reason] || humanise(row.reason)) + ' · ' + (row.targetType || '').toLowerCase()}</b>
                  <small>{fmtWhen(row.createdAt)}</small>
                </div>
                <div className="flex gap-8" style={{ alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {outcomeLabel && (
                    <span className={'stx-chip ' + (OUTCOME_CHIP[row.coarseOutcome] || 'plain')}>{outcomeLabel}</span>
                  )}
                  {APPEALABLE_STATES.has(row.state) && (
                    <button type="button" className="btn btn-secondary btn-sm"
                      disabled={appealingId === row.id}
                      onClick={() => appeal(row)}>
                      {appealingId === row.id ? 'Appealing…' : 'Appeal'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
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

export function StrikesPanel() {
  const [rows, setRows] = React.useState(null)
  const [error, setError] = React.useState(false)

  const load = React.useCallback(() => {
    setError(false); setRows(null)
    let alive = true
    api.settings.safety.strikes()
      .then(list => { if (alive) setRows(list || []) })
      .catch(() => { if (alive) { setError(true); setRows([]) } })
    return () => { alive = false }
  }, [])
  React.useEffect(load, [load])

  const sub = 'Strikes are issued for confirmed violations of the community guidelines. Each strike expires 90 days after it is issued; repeated strikes can limit what your account can do.'

  if (rows === null) {
    return (
      <SetCard icon="alert" title="Account standing" sub={sub}>
        <p className="muted text-sm">Loading…</p>
      </SetCard>
    )
  }
  return (
    <SetCard icon="alert" title="Account standing" sub={sub}>
      {error ? (
        <ErrorState message="Could not load your account standing" onRetry={load}/>
      ) : rows.length === 0 ? (
        <div className="stx-note ok">
          <Icon name="check"/>
          <span>No active strikes — your account is in good standing.</span>
        </div>
      ) : (
        <>
          <div className="stx-note warn">
            <Icon name="alert"/>
            <span>
              {rows.length === 1
                ? 'You have 1 active strike on your account.'
                : `You have ${rows.length} active strikes on your account.`}
              {' '}Each one expires 90 days after it was issued.
            </span>
          </div>
          {rows.map(row => (
            <div key={row.id} className="stx-sess">
              <div className="stx-sess-ic"><Icon name="alert"/></div>
              <div className="stx-sess-info">
                <b>{REASON_LABELS[row.reason] || humanise(row.reason)}</b>
                <small>{'issued ' + fmtDate(row.issuedAt) + ' · expires ' + fmtDate(row.expiresAt)}</small>
              </div>
            </div>
          ))}
        </>
      )}
    </SetCard>
  )
}
