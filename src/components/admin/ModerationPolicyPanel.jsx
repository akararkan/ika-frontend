/* =========================================================
   Moderation console — POLICY
   GET  /api/v1/admin/moderation/settings
   GET  /api/v1/admin/moderation/settings/thresholds
   PUT  /api/v1/admin/moderation/settings/thresholds      ← step-up
   PUT  /api/v1/admin/moderation/settings/hold-durations  ← step-up
   POST /api/v1/admin/moderation/settings/dry-run         ← writes nothing

   This panel is the tuning bench for the decision engine: what counts as
   "needs a human", what counts as "block outright", how long a piece of
   content may sit unpublished while we decide, and what happens when the
   classifier is unreachable. Everything here is per ENTITY TYPE.

   Three things shape every decision in this file:

   1. THE WARNING IS THE HEADLINE. `GET /settings` may carry a `warning` —
      moderation switched off entirely, or the inference service not
      answering. That single string is the difference between "the policy
      below is in force" and "nothing is being scored at all", so it is
      rendered first, verbatim, and never paraphrased.
   2. THE DRY RUN IS WHY THIS SCREEN IS SAFE. Nobody should discover the
      effect of a band by shipping it. `POST /dry-run` re-decides stored
      cases against a proposed band and writes nothing — it is a first-class
      button next to the editor, not a hidden expert mode. Its one trap is
      that `caseIds` has no "recent cases" default: sent empty it answers a
      confident, meaningless zero, so this panel samples real cases itself.
   3. THE SERVER IS THE SOURCE OF TRUTH AFTER A WRITE. `inlineMs` is NOT
      validated on write and is clamped at READ time, so a saved value can
      legitimately differ from the effective one. Every save re-reads the
      `effective` block instead of trusting the form.

   Casing: state is keyed on the UPPERCASE enum name (it matches ENTITY_LABEL
   in lib/moderation.js); every response map is keyed on the lowercase
   `key()` form. `entityTypeKey()` is the only bridge — do not hand-lowercase.
   ========================================================= */
import React from 'react'
import { api } from '../../api/index.js'
import {
  FALLBACK_POLICIES, MODERATED_ENTITY_TYPES, MODERATION_LABELS, MODERATION_STATUSES,
  entityTypeKey,
} from '../../api/moderation.js'
import { ENTITY_LABEL } from '../../lib/moderation.js'
import { Icon, showToast } from '../ui.jsx'
import { Loader, ErrorState } from '../states.jsx'
import { Field, Seg, SubHead, ToggleRow, runStepUp } from '../settings/shared.jsx'

/* The engine's own words for the two cut points (ModerationThresholds.Band):
   at/above `low` the content needs a human, at/above `high` it is auto-blocked,
   and below `low` it is approved inline. Printed on screen because a bare
   "0.30 / 0.80" means nothing to anyone who has not read the decision engine. */
const BAND_LOW_H = 'Review at ≥'
const BAND_HIGH_H = 'Block at ≥'

/* FallbackPolicy, in the enum's own terms — what happens to a unit whose hold
   window expires with no verdict (the model being down is the usual cause). */
const FALLBACK_COPY = {
  FAIL_CLOSED: 'Force review — the content stays hidden until a human looks at it.',
  FAIL_OPEN_SHADOW: 'Publish anyway, flagged for priority review and ready to retract.',
}

/* Server-side bounds, mirrored so the form refuses before the round trip.
   `holdMs` is genuinely validated on write; `inlineMs` is not (see header). */
const HOLD_MIN = 500
const HOLD_MAX = 600000

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/* Band inputs are held as STRINGS for as long as they are being typed. A
   controlled number input that round-trips through parseFloat eats the "0."
   a user is halfway through typing. Parsing happens once, at validate time. */
const num = (v) => (String(v ?? '').trim() === '' ? null : Number(v))
const fmtBand = (v) => (v == null ? '' : String(Math.round(Number(v) * 1000) / 1000))
const int = (v) => {
  const n = num(v)
  return n === null ? null : Math.trunc(n)
}

function bandsToDraft(bands) {
  const out = {}
  for (const label of MODERATION_LABELS) {
    const b = bands?.[label] || {}
    out[label] = { low: fmtBand(b.low), high: fmtBand(b.high) }
  }
  return out
}

/**
 * Client-side threshold validation, mirroring INVALID_THRESHOLD.
 *
 * A blank edge means "leave this one alone" — `low` and `high` are
 * independently optional on the wire and a single-ended patch is the supported
 * way to nudge one edge. That is also the reason the low/high comparison is
 * done against the value that would REMAIN IN FORCE rather than against the
 * other input: the server only compares the two when both arrive in the same
 * patch, so a one-edge edit can legally invert a band and nothing would say so.
 */
function validateBands(draft, current) {
  const problems = []
  const bad = new Set()
  for (const label of MODERATION_LABELS) {
    const d = draft[label] || {}
    const server = current?.[label] || {}
    const parsed = { low: num(d.low), high: num(d.high) }
    for (const edge of ['low', 'high']) {
      const v = parsed[edge]
      if (v === null) continue
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        problems.push(`${label} · ${edge}: must be a number between 0 and 1.`)
        bad.add(`${label}.${edge}`)
      }
    }
    const low = parsed.low ?? (server.low ?? null)
    const high = parsed.high ?? (server.high ?? null)
    if (Number.isFinite(low) && Number.isFinite(high) && high < low) {
      problems.push(`${label}: the block cut (${high}) sits below the review cut (${low}) — that band would auto-block everything it reviews.`)
      bad.add(`${label}.low`); bad.add(`${label}.high`)
    }
  }
  return { problems, bad }
}

/** Only the edges that actually moved. Sending an unchanged edge would mint a
 *  stored override row holding a value that was already inherited — a silent
 *  freeze of a default that should have stayed a default. */
function bandDiff(draft, current) {
  const labels = {}
  for (const label of MODERATION_LABELS) {
    const d = draft[label] || {}
    const server = current?.[label] || {}
    const patch = {}
    for (const edge of ['low', 'high']) {
      const v = num(d[edge])
      if (v === null || !Number.isFinite(v)) continue
      const was = server[edge]
      if (was == null || Math.abs(v - Number(was)) > 1e-9) patch[edge] = v
    }
    if (Object.keys(patch).length) labels[label] = patch
  }
  return labels
}

/** The dry run wants WHOLE bands, not the sparse patch a PUT wants: an edge
 *  left null there is ambiguous, and overriding an edge with the value it
 *  already has is a provable no-op. So every changed label is sent complete. */
function dryLabels(draft, current) {
  const changed = bandDiff(draft, current)
  const out = {}
  for (const label of Object.keys(changed)) {
    const d = draft[label] || {}
    const server = current?.[label] || {}
    out[label] = {
      low: num(d.low) ?? Number(server.low ?? 0),
      high: num(d.high) ?? Number(server.high ?? 1),
    }
  }
  return out
}

/** Hold/inline/fallback/enabled — again only what moved, because all four null
 *  is 400 "Unknown moderation setting key: (empty patch)", not a no-op. */
function holdDiff(draft, row) {
  const patch = {}
  const hold = int(draft.holdMs)
  const inline = int(draft.inlineMs)
  if (hold !== null && Number.isFinite(hold) && hold !== Number(row.holdMs)) patch.holdMs = hold
  if (inline !== null && Number.isFinite(inline) && inline !== Number(row.inlineMs)) patch.inlineMs = inline
  if (draft.fallback && draft.fallback !== row.fallback) patch.fallback = draft.fallback
  if (!!draft.enabled !== (row.enabled !== false)) patch.enabled = !!draft.enabled
  return patch
}

/** The server's read-time clamp on the inline budget, reproduced so the form
 *  can show what a number will ACTUALLY become before it is saved
 *  (ModerationSettingsService.inlineBudget). */
const effectiveInline = (inlineMs, holdMs) =>
  Math.max(100, Math.min(Number(inlineMs) || 0, Math.max(200, Math.floor((Number(holdMs) || 0) / 2))))

const shortId = (id) => String(id || '').slice(0, 8)
const pct = (v) => `${Math.round(Number(v || 0) * 100)}%`

/**
 * Sample real stored cases to dry-run against.
 *
 * `caseIds` is mandatory in practice — the endpoint has no "recent cases"
 * default and an empty list evaluates zero fields — so the button has to bring
 * its own corpus. One page per status because the queue's filters are an
 * if/else chain with no "any status" value; four pages of 100 stay under the
 * endpoint's 500-id cap. A status that errors contributes nothing rather than
 * failing the whole sample: a partial corpus still answers the question.
 */
async function sampleCaseIds(type) {
  const pages = await Promise.all(MODERATION_STATUSES.map(status =>
    api.moderation.review.list({ status, entityType: type, pageSize: 100 })
      .then(r => r.items || [])
      .catch(() => [])))
  const seen = new Set()
  for (const rowsOfStatus of pages) {
    for (const row of rowsOfStatus) if (row?.caseId) seen.add(row.caseId)
  }
  return Array.from(seen).slice(0, 500)
}

/* ---------------------------------------------------------
   Small read-only pieces
   --------------------------------------------------------- */

/** One stored-override marker. Staff need to know whether a number is a DB row
 *  somebody typed or a configuration default that will move with the deploy. */
function OverrideChip({ overrides, keyName }) {
  const value = overrides?.[keyName]
  if (value === undefined) return null
  return (
    <span className="stx-chip info" title={`Stored override: ${keyName} = ${value}`}>override</span>
  )
}

function ModelHealth({ model }) {
  if (!model) return null
  const up = model.inferenceUp !== false
  const active = model.activeVersion
  return (
    <div className="flex gap-8 mt-8" style={{ flexWrap: 'wrap' }}>
      <span className={'stx-chip ' + (up ? 'ok' : 'err')}>
        <Icon name={up ? 'check' : 'alert'} className="xs"/>
        {up ? 'Inference up' : 'Inference down'}
      </span>
      {/* An OPEN breaker means calls are being short-circuited, so the fallback
          policy below is what is actually deciding right now. */}
      <span className={'stx-chip ' + (model.circuit === 'OPEN' ? 'err' : 'plain')}>
        Circuit {model.circuit || '—'}
      </span>
      {model.residentVersion && <span className="stx-chip plain">Serving {model.residentVersion}</span>}
      {active?.version && (
        <span className="stx-chip plain">
          Registry {active.version}{active.macroF1 != null ? ` · F1 ${Number(active.macroF1).toFixed(3)}` : ''}
        </span>
      )}
      {model.registryInSync === false && (
        <span className="stx-chip warn" title="The container is serving a different artifact from the one the registry calls ACTIVE.">
          Registry out of sync
        </span>
      )}
      {model.lastError && <span className="stx-chip err" title={model.lastError}>Last error recorded</span>}
    </div>
  )
}

/* ---------------------------------------------------------
   The panel
   --------------------------------------------------------- */
export function ModerationPolicyPanel() {
  const [data, setData] = React.useState(null)
  const [loadErr, setLoadErr] = React.useState(null)
  const [type, setType] = React.useState('POST')
  const [scope, setScope] = React.useState('type')          // 'type' | 'global'
  const [bandDraft, setBandDraft] = React.useState(null)    // null ⇒ showing the server's values
  const [holdDraft, setHoldDraft] = React.useState(null)
  const [saving, setSaving] = React.useState('')            // '' | 'bands' | 'holds'
  const [bandErr, setBandErr] = React.useState(null)
  const [holdErr, setHoldErr] = React.useState(null)
  const [dryIds, setDryIds] = React.useState('')
  const [dry, setDry] = React.useState(null)
  const [dryErr, setDryErr] = React.useState(null)
  const [dryBusy, setDryBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoadErr(null)
    try {
      const res = await api.moderation.settings.get()
      setData(res || {})
      /* Deliberately does NOT clear the drafts. Both save handlers call load()
         to refresh overrides + model health, and a blanket clear here made
         saving one section throw away the other section's unsaved edits a
         moment later — worse, that section's Save then went disabled, so it
         read as "saved" when nothing had been sent. Each section already clears
         its own draft on its own success (and the entity-type switch clears
         both), which is every case that should reset one. */
    } catch (e) {
      setLoadErr(e)
    }
  }, [])

  React.useEffect(() => { load() }, [load])

  /* Switching entity type abandons the drafts on purpose: a band typed for
     `post` must never be saved against `research` because the select moved. */
  React.useEffect(() => {
    setBandDraft(null); setHoldDraft(null)
    setBandErr(null); setHoldErr(null)
    setDry(null); setDryErr(null)
  }, [type])

  if (loadErr) {
    return <ErrorState message={loadErr.message || 'Could not load the moderation policy.'} onRetry={load}/>
  }
  if (!data) return <Loader label="Reading the effective policy…"/>

  const eff = data.effective || {}
  const overrides = data.overrides || {}
  const typeKey = entityTypeKey(type)
  const row = eff.entityTypes?.[typeKey] || {}
  const serverBands = row.thresholds || {}
  const masterOn = eff.enabled !== false

  const bands = bandDraft || bandsToDraft(serverBands)
  const holds = holdDraft || {
    holdMs: row.holdMs == null ? '' : String(row.holdMs),
    inlineMs: row.inlineMs == null ? '' : String(row.inlineMs),
    fallback: row.fallback || FALLBACK_POLICIES[0],
    enabled: row.enabled !== false,
  }

  const { problems, bad } = validateBands(bands, serverBands)
  const bandPatch = bandDiff(bands, serverBands)
  const bandDirty = Object.keys(bandPatch).length > 0
  const holdPatch = holdDiff(holds, row)
  const holdDirty = Object.keys(holdPatch).length > 0
  const holdMsValue = int(holds.holdMs)
  const holdRangeBad = holdMsValue !== null
    && (!Number.isFinite(holdMsValue) || holdMsValue < HOLD_MIN || holdMsValue > HOLD_MAX)

  const setBand = (label, edge, value) => {
    setBandErr(null)
    setBandDraft({ ...bands, [label]: { ...bands[label], [edge]: value } })
  }
  const setHold = (key, value) => {
    setHoldErr(null)
    setHoldDraft({ ...holds, [key]: value })
  }

  /* ---- writes (both step-up gated) ---- */

  const saveBands = async () => {
    if (!bandDirty || problems.length) return
    setSaving('bands'); setBandErr(null)
    try {
      const res = await runStepUp(() => api.moderation.settings.putThresholds({
        /* Blank/absent entityType is the GLOBAL band — the exact opposite of
           the GET, which defaults to POST. The scope control makes that choice
           explicit rather than leaving it to a field somebody forgot to fill. */
        entityType: scope === 'global' ? undefined : type,
        labels: bandPatch,
      }))
      if (res === undefined) return                    // cancelled at the challenge
      const applied = Object.keys(res?.applied || {}).length
      setData(d => (d ? { ...d, effective: res?.effective || d.effective } : d))
      setBandDraft(null)
      showToast(`${applied} threshold value${applied === 1 ? '' : 's'} saved`, 'ok')
      load()                                           // refresh overrides + warning + model health
    } catch (e) {
      setBandErr(e)                                    // INVALID_THRESHOLD arrives with usable server copy
    } finally {
      setSaving('')
    }
  }

  const saveHolds = async () => {
    if (!holdDirty || holdRangeBad) return
    setSaving('holds'); setHoldErr(null)
    try {
      const res = await runStepUp(() => api.moderation.settings.putHoldDurations({
        entityType: type,                              // REQUIRED here; omitting it is a 400 that reads like a bug report
        ...holdPatch,
      }))
      if (res === undefined) return
      setData(d => (d ? { ...d, effective: res?.effective || d.effective } : d))
      setHoldDraft(null)
      showToast('Hold policy saved', 'ok')
      load()
    } catch (e) {
      setHoldErr(e)
    } finally {
      setSaving('')
    }
  }

  /* ---- the dry run (no write, no model call) ---- */

  const runDry = async () => {
    setDryBusy(true); setDryErr(null); setDry(null)
    try {
      const explicit = Array.from(new Set(String(dryIds).match(UUID_RE) || []))
      const ids = explicit.length ? explicit.slice(0, 500) : await sampleCaseIds(type)
      if (!ids.length) {
        setDryErr(new Error(`There are no stored ${ENTITY_LABEL[type] || 'content'} cases to test these bands against yet.`))
        return
      }
      const res = await api.moderation.settings.dryRun({
        entityType: type,
        labels: dryLabels(bands, serverBands),
        caseIds: ids,
      })
      setDry({ ...res, sampled: ids.length, explicit: explicit.length > 0 })
    } catch (e) {
      setDryErr(e)
    } finally {
      setDryBusy(false)
    }
  }

  /* Count of stored override rows touching this type's bands, plus the global
     ones that apply to every type — the honest answer to "is this number a
     decision somebody made, or a default?". */
  const bandOverrideCount = MODERATION_LABELS.reduce((n, label) => n
    + (overrides[`threshold.${typeKey}.${label}.low`] !== undefined ? 1 : 0)
    + (overrides[`threshold.${typeKey}.${label}.high`] !== undefined ? 1 : 0), 0)
  const globalBandOverrideCount = MODERATION_LABELS.reduce((n, label) => n
    + (overrides[`threshold.${label}.low`] !== undefined ? 1 : 0)
    + (overrides[`threshold.${label}.high`] !== undefined ? 1 : 0), 0)

  const typeNoun = ENTITY_LABEL[type] || typeKey

  return (
    <div>
      {/* ---------- state of the engine ---------- */}
      <section className="card card-pad">
        <h3 className="title"><Icon name="shield" className="sm"/>Effective policy</h3>

        {/* The server's own words, never paraphrased: `warning` is the only
            thing that distinguishes "the policy below is in force" from
            "nothing is being scored at all". Tone is chosen from the enabled
            flag, not from the sentence — the wording is tuned server-side. */}
        {data.warning && (
          <p className={'stx-note ' + (masterOn ? 'warn' : 'err')} role="status">
            <Icon name="alert" className="xs"/>
            <span>{data.warning}</span>
          </p>
        )}

        <div className="flex gap-8 mt-12" style={{ flexWrap: 'wrap' }}>
          <span className={'stx-chip ' + (masterOn ? 'ok' : 'err')}>
            <Icon name={masterOn ? 'check' : 'close'} className="xs"/>
            {masterOn ? 'Automated scoring ON' : 'Automated scoring OFF'}
          </span>
          {!masterOn && (
            <span className="stx-chip plain">Only the keyword blocklist is enforced</span>
          )}
        </div>

        <ModelHealth model={data.model}/>

        <dl className="stx-kv">
          <dt>Live-chat buffer</dt>
          <dd>{eff['livechat.buffer.ms'] ?? '—'} ms</dd>
          <dt>Live-chat borderline messages</dt>
          <dd>{eff['livechat.borderline.hidden'] ? 'Hidden while scoring' : 'Shown while scoring'}</dd>
          <dt>Retrain — max F1 drop</dt>
          <dd>{eff['retrain.max-f1-drop'] ?? '—'}</dd>
          <dt>Retrain — human promote</dt>
          <dd>{eff['retrain.require-human-promote'] === false ? 'Not required' : 'Required'}</dd>
          <dt>Stored overrides</dt>
          <dd>{Object.keys(overrides).length} row{Object.keys(overrides).length === 1 ? '' : 's'} in the database</dd>
        </dl>

        {Object.keys(overrides).length > 0 && (
          <details className="mt-12">
            <summary className="text-sm muted" style={{ cursor: 'pointer' }}>
              Show every stored override
            </summary>
            <dl className="stx-kv">
              {Object.entries(overrides).map(([k, v]) => (
                <React.Fragment key={k}>
                  <dt style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{k}</dt>
                  <dd style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{String(v)}</dd>
                </React.Fragment>
              ))}
            </dl>
            {/* Values are stored as strings and keys are never namespace-checked,
                so a typo becomes a permanent inert row rather than an error. */}
            <p className="stx-hint">
              Raw rows, exactly as stored. Anything that is not a recognised key is inert —
              it is kept, but nothing reads it.
            </p>
          </details>
        )}
      </section>

      {/* ---------- the type under edit ---------- */}
      <section className="card card-pad mt-16">
        <h3 className="title"><Icon name="filter" className="sm"/>Entity type</h3>
        <p className="stx-sub">
          Every setting below applies to one kind of content. Each type carries its own
          bands, its own hold ceiling and its own fallback.
        </p>
        <div className="mdq-bar">
          <select
            className="field" aria-label="Entity type" value={type}
            onChange={e => setType(e.target.value)} style={{ minWidth: 220 }}
          >
            {MODERATED_ENTITY_TYPES.map(t => (
              <option key={t} value={t}>{ENTITY_LABEL[t] || t} — {entityTypeKey(t)}</option>
            ))}
          </select>
          <span className={'stx-chip ' + (row.enabled === false ? 'err' : 'ok')}>
            {row.enabled === false ? 'Not scored' : 'Scored'}
          </span>
          {row.ephemeral && (
            <span className="stx-chip plain" title="Short-lived content: it may expire before a human ever reaches the case.">
              Ephemeral
            </span>
          )}
          {!masterOn && (
            <span className="mdq-hint">
              Scoring is off platform-wide, so this type is not being scored whatever it says here.
            </span>
          )}
        </div>
      </section>

      {/* ---------- thresholds ---------- */}
      <section className="card card-pad mt-16">
        <h3 className="title"><Icon name="trending" className="sm"/>Threshold bands</h3>
        <p className="stx-sub">
          Each classifier head has two cut points. Below the review cut the content is
          approved inline; at or above it a case is opened for a human; at or above the
          block cut it is refused outright and nothing is persisted.
        </p>

        <div className="mdq-band-h" aria-hidden="true">
          <span>Label</span><span>{BAND_LOW_H}</span><span>{BAND_HIGH_H}</span>
        </div>
        {MODERATION_LABELS.map(label => (
          <div className="mdq-band" key={label}>
            <span className="mdq-band-n">{label}</span>
            <input
              className="field mdq-num" type="number" step="0.01" min="0" max="1"
              inputMode="decimal"
              aria-label={`${label} — ${BAND_LOW_H}`}
              aria-invalid={bad.has(`${label}.low`) || undefined}
              value={bands[label]?.low ?? ''}
              onChange={e => setBand(label, 'low', e.target.value)}
            />
            <input
              className="field mdq-num" type="number" step="0.01" min="0" max="1"
              inputMode="decimal"
              aria-label={`${label} — ${BAND_HIGH_H}`}
              aria-invalid={bad.has(`${label}.high`) || undefined}
              value={bands[label]?.high ?? ''}
              onChange={e => setBand(label, 'high', e.target.value)}
            />
          </div>
        ))}

        <p className="stx-hint">
          {bandOverrideCount} of 12 cut points for <b>{typeNoun}</b> come from stored overrides
          {globalBandOverrideCount > 0 && <> and {globalBandOverrideCount} from platform-wide overrides</>}
          ; the rest are configuration defaults. Clearing a box leaves that cut point untouched —
          only the edges you change are written.
        </p>

        {problems.length > 0 && (
          <div className="stx-note err" role="alert">
            <Icon name="alert" className="xs"/>
            <span>
              {problems.map((p, i) => <React.Fragment key={i}>{i > 0 && <br/>}{p}</React.Fragment>)}
            </span>
          </div>
        )}
        {/* INVALID_THRESHOLD, or anything else the server refuses. Its copy is
            already precise, so it is shown as sent. */}
        {bandErr && (
          <div className="stx-note err" role="alert">
            <Icon name="alert" className="xs"/>
            <span>{bandErr.message || 'The thresholds were not saved.'}</span>
          </div>
        )}

        <div className="mdq-acts">
          <div style={{ minWidth: 220 }}>
            <Seg
              ariaLabel="Threshold scope"
              value={scope}
              onChange={setScope}
              options={[['type', `Only ${typeNoun}`], ['global', 'Platform default']]}
            />
          </div>
          <span className="mdq-hint">
            {scope === 'global'
              ? 'Writes the platform-wide default. A type that already has its own override keeps it.'
              : `Writes an override for ${typeKey} alone.`}
          </span>
          <span className="mdq-bar-sp"/>
          <button
            type="button" className="btn btn-secondary btn-sm"
            disabled={!bandDirty || !!saving} onClick={() => { setBandDraft(null); setBandErr(null) }}
          >
            Discard
          </button>
          <button
            type="button" className="btn btn-primary btn-sm"
            disabled={!bandDirty || problems.length > 0 || !!saving}
            onClick={saveBands}
          >
            <Icon name="lock" className="xs"/>
            {saving === 'bands' ? 'Saving…' : 'Save bands'}
          </button>
        </div>
        <p className="stx-hint">
          Saving asks you to confirm it is you — threshold writes are step-up guarded.
          {!bandDirty && ' Nothing has changed yet.'}
        </p>

        {/* ---------- dry run ---------- */}
        <SubHead>Dry-run these bands</SubHead>
        <p className="stx-sub">
          Re-decides stored cases with the numbers above and reports which verdicts would
          flip. <b>Nothing is written, no content moves, and the model is not called</b> —
          this is the safe way to find out what a band does before it is in force.
        </p>

        <Field
          label="Case ids (optional)"
          hint="Leave empty to sample up to 500 stored cases of this type automatically. Paste ids to test a specific set — anything that is not a UUID is ignored."
        >
          <textarea
            className="field" rows={2} value={dryIds}
            onChange={e => setDryIds(e.target.value)}
            placeholder="0f9c…-…  0a21…-…"
            style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12 }}
          />
        </Field>

        <div className="mdq-acts">
          <button
            type="button" className="btn btn-secondary btn-sm"
            disabled={dryBusy} onClick={runDry}
          >
            <Icon name="eye" className="xs"/>{dryBusy ? 'Evaluating…' : 'Dry-run (writes nothing)'}
          </button>
          {!bandDirty && <span className="mdq-hint">With no edits this replays the current bands — every verdict will match.</span>}
        </div>

        {dryErr && (
          <div className="stx-note err" role="alert">
            <Icon name="alert" className="xs"/>
            <span>{dryErr.message || 'The dry run failed.'}</span>
          </div>
        )}

        {dry && (
          <div className="mt-12" aria-live="polite">
            <div className="mdq-kpis">
              <div className="mdq-kpi">
                <div className="mdq-kpi-v">{dry.evaluated ?? 0}</div>
                <div className="mdq-kpi-k">fields evaluated</div>
              </div>
              <div className="mdq-kpi">
                <div className="mdq-kpi-v">{dry.unchanged ?? 0}</div>
                <div className="mdq-kpi-k">verdicts unchanged</div>
              </div>
              <div className={'mdq-kpi ' + ((dry.changed || []).length ? 'warn' : 'good')}>
                <div className="mdq-kpi-v">{(dry.changed || []).length}</div>
                <div className="mdq-kpi-k">verdicts would flip</div>
              </div>
            </div>
            <p className="stx-hint">
              Across {dry.sampled} case{dry.sampled === 1 ? '' : 's'}
              {dry.explicit ? ' you supplied' : ' sampled from the queue'} for {typeKey}.
              {/* Fields whose stored score blob was empty or unreadable are skipped
                  and counted in neither column, so the numbers need not add up. */}
              {' '}Counts are per FIELD, not per case, and fields with unreadable scores are
              skipped entirely — the three numbers do not have to add up.
            </p>

            {(dry.changed || []).length === 0 ? (
              <p className="mdq-empty">No stored case would decide differently.</p>
            ) : (
              (dry.changed || []).map((c, i) => (
                <div className="mdq-field" key={`${c.caseId}-${c.field}-${i}`}>
                  <div className="mdq-field-h" style={{ flexWrap: 'wrap' }}>
                    <span className="mdq-field-n">{c.field}</span>
                    <span className="stx-chip plain">case {shortId(c.caseId)}</span>
                    <span className="stx-chip info">{c.before} → {c.after}</span>
                    {c.topLabel && (
                      <span className="stx-chip plain">{c.topLabel} {pct(c.topScore)}</span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </section>

      {/* ---------- hold durations ---------- */}
      <section className="card card-pad mt-16">
        <h3 className="title"><Icon name="hourglass" className="sm"/>Holds and fallback</h3>
        <p className="stx-sub">
          How long a {typeNoun} may sit unpublished while the classifier decides, how much
          of that budget is spent on the request thread, and what happens if the window
          closes without a verdict.
        </p>

        <ToggleRow
          title={`Score ${typeNoun}`}
          desc="Off means this type is written straight through without any automated check."
          on={!!holds.enabled}
          onToggle={() => setHold('enabled', !holds.enabled)}
        >
          <OverrideChip overrides={overrides} keyName={`enabled.${typeKey}`}/>
        </ToggleRow>

        <div className="flex gap-16 mt-12" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 190px' }}>
            <Field
              label="Hold ceiling (ms)"
              hint={`Between ${HOLD_MIN} and ${HOLD_MAX}. Past this the fallback policy decides.`}
            >
              <input
                className="field" type="number" min={HOLD_MIN} max={HOLD_MAX} step="500"
                inputMode="numeric"
                aria-invalid={holdRangeBad || undefined}
                value={holds.holdMs}
                onChange={e => setHold('holdMs', e.target.value)}
              />
            </Field>
            <OverrideChip overrides={overrides} keyName={`hold.${typeKey}.ms`}/>
          </div>
          {/* The inline budget is not validated on write and IS clamped on read,
              so the saved number and the number in force can honestly differ.
              The hint states both rather than pretending the input is the truth. */}
          <div style={{ flex: '1 1 190px' }}>
            <Field
              label="Inline budget (ms)"
              hint={`Time spent waiting on the request itself. In force: ${
                effectiveInline(holds.inlineMs, holds.holdMs)} ms after the server's clamp.`}
            >
              <input
                className="field" type="number" min="0" step="50" inputMode="numeric"
                value={holds.inlineMs}
                onChange={e => setHold('inlineMs', e.target.value)}
              />
            </Field>
            <OverrideChip overrides={overrides} keyName={`inline.${typeKey}.ms`}/>
          </div>
          <div style={{ flex: '1 1 260px' }}>
            <Field label="Fallback policy" hint={FALLBACK_COPY[holds.fallback] || ''}>
              <select
                className="field" value={holds.fallback}
                onChange={e => setHold('fallback', e.target.value)}
              >
                {FALLBACK_POLICIES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </Field>
            <OverrideChip overrides={overrides} keyName={`fallback.${typeKey}`}/>
          </div>
        </div>

        {holdRangeBad && (
          <div className="stx-note err" role="alert">
            <Icon name="alert" className="xs"/>
            <span>Hold ceiling must be between {HOLD_MIN}ms and {HOLD_MAX}ms.</span>
          </div>
        )}
        {holdErr && (
          <div className="stx-note err" role="alert">
            <Icon name="alert" className="xs"/>
            <span>{holdErr.message || 'The hold policy was not saved.'}</span>
          </div>
        )}

        <div className="mdq-acts">
          <span className="mdq-hint">
            Saved values are read back from the server, not from this form — the inline
            budget is clamped against the hold ceiling on every read.
          </span>
          <span className="mdq-bar-sp"/>
          <button
            type="button" className="btn btn-secondary btn-sm"
            disabled={!holdDirty || !!saving} onClick={() => { setHoldDraft(null); setHoldErr(null) }}
          >
            Discard
          </button>
          <button
            type="button" className="btn btn-primary btn-sm"
            disabled={!holdDirty || holdRangeBad || !!saving}
            onClick={saveHolds}
          >
            <Icon name="lock" className="xs"/>
            {saving === 'holds' ? 'Saving…' : 'Save hold policy'}
          </button>
        </div>
      </section>
    </div>
  )
}
