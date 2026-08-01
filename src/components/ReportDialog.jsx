/* =========================================================
   ReportDialog — the platform-wide "report this" flow.
   Promise-based like Dialog.jsx: any handler can do
     const sent = await openReport({ targetType, targetId, targetLabel })
   The <ReportHost/> at app root (next to <DialogHost/>) listens
   for open requests and stacks them; Esc or the overlay cancels.
   Wire: POST /api/v1/safety/reports — no envelope, 20/hour, and
   an already-open report for the same (target, reason) comes
   back as the EXISTING row with a plain 200, so the only tell is
   an old createdAt.
   ========================================================= */
/* eslint-disable react-refresh/only-export-components */
import React from 'react'
import { Icon, showToast } from './ui.jsx'
import { api, REPORT_REASONS, REPORT_TARGET_TYPES } from '../api/index.js'
import { parseServerDate } from './settings/shared.jsx'

/* Friendly stand-ins when the caller passes no targetLabel. */
const TARGET_LABELS = {
  USER: 'this account', POST: 'this post', COMMENT: 'this comment',
  RESEARCH: 'this paper', QUESTION: 'this question', ANSWER: 'this answer',
  MESSAGE: 'this message', CHANNEL: 'this channel', STORY: 'this story',
}
const friendlyTarget = (t) =>
  (REPORT_TARGET_TYPES.includes(t) && TARGET_LABELS[t]) || 'this content'

const DETAILS_MAX = 1000
const DETAILS_COUNTER_AT = 800
/* A report handed back from the dedup path was created earlier; anything
   older than this is treated as "already reported". */
const FRESH_MS = 60_000

/* Module-level "openFn" is set by the ReportHost when mounted. With no host
   there is nowhere to render, so the request resolves as a cancellation. */
let openFn = null
let seq = 0

/** Open the report dialog. Resolves true when a report was submitted,
 *  false when the viewer cancelled (or no host is mounted). */
export function openReport(opts = {}) {
  return new Promise(resolve => {
    if (openFn) openFn({ id: ++seq, resolve, ...opts })
    else resolve(false)
  })
}

export function ReportHost() {
  const [stack, setStack] = React.useState([])

  React.useEffect(() => {
    openFn = (req) => setStack(s => [...s, req])
    return () => { openFn = null }
  }, [])

  if (!stack.length) return null
  const top = stack[stack.length - 1]
  const close = (result) => {
    setStack(s => s.filter(r => r.id !== top.id))
    top.resolve(result)
  }
  return <ReportModal key={top.id} req={top} onClose={close}/>
}

function ReportModal({ req, onClose }) {
  const { targetType, targetId, targetLabel } = req
  const [reason, setReason] = React.useState('')
  const [details, setDetails] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const firstRef = React.useRef(null)
  const busyRef = React.useRef(false)

  const cancel = React.useCallback(() => { if (!busyRef.current) onClose(false) }, [onClose])

  React.useEffect(() => {
    const raf = requestAnimationFrame(() => firstRef.current?.focus())
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); cancel() } }
    window.addEventListener('keydown', onKey)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', onKey) }
  }, [cancel])

  const submit = async () => {
    if (!reason || busy) return
    setBusy(true); busyRef.current = true
    try {
      const res = await api.settings.safety.report({
        targetType, targetId, reason, details: details.trim(),
      })
      const made = parseServerDate(res?.createdAt)
      const stale = made && Date.now() - made.getTime() > FRESH_MS
      showToast(stale
        ? 'You already reported this — it is still under review'
        : 'Report submitted — thank you')
      busyRef.current = false
      onClose(true)
    } catch (e) {
      busyRef.current = false
      setBusy(false)
      if (e?.status === 429) { onClose(false); return }   // rate limit already toasted globally
      showToast('Could not submit the report')
    }
  }

  const label = targetLabel || friendlyTarget(targetType)

  return (
    <div className="dlg-overlay" onClick={(e) => { if (e.target === e.currentTarget) cancel() }}>
      <div className="dlg" role="dialog" aria-modal="true" aria-labelledby="report-dlg-title">
        <div className="dlg-head">
          <div className="dlg-ic"><Icon name="flag"/></div>
          <h3 id="report-dlg-title">Report {label}</h3>
          <button type="button" className="dlg-x" onClick={cancel} aria-label="Close">
            <Icon name="close" className="sm"/>
          </button>
        </div>

        <div className="dlg-body">
          <p className="dlg-msg">
            Reports are reviewed by moderators. Your name is never shown to the person you report.
          </p>

          <label className="field-label dlg-label" id="report-reason-label">Reason</label>
          <div role="radiogroup" aria-labelledby="report-reason-label">
            {REPORT_REASONS.map(([value, text], i) => (
              <label key={value}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 8, cursor: busy ? 'default' : 'pointer' }}>
                <input
                  ref={i === 0 ? firstRef : null}
                  type="radio"
                  name="report-reason"
                  value={value}
                  checked={reason === value}
                  disabled={busy}
                  onChange={() => setReason(value)}
                />
                <span>{text}</span>
              </label>
            ))}
          </div>

          <label className="field-label dlg-label" htmlFor="report-details">Details (optional)</label>
          <textarea
            id="report-details"
            className="field"
            style={{ minHeight: 96 }}
            value={details}
            disabled={busy}
            placeholder="Add anything the moderators should know (optional)"
            onChange={e => setDetails(e.target.value.slice(0, DETAILS_MAX))}
          />
          {details.length > DETAILS_COUNTER_AT && (
            <div className="text-xs muted" style={{ marginTop: 4, textAlign: 'right' }}>
              {details.length} / {DETAILS_MAX}
            </div>
          )}
        </div>

        <div className="dlg-foot">
          <button type="button" className="btn btn-ghost" onClick={cancel} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || !reason} onClick={submit}>
            {busy ? 'Submitting…' : 'Submit report'}
          </button>
        </div>
      </div>
    </div>
  )
}
