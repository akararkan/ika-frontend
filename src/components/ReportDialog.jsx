/* =========================================================
   ReportDialog — the platform-wide "report this" flow.
   Promise-based like Dialog.jsx: any handler can do
     const filed = await openReport({ targetType, targetId, targetLabel, subject })
   The <ReportHost/> at app root (next to <DialogHost/>) listens
   for open requests and stacks them; Esc or the overlay cancels.

   Wire: POST /api/v1/safety/reports — no envelope, 20/hour.
   Dedup trap: ReportService.submit groups on (targetId + reason)
   ONLY — targetType is not part of the key — and an already-open
   report (SUBMITTED/TRIAGED) is handed BACK with a plain 200 and
   its original id/state/createdAt. Nothing in the response says
   "this is a duplicate", so we infer it from an id we have
   already filed this session, from a state past SUBMITTED, or
   from a createdAt that is not fresh — and then say so instead
   of thanking the user for nothing.
   ========================================================= */
/* eslint-disable react-refresh/only-export-components */
import React from 'react'
import { Link } from 'react-router-dom'
import { Icon, showToast } from './ui.jsx'
import { api, REPORT_REASONS, REPORT_TARGET_TYPES } from '../api/index.js'
import { parseServerDate } from './settings/shared.jsx'

/* Friendly stand-ins when the caller passes no targetLabel.
   One entry per ReportTargetType the backend accepts
   (settings/safety/enums/ReportTargetType.java) — a missing entry would
   read as "this content", which is true but useless in the title. */
const TARGET_LABELS = {
  USER: 'this account', POST: 'this post', COMMENT: 'this comment',
  RESEARCH: 'this paper', QUESTION: 'this question', ANSWER: 'this answer',
  MESSAGE: 'this message', CHANNEL: 'this channel', STORY: 'this story',
}
/* Icon for the subject plate — same nine keys. */
const TARGET_ICONS = {
  USER: 'user', POST: 'doc', COMMENT: 'comment',
  RESEARCH: 'book', QUESTION: 'help', ANSWER: 'comment',
  MESSAGE: 'message', CHANNEL: 'megaphone', STORY: 'image',
}
const friendlyTarget = (t) =>
  (REPORT_TARGET_TYPES.includes(t) && TARGET_LABELS[t]) || 'this content'

const LINK_STYLE = { color: 'var(--ox-blue-link)', textDecoration: 'underline' }

const DETAILS_MAX = 1000
const DETAILS_COUNTER_AT = 800
const SUBJECT_MAX = 160        // the plate is a reminder, never the whole message
/* A report handed back from the dedup path was created earlier; anything
   older than this is treated as "already reported". Server clock, so keep
   the window generous — the session id-set below is the exact tell. */
const FRESH_MS = 60_000

/* Report ids this tab has already filed. The dedup path returns the SAME row,
   so a second submit that lands on a known id is a duplicate however fresh
   its createdAt looks. Cleared on reload; the createdAt test covers that. */
const filedIds = new Set()

/* Module-level "openFn" is set by the ReportHost when mounted. With no host
   there is nowhere to render, so the request resolves as a cancellation. */
let openFn = null
let seq = 0

/**
 * Open the report dialog — the ONLY entry point report affordances should use.
 *
 * @param {object}  opts
 * @param {string}  opts.targetType   ReportTargetType: 'USER' | 'POST' | 'COMMENT' |
 *                                    'RESEARCH' | 'QUESTION' | 'ANSWER' | 'MESSAGE' |
 *                                    'CHANNEL' | 'STORY'. Anything else is refused.
 * @param {string}  opts.targetId     UUID of the thing being reported (required).
 * @param {string} [opts.targetLabel] Grammatical phrase for the title — "this comment",
 *                                    "@amina". Defaults to a per-type stand-in.
 * @param {string} [opts.subject]     Optional excerpt/name of the actual item (comment
 *                                    text, message preview, channel title). Shown on a
 *                                    plate so the reporter can see WHAT they are filing
 *                                    about; trimmed to 160 chars, never sent to the API.
 * @returns {Promise<boolean>} true when a report is on file (including the case where
 *   an identical open report already existed), false when the viewer cancelled, when no
 *   host is mounted, or when the arguments were refused. A rate-limited submit keeps the
 *   dialog open (the cooldown is toasted globally), so it resolves only once the viewer
 *   gives up. Callers may ignore it — the dialog reports its own outcome — but it never
 *   rejects.
 */
export function openReport(opts = {}) {
  const { targetType, targetId } = opts
  /* Fail loudly at the call site rather than sending a 400: an unknown type or a
     missing id means the entry point wired the wrong field. */
  if (!REPORT_TARGET_TYPES.includes(targetType) || !targetId) {
    showToast('Nothing to report here', 'err')
    return Promise.resolve(false)
  }
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
  const { targetType, targetId, targetLabel, subject } = req
  const [reason, setReason] = React.useState('')
  const [details, setDetails] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [sent, setSent] = React.useState(null)          // null | 'new' | 'duplicate'
  const firstRef = React.useRef(null)
  const doneRef = React.useRef(null)
  const busyRef = React.useRef(false)

  /* Once a report is on file the flow can only end one way — Esc and the
     overlay must not report it as a cancellation. */
  const dismiss = React.useCallback(() => {
    if (busyRef.current) return
    onClose(!!sent)
  }, [onClose, sent])

  React.useEffect(() => {
    const raf = requestAnimationFrame(() => (sent ? doneRef : firstRef).current?.focus())
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); dismiss() } }
    window.addEventListener('keydown', onKey)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', onKey) }
  }, [dismiss, sent])

  const submit = async () => {
    if (!reason || busy) return
    setBusy(true); busyRef.current = true
    try {
      const res = await api.settings.safety.report({
        targetType, targetId, reason, details: details.trim(),
      })
      /* Three tells, most certain first: an id this tab already filed; a state
         past SUBMITTED (a brand-new row is always SUBMITTED, so TRIAGED can
         only be a row that was already in the queue); and last a createdAt
         that is not fresh, which survives a reload but leans on the client
         clock being roughly right. */
      const known = res?.id && filedIds.has(res.id)
      const moved = !!res?.state && res.state !== 'SUBMITTED'
      const made = parseServerDate(res?.createdAt)
      const stale = made && Date.now() - made.getTime() > FRESH_MS
      if (res?.id) filedIds.add(res.id)
      busyRef.current = false
      setBusy(false)
      setSent(known || moved || stale ? 'duplicate' : 'new')
    } catch (e) {
      busyRef.current = false
      setBusy(false)
      /* 429 is already toasted globally (http.js) with the cooldown. Keep the
         dialog open — closing it would throw away the reason and details the
         user typed, which is the only part they cannot get back. */
      if (e?.status === 429) return
      showToast('Could not submit the report', 'err')
    }
  }

  const label = targetLabel || friendlyTarget(targetType)
  const excerpt = typeof subject === 'string' ? subject.trim().slice(0, SUBJECT_MAX) : ''
  const duplicate = sent === 'duplicate'

  return (
    <div className="dlg-overlay" onClick={(e) => { if (e.target === e.currentTarget) dismiss() }}>
      <div className="dlg" role="dialog" aria-modal="true" aria-labelledby="report-dlg-title">
        <div className="dlg-head">
          <div className="dlg-ic"><Icon name="flag"/></div>
          <h3 id="report-dlg-title">{sent ? 'Report received' : `Report ${label}`}</h3>
          <button type="button" className="dlg-x" onClick={dismiss} aria-label="Close">
            <Icon name="close" className="sm"/>
          </button>
        </div>

        {sent ? (
          <div className="dlg-body">
            {/* role=status: the outcome replaces the body in place and focus
                only moves to "Done", which on its own announces nothing. */}
            <div className={'stx-note ' + (duplicate ? 'info' : 'ok')} role="status">
              <Icon name={duplicate ? 'info' : 'check'}/>
              <span>
                {duplicate
                  ? 'You already reported this for the same reason — that report is still under review, so we have not filed a second one.'
                  : 'Thank you. Moderators review every report; your name is never shown to the person you reported.'}
              </span>
            </div>
            <p className="dlg-msg" style={{ marginTop: 14 }}>
              You can follow this report, and appeal a decision once it is made, in{' '}
              {/* Nothing styles a link inside .dlg-msg (the global rule is
                  `a{color:inherit;text-decoration:none}`), so it says so here —
                  coloured AND underlined, never colour alone. */}
              <Link to="/settings/safety#reports" style={LINK_STYLE} onClick={() => onClose(true)}>
                Settings → Safety Center
              </Link>.
            </p>
          </div>
        ) : (
          <div className="dlg-body">
            <p className="dlg-msg">
              Reports are reviewed by moderators. Your name is never shown to the person you report.
            </p>

            {excerpt && (
              /* minWidth/overflowWrap: the excerpt is raw user text, and a
                 single 160-character token (a pasted URL) in a flex child
                 would otherwise widen the whole dialog. */
              <div className="stx-plate" style={{ marginBottom: 14 }}>
                <Icon name={TARGET_ICONS[targetType] || 'flag'} className="sm"/>
                <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', fontSize: 13, lineHeight: 1.45 }}>
                  {excerpt}
                </span>
              </div>
            )}

            {/* Not a <label>: it names a radiogroup, not a control, and an
                orphan label element is a click target that focuses nothing. */}
            <div className="field-label dlg-label" id="report-reason-label">Reason</div>
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
        )}

        <div className="dlg-foot">
          {sent ? (
            <button type="button" className="btn btn-primary" ref={doneRef} onClick={() => onClose(true)}>Done</button>
          ) : (
            <>
              <button type="button" className="btn btn-ghost" onClick={dismiss} disabled={busy}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={busy || !reason} onClick={submit}>
                {busy ? 'Submitting…' : 'Submit report'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
