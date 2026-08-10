/* =========================================================
   Admin — the automated-moderation console
   /admin/moderation   (route, sidebar entry and stylesheet are already wired;
   the route is gated to PLATFORM_ADMIN_ROLES in App.jsx, which is NARROWER than
   the backend's ADMIN|MODERATOR|ANALYST — this app has no moderator shell yet.)

   THE STAFF HALF OF THE CONTRACT. Everything in src/lib/moderation.js exists to
   keep a label and a score away from an AUTHOR, because a precise refusal is a
   working oracle for probing the classifier until something gets through. None
   of that applies on this screen: a moderator is *supposed* to see the head, the
   score and the band it was measured against. That is the whole point of the
   page — a queue that only said "risky" would turn every case into a coin flip.

   Four tabs. Two are rendered here (the queue and the ops board); Policy and
   Model are self-contained panels imported below, because threshold tuning and
   the classifier's lifecycle are their own screens with their own step-up dance.

   The wire truths that shape this file — all of them from src/api/moderation.js,
   which was probed against the Java source rather than the published docs:

     1. The three queue filters are NOT composable. The controller is an
        if/else-if chain and `slaBreached` wins, so the entity-type select is
        DISABLED while it is on rather than lying about what the server did.
     2. `counts` is table-wide, not a count of the filtered page. It is labelled
        as such; a filtered view claiming "412 in review" over nine rows reads
        like the console is hiding something.
     3. `preview` is built from an unordered field fetch, so the previewed field
        is arbitrary. It is a hint, never "the body" — every scored field lives
        one click away in the evidence panel.
     4. `fields[].scores` is `{}` (not absent) when the stored blob could not be
        read, and an individual head can be missing from a populated map. An
        absent score means "we don't know", NOT "zero", so it renders as an
        em dash and no bar — six confident 0.00 bars would be a lie.
     5. Chat and live-chat bodies are withheld from staff BY POLICY. The case
        still carries scores, labels and thresholds, so a decision is still
        possible without reading a private message — and `teachModel` is a
        silent no-op for those two types, so the checkbox is disabled rather
        than promising a training row that will never appear.

   Single decisions deliberately need NO step-up (per the controller's own design
   note: they are the everyday act). Bulk does, so it runs through the same
   challenge dialog the settings panels use.
   ========================================================= */
import React from 'react'
import { Icon, showToast } from '../components/ui.jsx'
import { Loader } from '../components/states.jsx'
import { uiConfirm } from '../components/Dialog.jsx'
import { runStepUp, parseServerDate, fmtWhen, humanEnum } from '../components/settings/shared.jsx'
import {
  api, MODERATION_STATUSES, MODERATED_ENTITY_TYPES, MODERATION_LABELS,
  entityTypeName, isRedactedText, isRedactedType,
} from '../api/index.js'
import { ENTITY_LABEL } from '../lib/moderation.js'
/* Written against the agreed names/paths. Both panels are self-contained and
   take no props — thresholds and the model registry own their own loading,
   error and step-up handling, exactly as this page owns the queue's. */
import { ModerationPolicyPanel } from '../components/admin/ModerationPolicyPanel.jsx'
import { ModerationModelPanel } from '../components/admin/ModerationModelPanel.jsx'

/* ---------------------------------------------------------
   Formatters. Deliberately tiny and local: every one of them
   encodes a fact about this wire, not a general-purpose need.
   --------------------------------------------------------- */

/** Scores are 0..1 doubles. Two decimals is the resolution a human can act on;
 *  the float tail (0.8300000000000001) is noise from the JSON round-trip. */
const score2 = (v) => (Number(v) || 0).toFixed(2)

/** 0..1 → a CSS width, clamped so a malformed score cannot overflow its track
 *  and rounded so the float tail (87.33999999999999%) stays out of the DOM. */
const pctW = (v) => `${(Math.max(0, Math.min(1, Number(v) || 0)) * 100).toFixed(1)}%`

/** Exact counts, never abbreviated — `fmt()` would turn a 12,431-row backlog
 *  into "12.4k", and the whole reason to show a queue depth is the real number. */
const count = (n) => Number(n || 0).toLocaleString()

/** A percentage the server already computed. It arrives as a double like
 *  93.75; one decimal is honest without implying more precision than a small
 *  window can carry. */
const pct1 = (v) => `${(Number(v) || 0).toFixed(1)}%`

/** ms → the coarsest unit that still reads precisely. Case ages run from a few
 *  hundred milliseconds (an inline clear) to days (a forgotten backlog). */
function fmtDur(ms) {
  const s = Math.max(0, Math.round(Math.abs(Number(ms) || 0) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

/** The uppercase enum name → the noun the server uses in its own notification
 *  bodies, so the console and the author's bell never disagree about what was
 *  held. `entityLabel` on the row says the same thing; this is the fallback for
 *  a type the wire names but ENTITY_LABEL has not been taught yet. */
const kindOf = (type, fallback) => fallback || ENTITY_LABEL[entityTypeName(type)] || 'content'

/* Chip tones. Nothing here is a value judgement about the AUTHOR — it is the
   state of the CASE, which is what a moderator triages on. */
const STATUS_TONE = { IN_REVIEW: 'warn', PENDING: 'info', APPROVED: 'ok', REJECTED: 'err' }
const VERDICT_TONE = { APPROVE: 'ok', REVIEW: 'warn', REJECT: 'err' }
const REASON_TONE = {
  BLOCKLIST: 'err', SLA_BREACH: 'warn', INFERENCE_UNAVAILABLE: 'warn',
  MODEL: 'info', ADMIN: 'plain', DISABLED: 'plain', NO_TEXT: 'plain',
}

/** A coarse read of the list's single `maxScore`. The queue rows carry NO
 *  bands — those arrive with the case detail — so this cannot be the verdict
 *  and must not pretend to be: it is a "look here first" tint, and the real
 *  band comparison happens per label in the evidence panel. */
const listFill = (s) => (s >= 0.8 ? 'hi' : s < 0.3 ? 'lo' : '')

/* 401/403 are one situation to the reader: the signed-in account cannot do
   this, and the likeliest cause is a stale session rather than a real demotion.
   STEP_UP_REQUIRED is carved out — it is also a 403, but it means "confirm it's
   you", and runStepUp() already answers it with the challenge dialog. */
const isDenied = (e) => (e?.status === 401 || e?.status === 403) && e?.code !== 'STEP_UP_REQUIRED'
const errorCopy = (e) => (isDenied(e) ? 'This account may no longer have moderator rights — the server refused with 401/403.' : (e?.message || e?.code || 'The request failed.'))

/** The in-page rights refusal. The route is already gated, so reaching this
 *  means the SESSION went stale (or the role changed underneath the tab) —
 *  which is a different fix from "you are on the wrong page", and worth saying. */
function DeniedCard({ error }) {
  return (
    <div className="card card-pad" style={{ borderColor: 'var(--danger)', marginBottom: 16 }}>
      <h3 className="title" style={{ color: 'var(--danger)' }}><Icon name="lock" className="sm"/>Refused by the server</h3>
      <p className="text-sm">
        The moderation endpoints answered <b>HTTP {error?.status || '403'}</b>. This route is gated to platform
        administrators, so the usual cause is a session that expired or an account whose role changed since this tab
        was opened — not a bad request.
      </p>
      <p className="muted text-sm" style={{ marginTop: 6 }}>
        Sign in again and reload. Nothing was decided, re-scored or written.
      </p>
    </div>
  )
}

/** A failure that is NOT a rights problem. The reader is a moderator debugging
 *  their own queue, so the server's own message and code stay visible. */
function FailCard({ error, onRetry }) {
  return (
    <div className="card card-pad" style={{ marginBottom: 16 }}>
      <h3 className="title"><Icon name="alert" className="sm"/>Could not load</h3>
      <p className="text-sm">{errorCopy(error)}</p>
      <p className="muted text-xs" style={{ marginTop: 4 }}>
        {error?.status ? `HTTP ${error.status}` : 'No response'}{error?.code ? ` · ${error.code}` : ''}
      </p>
      {onRetry && <button type="button" className="btn btn-secondary btn-sm mt-12" onClick={onRetry}><Icon name="refresh" className="xs"/>Try again</button>}
    </div>
  )
}

/* =========================================================
   QUEUE — one row
   ========================================================= */

/**
 * The row is a <div>, not a <button>, even though .mdq-row carries button
 * resets: a queue row has to hold a real checkbox for bulk selection, and a
 * checkbox inside a button is invalid HTML that browsers resolve by swallowing
 * the click. So the checkbox is its own control and the middle column is the
 * button that opens the case.
 */
function QueueRow({ row, now, selected, picked, onOpen, onPick, filterStatus }) {
  const waited = parseServerDate(row.submittedAt)
  const due = parseServerDate(row.holdDeadline)
  const overdue = due ? now - due.getTime() : null
  const redacted = isRedactedText(row.preview) || isRedactedType(row.entityType)
  const topScore = Number(row.topScore || 0)

  return (
    <div className={'mdq-row' + (selected ? ' on' : '')}>
      <input
        type="checkbox" className="stx-tick" checked={picked} onChange={e => onPick(row.caseId, e.target.checked)}
        aria-label={`Select this ${kindOf(row.entityType, row.entityLabel)} case for a bulk decision`}
      />

      {/* Inline reset only: .mdq-row-main is a layout class (min-width:0) and the
          button chrome would otherwise plate the whole row. */}
      <button
        type="button" className="mdq-row-main" onClick={() => onOpen(row.caseId)}
        aria-current={selected ? 'true' : undefined}
        aria-label={`Open the evidence for this ${kindOf(row.entityType, row.entityLabel)} case`}
        style={{ background: 'none', border: 0, padding: 0, font: 'inherit', color: 'inherit', textAlign: 'start', cursor: 'pointer' }}
      >
        <div className="mdq-ref">
          <span className="mdq-kind">{kindOf(row.entityType, row.entityLabel)}</span>
          {/* Only shown when it disagrees with the active filter — which is
              exactly what happens the moment you decide a case without
              re-reading the list, and the row would otherwise look untouched. */}
          {row.status && row.status !== filterStatus && (
            <span className={'stx-chip ' + (STATUS_TONE[row.status] || 'plain')}>{humanEnum(row.status)}</span>
          )}
          {row.reasonCode && <span className={'stx-chip ' + (REASON_TONE[row.reasonCode] || 'plain')}>{humanEnum(row.reasonCode)}</span>}
          {row.slaBreached && <span className="stx-chip err"><Icon name="clock" className="xs"/>SLA</span>}
          {row.blocklistHit && <span className="stx-chip err">“{row.blocklistHit}”</span>}
        </div>

        {/* User text, so dir="auto" — a queue is the one place an Arabic body and
            a Latin one sit in the same column. */}
        <p className={'mdq-prev' + (redacted ? ' mdq-redacted' : '')} dir="auto">
          {row.preview || 'No stored preview for this case.'}
        </p>

        <div className="mdq-meta">
          {waited && <span title={fmtWhen(row.submittedAt)}>waiting {fmtDur(now - waited.getTime())}</span>}
          {overdue != null && (
            overdue > 0
              ? <span style={{ color: 'var(--warn)' }}>hold ended {fmtDur(overdue)} ago</span>
              : <span>hold ends in {fmtDur(-overdue)}</span>
          )}
          {row.authorPriorRejections > 0 && (
            <span>author has {count(row.authorPriorRejections)} prior rejection{row.authorPriorRejections === 1 ? '' : 's'}</span>
          )}
          {row.modelVersion && <span>{row.modelVersion}</span>}
          {row.entityRef && <span title={row.entityRef}>ref {String(row.entityRef).slice(0, 8)}</span>}
        </div>
      </button>

      <div className="mdq-row-side">
        <div className="mdq-score">
          <span className="mdq-score-n" title={`Highest score across every scored field: ${topScore}`}>{score2(topScore)}</span>
          <span className="mdq-score-bar" aria-hidden="true">
            <span className={'mdq-score-fill ' + listFill(topScore)} style={{ width: pctW(topScore) }}/>
          </span>
        </div>
        {row.topLabel && <span className="stx-chip plain">{row.topLabel}</span>}
      </div>
    </div>
  )
}

/* =========================================================
   QUEUE — the evidence panel
   The reason this screen exists: every scored FIELD, every head, against the
   band that actually applied to this entity type.
   ========================================================= */
function CaseDetail({ caseId, onDecided, onClose }) {
  const [data, setData] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [busy, setBusy] = React.useState('')
  const [reason, setReason] = React.useState('')
  const [teach, setTeach] = React.useState(false)
  const [rescored, setRescored] = React.useState(null)
  const [tick, setTick] = React.useState(0)

  React.useEffect(() => {
    let alive = true
    setData(null); setError(null)
    api.moderation.review.get(caseId)
      .then(d => { if (alive) setData(d) })
      .catch(e => { if (alive) setError(e) })
    return () => { alive = false }
  }, [caseId, tick])

  /* Keyed on caseId ALONE, not on the reload tick. A re-score bumps the tick to
     pull fresh evidence, and clearing the outcome here would erase the very
     sentence that explains why the panel just reloaded. A fresh CASE, though,
     gets a fresh decision: carrying a reason typed for the previous one into
     this one would attach the wrong sentence to a permanent record. */
  React.useEffect(() => { setReason(''); setTeach(false); setRescored(null) }, [caseId])

  const summary = data?.summary
  const th = data?.thresholds
  const bands = th?.bands || {}
  /* Decided off the entity TYPE, not off the text: it has to be known before any
     field arrives, and a chat case whose fields failed to load is still redacted. */
  const redacted = isRedactedType(summary?.entityType)

  const decide = async (action) => {
    setBusy(action)
    try {
      const row = await api.moderation.review.decide(caseId, {
        action,
        reason: reason.trim() || undefined,
        /* Never sent for a chat case: the server accepts it, returns
           outcome "ok", and quietly does nothing. */
        teachModel: teach && !redacted,
      })
      setData(d => (d && row ? { ...d, summary: row } : d))
      onDecided?.(row)
      showToast(action === 'APPROVE' ? 'Case approved' : 'Case rejected', action === 'APPROVE' ? 'ok' : 'warn')
    } catch (e) {
      showToast(errorCopy(e), 'err')
    } finally {
      setBusy('')
    }
  }

  const rescore = async () => {
    setBusy('rescore')
    try {
      const res = await api.moderation.review.rescore(caseId)
      const status = res?.status
      /* `GONE` is a SYNTHETIC value, not a ModerationStatus — the case row no
         longer exists. It must never reach a status formatter that assumes the
         enum, so it gets its own branch and its own sentence. */
      if (status === 'GONE') {
        setRescored({ gone: true })
        showToast('That case no longer exists', 'warn')
      } else {
        setRescored({ status })
        setTick(t => t + 1)               // re-read: the verdict and the fields may have moved
        showToast(`Re-scored — ${humanEnum(status) || 'unchanged'}`)
      }
    } catch (e) {
      showToast(errorCopy(e), 'err')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="card card-pad mdq-detail">
      <div className="mdq-bar" style={{ paddingTop: 0, borderBottom: 0 }}>
        <h3 className="title" style={{ margin: 0 }}>
          <Icon name="doc" className="sm"/>{summary ? kindOf(summary.entityType, summary.entityLabel) : 'Case'}
        </h3>
        {summary?.status && <span className={'stx-chip ' + (STATUS_TONE[summary.status] || 'plain')}>{humanEnum(summary.status)}</span>}
        <span className="mdq-bar-sp"/>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}><Icon name="close" className="xs"/>Close</button>
      </div>

      {/* A missing case is 400 MODERATION_CASE_NOT_FOUND, never a 404 — so the
          "it's gone" branch has to live in the error handler, not in a status
          check. It is a routine outcome here: a case can be deleted with its
          content while the list page is still on screen. */}
      {error && (error.code === 'MODERATION_CASE_NOT_FOUND'
        ? <p className="stx-note warn"><Icon name="alert"/>This case no longer exists — it was decided and cleaned up, or its content was deleted. Refresh the queue.</p>
        : isDenied(error) ? <DeniedCard error={error}/> : <FailCard error={error} onRetry={() => setTick(t => t + 1)}/>)}

      {!data && !error && <Loader label="Loading the evidence…"/>}

      {data && (
        <>
          {/* The band that applied, stated before any bar is drawn — a score
              means nothing without it. Note the casing asymmetry in one payload:
              summary.entityType is UPPERCASE, thresholds.entityType is the
              lowercase key(). Both are shown as the plain noun instead. */}
          <div className="mdq-meta" style={{ marginTop: 2 }}>
            <span>bands for <b>{kindOf(th?.entityType)}</b></span>
            {th?.holdMs != null && <span>hold ceiling {fmtDur(th.holdMs)}</span>}
            {th?.fallback && <span>fallback {humanEnum(th.fallback)}</span>}
            {summary?.submittedAt && <span>submitted {fmtWhen(summary.submittedAt)}</span>}
            {summary?.decidedAt && <span>decided {fmtWhen(summary.decidedAt)}</span>}
          </div>
          <p className="mdq-hint" style={{ marginTop: 6 }}>
            A head at or above its <b>low</b> edge sends the field to review (amber); at or above <b>high</b> it is a
            reject (red). Everything below both is inside the band and reads as approve.
          </p>

          {redacted && (
            <p className="stx-note info" role="note">
              <Icon name="eyeoff"/>
              Message bodies are withheld from staff by design. The scores, labels and thresholds below are the whole
              evidence for this case — that is deliberate, so a private message can be judged without being read.
            </p>
          )}

          {rescored && (
            <p className={'stx-note ' + (rescored.gone ? 'warn' : 'info')}>
              <Icon name="refresh"/>
              {rescored.gone
                ? 'Re-score found no case row — it has already been removed.'
                : <>Re-scored against the current thresholds: <b>{humanEnum(rescored.status) || 'unchanged'}</b>. A case still inside its hold window comes back <b>Pending</b> unchanged — that is not a failure.</>}
            </p>
          )}

          {(data.fields || []).length === 0 && (
            <p className="mdq-empty">This case has no stored fields. Nothing was scored — decide on the summary alone.</p>
          )}

          {(data.fields || []).map((f, i) => {
            const isRedacted = isRedactedText(f.text)
            const scores = f.scores || {}
            const unreadable = Object.keys(scores).length === 0
            /* Which heads actually crossed, spelled out — the band is the point
               of the screen and a colour alone is not a record of a decision. */
            const crossed = MODERATION_LABELS
              .map(label => {
                const raw = scores[label]
                if (raw == null) return null
                const v = Number(raw)
                const b = bands[label] || {}
                const high = Number(b.high), low = Number(b.low)
                if (Number.isFinite(high) && v >= high) return `${label} ${score2(v)} ≥ high ${score2(high)}`
                if (Number.isFinite(low) && v >= low) return `${label} ${score2(v)} ≥ low ${score2(low)}`
                return null
              })
              .filter(Boolean)

            return (
              <div className="mdq-field" key={f.fieldName ? `${f.fieldName}-${i}` : i}>
                <div className="mdq-field-h">
                  <span className="mdq-field-n">{f.fieldName || 'field'}</span>
                  {f.verdict && <span className={'stx-chip ' + (VERDICT_TONE[f.verdict] || 'plain')}>{humanEnum(f.verdict)}</span>}
                  {f.blocklistHit && <span className="stx-chip err">blocklist “{f.blocklistHit}”</span>}
                  {f.topLabel && <span className="stx-chip plain">{f.topLabel} {score2(f.topScore)}</span>}
                </div>

                <p className={'mdq-text' + (isRedacted ? ' mdq-redacted' : '')} dir="auto">
                  {f.text || '(empty)'}
                </p>

                {unreadable ? (
                  <p className="mdq-hint" style={{ marginTop: 8 }}>
                    <Icon name="alert" className="xs"/> The stored score blob for this field was missing or malformed.
                    An empty map means <b>we could not read it</b> — not that every head scored zero.
                  </p>
                ) : (
                  <>
                    <div className="mdq-labels">
                      {MODERATION_LABELS.map(label => {
                        const raw = scores[label]
                        const known = raw != null
                        const v = known ? Number(raw) : 0
                        const b = bands[label] || {}
                        const low = Number(b.low), high = Number(b.high)
                        const over = known && Number.isFinite(high) && v >= high
                        const inBand = known && !over && Number.isFinite(low) && v >= low
                        return (
                          <React.Fragment key={label}>
                            <span className="mdq-label-n">{label}</span>
                            <span className="mdq-label-bar" aria-hidden="true">
                              {known && <span className={'mdq-label-fill' + (over ? ' over' : inBand ? ' band' : '')} style={{ width: pctW(v) }}/>}
                            </span>
                            <span className="mdq-label-v">
                              {/* An absent head is not a zero — the model did not
                                  report it, so it renders as an em dash. */}
                              <b>{known ? score2(v) : '—'}</b>{' '}
                              <span className="muted">
                                / {Number.isFinite(low) ? score2(low) : '—'}–{Number.isFinite(high) ? score2(high) : '—'}
                              </span>
                            </span>
                          </React.Fragment>
                        )
                      })}
                    </div>
                    <p className="mdq-hint" style={{ marginTop: 7 }}>
                      {crossed.length
                        ? <>Crossed: {crossed.join(' · ')}</>
                        : 'No head reached its review edge on this field.'}
                    </p>
                  </>
                )}
              </div>
            )
          })}

          {/* ---------- the decision ---------- */}
          <div className="mdq-acts">
            <input
              className="field" style={{ flex: '1 1 200px' }} maxLength={500}
              placeholder="Reason (optional, 500 characters)" aria-label="Reason for this decision"
              value={reason} onChange={e => setReason(e.target.value)}
            />
            <label className="flex-c gap-8 text-sm" style={{ cursor: redacted ? 'default' : 'pointer' }}
              title={redacted ? 'The server ignores teachModel for chat and live-chat cases.' : 'Promote this text into the labelled training set.'}>
              <input type="checkbox" className="stx-tick" checked={teach && !redacted} disabled={redacted}
                onChange={e => setTeach(e.target.checked)}/>
              <span className={redacted ? 'muted' : undefined}>Teach the model</span>
            </label>
            <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => decide('APPROVE')}>
              <Icon name="check" className="xs"/>{busy === 'APPROVE' ? 'Approving…' : 'Approve'}
            </button>
            <button type="button" className="btn btn-danger btn-sm" disabled={!!busy} onClick={() => decide('REJECT')}>
              <Icon name="close" className="xs"/>{busy === 'REJECT' ? 'Rejecting…' : 'Reject'}
            </button>
            <span className="mdq-bar-sp"/>
            <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={rescore}>
              <Icon name="refresh" className="xs"/>{busy === 'rescore' ? 'Re-scoring…' : 'Re-score'}
            </button>
          </div>

          <p className="mdq-hint" style={{ marginTop: 8 }}>
            A decision really applies: rejecting un-publishes the content and approving re-publishes it, because the
            server clears the applied/notified stamps and re-runs the applier. Deciding an already-decided case is
            allowed and silent, so a mistake here is fixed by deciding again — not by an undo.
            {redacted && ' Training promotion is off for chat cases: the server accepts the flag and ignores it.'}
          </p>
        </>
      )}
    </div>
  )
}

/* =========================================================
   QUEUE tab
   ========================================================= */
function QueueTab({ filters, setFilters, onCounts }) {
  const [data, setData] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [selected, setSelected] = React.useState(null)
  const [picked, setPicked] = React.useState(() => new Set())
  const [bulkReason, setBulkReason] = React.useState('')
  const [bulkTeach, setBulkTeach] = React.useState(false)
  const [bulkBusy, setBulkBusy] = React.useState(false)
  const [bulkErrors, setBulkErrors] = React.useState(null)
  const [now, setNow] = React.useState(() => Date.now())

  /* Filter changes are fast and the responses are not ordered, so a stale
     answer can land after a newer one. The sequence number is a ref because it
     has to be written synchronously at call time, before any await. */
  const seq = React.useRef(0)

  const load = React.useCallback(async () => {
    const mine = ++seq.current
    setLoading(true); setError(null)
    try {
      const res = await api.moderation.review.list(filters)
      if (seq.current !== mine) return
      setData(res)
      onCounts(res.counts)
    } catch (e) {
      if (seq.current !== mine) return
      setError(e); setData(null)
    } finally {
      if (seq.current === mine) setLoading(false)
    }
  }, [filters, onCounts])

  React.useEffect(() => { load() }, [load])

  /* Ages are the triage signal, so they cannot silently freeze. The clock is
     STATE read in an effect, not `Date.now()` read during render: a render must
     stay pure, and a row's age is derived from it on every pass. Half a minute
     is well under the coarsest unit fmtDur prints, and the timer only exists
     while rows are on screen — an empty queue must not hold one open. */
  const items = data?.items
  React.useEffect(() => {
    if (!items?.length) return undefined
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(t)
  }, [items])

  const rows = items || []
  const counts = data?.counts

  const patch = (next) => setFilters(f => ({ ...f, ...next, page: next.page ?? 0 }))

  const pick = (id, on) => setPicked(prev => {
    const s = new Set(prev)
    if (on) s.add(id); else s.delete(id)
    return s
  })
  const pageIds = rows.map(r => r.caseId)
  const allPicked = pageIds.length > 0 && pageIds.every(id => picked.has(id))
  const togglePage = () => setPicked(prev => {
    const s = new Set(prev)
    if (allPicked) pageIds.forEach(id => s.delete(id))
    else pageIds.forEach(id => s.add(id))
    return s
  })

  /* A decided row is patched in place rather than dropped. Removing it would
     yank the row out from under the cursor and silently renumber the page; the
     status chip appearing on it says what happened, and Refresh re-reads. */
  const patchRow = React.useCallback((row) => {
    if (!row?.caseId) return
    setData(d => (d ? { ...d, items: d.items.map(it => (it.caseId === row.caseId ? row : it)) } : d))
  }, [])

  /* Only rows on THIS page can be inspected — a selection may span pages and
     the list carries no memory of the rows it has scrolled past. So the warning
     below says "on this page" rather than claiming a count it cannot know. */
  const redactedPicks = rows.filter(r => picked.has(r.caseId) && isRedactedType(r.entityType)).length

  const bulk = async (action) => {
    const ids = [...picked]
    if (!ids.length) return
    if (ids.length > 100) { showToast('Bulk decisions are limited to 100 cases', 'err'); return }
    const ok = await uiConfirm({
      title: `${action === 'APPROVE' ? 'Approve' : 'Reject'} ${ids.length} case${ids.length === 1 ? '' : 's'}?`,
      message: action === 'REJECT'
        ? `${ids.length} pieces of content will be un-published and their authors notified. Each case is decided independently — a failure on one does not stop the rest.`
        : `${ids.length} pieces of content will be published. Each case is decided independently — a failure on one does not stop the rest.`,
      confirmLabel: action === 'APPROVE' ? 'Approve all' : 'Reject all',
      danger: action === 'REJECT',
      icon: 'shield',
    })
    if (!ok) return

    setBulkBusy(true); setBulkErrors(null)
    try {
      /* The ONE step-up on this tab. Single decisions are deliberately
         unguarded server-side; a hundred at once is not, so one challenge
         covers the batch (see REQUIRES_STEP_UP in api/moderation.js). */
      const res = await runStepUp(() => api.moderation.review.bulk({
        action, caseIds: ids,
        reason: bulkReason.trim() || undefined,
        teachModel: bulkTeach,
      }))
      if (res === undefined) return                       // cancelled at the challenge; already toasted
      const results = Array.isArray(res) ? res : []
      const failed = results.filter(r => r.outcome !== 'ok')
      /* Per-item failures come back INSIDE a 200 as raw exception messages, not
         error codes — so they are rendered as text and never mapped to copy. */
      if (failed.length) setBulkErrors(failed)
      showToast(
        failed.length
          ? `${results.length - failed.length} of ${results.length} decided — ${failed.length} failed`
          : `${results.length} case${results.length === 1 ? '' : 's'} ${action === 'APPROVE' ? 'approved' : 'rejected'}`,
        failed.length ? 'warn' : 'ok',
      )
      setPicked(new Set())
      setSelected(null)
      load()                                              // a batch moves too many rows to patch by hand
    } catch (e) {
      showToast(errorCopy(e), 'err')
    } finally {
      setBulkBusy(false)
    }
  }

  const totalPages = data?.totalPages || 0
  const page = data?.page ?? filters.page

  return (
    <>
      {/* ---------- filters ---------- */}
      <div className="mdq-bar">
        <select className="field" aria-label="Case status" value={filters.status}
          onChange={e => patch({ status: e.target.value })}>
          {MODERATION_STATUSES.map(s => <option key={s} value={s}>{humanEnum(s)}</option>)}
        </select>

        {/* Disabled, not merely ignored: the server's filter chain drops
            entityType whenever slaBreached is set, and a select that still
            looked active would be describing a query that never ran. */}
        <select className="field" aria-label="Content type" value={filters.entityType}
          disabled={filters.slaBreached} onChange={e => patch({ entityType: e.target.value })}>
          <option value="">All content types</option>
          {MODERATED_ENTITY_TYPES.map(t => <option key={t} value={t}>{ENTITY_LABEL[t] || t}</option>)}
        </select>

        <label className="flex-c gap-8 text-sm" style={{ cursor: 'pointer' }}>
          <input type="checkbox" className="stx-tick" checked={filters.slaBreached}
            onChange={e => patch({ slaBreached: e.target.checked })}/>
          Past the hold ceiling
        </label>

        <select className="field" aria-label="Sort order" value={filters.sort}
          onChange={e => patch({ sort: e.target.value })}>
          <option value="risk">Highest score first</option>
          <option value="oldest">Oldest first</option>
        </select>

        <select className="field" aria-label="Cases per page" value={filters.pageSize}
          onChange={e => patch({ pageSize: Number(e.target.value) })}>
          {[25, 50, 100].map(n => <option key={n} value={n}>{n} per page</option>)}
        </select>

        <span className="mdq-bar-sp"/>
        <button type="button" className="btn btn-secondary btn-sm" onClick={load} disabled={loading}>
          <Icon name="refresh" className="xs"/>{loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {filters.slaBreached && (
        <p className="mdq-hint" style={{ marginTop: 8 }}>
          The breach filter is not composable with the content type — the server drops the type whenever it is set, so
          this view is <b>every</b> type that ran past its hold ceiling.
        </p>
      )}

      {counts && (
        <p className="mdq-hint" style={{ marginTop: 8 }}>
          Table-wide totals (not this filter): <b>{count(counts.inReview)}</b> in review ·{' '}
          <b>{count(counts.pending)}</b> pending · <b>{count(counts.slaBreached)}</b> past the ceiling.
        </p>
      )}

      {/* ---------- bulk bar ---------- */}
      {picked.size > 0 && (
        <div className="mdq-bar">
          <b>{picked.size} selected</b>
          <input className="field" style={{ flex: '1 1 180px' }} maxLength={500}
            placeholder="Reason for all (optional)" aria-label="Reason for the bulk decision"
            value={bulkReason} onChange={e => setBulkReason(e.target.value)}/>
          <label className="flex-c gap-8 text-sm" style={{ cursor: 'pointer' }}>
            <input type="checkbox" className="stx-tick" checked={bulkTeach} onChange={e => setBulkTeach(e.target.checked)}/>
            Teach the model
          </label>
          <button type="button" className="btn btn-primary btn-sm" disabled={bulkBusy || picked.size > 100} onClick={() => bulk('APPROVE')}>
            <Icon name="check" className="xs"/>Approve
          </button>
          <button type="button" className="btn btn-danger btn-sm" disabled={bulkBusy || picked.size > 100} onClick={() => bulk('REJECT')}>
            <Icon name="close" className="xs"/>Reject
          </button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={bulkBusy} onClick={() => setPicked(new Set())}>Clear</button>
          <span className="mdq-bar-sp"/>
          <span className="mdq-hint"><Icon name="shield" className="xs"/> Bulk decisions ask for your password.</span>
        </div>
      )}

      {picked.size > 100 && (
        <p className="stx-note warn"><Icon name="alert"/>
          The server takes at most 100 case ids in one batch. Deselect {picked.size - 100} before deciding.
        </p>
      )}
      {picked.size > 0 && bulkTeach && redactedPicks > 0 && (
        <p className="stx-note info"><Icon name="eyeoff"/>
          {redactedPicks} selected case{redactedPicks === 1 ? '' : 's'} on this page {redactedPicks === 1 ? 'is a chat case' : 'are chat cases'} —
          the server ignores training promotion for those and still reports success.
        </p>
      )}
      {bulkErrors && (
        <div className="stx-note err">
          <Icon name="alert"/>
          <div>
            {bulkErrors.length} case{bulkErrors.length === 1 ? '' : 's'} could not be decided. The server sends these as
            raw exception messages, not error codes, so they are shown as written:
            {bulkErrors.map(r => (
              <div key={r.caseId}>{String(r.caseId).slice(0, 8)} — {r.error || 'no message'}</div>
            ))}
          </div>
        </div>
      )}

      {/* ---------- list + evidence ---------- */}
      {isDenied(error) && <DeniedCard error={error}/>}
      {error && !isDenied(error) && <FailCard error={error} onRetry={load}/>}

      {/* auto-fit collapses the empty track, so with nothing selected the queue
          spans the full width and the split appears only when it is needed —
          no media query, which an inline style could not carry anyway. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', gap: 18, alignItems: 'start', marginTop: 14 }}>
        <div className="card card-pad">
          <div className="mdq-bar" style={{ paddingTop: 0 }}>
            <label className="flex-c gap-8 text-sm" style={{ cursor: rows.length ? 'pointer' : 'default' }}>
              <input type="checkbox" className="stx-tick" checked={allPicked} disabled={!rows.length}
                onChange={togglePage} aria-label="Select every case on this page"/>
              Select page
            </label>
            <span className="mdq-bar-sp"/>
            <span className="mdq-hint">
              {count(data?.totalElements)} case{data?.totalElements === 1 ? '' : 's'} match this filter
            </span>
          </div>

          {loading && !rows.length && <Loader label="Reading the queue…"/>}

          {!loading && !rows.length && !error && (
            <div className="mdq-empty">
              <Icon name="checks" className="lg"/>
              <p style={{ marginTop: 8 }}>
                Nothing {filters.status === 'IN_REVIEW' ? 'is waiting for a human' : `is ${humanEnum(filters.status).toLowerCase()}`}
                {filters.slaBreached ? ' past its hold ceiling' : ''}
                {filters.entityType && !filters.slaBreached ? ` under ${ENTITY_LABEL[filters.entityType] || filters.entityType}` : ''}.
              </p>
              <p className="text-xs" style={{ marginTop: 4 }}>An empty queue is the normal state — almost everything clears automatically in under a second.</p>
            </div>
          )}

          {rows.length > 0 && (
            <div className="mdq-list">
              {rows.map(row => (
                <QueueRow
                  key={row.caseId} row={row} now={now}
                  selected={selected === row.caseId}
                  picked={picked.has(row.caseId)}
                  filterStatus={filters.status}
                  onOpen={setSelected} onPick={pick}
                />
              ))}
            </div>
          )}

          {totalPages > 1 && (
            <div className="mdq-bar" style={{ borderBottom: 0 }}>
              <button type="button" className="btn btn-secondary btn-sm" disabled={page <= 0 || loading}
                onClick={() => setFilters(f => ({ ...f, page: Math.max(0, page - 1) }))}>
                <Icon name="chevleft" className="xs"/>Previous
              </button>
              <span className="mdq-hint">Page {page + 1} of {totalPages}</span>
              <button type="button" className="btn btn-secondary btn-sm" disabled={page + 1 >= totalPages || loading}
                onClick={() => setFilters(f => ({ ...f, page: page + 1 }))}>
                Next<Icon name="chevright" className="xs"/>
              </button>
            </div>
          )}
        </div>

        {selected && (
          <CaseDetail
            key={selected} caseId={selected}
            onDecided={patchRow} onClose={() => setSelected(null)}
          />
        )}
      </div>
    </>
  )
}

/* =========================================================
   METRICS tab — the ops board
   Roles widen here (ANALYST is admitted), which is a hint about what it is for:
   it is the only read on this console that answers "is the machine healthy",
   not "is this piece of content allowed".
   ========================================================= */
const WINDOWS = [[1, 'Last hour'], [6, 'Last 6 hours'], [24, 'Last 24 hours'], [168, 'Last 7 days'], [720, 'Last 30 days']]

function Kpi({ value, label, tone = '', title }) {
  return (
    <div className={'mdq-kpi ' + tone} title={title}>
      <div className="mdq-kpi-v">{value}</div>
      <div className="mdq-kpi-k">{label}</div>
    </div>
  )
}

function MetricsTab() {
  const [win, setWin] = React.useState(24)
  const [m, setM] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [tick, setTick] = React.useState(0)

  React.useEffect(() => {
    let alive = true
    setLoading(true); setError(null)
    api.moderation.review.metrics({ windowHours: win })
      .then(r => { if (alive) { setM(r); setError(null) } })
      .catch(e => { if (alive) { setError(e); setM(null) } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [win, tick])

  if (isDenied(error)) return <DeniedCard error={error}/>
  if (error) return <FailCard error={error} onRetry={() => setTick(t => t + 1)}/>
  if (loading && !m) return <Loader label="Reading the ops board…"/>
  if (!m) return null

  const queue = m.queue || {}
  const volume = m.volume || {}
  const bands = m.bands || {}
  const model = m.model || {}
  const dataset = m.dataset || {}
  const labels = m.labels || []
  const sla = m.sla || []
  const byType = Object.entries(volume.byEntityType || {}).filter(([, statuses]) => Object.keys(statuses || {}).length > 0)
  const idleTypes = Object.keys(volume.byEntityType || {}).length - byType.length

  return (
    <>
      <div className="mdq-bar">
        <select className="field" aria-label="Reporting window" value={win} onChange={e => setWin(Number(e.target.value))}>
          {WINDOWS.map(([h, label]) => <option key={h} value={h}>{label}</option>)}
        </select>
        <span className="mdq-bar-sp"/>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setTick(t => t + 1)} disabled={loading}>
          <Icon name="refresh" className="xs"/>{loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {/* The server's own switch, surfaced rather than smoothed over: with
          moderation off, every tile below is a record of a machine that is not
          running. */}
      {m.enabled === false && (
        <p className="stx-note warn"><Icon name="alert"/>
          <span>
            <b>Automated moderation is switched off.</b> Nothing is being scored — only the keyword blocklist is
            enforced. Every number below is history from before it was disabled.
          </span>
        </p>
      )}

      <div className="card card-pad" style={{ marginTop: 14 }}>
        <h3 className="title"><Icon name="hourglass" className="sm"/>Queue</h3>
        <div className="mdq-kpis">
          <Kpi value={count(queue.inReview)} label="Waiting for a human" tone={queue.inReview > 0 ? 'warn' : 'good'}/>
          <Kpi value={count(queue.pending)} label="Still being scored"/>
          <Kpi value={count(queue.slaBreached)} label="Past the hold ceiling" tone={queue.slaBreached > 0 ? 'bad' : 'good'}/>
          <Kpi value={count(volume.submitted)} label="Submitted in this window"/>
        </div>
        <p className="mdq-hint" style={{ marginTop: 10 }}>
          The three queue tiles are <b>live table-wide counts</b> and ignore the window — only “submitted” is windowed.
        </p>
      </div>

      <div className="card card-pad" style={{ marginTop: 14 }}>
        <h3 className="title"><Icon name="trending" className="sm"/>Where the decisions came from</h3>
        <div className="mdq-kpis">
          <Kpi value={pct1(bands.autoDecidedPercent)} label="Decided without a human"
            tone={Number(bands.autoDecidedPercent) >= 95 ? 'good' : Number(bands.autoDecidedPercent) >= 80 ? '' : 'warn'}/>
          <Kpi value={count(bands.autoApproved)} label="Auto-approved"/>
          <Kpi value={count(bands.autoRejected)} label="Auto-rejected"/>
          <Kpi value={count(bands.sentToReview)} label="Sent to review"/>
          <Kpi value={count(bands.decidedByHuman)} label="Decided by a human"/>
        </div>
        <p className="mdq-hint" style={{ marginTop: 10 }}>
          These count outcomes inside the window, so a quiet hour makes the percentage swing on a handful of cases.
          Read it next to the volume, never on its own.
        </p>
      </div>

      <div className="card card-pad" style={{ marginTop: 14 }}>
        <h3 className="title"><Icon name="sparkle" className="sm"/>Model</h3>
        <div className="mdq-bar" style={{ paddingTop: 0 }}>
          <span className={'stx-chip ' + (model.inferenceUp ? 'ok' : 'err')}>
            <Icon name={model.inferenceUp ? 'check' : 'close'} className="xs"/>
            {model.inferenceUp ? 'Inference up' : 'Inference down'}
          </span>
          <span className={'stx-chip ' + (model.circuit === 'OPEN' ? 'err' : 'ok')}>Circuit {humanEnum(model.circuit) || 'unknown'}</span>
          <span className={'stx-chip ' + (model.trainingUp ? 'ok' : 'plain')}>{model.trainingUp ? 'Training service up' : 'Training service unreachable'}</span>
          {model.registryInSync === false && <span className="stx-chip warn">Registry out of sync</span>}
        </div>

        <div className="mdq-kpis">
          {/* residentVersion is dropped from the payload when null, so an absent
              key means "the container never told us", not "version none". */}
          <Kpi value={model.residentVersion || '—'} label="Version the container is serving"
            tone={model.residentVersion ? '' : 'warn'}
            title={model.residentVersion ? undefined : 'The inference container did not report a version.'}/>
          {/* activeVersion is only added to the payload when an ACTIVE row
              exists, so its absence is a fact worth showing, not a blank. */}
          <Kpi value={model.activeVersion?.version || '—'} label="ACTIVE in the registry"
            tone={model.activeVersion ? '' : 'warn'}
            title={model.activeVersion ? undefined : 'No version is marked ACTIVE in the registry.'}/>
          <Kpi value={count(model.calls)} label="Inference calls"/>
          <Kpi value={count(model.failures)} label="Failures" tone={model.failures > 0 ? 'warn' : 'good'}/>
          <Kpi value={`${count(model.avgLatencyMs)} ms`} label="Average latency"/>
        </div>

        {model.registryInSync === false && (
          <p className="stx-note warn"><Icon name="alert"/>
            The container is serving a different model than the registry's ACTIVE row. Until they agree, the scores on
            this board and the version stamped on new cases describe two different classifiers.
          </p>
        )}
        {/* Server text, shown verbatim — the reader is debugging a container. */}
        {model.inferenceError && <p className="stx-note err"><Icon name="alert"/>{model.inferenceError}</p>}
        {model.lastError && model.lastError !== model.inferenceError && (
          <p className="stx-note warn"><Icon name="clock"/>Last error seen: {model.lastError}</p>
        )}
        {model.activeVersion && (
          <p className="mdq-hint" style={{ marginTop: 10 }}>
            ACTIVE <b>{model.activeVersion.version}</b> · macro-F1 {model.activeVersion.macroF1 == null ? '—' : Number(model.activeVersion.macroF1).toFixed(3)} ·
            trained on {count(model.activeVersion.trainingExamples)} examples · promoted {fmtWhen(model.activeVersion.promotedAt)}
          </p>
        )}
      </div>

      <div className="card card-pad" style={{ marginTop: 14 }}>
        <h3 className="title"><Icon name="book" className="sm"/>Training data</h3>
        <div className="mdq-kpis">
          <Kpi value={count(dataset.examples)} label="Labelled examples"/>
          <Kpi value={count(dataset.untrained)} label="Not yet in a trained version" tone={dataset.untrained > 0 ? 'warn' : ''}/>
          <Kpi value={count(dataset.goldenCases)} label="Golden regression cases"/>
        </div>
        <p className="mdq-hint" style={{ marginTop: 10 }}>
          Examples only reach the classifier through a retrain — adding one changes nothing until then. The Model tab
          is where a run is started; the blocklist is the instant lever.
        </p>
      </div>

      {labels.length > 0 && (
        <div className="card card-pad" style={{ marginTop: 14 }}>
          <h3 className="title"><Icon name="filter" className="sm"/>What the classifier is flagging</h3>
          <div className="mdq-labels">
            {labels.map(l => (
              <React.Fragment key={l.label}>
                <span className="mdq-label-n">{l.label}</span>
                <span className="mdq-label-bar" aria-hidden="true">
                  <span className="mdq-label-fill" style={{ width: pctW(l.avgScore) }}/>
                </span>
                <span className="mdq-label-v"><b>{score2(l.avgScore)}</b> <span className="muted">avg · {count(l.count)}</span></span>
              </React.Fragment>
            ))}
          </div>
          <p className="mdq-hint" style={{ marginTop: 10 }}>Average top score per head, over cases in this window.</p>
        </div>
      )}

      {sla.length > 0 && (
        <div className="card card-pad" style={{ marginTop: 14 }}>
          <h3 className="title"><Icon name="clock" className="sm"/>Held past the ceiling, by content type</h3>
          <div className="mdq-labels">
            {sla.map(s => {
              const ratio = s.total ? (Number(s.breached) || 0) / Number(s.total) : 0
              return (
                <React.Fragment key={s.entityType}>
                  <span className="mdq-label-n">{kindOf(s.entityType)}</span>
                  <span className="mdq-label-bar" aria-hidden="true">
                    <span className={'mdq-label-fill' + (ratio > 0 ? ' over' : '')} style={{ width: pctW(ratio) }}/>
                  </span>
                  <span className="mdq-label-v">
                    <b>{count(s.breached)}</b> <span className="muted">of {count(s.total)} · {pct1(s.withinSlaPercent)} within</span>
                  </span>
                </React.Fragment>
              )
            })}
          </div>
        </div>
      )}

      <div className="card card-pad" style={{ marginTop: 14 }}>
        <h3 className="title"><Icon name="list" className="sm"/>Volume by content type</h3>
        {byType.length === 0 ? (
          <p className="mdq-empty">Nothing was submitted for scoring in this window.</p>
        ) : (
          <>
            {byType.map(([key, statuses]) => (
              <div className="mdq-field" key={key}>
                <div className="mdq-field-h"><span className="mdq-field-n">{kindOf(key)}</span></div>
                <div className="mdq-meta">
                  {Object.entries(statuses).map(([status, n]) => (
                    <span key={status}>{humanEnum(status)} <b>{count(n)}</b></span>
                  ))}
                </div>
              </div>
            ))}
            {idleTypes > 0 && (
              <p className="mdq-hint" style={{ marginTop: 10 }}>
                {idleTypes} other content type{idleTypes === 1 ? '' : 's'} had no submissions in this window. The server
                sends an empty map for those, which is why they are not listed as zeroes.
              </p>
            )}
          </>
        )}
      </div>

      <div className="card card-pad" style={{ marginTop: 14 }}>
        <h3 className="title"><Icon name="info" className="sm"/>How to read this board</h3>
        <p className="muted text-sm">
          The window covers volume, band outcomes, label averages and the ceiling table. It does <b>not</b> cover the
          queue counts or the model health block — those are read live at request time.
        </p>
        <p className="muted text-sm" style={{ marginTop: 6 }}>
          Absent is not zero. The API omits every null field, so a missing resident version, a missing ACTIVE row and an
          empty status map all mean “not reported” rather than “none”. They are rendered as em dashes here, never as 0.
        </p>
        <p className="muted text-sm" style={{ marginTop: 6 }}>
          Timestamps arrive without a real timezone (a literal <code>Z</code> on a zoneless server clock) and are shown
          in this browser's local time. Treat a few hours of skew as possible when correlating with server logs.
        </p>
      </div>
    </>
  )
}

/* =========================================================
   The page
   ========================================================= */
const TABS = [
  { key: 'queue', label: 'Queue', icon: 'hourglass' },
  { key: 'metrics', label: 'Metrics', icon: 'trending' },
  { key: 'policy', label: 'Policy', icon: 'settings' },
  { key: 'model', label: 'Model', icon: 'sparkle' },
]

export function AdminModerationPage() {
  const [tab, setTab] = React.useState('queue')
  /* Counts live up here so the tab strip can carry the backlog even while the
     Metrics or Policy tab is on screen — the queue's own state is allowed to
     reset on a tab change (a queue is live; a stale list is worse than a
     refetch), but the FILTER is not, because retyping it every time would make
     the other tabs feel like a punishment. */
  const [counts, setCounts] = React.useState(null)
  const [filters, setFilters] = React.useState({
    status: 'IN_REVIEW', entityType: '', slaBreached: false, sort: 'risk', page: 0, pageSize: 50,
  })

  return (
    <div className="main wide">
      <div className="col-main">
        <div className="phead">
          <div>
            <h1>Moderation <span className="phead-ar" lang="ar" dir="rtl">الإشراف الآلي</span></h1>
            <p className="sub">
              Every text-bearing post, comment, question, answer and message is scored before anyone but its author can
              see it. This is where the cases the model would not decide alone come to a person.
            </p>
          </div>
        </div>

        <div className="mdq-tabs" role="tablist" aria-label="Moderation console">
          {TABS.map(t => (
            <button
              key={t.key} type="button" role="tab" id={`mdq-tab-${t.key}`}
              aria-selected={tab === t.key} aria-controls={`mdq-panel-${t.key}`}
              className={'mdq-tab' + (tab === t.key ? ' on' : '')}
              onClick={() => setTab(t.key)}
            >
              <Icon name={t.icon} className="xs"/>{t.label}
              {t.key === 'queue' && counts?.inReview > 0 && <span className="mdq-count">{count(counts.inReview)}</span>}
            </button>
          ))}
        </div>

        <div role="tabpanel" id={`mdq-panel-${tab}`} aria-labelledby={`mdq-tab-${tab}`}>
          {tab === 'queue' && <QueueTab filters={filters} setFilters={setFilters} onCounts={setCounts}/>}
          {tab === 'metrics' && <MetricsTab/>}
          {/* Both panels are self-contained and take no props: threshold tuning
              and the classifier's lifecycle each own their own reads, writes and
              step-up dance, and neither belongs in a queue's state. */}
          {tab === 'policy' && <ModerationPolicyPanel/>}
          {tab === 'model' && <ModerationModelPanel/>}
        </div>
      </div>
    </div>
  )
}
