/* =========================================================
   Moderation console — MODEL
   /api/v1/admin/moderation/model/**

   Two jobs on one screen, deliberately kept apart:

     TEACHING   the labelled dataset the classifier trains on, plus the golden
                set — a regression suite that is NEVER trained on and exists
                only so a bad model cannot be promoted quietly.
     OPERATING  the version registry: retrain, promote, shadow, roll back, and
                a probe that scores arbitrary text against the live container.

   The rules this file is written around:

   1. SAY WHY AN ACTION IS UNAVAILABLE. A greyed button with no explanation is
      how an operator ends up filing a bug against the backend. Only READY /
      SHADOW / RETIRED can be promoted; a retrain refuses while one is running.
      Both are stated on screen, next to the control they disable.
   2. THE SERVER'S REFUSALS ARE ALREADY GOOD COPY. TRAINING_ALREADY_RUNNING,
      TRAINING_DATASET_TOO_SMALL, TRAINING_SERVICE_UNAVAILABLE,
      MODEL_NOT_PROMOTABLE and MODEL_GATE_FAILED carry precise, actionable
      messages. This panel adds a heading so the code is legible at a glance
      and then prints the server's sentence verbatim. It never rewrites one.
   3. FORCE IS A SECOND DECISION. `force: true` on a promote overrides a FAILED
      evaluation gate. It is never the default click and never a checkbox left
      lying around — it lives behind its own confirm, after the gate has
      already refused once.
   4. CHAT AND DM TEXT CANNOT BE TAUGHT. Private message bodies are withheld
      from staff by policy and `teachModel` is a silent no-op for them. The
      note sits beside the "add an example" box, which is precisely where
      someone would otherwise paste a reported message to route around it.

   Roles worth remembering, because they surface as 403s rather than as a
   missing button: the versions registry is ADMIN | ANALYST and refuses a
   MODERATOR, while the rest of this controller is ADMIN | MODERATOR with
   ADMIN-only deletes and golden-case writes.
   ========================================================= */
import React from 'react'
import { api } from '../../api/index.js'
import {
  MODERATION_LABELS, MODEL_VERSION_STATUSES, TRAINING_SOURCES, goldenLabelsOf,
} from '../../api/moderation.js'
import { Icon, showToast } from '../ui.jsx'
import { Loader } from '../states.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { Field, SubHead, fmtWhen, humanEnum, runStepUp } from '../settings/shared.jsx'

/* Only these three can be promoted (ModelVersionStatus). Kept as a set here
   rather than re-derived per row so the disabled state and the sentence that
   explains it can never drift apart. */
const PROMOTABLE = new Set(['READY', 'SHADOW', 'RETIRED'])

/* Statuses a shadow deployment should not be given without a second thought.
   The endpoint has NO status precondition — a FAILED artifact can be pushed
   into SHADOW and will start scoring live traffic — so the guard is ours. */
const SHADOW_NEEDS_CONFIRM = new Set(['TRAINING', 'EVALUATING', 'FAILED'])

/* Chip tone per lifecycle state. ACTIVE is the one users are being judged by;
   FAILED and TRAINING are the two that mean "not yet a candidate". */
const STATUS_TONE = {
  ACTIVE: 'ok', READY: 'info', SHADOW: 'info',
  TRAINING: 'warn', EVALUATING: 'warn',
  FAILED: 'err', RETIRED: 'plain',
}

/* A heading per known refusal, so the operator can see WHICH failure this is
   without parsing the sentence. The sentence itself is always the server's. */
const ERROR_HEADING = {
  TRAINING_ALREADY_RUNNING: 'A training run is already in progress',
  TRAINING_DATASET_TOO_SMALL: 'The dataset is too small to train on',
  TRAINING_SERVICE_UNAVAILABLE: 'The training service is unreachable',
  INFERENCE_UNAVAILABLE: 'The inference service is unreachable',
  MODEL_NOT_PROMOTABLE: 'This version cannot be promoted',
  MODEL_GATE_FAILED: 'This version failed the promotion gate',
  MODEL_VERSION_NOT_FOUND: 'That version is not in the registry',
  INVALID_TRAINING_EXAMPLE: 'That example was rejected',
}

/** The server's copy, with a heading when we recognise the code. Never edits
 *  the message — these sentences are written to be shown. */
function ActionError({ err, fallback = 'That did not work.', hint }) {
  if (!err) return null
  const heading = ERROR_HEADING[err.code]
  return (
    <div className="stx-note err" role="alert">
      <Icon name="alert" className="xs"/>
      <span>
        {heading && <><b>{heading}.</b>{' '}</>}
        {err.message || err.code || fallback}
        {hint && <><br/><span className="text-xs">{hint}</span></>}
      </span>
    </div>
  )
}

/** 403 on this controller is a ROLE, never an expired session (http.js has
 *  already refreshed and retried by the time we see one). */
const denied = (e) => e?.status === 403 && e?.code !== 'STEP_UP_REQUIRED'

const f3 = (v) => (v == null ? '—' : Number(v).toFixed(3))

/** The six classifier heads as tick boxes. Values stay a plain
 *  {label: bool} map — `labelsTo()` inside the API module coerces it to the
 *  exact wire keys, which matters because the training writer does NO alias
 *  lookup and would silently store 0 for `identity_attack`. */
function LabelTicks({ value, onChange, disabled, name }) {
  return (
    <div className="flex gap-12 mt-8" style={{ flexWrap: 'wrap' }}>
      {MODERATION_LABELS.map(label => (
        <label key={label} className="flex-c gap-6 text-sm" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox" className="stx-tick" disabled={disabled}
            checked={!!value[label]}
            aria-label={`${name} — ${label}`}
            onChange={() => onChange({ ...value, [label]: !value[label] })}
          />
          <span style={{ fontFamily: 'var(--mono)' }}>{label}</span>
        </label>
      ))}
    </div>
  )
}

/** Read-only echo of a stored row's labels. An example with every head at 0 is
 *  a NEGATIVE example, not a broken row — say so rather than showing nothing. */
function LabelChips({ labels }) {
  const on = MODERATION_LABELS.filter(l => Number(labels?.[l] || 0) > 0)
  if (!on.length) return <span className="stx-chip ok">clean example</span>
  return <>{on.map(l => <span key={l} className="stx-chip err">{l}</span>)}</>
}

const emptyLabels = () => Object.fromEntries(MODERATION_LABELS.map(l => [l, false]))

/* =========================================================
   §1 registry — versions and the four lifecycle actions
   ========================================================= */
function Registry({ datasetTotal }) {
  const [items, setItems] = React.useState([])
  const [total, setTotal] = React.useState(0)
  const [health, setHealth] = React.useState(null)
  const [page, setPage] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [loadErr, setLoadErr] = React.useState(null)
  const [busy, setBusy] = React.useState('')            // '' | 'retrain' | 'rollback' | 'refresh' | <version id>
  const [actionErr, setActionErr] = React.useState(null)
  const [errFor, setErrFor] = React.useState('')        // which action produced actionErr
  const [gateBlocked, setGateBlocked] = React.useState(null)   // id whose promote hit MODEL_GATE_FAILED
  const [notes, setNotes] = React.useState('')
  const [baseVersion, setBaseVersion] = React.useState('')

  const load = React.useCallback(async (nextPage = 0, append = false) => {
    setLoading(true); setLoadErr(null)
    try {
      const res = await api.moderation.model.versions({ page: nextPage })
      setItems(prev => (append ? [...prev, ...res.items] : res.items))
      setTotal(res.totalElements || 0)
      setHealth(res.health || null)
      setPage(nextPage)
    } catch (e) {
      setLoadErr(e)
      if (!append) setItems([])
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { load(0, false) }, [load])

  /* A run in flight is the one obstacle we can see from here, and it is the
     commonest reason a retrain is refused — so the button says so instead of
     making the operator discover it through a 400. */
  const running = items.find(v => v.status === 'TRAINING' || v.status === 'EVALUATING')

  const wrap = async (key, fn, okMsg) => {
    setBusy(key); setActionErr(null); setErrFor(''); setGateBlocked(null)
    try {
      const res = await fn()
      if (res === undefined) return undefined       // step-up cancelled
      if (okMsg) showToast(okMsg, 'ok')
      await load(0, false)
      return res
    } catch (e) {
      setActionErr(e); setErrFor(key)
      return undefined
    } finally {
      setBusy('')
    }
  }

  const retrain = () => wrap('retrain',
    () => runStepUp(() => api.moderation.model.retrain({ baseVersion, notes })),
    /* 202 with a placeholder row (`job-<jobId>`, status TRAINING) — a receipt,
       not a model. The list reload below is what will eventually show the real
       version, which is why the toast promises a job and not a result. */
    'Training job accepted — the registry will show the version when it lands')

  const refresh = () => wrap('refresh', async () => {
    const res = await api.moderation.model.retrainRefresh()
    /* `settled` counts jobs that reached a terminal state ON THIS CALL, so 0
       means "nothing new", never "nothing running". */
    showToast(res?.settled ? `${res.settled} job${res.settled === 1 ? '' : 's'} settled` : 'No job finished since the last check', 'ok')
    return res
  })

  const rollback = async () => {
    const ok = await uiConfirm({
      title: 'Roll back to the previous model?',
      message: 'This re-promotes the most recently retired version that was once active, '
        + 'overriding its evaluation gate. Live scoring changes the moment the container reloads.',
      confirmLabel: 'Roll back',
      danger: true,
      icon: 'refresh',
    })
    if (!ok) return
    wrap('rollback', () => runStepUp(() => api.moderation.model.rollback()), 'Rolled back')
  }

  const promote = async (v, force) => {
    if (force) {
      const ok = await uiConfirm({
        title: `Promote ${v.version} anyway?`,
        message: 'This version did not clear the promotion gate. Forcing it makes it the '
          + 'model every piece of content on the platform is judged by, with an evaluation '
          + 'that already failed. Do this only if you know why the gate is wrong.',
        confirmLabel: 'Override the gate',
        danger: true,
        icon: 'alert',
      })
      if (!ok) return
    }
    /* Promote does not go through `wrap` because it is the one action whose
       FAILURE arms a second, deliberate path: the gate refusal has to be
       remembered against the row that was refused, so the override button
       appears there and nowhere else. Any other error clears it again. */
    setBusy(v.id); setActionErr(null); setErrFor(''); setGateBlocked(null)
    try {
      const res = await runStepUp(() => api.moderation.model.promote(v.id, { force: !!force }))
      if (res === undefined) return                 // step-up cancelled
      showToast(force ? `${v.version} promoted over a failed gate` : `${v.version} is now active`, 'ok')
      await load(0, false)
    } catch (e) {
      setActionErr(e); setErrFor(v.id)
      if (e?.code === 'MODEL_GATE_FAILED') setGateBlocked(v.id)
    } finally {
      setBusy('')
    }
  }

  const shadow = async (v) => {
    if (SHADOW_NEEDS_CONFIRM.has(v.status)) {
      const ok = await uiConfirm({
        title: `Shadow a ${humanEnum(v.status).toLowerCase()} version?`,
        message: 'Shadow mode scores live traffic in parallel with the active model. '
          + 'The endpoint accepts any status, including a failed or still-training artifact — '
          + 'its decisions are logged, never enforced, but the container will be asked to load it.',
        confirmLabel: 'Run in shadow',
        danger: true,
        icon: 'eye',
      })
      if (!ok) return
    }
    wrap(v.id, () => api.moderation.model.shadow(v.id), `${v.version} is running in shadow`)
  }

  /* Rollback's "not found" is not a missing id — it means there has never been
     a retired version to go back to, and the raw message reads like a bug. */
  const actionHint = errFor === 'rollback' && actionErr?.code === 'MODEL_VERSION_NOT_FOUND'
    ? 'Nothing to roll back to: no version has ever been retired.'
    : actionErr?.code === 'INFERENCE_UNAVAILABLE'
      ? 'The container reload is attempted before the registry is changed, so nothing was promoted.'
      : undefined

  if (loading && !items.length && !loadErr) return <Loader label="Reading the model registry…"/>

  return (
    <section className="card card-pad">
      <h3 className="title"><Icon name="sparkle" className="sm"/>Model registry</h3>
      <p className="stx-sub">
        Every trained artifact and where it sits in its lifecycle. Exactly one version is
        ACTIVE — that is the one scoring content right now.
      </p>

      {loadErr && (
        <ActionError
          err={loadErr}
          fallback="Could not read the registry."
          hint={denied(loadErr)
            ? 'The registry is restricted to ADMIN and ANALYST accounts — a moderator is refused here even though the training data below still loads.'
            : undefined}
        />
      )}

      {health && (
        <div className="flex gap-8 mt-12" style={{ flexWrap: 'wrap' }}>
          <span className={'stx-chip ' + (health.inferenceUp === false ? 'err' : 'ok')}>
            <Icon name={health.inferenceUp === false ? 'alert' : 'check'} className="xs"/>
            {health.inferenceUp === false ? 'Inference down' : 'Inference up'}
          </span>
          <span className={'stx-chip ' + (health.trainingUp === false ? 'err' : 'plain')}>
            {health.trainingUp === false ? 'Trainer down' : 'Trainer up'}
          </span>
          {health.residentVersion && <span className="stx-chip plain">Serving {health.residentVersion}</span>}
          {health.registryInSync === false && (
            <span className="stx-chip warn" title="The container is serving a different artifact from the one the registry calls ACTIVE.">
              Registry out of sync
            </span>
          )}
          {health.avgLatencyMs != null && <span className="stx-chip plain">~{health.avgLatencyMs} ms</span>}
        </div>
      )}

      {/* ---- retrain / refresh / rollback ---- */}
      <SubHead>Train a new version</SubHead>
      <div className="flex gap-16" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 200px' }}>
          <Field label="Base checkpoint (optional)" hint="Empty starts from the current ACTIVE version.">
            <input className="field" value={baseVersion} maxLength={40}
              onChange={e => setBaseVersion(e.target.value)} placeholder="v3"/>
          </Field>
        </div>
        <div style={{ flex: '2 1 300px' }}>
          <Field label="Notes (optional)" hint="Why this run exists. Stored on the version row.">
            <input className="field" value={notes} maxLength={500}
              onChange={e => setNotes(e.target.value)} placeholder="added 40 threat examples"/>
          </Field>
        </div>
      </div>

      {/* Both obstacles are stated before the click, and neither hides the
          button: the server owns the real decision (the minimum example count
          is configurable, so our number is a prediction, not the rule). */}
      {running && (
        <p className="stx-note warn">
          <Icon name="hourglass" className="xs"/>
          <span>
            {running.version} is {humanEnum(running.status).toLowerCase()}. A second run is refused
            until it settles — use <b>Check for finished jobs</b> if you think it is already done.
          </span>
        </p>
      )}
      {datasetTotal != null && datasetTotal < 20 && (
        <p className="stx-note warn">
          <Icon name="alert" className="xs"/>
          <span>
            The dataset holds {datasetTotal} example{datasetTotal === 1 ? '' : 's'}. The server refuses a
            run below its configured minimum, which defaults to 20 — add examples below first.
          </span>
        </p>
      )}

      <div className="mdq-acts">
        <button type="button" className="btn btn-primary btn-sm"
          disabled={!!busy || !!running} onClick={retrain}>
          <Icon name="sparkle" className="xs"/>{busy === 'retrain' ? 'Starting…' : 'Retrain'}
        </button>
        <button type="button" className="btn btn-secondary btn-sm"
          disabled={!!busy} onClick={refresh}>
          <Icon name="refresh" className="xs"/>{busy === 'refresh' ? 'Checking…' : 'Check for finished jobs'}
        </button>
        <span className="mdq-bar-sp"/>
        <button type="button" className="btn btn-danger btn-sm"
          disabled={!!busy} onClick={rollback}>
          <Icon name="chevleft" className="xs"/>{busy === 'rollback' ? 'Rolling back…' : 'Roll back'}
        </button>
      </div>
      <p className="stx-hint">
        Retrain, promote and roll back all ask you to confirm it is you. Shadow does not —
        it changes nothing that is enforced.
      </p>

      <ActionError err={actionErr} fallback="The registry action failed." hint={actionHint}/>

      {/* ---- the versions ---- */}
      <SubHead>Versions</SubHead>
      {!items.length && !loadErr ? (
        <p className="mdq-empty">No versions yet. The first retrain creates one.</p>
      ) : items.map(v => {
        const blocked = PROMOTABLE.has(v.status) ? null
          : `Only READY, SHADOW or RETIRED versions can be promoted; this one is ${v.status}.`
        const gateFailed = v.gatePassed === false
        return (
          <div className="mdq-ver" key={v.id}>
            <div>
              <div className="flex-c gap-8" style={{ flexWrap: 'wrap' }}>
                <span className="mdq-ver-n">{v.version}</span>
                <span className={'stx-chip ' + (STATUS_TONE[v.status] || 'plain')}>{v.status}</span>
                {v.gatePassed === true && <span className="stx-chip ok">gate passed</span>}
                {gateFailed && <span className="stx-chip err">gate failed</span>}
              </div>
              <div className="mdq-ver-m">
                macro-F1 {f3(v.macroF1)} · {v.trainingExamples ?? 0} train / {v.validationCount ?? 0} validation
                {/* Timestamps carry a literal Z bolted onto a zoneless server
                    clock, so they are rendered as local time on the same
                    assumption the rest of the app makes. */}
                {v.trainedAt && <> · trained {fmtWhen(v.trainedAt)}</>}
                {v.promotedAt && <> · promoted {fmtWhen(v.promotedAt)}</>}
              </div>
              {v.gateDetail && <div className="mdq-ver-m">{v.gateDetail}</div>}
              {v.notes && <div className="mdq-ver-m">{v.notes}</div>}
              {v.error && <div className="mdq-ver-m" style={{ color: 'var(--ox-red)' }}>{v.error}</div>}
              {/* The reason lives next to the row, not inside a tooltip: a
                  disabled button with no explanation reads as a broken screen. */}
              {blocked && <div className="mdq-ver-m">{blocked}</div>}
              {gateBlocked === v.id && (
                <div className="mdq-ver-m">
                  The gate refused this version. <b>Promote anyway</b> overrides that decision.
                </div>
              )}
            </div>
            <div className="flex gap-8" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary btn-sm"
                disabled={!!busy || v.status === 'SHADOW'}
                title={v.status === 'SHADOW' ? 'Already running in shadow' : 'Score live traffic without enforcing it'}
                onClick={() => shadow(v)}>
                <Icon name="eye" className="xs"/>Shadow
              </button>
              <button type="button" className="btn btn-primary btn-sm"
                disabled={!!busy || !!blocked}
                title={blocked || 'Make this the model that scores content'}
                onClick={() => promote(v, false)}>
                <Icon name="check" className="xs"/>{busy === v.id ? 'Working…' : 'Promote'}
              </button>
              {/* Only after the gate has actually refused, and only on that row. */}
              {gateBlocked === v.id && (
                <button type="button" className="btn btn-danger btn-sm"
                  disabled={!!busy} onClick={() => promote(v, true)}>
                  <Icon name="alert" className="xs"/>Promote anyway
                </button>
              )}
            </div>
          </div>
        )
      })}

      {items.length > 0 && items.length < total && (
        <div className="mdq-acts">
          <button type="button" className="btn btn-secondary btn-sm"
            disabled={loading} onClick={() => load(page + 1, true)}>
            {loading ? 'Loading…' : `Show more (${items.length} of ${total})`}
          </button>
        </div>
      )}
    </section>
  )
}

/* =========================================================
   §2 score probe — what does the live model think of this text?
   ========================================================= */
function ScoreProbe() {
  const [text, setText] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState(null)
  const [err, setErr] = React.useState(null)

  const probe = async () => {
    if (!text.trim()) return
    setBusy(true); setErr(null); setResult(null)
    try {
      setResult(await api.moderation.model.scoreProbe(text))
    } catch (e) {
      setErr(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card card-pad mt-16">
      <h3 className="title"><Icon name="search" className="sm"/>Score probe</h3>
      <p className="stx-sub">
        Runs one piece of text through the live model. No case is created, nothing is
        stored, and the text is not added to any dataset — this only tells you what the
        classifier currently thinks.
      </p>

      <textarea
        className="field" rows={3} value={text} maxLength={5000}
        aria-label="Text to score"
        placeholder="Paste the text to score…"
        onChange={e => setText(e.target.value)}
        style={{ width: '100%' }}
      />
      <div className="mdq-acts">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !text.trim()} onClick={probe}>
          <Icon name="play" className="xs"/>{busy ? 'Scoring…' : 'Score it'}
        </button>
        {/* The call has a 5s server-side budget; a down container is a 400, not
            a hang, so there is nothing to cancel and no retry loop to build. */}
        <span className="mdq-hint">Times out after five seconds.</span>
      </div>

      <ActionError err={err} fallback="The probe failed."/>

      {result && (
        <div className="mt-12" aria-live="polite">
          <div className="mdq-ver-m">
            {result.modelVersion || 'unknown version'}
            {result.inferenceMs != null && <> · {Number(result.inferenceMs).toFixed(1)} ms in the container</>}
          </div>
          <div className="mdq-labels">
            {MODERATION_LABELS.map(label => {
              const v = Number(result.scores?.[label] ?? 0)
              return (
                <React.Fragment key={label}>
                  <span className="mdq-label-n">{label}</span>
                  <span className="mdq-label-bar">
                    <span className="mdq-label-fill" style={{ width: `${Math.min(100, v * 100)}%` }}/>
                  </span>
                  <span className="mdq-label-v">{v.toFixed(3)}</span>
                </React.Fragment>
              )
            })}
          </div>
          <p className="stx-hint">
            Raw scores only. Whether a score means approve, review or block depends on the
            band configured for the entity type — see the Policy tab.
          </p>
        </div>
      )}
    </section>
  )
}

/* =========================================================
   §3 training data — the labelled dataset
   ========================================================= */
function TrainingData({ onSummary }) {
  const [items, setItems] = React.useState([])
  const [total, setTotal] = React.useState(0)
  const [summary, setSummary] = React.useState(null)
  const [source, setSource] = React.useState('')
  const [page, setPage] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [loadErr, setLoadErr] = React.useState(null)

  const [text, setText] = React.useState('')
  const [labels, setLabels] = React.useState(emptyLabels)
  const [note, setNote] = React.useState('')
  const [word, setWord] = React.useState('')
  const [wordLabels, setWordLabels] = React.useState(emptyLabels)
  const [busy, setBusy] = React.useState('')
  const [writeErr, setWriteErr] = React.useState(null)
  const [wordNote, setWordNote] = React.useState(null)

  const load = React.useCallback(async (nextPage, nextSource, append) => {
    setLoading(true); setLoadErr(null)
    try {
      const res = await api.moderation.model.trainingExamples({ source: nextSource || undefined, page: nextPage })
      setItems(prev => (append ? [...prev, ...res.items] : res.items))
      setTotal(res.totalElements || 0)
      setPage(nextPage)
      if (res.summary) { setSummary(res.summary); onSummary?.(res.summary) }
    } catch (e) {
      setLoadErr(e)
      if (!append) setItems([])
    } finally {
      setLoading(false)
    }
  }, [onSummary])

  React.useEffect(() => { load(0, source, false) }, [load, source])

  const addExample = async () => {
    if (!text.trim()) return
    setBusy('example'); setWriteErr(null)
    try {
      await api.moderation.model.addTrainingExample({ text, labels, note })
      /* Dedup is on a normalised hash of the text, so re-posting a sentence
         UPDATES its labels and clears `trainedInVersion` instead of creating a
         second row. The toast says "saved", never "added". */
      showToast('Example saved', 'ok')
      setText(''); setLabels(emptyLabels()); setNote('')
      load(0, source, false)
    } catch (e) {
      setWriteErr(e)
    } finally {
      setBusy('')
    }
  }

  const addWord = async () => {
    if (!word.trim()) return
    setBusy('word'); setWriteErr(null); setWordNote(null)
    try {
      /* No `note`: the only note input on this screen belongs to the "add an
         example" form above. Sending it here stamped an unrelated sentence's
         note onto all three generated word rows AND suppressed the server's own
         default note — which is the one that tells you to add the word to the
         blocklist too if you want it banned instantly. */
      const res = await api.moderation.model.addWord({ word, labels: wordLabels })
      setWordNote(res?.note || null)                    // the server's own "…add it to the blocklist as well"
      showToast(`${res?.created?.length || 0} sentences generated`, 'ok')
      setWord(''); setWordLabels(emptyLabels())
      load(0, source, false)
    } catch (e) {
      setWriteErr(e)
    } finally {
      setBusy('')
    }
  }

  const remove = async (row) => {
    const ok = await uiConfirm({
      title: 'Remove this example?',
      message: 'It stops influencing the next retrain. Models already trained on it are unaffected.',
      confirmLabel: 'Remove', danger: true, icon: 'trash',
    })
    if (!ok) return
    setBusy(row.id); setWriteErr(null)
    try {
      await api.moderation.model.removeTrainingExample(row.id)
      /* A delete answers 204 even for an id that was never there, so the list
         is re-read rather than patched — 204 is not proof. */
      load(0, source, false)
    } catch (e) {
      setWriteErr(e)
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="card card-pad mt-16">
      <h3 className="title"><Icon name="book" className="sm"/>Training data</h3>
      <p className="stx-sub">
        The labelled sentences the next retrain learns from. Nothing here changes how
        content is scored until a new version is trained and promoted.
      </p>

      {summary && (
        <div className="mdq-kpis">
          <div className="mdq-kpi">
            <div className="mdq-kpi-v">{summary.total ?? 0}</div>
            <div className="mdq-kpi-k">examples</div>
          </div>
          <div className={'mdq-kpi ' + ((summary.untrained ?? 0) > 0 ? 'warn' : '')}>
            <div className="mdq-kpi-v">{summary.untrained ?? 0}</div>
            <div className="mdq-kpi-k">not yet trained on</div>
          </div>
          <div className="mdq-kpi">
            <div className="mdq-kpi-v">{summary.goldenCases ?? 0}</div>
            <div className="mdq-kpi-k">golden cases</div>
          </div>
        </div>
      )}
      {summary?.labelTotals && (
        <p className="stx-hint">
          By label: {MODERATION_LABELS.map(l => `${l} ${summary.labelTotals[l] ?? 0}`).join(' · ')}
        </p>
      )}

      {/* ---- add one example ---- */}
      <SubHead>Add an example</SubHead>

      {/* This is the exact spot where someone reaches for a reported DM. */}
      <p className="stx-note info">
        <Icon name="lock" className="xs"/>
        <span>
          Chat and direct-message bodies never enter the training set by policy — staff cannot
          even read them in the review queue, and marking a chat case &ldquo;teach the model&rdquo;
          is a silent no-op. Do not paste message text here to work around that.
        </span>
      </p>

      <textarea
        className="field" rows={3} value={text} maxLength={5000}
        aria-label="Example text"
        placeholder="A sentence the model should learn from…"
        onChange={e => setText(e.target.value)}
        style={{ width: '100%' }}
      />
      <LabelTicks value={labels} onChange={setLabels} name="Example labels" disabled={!!busy}/>
      <p className="stx-hint">
        Leave every box unticked to teach a <b>clean</b> example — negatives matter as much as
        positives. Re-adding a sentence that already exists updates its labels instead of
        duplicating it, and puts it back in the untrained pool.
      </p>
      <div className="mt-12">
        <Field label="Note (optional)" hint="Why this example exists. Shown in the list below.">
          <input className="field" value={note} maxLength={300}
            onChange={e => setNote(e.target.value)} placeholder="from case 0f9c…"/>
        </Field>
      </div>
      <div className="mdq-acts">
        <button type="button" className="btn btn-primary btn-sm"
          disabled={!!busy || !text.trim()} onClick={addExample}>
          <Icon name="compose" className="xs"/>{busy === 'example' ? 'Saving…' : 'Add example'}
        </button>
      </div>

      {/* ---- add a word ---- */}
      <SubHead>Add a word</SubHead>
      <p className="stx-sub">
        The server expands one word into short template sentences and stores all of them, so a
        single term produces usable training signal instead of a one-word fragment.
      </p>
      <div className="flex gap-16" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 240px' }}>
          <Field label="Word" hint="One term. It is expanded, not matched.">
            <input className="field" value={word} maxLength={100}
              onChange={e => setWord(e.target.value)}/>
          </Field>
        </div>
      </div>
      <LabelTicks value={wordLabels} onChange={setWordLabels} name="Word labels" disabled={!!busy}/>
      <div className="mdq-acts">
        <button type="button" className="btn btn-secondary btn-sm"
          disabled={!!busy || !word.trim()} onClick={addWord}>
          <Icon name="hash" className="xs"/>{busy === 'word' ? 'Expanding…' : 'Add word'}
        </button>
        <span className="mdq-hint">A word only changes behaviour after the next retrain.</span>
      </div>
      {wordNote && (
        <p className="stx-note info">
          <Icon name="info" className="xs"/>
          <span>{wordNote}</span>
        </p>
      )}

      <ActionError
        err={writeErr}
        fallback="That write failed."
        hint={denied(writeErr) ? 'Removing an example is ADMIN-only; adding one is open to moderators.' : undefined}
      />

      {/* ---- the dataset ---- */}
      <SubHead>Stored examples</SubHead>
      <div className="mdq-bar">
        <select className="field" aria-label="Filter by source" value={source}
          onChange={e => setSource(e.target.value)}>
          <option value="">Every source</option>
          {TRAINING_SOURCES.map(s => <option key={s} value={s}>{humanEnum(s)}</option>)}
        </select>
        <span className="mdq-hint">{total} example{total === 1 ? '' : 's'}{source ? ' from this source' : ''}</span>
      </div>

      {loadErr && <ActionError err={loadErr} fallback="Could not read the dataset."/>}

      {!items.length && !loading && !loadErr ? (
        <p className="mdq-empty">Nothing stored under this filter.</p>
      ) : items.map(row => (
        <div className="mdq-field" key={row.id}>
          <div className="mdq-field-h" style={{ flexWrap: 'wrap' }}>
            <LabelChips labels={row.labels}/>
            <span className="stx-chip plain">{humanEnum(row.source)}</span>
            {/* No `trainedInVersion` means no model has seen it yet — that is the
                queue the retrain will consume, so it is worth calling out. */}
            {!row.trainedInVersion && <span className="stx-chip warn">untrained</span>}
            <span className="mdq-bar-sp"/>
            <button type="button" className="btn btn-ghost btn-sm"
              disabled={busy === row.id} onClick={() => remove(row)}
              aria-label="Remove this example">
              <Icon name="trash" className="xs"/>
            </button>
          </div>
          <p className="mdq-text">{row.text}</p>
          <div className="mdq-ver-m">
            {row.trainedInVersion ? `trained in ${row.trainedInVersion}` : 'awaiting the next run'}
            {row.addedAt && <> · added {fmtWhen(row.addedAt)}</>}
            {row.note && <> · {row.note}</>}
          </div>
        </div>
      ))}

      {items.length > 0 && items.length < total && (
        <div className="mdq-acts">
          <button type="button" className="btn btn-secondary btn-sm"
            disabled={loading} onClick={() => load(page + 1, source, true)}>
            {loading ? 'Loading…' : `Show more (${items.length} of ${total})`}
          </button>
        </div>
      )}
    </section>
  )
}

/* =========================================================
   §4 golden cases — the regression suite
   ========================================================= */
const GOLDEN_PAGE = 50

function GoldenCases() {
  const [items, setItems] = React.useState([])
  const [page, setPage] = React.useState(0)
  const [maybeMore, setMaybeMore] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [loadErr, setLoadErr] = React.useState(null)
  const [text, setText] = React.useState('')
  const [labels, setLabels] = React.useState(emptyLabels)
  const [note, setNote] = React.useState('')
  const [busy, setBusy] = React.useState('')
  const [writeErr, setWriteErr] = React.useState(null)

  const load = React.useCallback(async (nextPage, append) => {
    setLoading(true); setLoadErr(null)
    try {
      const rows = await api.moderation.model.goldenCases({ page: nextPage, pageSize: GOLDEN_PAGE })
      setItems(prev => (append ? [...prev, ...rows] : rows))
      setPage(nextPage)
      /* A bare array with no total: "is there another page?" can only be
         inferred from this one being full. A full last page shows the button
         and an empty next page retires it — honest, if occasionally one click
         longer than necessary. */
      setMaybeMore(rows.length === GOLDEN_PAGE)
    } catch (e) {
      setLoadErr(e)
      if (!append) setItems([])
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { load(0, false) }, [load])

  const add = async () => {
    if (!text.trim()) return
    setBusy('add'); setWriteErr(null)
    try {
      await api.moderation.model.addGoldenCase({ text, labels, note })
      showToast('Golden case saved', 'ok')
      setText(''); setLabels(emptyLabels()); setNote('')
      load(0, false)
    } catch (e) {
      setWriteErr(e)
    } finally {
      setBusy('')
    }
  }

  const remove = async (row) => {
    const ok = await uiConfirm({
      title: 'Remove this golden case?',
      message: 'The promotion gate stops checking for this behaviour. A future model could '
        + 'regress on it without anything noticing.',
      confirmLabel: 'Remove', danger: true, icon: 'trash',
    })
    if (!ok) return
    setBusy(row.id); setWriteErr(null)
    try {
      await api.moderation.model.removeGoldenCase(row.id)
      load(0, false)
    } catch (e) {
      setWriteErr(e)
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="card card-pad mt-16">
      <h3 className="title"><Icon name="shield" className="sm"/>Golden cases</h3>
      {/* The distinction is the whole point of the section, so it is the first
          sentence rather than a footnote under the list. */}
      <p className="stx-sub">
        A held-out regression suite. Golden cases are <b>never trained on</b> — the promotion
        gate scores a freshly trained version against them, and a version that gets these
        wrong fails the gate before it can reach live traffic. Put the mistakes you never
        want to see again here, not in the training data above.
      </p>

      <SubHead>Add a golden case</SubHead>
      <textarea
        className="field" rows={3} value={text} maxLength={5000}
        aria-label="Golden case text"
        placeholder="Text whose verdict must not regress…"
        onChange={e => setText(e.target.value)}
        style={{ width: '100%' }}
      />
      <LabelTicks value={labels} onChange={setLabels} name="Golden case labels" disabled={!!busy}/>
      <p className="stx-hint">
        Tick what the correct answer <em>is</em>. An untouched row means the model must call
        this text clean — the false-positive half of the suite, and the half people forget.
      </p>
      <div className="mt-12">
        <Field label="Note (optional)" hint="What regression this case guards against.">
          <input className="field" value={note} maxLength={300}
            onChange={e => setNote(e.target.value)}/>
        </Field>
      </div>
      <div className="mdq-acts">
        <button type="button" className="btn btn-primary btn-sm"
          disabled={!!busy || !text.trim()} onClick={add}>
          <Icon name="compose" className="xs"/>{busy === 'add' ? 'Saving…' : 'Add golden case'}
        </button>
        <span className="mdq-hint">Re-adding the same text updates the existing case rather than duplicating it.</span>
      </div>

      <ActionError
        err={writeErr}
        fallback="That write failed."
        hint={denied(writeErr) ? 'Golden-case writes are ADMIN-only; moderators can read the suite but not change it.' : undefined}
      />

      <SubHead>The suite</SubHead>
      {loadErr && <ActionError err={loadErr} fallback="Could not read the golden set."/>}
      {!items.length && !loading && !loadErr ? (
        <p className="mdq-empty">No golden cases yet — nothing is guarding the next promote.</p>
      ) : items.map(row => (
        <div className="mdq-field" key={row.id}>
          <div className="mdq-field-h" style={{ flexWrap: 'wrap' }}>
            {/* The one place request and response disagree about label keys:
                you POST `identity_hate`, the entity answers `identityHate`. */}
            <LabelChips labels={goldenLabelsOf(row)}/>
            <span className="mdq-bar-sp"/>
            <button type="button" className="btn btn-ghost btn-sm"
              disabled={busy === row.id} onClick={() => remove(row)}
              aria-label="Remove this golden case">
              <Icon name="trash" className="xs"/>
            </button>
          </div>
          <p className="mdq-text">{row.text}</p>
          {(row.note || row.addedAt) && (
            <div className="mdq-ver-m">
              {row.addedAt && <>added {fmtWhen(row.addedAt)}</>}
              {row.note && <>{row.addedAt ? ' · ' : ''}{row.note}</>}
            </div>
          )}
        </div>
      ))}

      {items.length > 0 && maybeMore && (
        <div className="mdq-acts">
          <button type="button" className="btn btn-secondary btn-sm"
            disabled={loading} onClick={() => load(page + 1, true)}>
            {loading ? 'Loading…' : 'Show more'}
          </button>
        </div>
      )}
    </section>
  )
}

/* =========================================================
   The panel
   ========================================================= */
export function ModerationModelPanel() {
  /* The dataset summary is owned here so the registry can warn about a
     too-small dataset BEFORE a retrain is refused for it. It arrives from the
     training-examples response, which is the only endpoint that reports it. */
  const [summary, setSummary] = React.useState(null)

  return (
    <div>
      <Registry datasetTotal={summary?.total ?? null}/>
      <ScoreProbe/>
      <TrainingData onSummary={setSummary}/>
      <GoldenCases/>
      <p className="stx-hint mt-16">
        Statuses in this registry: {MODEL_VERSION_STATUSES.join(' · ')}. Promotion is only ever
        a human act — a retrain never promotes itself.
      </p>
    </div>
  )
}
