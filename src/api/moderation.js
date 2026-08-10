/* =========================================================
   Admin — automated content moderation
   /api/v1/admin/moderation/**  +  /api/v1/admin/content/blocklist
   (backend: AdminAutoModerationController, AdminModerationSettingsController,
    AdminModerationModelController, AdminModerationController, AdminContentController)

   This is the STAFF half of the moderation contract; the author-facing half —
   codes, held states, copy, hold ceilings — lives in src/lib/moderation.js and
   is not repeated here. Nothing in this file talks to a user about their own
   content, so none of the anti-probing rules apply to it: a moderator IS
   allowed to see the label and the score.

   Wire truths, probed from the backend source rather than docs/moderation/*
   (the docs are wrong in twelve places; each divergence is commented `drift:`):

   - Jackson `default-property-inclusion: non_null` GLOBALLY. Every null field
     and null map VALUE is omitted, so an absent key IS the null: read with
     `?.`/defaults, never `=== null`. The docs' `"decidedAt": null` examples
     cannot occur.
   - Timestamps are `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'` — a literal Z bolted onto a
     zoneless LocalDateTime. Same no-real-zone caveat as the settings module.
   - Paging is `?page=&pageSize=` with `pageSize` clamped server-side to [1,100].
     There are NO cursors anywhere on this surface, and three of the six list
     endpoints answer with a bare array and no totals at all.
   - The chain rule on `/api/v1/admin/**` demands one of ADMIN / MODERATOR /
     SUPPORT / ANALYST BEFORE any @PreAuthorize runs, so the per-endpoint role
     noted on each method is an intersection, never a widening.
   - Step-up: the seven writes marked STEP-UP answer 403 STEP_UP_REQUIRED until
     the short-lived marker is armed. This module deliberately does NOT arm it —
     wrap the call at the call site so one dialog covers the whole panel:
         security.withStepUp(() => api.moderation.settings.reset(), challenge)
     REQUIRES_STEP_UP below is that list, machine-readable.
   ========================================================= */
import { http } from './http.js'

/* ---------- redaction ----------------------------------------------------
   Chat and live-chat bodies are withheld from staff BY POLICY: the case still
   carries its scores, labels, verdict and thresholds, so a moderator can decide
   without reading a private message. The server substitutes this exact string
   (em dash is U+2014) into `CaseDetail.fields[].text` and into `QueueRow.preview`.
   Exported so the console can recognise it structurally instead of a component
   string-matching a sentence that could be re-worded server-side.

   Related trap: `teachModel: true` is a SILENT no-op for these two types — the
   decide/bulk response still reports success — so the console must not promise
   "added to the training set" for a chat case. */
export const MODERATION_REDACTED = '[private message — body withheld from staff by policy]'

/** Entity types whose text never reaches staff (EnumSet in the controller). */
export const REDACTED_ENTITY_TYPES = ['CHAT_MESSAGE', 'LIVE_CHAT']

/** True when this text is the policy placeholder rather than real content. */
export function isRedactedText(text) {
  return text === MODERATION_REDACTED
}

/** True when this case's text is withheld — usable before any field loads. */
export function isRedactedType(entityType) {
  return REDACTED_ENTITY_TYPES.includes(entityTypeName(entityType))
}

/* ---------- enum wire spellings (verbatim from the backend enums) ---------- */

/** ModerationStatus. IN_REVIEW is the default queue filter. */
export const MODERATION_STATUSES = ['IN_REVIEW', 'PENDING', 'APPROVED', 'REJECTED']

/** ModerationVerdict — per-FIELD outcome, not per-case status. */
export const MODERATION_VERDICTS = ['APPROVE', 'REVIEW', 'REJECT']

/** ModeratedEntityType, in enum order. Same 13 keys as ENTITY_LABEL in
 *  src/lib/moderation.js — import the nouns from there, not from here. */
export const MODERATED_ENTITY_TYPES = [
  'POST', 'POST_COMMENT', 'STORY', 'STORY_POLL', 'RESEARCH', 'RESEARCH_COMMENT',
  'QNA_QUESTION', 'QNA_ANSWER', 'CHAT_MESSAGE', 'CHANNEL', 'STREAM_META',
  'LIVE_CHAT', 'CONTENT_ANNOTATION',
]

/** ModerationLabel.wire() — the six classifier heads, in enum order. Score maps,
 *  threshold bands and training-example labels are ALL keyed by these exact
 *  strings. Inbound aliases (`toxicity`, `severe_toxicity`, `identity_attack`)
 *  are accepted by the threshold endpoints only — the training-example writer
 *  reads `labels.get(wire)` directly, so an alias there silently means 0. */
export const MODERATION_LABELS = ['toxic', 'severe_toxic', 'obscene', 'threat', 'insult', 'identity_hate']

/** FallbackPolicy — what happens to content when the model is unreachable. */
export const FALLBACK_POLICIES = ['FAIL_CLOSED', 'FAIL_OPEN_SHADOW']

/** ModelVersionStatus. Only READY / SHADOW / RETIRED can be promoted. */
export const MODEL_VERSION_STATUSES = ['TRAINING', 'EVALUATING', 'READY', 'SHADOW', 'ACTIVE', 'RETIRED', 'FAILED']

/** TrainingExampleSource — the `source` filter on the dataset list. */
export const TRAINING_SOURCES = [
  'SEED_DATASET', 'ADMIN_MANUAL', 'ADMIN_CORRECTION', 'REVIEW_PROMOTION', 'USER_REPORT_CONFIRMED',
]

/** QueueRow.reasonCode — why the case exists at all. */
export const REASON_CODES = ['BLOCKLIST', 'MODEL', 'SLA_BREACH', 'DISABLED', 'NO_TEXT', 'ADMIN', 'INFERENCE_UNAVAILABLE']

/** PlatformKeyword.Severity. drift: admin-guide.md calls these `hard_block` /
 *  `soft_flag`; the enum has only these two spellings, in both directions. */
export const BLOCKLIST_SEVERITIES = ['FLAG', 'BLOCK']

/** Queue sort keys. `oldest` → submittedAt ASC; ANYTHING else falls through to
 *  maxScore DESC, so there are only ever two behaviours no matter what is sent. */
export const REVIEW_SORTS = ['risk', 'oldest']

/** The pre-existing reactive queue's three feeders (§4). An unknown `source`
 *  is not an error — it returns an empty array, which reads as "all clear". */
export const QUEUE_SOURCES = ['reports', 'media', 'keywords']

/** Legacy bulk actions and the ONE target type each accepts. A mismatch is not
 *  a 400: it comes back as a per-target `error` string inside a 200 array. */
export const QUEUE_BULK_ACTIONS = [
  { action: 'TAKEDOWN', type: 'POST', label: 'Take down post' },
  { action: 'RESTORE', type: 'POST', label: 'Restore post' },
  { action: 'DELETE', type: 'COMMENT', label: 'Delete comment' },
  { action: 'DELETE', type: 'STORY', label: 'Delete story' },
  { action: 'SOUND_APPROVE', type: 'SOUND', label: 'Approve sound' },
  { action: 'SOUND_REJECT', type: 'SOUND', label: 'Reject sound' },
]

/** Dotted names of every @RequiresStepUp method below, so a panel can decide
 *  whether to mount the credential dialog without hard-coding the list twice.
 *  Kept in sync by hand — the interceptor is registered on `/admin/**` only. */
export const REQUIRES_STEP_UP = [
  'review.bulk',
  'settings.putThresholds',
  'settings.putHoldDurations',
  'settings.rawPut',
  'settings.rawDelete',
  'settings.reset',
  'model.retrain',
  'model.promote',
  'model.rollback',
  'queue.bulk',
  'blocklist.add',
]

/* ---------- entityType casing ------------------------------------------
   THE trap on this surface. Params are parsed with
   `valueOf(raw.trim().toUpperCase())`, so they are case-INSENSITIVE — but
   hyphens are NOT normalised, and `chat-message` is a 400. Responses are mixed,
   not uniformly uppercase:

     UPPERCASE (enum .name()):  QueueRow.entityType
     lowercase (type.key()):    CaseDetail.thresholds.entityType,
                                GET /settings/thresholds.entityType,
                                POST /settings/dry-run.entityType,
                                settings.effective.entityTypes KEYS,
                                metrics.volume.byEntityType KEYS,
                                metrics.sla[].entityType

   So a console that keys its own state on the uppercase enum (the sane choice —
   it matches ENTITY_LABEL in lib/moderation.js) must convert on BOTH sides.
   Guessing here does not error, it silently returns an empty queue. */

/** Enum-name form: `post` | `Post` | `chat-message` → `POST` | `CHAT_MESSAGE`.
 *  Use for comparing against QueueRow.entityType and for ENTITY_LABEL lookups. */
export function entityTypeName(type) {
  const raw = String(type ?? '').trim()
  return raw ? raw.replace(/-/g, '_').toUpperCase() : ''
}

/** key() form: `CHAT_MESSAGE` → `chat_message`. Use for query params AND for
 *  indexing every lowercase-keyed map the responses carry. */
export function entityTypeKey(type) {
  return entityTypeName(type).toLowerCase()
}

/* ---------- small shared shapes ---------- */

/* Mirror the server's own clamp rather than discovering it: pageSize is
   max(1,min(n,100)) everywhere, and `page` is floored at 0 by the review and
   model controllers but NOT by the legacy queue — so floor it here for all of
   them and a negative page can never reach the one endpoint that would trust it. */
const paging = (page = 0, pageSize = 50) => ({
  page: Math.max(0, Math.trunc(page) || 0),
  pageSize: Math.max(1, Math.min(Math.trunc(pageSize) || 1, 100)),
})

/* The review queue is the only envelope carrying full page metadata; the
   dataset list omits totalPages and the versions list omits paging entirely
   (drift: api.md claims one uniform pagination shape). Normalise only what is
   genuinely absent — rows are handed back verbatim, because NON_NULL means
   every optional field is simply a missing key and `?.` already reads right. */
const listOf = (res) => (Array.isArray(res) ? res : res?.items || [])

/** Coerce a label selection into the exact six wire keys with 0/1 values.
 *  Accepts an array of wire labels or an object keyed by them. Needed because
 *  the training-example writer does NOT do alias lookup: a key of
 *  `identity_attack` (valid on the threshold endpoints) silently stores 0. */
export function labelsTo(selected) {
  const on = Array.isArray(selected)
    ? new Set(selected.map(l => String(l).toLowerCase()))
    : new Set(Object.entries(selected || {}).filter(([, v]) => !!v).map(([k]) => String(k).toLowerCase()))
  const out = {}
  for (const label of MODERATION_LABELS) out[label] = on.has(label) ? 1 : 0
  return out
}

/** Golden cases are the one place where the request and the response disagree
 *  about label keys: you POST `{"identity_hate": 1}` and the raw entity comes
 *  back with `identityHate: 1` (it serialises its columns, and `labelMap()` is
 *  not a bean getter so there is no `labels` key at all). Normalise the row into
 *  the same wire-keyed map every other surface uses. */
export function goldenLabelsOf(row) {
  const camel = {
    toxic: 'toxic', severe_toxic: 'severeToxic', obscene: 'obscene',
    threat: 'threat', insult: 'insult', identity_hate: 'identityHate',
  }
  const out = {}
  for (const label of MODERATION_LABELS) out[label] = Number(row?.[camel[label]] ?? 0) ? 1 : 0
  return out
}

/* =========================================================
   §1 review — the automated case queue
   /api/v1/admin/moderation/review     ADMIN | MODERATOR
   ========================================================= */
const review = {
  /**
   * The queue. Roles: ADMIN | MODERATOR. No step-up.
   *
   * TRAPS:
   * - The three filters are NOT composable (drift: api.md presents them as if
   *   they were). The controller is an if/else-if chain and `slaBreached` wins:
   *   send `slaBreached: true` and `entityType` is silently ignored — so this
   *   method drops it, and the console must never show both as active at once.
   * - `counts` is GLOBAL (inReview / pending / slaBreached across the whole
   *   table), not a count of the filtered result. Label it as such or a filtered
   *   view looks like it is hiding rows.
   * - `sort` only distinguishes `oldest`; every other value means risk-first.
   * - `items[].preview` is built from an unordered field fetch, so the previewed
   *   field is arbitrary — it is a hint, never "the body".
   * - An invalid `status`/`entityType` is 400 INVALID_MODERATION_SETTING, not an
   *   empty page.
   */
  async list({ status = 'IN_REVIEW', entityType, slaBreached = false, sort = 'risk', page = 0, pageSize = 50 } = {}) {
    const p = paging(page, pageSize)
    const res = await http.get('/api/v1/admin/moderation/review', {
      status: status || undefined,
      /* Sent in key() form: the server upper-cases it anyway, and matching the
         casing the responses use keeps one spelling in the console's state.
         Dropped outright under `slaBreached` rather than sent-and-ignored, so
         the request on the wire says what the server will actually do. */
      entityType: slaBreached ? undefined : (entityTypeKey(entityType) || undefined),
      slaBreached: slaBreached ? 'true' : undefined,   // only `true` does anything server-side
      sort: sort || undefined,
      ...p,
    })
    return {
      items: listOf(res),
      page: res?.page ?? p.page,
      pageSize: res?.pageSize ?? p.pageSize,
      totalElements: res?.totalElements ?? 0,
      totalPages: res?.totalPages ?? 0,
      counts: res?.counts || { inReview: 0, pending: 0, slaBreached: 0 },
    }
  },

  /**
   * One case with its per-field evidence.
   * → `{ summary: QueueRow, fields: FieldView[], thresholds: {entityType, bands, holdMs, fallback} }`
   *
   * - A missing case is 400 MODERATION_CASE_NOT_FOUND, never a 404 — so the
   *   console's "not found" branch has to live in the error handler.
   * - `fields[].scores` is `{}` (not absent) when the stored blob was empty or
   *   malformed; an empty score map means "we could not read it", not "all zero".
   * - `fields[].text` is the redaction placeholder for CHAT_MESSAGE / LIVE_CHAT.
   * - `thresholds.entityType` comes back LOWERCASE while `summary.entityType` is
   *   UPPERCASE, in the same payload.
   */
  get(caseId) { return http.get(`/api/v1/admin/moderation/review/${caseId}`) },

  /**
   * Decide one case. Roles: ADMIN | MODERATOR. NO step-up — deliberate, per the
   * controller's own design note: single decisions are the everyday act.
   * → 200 with a single QueueRow (not wrapped).
   *
   * `action` must be APPROVE | REJECT (400 INVALID_MODERATION_ACTION otherwise);
   * `reason` is capped at 500 chars by bean validation.
   *
   * A reversal really un-publishes: the server clears appliedAt/notifiedAt so
   * the applier re-runs, forces slaBreached=false and stamps reasonCode=ADMIN.
   * Re-deciding an already-decided case is allowed and silent — there is no
   * MODERATION_CASE_DECIDED error in the code path despite the constant
   * existing (drift: api.md lists it as a live 400; zero throw sites).
   *
   * `teachModel` is a silent no-op for CHAT_MESSAGE / LIVE_CHAT.
   */
  decide(caseId, { action, reason, teachModel } = {}) {
    return http.post(`/api/v1/admin/moderation/review/${caseId}/decide`, {
      action: String(action || '').toUpperCase(),
      reason: reason || undefined,
      teachModel: teachModel ? true : undefined,
    })
  },

  /**
   * Decide up to 100 cases. Roles: ADMIN | MODERATOR. **STEP-UP REQUIRED** —
   * wrap with `security.withStepUp`.
   * → a BARE array `[{caseId, outcome:'ok'|'error', error?}]`, one row per input
   *   id in input order. Per-item failures never fail the call, and `error` is a
   *   raw exception MESSAGE, not an errorCode — render it as text.
   *
   * The size bound is enforced (@Valid, 1..100), unlike the legacy bulk below,
   * so a "select all" that overshoots would come back as a field-error envelope.
   * Caught here instead, because the caller must chunk rather than see that.
   */
  bulk({ action, caseIds, reason, teachModel } = {}) {
    const ids = (caseIds || []).filter(Boolean)
    if (!ids.length) throw new Error('Select at least one case.')
    if (ids.length > 100) throw new Error(`Bulk decisions are limited to 100 cases (got ${ids.length}).`)
    return http.post('/api/v1/admin/moderation/review/bulk', {
      action: String(action || '').toUpperCase(),
      caseIds: ids,
      reason: reason || undefined,
      teachModel: teachModel ? true : undefined,
    })
  },

  /**
   * Re-run the decision engine on a case with the CURRENT thresholds.
   * → `{ caseId, status }` where status is a ModerationStatus **or the synthetic
   *   string `GONE`** when the case row no longer exists. `GONE` is not in the
   *   enum — do not feed it to a status formatter that assumes it is.
   *
   * A case still inside its hold window comes back PENDING unchanged, so an
   * unchanged status is not a failure.
   */
  rescore(caseId) { return http.post(`/api/v1/admin/moderation/review/${caseId}/rescore`, {}) },

  /**
   * The ops board. Roles: ADMIN | MODERATOR | **ANALYST** (method-level widening).
   * → `{ windowHours, enabled, queue, volume, bands, labels[], sla[], model, dataset }`
   *
   * `windowHours` has NO upper clamp and the response ECHOES THE RAW REQUEST
   * VALUE while querying `max(1, windowHours)` — send 0 and the body claims a
   * 0-hour window over 1 hour of data. Floored here so the echo is always true.
   *
   * `volume.byEntityType` and `sla[].entityType` are keyed LOWERCASE; the inner
   * status maps are UPPERCASE and may be `{}` for an idle type.
   */
  metrics({ windowHours = 24 } = {}) {
    return http.get('/api/v1/admin/moderation/review/metrics', {
      windowHours: Math.max(1, Math.trunc(windowHours) || 1),
    })
  },
}

/* =========================================================
   §2 settings — decision-engine tuning
   /api/v1/admin/moderation/settings
   ========================================================= */
const settings = {
  /**
   * Everything the engine is currently running on. Roles: ADMIN | MODERATOR.
   * → `{ overrides, effective, model, warning? }`
   *
   * - `overrides` is the raw DB rows: keys are dotted setting keys, values are
   *   ALWAYS strings (`"0.45"`, `"true"`) even when they mean numbers or flags.
   * - `effective.entityTypes` is keyed by the LOWERCASE type key, and the
   *   top-level keys contain literal dots (`"livechat.buffer.ms"`) — they are
   *   flat JSON keys, not a nested object.
   * - `warning` appears only when moderation is disabled or inference is down,
   *   and is server copy: render it verbatim.
   */
  get() { return http.get('/api/v1/admin/moderation/settings') },

  /**
   * Bands for one entity type. Roles: ADMIN | MODERATOR.
   * → `{ entityType: "post", bands: { "<wire label>": {low, high} × 6 } }`
   * Omitting `entityType` does NOT mean "global" here — it defaults to POST.
   */
  thresholds(entityType) {
    return http.get('/api/v1/admin/moderation/settings/thresholds', {
      entityType: entityTypeKey(entityType) || undefined,
    })
  },

  /**
   * Patch bands. Roles: ADMIN | MODERATOR. **STEP-UP REQUIRED**.
   * → `{ applied: {key: "stringified value"}, effective: {…} }`
   *
   * - `entityType` omitted/blank = the GLOBAL band (the opposite of the GET
   *   above, which defaults to POST — the asymmetry is real).
   * - `labels` is keyed by wire label; `low` and `high` are INDEPENDENTLY
   *   optional and only the non-null one is written, so a single-ended patch is
   *   the supported way to nudge one edge.
   * - Each value must be within [0,1] and finite, and when both are sent
   *   `high >= low`, else 400 INVALID_THRESHOLD.
   * - An empty/absent `labels` map is 400 INVALID_THRESHOLD, not a no-op.
   */
  putThresholds({ entityType, labels } = {}) {
    return http.put('/api/v1/admin/moderation/settings/thresholds', {
      entityType: entityTypeKey(entityType) || undefined,   // absent ⇒ global scope
      labels: labels || {},
    })
  },

  /**
   * Hold ceiling / inline budget / fallback / per-type enable.
   * Roles: ADMIN | MODERATOR. **STEP-UP REQUIRED**.
   *
   * - `entityType` is REQUIRED (drift: api.md says "every field is optional" —
   *   true only of the four value fields). Omitting it is 400
   *   INVALID_MODERATION_SETTING with the message "Unknown moderation setting
   *   key: null", which reads like a bug report rather than a form error, so the
   *   console must require the field itself.
   * - `holdMs` must be 500..600000 or 400. `inlineMs` is NOT validated on write
   *   and is instead clamped at READ time to max(100, min(v, max(200, hold/2))) —
   *   so a saved value can legitimately differ from the effective one; show the
   *   `effective` block back, not the input.
   * - `fallback` is validated with hyphens normalised but STORED as sent:
   *   "fail-open-shadow" persists as "FAIL-OPEN-SHADOW" and shows up hyphenated
   *   in `overrides`. Send FALLBACK_POLICIES values to keep the row clean.
   * - All four value fields null ⇒ 400 "Unknown moderation setting key:
   *   (empty patch)".
   */
  putHoldDurations({ entityType, holdMs, inlineMs, fallback, enabled } = {}) {
    return http.put('/api/v1/admin/moderation/settings/hold-durations', {
      entityType: entityTypeKey(entityType) || undefined,
      holdMs: holdMs ?? undefined,
      inlineMs: inlineMs ?? undefined,
      fallback: fallback ? String(fallback).toUpperCase().replace(/-/g, '_') : undefined,
      enabled: enabled ?? undefined,
    })
  },

  /**
   * "What would these bands have done to these cases?" Roles: ADMIN | MODERATOR.
   * No step-up — nothing is written and no model call is made.
   * → `{ entityType, evaluated, unchanged, changed:[{caseId, field, before, after, topLabel?, topScore}] }`
   *
   * - `caseIds` is MANDATORY in practice: null or empty evaluates zero fields
   *   and returns an empty result. There is no "recent cases" default, so a
   *   dry-run button with nothing selected reports a confident, meaningless zero.
   * - `evaluated` counts FIELD rows, not cases; fields with unreadable scores are
   *   skipped and counted in neither `evaluated`'s companion `unchanged` nor
   *   `changed`, so the three numbers need not add up.
   * - Only the labels present are overridden; the rest inherit current bands.
   * - Max 500 ids (@Size), guarded here so the overflow is a sentence rather
   *   than a field-error envelope.
   */
  dryRun({ entityType, labels, caseIds } = {}) {
    const ids = (caseIds || []).filter(Boolean)
    if (ids.length > 500) throw new Error(`A dry run covers at most 500 cases (got ${ids.length}).`)
    return http.post('/api/v1/admin/moderation/settings/dry-run', {
      entityType: entityTypeKey(entityType) || undefined,   // absent ⇒ POST
      labels: labels || undefined,
      caseIds: ids,
    })
  },

  /**
   * Write one raw override row. Roles: **ADMIN only**. **STEP-UP REQUIRED**.
   * → `{ overrides: {…} }`
   * No namespace validation whatsoever — any key ≤120 chars is accepted and
   * lower-cased on write, so a typo becomes a permanent, inert row rather than
   * an error. Both key and value are stored as strings.
   */
  rawPut(key, value) {
    return http.put('/api/v1/admin/moderation/settings/raw', { key, value: String(value) })
  },

  /**
   * Delete one override row. Roles: **ADMIN only**. **STEP-UP REQUIRED**. → 204.
   * Keys contain dots (`threshold.threat.high`); encoded because the path
   * variable is the key itself. An unknown key still answers 204, so success
   * here does not prove the row existed — re-read `get()` to confirm.
   */
  rawDelete(key) {
    return http.del(`/api/v1/admin/moderation/settings/raw/${encodeURIComponent(String(key || '').trim().toLowerCase())}`)
  },

  /**
   * Delete EVERY override row — the whole engine falls back to configuration
   * defaults. Roles: **ADMIN only**. **STEP-UP REQUIRED**.
   * → `{ effective: {…} }`. Irreversible; there is no undo endpoint.
   */
  reset() { return http.post('/api/v1/admin/moderation/settings/reset', {}) },
}

/* =========================================================
   §3 model — training data + classifier registry
   /api/v1/admin/moderation/model   (class-level ADMIN; some methods widen)
   ========================================================= */
const model = {
  /**
   * The labelled dataset. Roles: ADMIN | MODERATOR.
   * → `{ items, page, pageSize, totalElements, summary }` — **no `totalPages`**
   *   (drift: api.md claims a uniform envelope).
   * `items[].labels` always carries all six wire keys with 0/1 values.
   */
  async trainingExamples({ source, page = 0, pageSize = 50 } = {}) {
    const p = paging(page, pageSize)
    const res = await http.get('/api/v1/admin/moderation/model/training-examples', {
      source: source ? String(source).toUpperCase() : undefined,
      ...p,
    })
    return {
      items: listOf(res),
      page: res?.page ?? p.page,
      pageSize: res?.pageSize ?? p.pageSize,
      totalElements: res?.totalElements ?? 0,
      summary: res?.summary || null,
    }
  },

  /**
   * Add one labelled example. Roles: ADMIN | MODERATOR. → 201 with the row.
   *
   * Dedup is on a normalised SHA-256 of the text (trim → lowercase → collapse
   * whitespace), so re-posting the same sentence UPDATES its labels and resets
   * `trainedInVersion` to null rather than creating a second row: the console
   * should present a repeat submission as an edit, not a duplicate.
   * `source` is forced to ADMIN_MANUAL server-side.
   * Label keys must be exact wire names — see labelsTo().
   */
  addTrainingExample({ text, labels, note } = {}) {
    return http.post('/api/v1/admin/moderation/model/training-examples', {
      text, labels: labelsTo(labels), note: note || undefined,
    })
  },

  /**
   * Expand ONE word into three template sentences and add all three.
   * Roles: ADMIN | MODERATOR. → 201 `{ word, created: [3 rows], note }`
   *
   * The server's own `note` says the quiet part: this only matters after a
   * retrain. For an instant ban, add the word to the blocklist as well.
   */
  addWord({ word, labels, note } = {}) {
    return http.post('/api/v1/admin/moderation/model/training-examples/word', {
      word, labels: labelsTo(labels), note: note || undefined,
    })
  },

  /** Remove one example. Roles: **ADMIN only**. → 204 even for an unknown id
   *  (Spring Data's deleteById is a no-op), so never treat 204 as proof. */
  removeTrainingExample(id) { return http.del(`/api/v1/admin/moderation/model/training-examples/${id}`) },

  /**
   * The golden set — the regression suite the promotion gate scores against.
   * Roles: ADMIN | MODERATOR. → a **BARE ARRAY** of raw entities: no envelope,
   * no total, so "is there a next page?" can only be inferred from a full page.
   * Rows carry camelCase label columns; use goldenLabelsOf() to read them.
   */
  async goldenCases({ page = 0, pageSize = 50 } = {}) {
    return listOf(await http.get('/api/v1/admin/moderation/model/golden-cases', paging(page, pageSize)))
  },

  /** Add a golden case. Roles: **ADMIN only**. → 201 with the raw entity.
   *  Request takes wire label keys, the response answers in camelCase columns.
   *  Same SHA-256 dedup as training examples (update in place). */
  addGoldenCase({ text, labels, note } = {}) {
    return http.post('/api/v1/admin/moderation/model/golden-cases', {
      text, labels: labelsTo(labels), note: note || undefined,
    })
  },

  /** Remove a golden case. Roles: **ADMIN only**. → 204, unknown id included. */
  removeGoldenCase(id) { return http.del(`/api/v1/admin/moderation/model/golden-cases/${id}`) },

  /**
   * The model registry. Roles: ADMIN | **ANALYST** — **not MODERATOR**, who gets
   * a 403 here while being allowed everywhere else on this controller.
   * → `{ items, totalElements, health }` — no page/pageSize/totalPages echoed
   *   back, so the caller owns the page cursor. Default pageSize is **20** here,
   *   not 50 (drift: api.md).
   */
  async versions({ page = 0, pageSize = 20 } = {}) {
    const res = await http.get('/api/v1/admin/moderation/model/versions', paging(page, pageSize))
    return { items: listOf(res), totalElements: res?.totalElements ?? 0, health: res?.health || null }
  },

  /**
   * Kick off a training run. Roles: **ADMIN only**. **STEP-UP REQUIRED**.
   * → **202** with a placeholder version whose `version` is `job-<jobId>` and
   *   `status: "TRAINING"` — it is a receipt, not a model. Poll `versions()` (or
   *   `retrainRefresh()`) for the real one.
   *
   * Errors worth distinct copy: TRAINING_ALREADY_RUNNING,
   * TRAINING_DATASET_TOO_SMALL (min 20 examples by default),
   * TRAINING_SERVICE_UNAVAILABLE.
   */
  retrain({ baseVersion, notes } = {}) {
    return http.post('/api/v1/admin/moderation/model/retrain', {
      baseVersion: baseVersion || undefined,   // omitted ⇒ the current ACTIVE version
      notes: notes || undefined,
    })
  },

  /**
   * Poll the training container for jobs that finished while nobody was looking.
   * Roles: ADMIN. No step-up. → `{ settled: <int> }` — how many jobs reached a
   * terminal state ON THIS CALL, so 0 means "nothing new", not "nothing running".
   */
  retrainRefresh() { return http.post('/api/v1/admin/moderation/model/retrain/refresh', {}) },

  /**
   * Make a version ACTIVE. Roles: **ADMIN only**. **STEP-UP REQUIRED**.
   * → 200 VersionView with `status: "ACTIVE"`.
   *
   * The container reload is attempted BEFORE the registry flip, so
   * INFERENCE_UNAVAILABLE means nothing changed. MODEL_GATE_FAILED is the one
   * error `force: true` overrides — and it should be a deliberate second click,
   * never the default.
   * Only READY / SHADOW / RETIRED are promotable (else MODEL_NOT_PROMOTABLE).
   */
  promote(id, { force = false } = {}) {
    return http.post(`/api/v1/admin/moderation/model/versions/${id}/promote`, { force: !!force })
  },

  /**
   * Run a version in SHADOW (scored, never enforced). Roles: **ADMIN only**.
   * No step-up, and — unlike promote — **no status precondition**: any version
   * can be forced to SHADOW, including a FAILED one. Guard that in the UI.
   */
  shadow(id) { return http.post(`/api/v1/admin/moderation/model/versions/${id}/shadow`, {}) },

  /**
   * Re-promote the most recently RETIRED version that was ever active, with
   * `force=true`. Roles: **ADMIN only**. **STEP-UP REQUIRED**. No body.
   * With no such version the error is MODEL_VERSION_NOT_FOUND carrying the
   * message "Model version not found: no retired version" — surface that as
   * "nothing to roll back to", not as a missing id.
   */
  rollback() { return http.post('/api/v1/admin/moderation/model/rollback', {}) },

  /**
   * Score arbitrary text against the live model without creating a case.
   * Roles: ADMIN | MODERATOR. → `{ modelVersion, inferenceMs, scores }`, scores
   * keyed by the six wire labels. 5-second server-side timeout; a down container
   * is 400 INFERENCE_UNAVAILABLE.
   */
  scoreProbe(text) { return http.post('/api/v1/admin/moderation/model/score-probe', { text }) },

  /* Not exposed: POST /model/train-callback. drift: api.md calls it
     "container-authenticated via permitAll", but the method-level permitAll
     cannot bypass the chain rule on /api/v1/admin/**, so it is reachable only by
     an already-privileged session. It is the training container's own webhook
     and there is nothing for this app to do with it. */
}

/* =========================================================
   §4 queue — the PRE-EXISTING reactive inbox (user reports, failed media,
   keyword hits). /api/v1/admin/moderation   ADMIN | MODERATOR

   Distinct from §1 in every way that matters: it is fed by humans and by the
   media pipeline rather than by the classifier, and its QueueRow is a DIFFERENT
   record with different field names. Do not render the two through one card.
   ========================================================= */
const queue = {
  /**
   * → a **BARE ARRAY** of `{source, targetType, targetRef, reason, reportCount,
   *   state, firstSeen, lastSeen}`. No envelope, no totals.
   *
   * TRAPS:
   * - Paging is applied PER FEEDER and the three lists are then concatenated, so
   *   one page can hold up to `3 × pageSize` rows and page 2 is not "the next
   *   50 of one ordering".
   * - `targetType` filters the REPORTS feeder only. When it is absent, reports
   *   are additionally narrowed client-side by the server to POST/COMMENT/STORY,
   *   so USER / RESEARCH / QUESTION / ANSWER / MESSAGE / CHANNEL reports are
   *   INVISIBLE unless you ask for that type explicitly.
   * - An unrecognised `source` returns an empty array rather than a 400.
   * - `reportCount` is COUNT(*), not distinct reporters.
   */
  async list({ source, targetType, page = 0, pageSize = 50 } = {}) {
    const res = await http.get('/api/v1/admin/moderation/queue', {
      source: source || undefined,
      targetType: targetType ? String(targetType).toUpperCase() : undefined,
      ...paging(page, pageSize),
    })
    return listOf(res)
  },

  /** Mark a keyword hit handled. → 204 — including for an unknown hitId, which
   *  is swallowed by an `ifPresent`. Refresh the list rather than trusting it. */
  resolveKeyword(hitId) { return http.post(`/api/v1/admin/moderation/queue/keywords/${hitId}/resolve`, {}) },

  /**
   * Act on report targets in bulk. Roles: ADMIN | MODERATOR. **STEP-UP REQUIRED**.
   * → a bare array of `{type, id, outcome, error?}` echoing the RAW input
   *   strings; a wrong action/type pair is a per-target `error`, not a 400.
   *
   * This controller forgot `@Valid` (drift: api.md implies the same validation
   * as the review bulk), so its @NotBlank/@Size annotations are dead: a missing
   * `action` NPEs into a **500** and a 500-element list is accepted. Both guarded
   * here, because a 500 is indistinguishable from a real outage in the console.
   */
  bulk({ action, targets, reason } = {}) {
    const act = String(action || '').trim().toUpperCase()
    if (!act) throw new Error('Pick an action first.')
    const rows = (targets || []).filter(t => t && t.id)
    if (!rows.length) throw new Error('Select at least one item.')
    if (rows.length > 100) throw new Error(`Bulk actions are limited to 100 items (got ${rows.length}).`)
    return http.post('/api/v1/admin/moderation/bulk', {
      action: act,
      targets: rows.map(t => ({ type: String(t.type || '').toUpperCase(), id: t.id })),
      reason: reason || undefined,
    })
  },
}

/* =========================================================
   §5 blocklist — the keyword deny-list
   /api/v1/admin/content/blocklist   ADMIN | MODERATOR

   The instant lever: BLOCK refuses the write outright (400
   CONTENT_BLOCKED_BY_POLICY at create time), FLAG publishes and files a hit into
   queue.list({source:'keywords'}). Unlike a training example, it needs no
   retrain — which is exactly why the model panel points here for urgent bans.
   ========================================================= */
const blocklist = {
  /** → a **BARE ARRAY** of every keyword. No pagination and no params at all:
   *  this is `findAll()`, so filtering and sorting are the client's job. */
  async list() { return listOf(await http.get('/api/v1/admin/content/blocklist')) },

  /**
   * Add or update a keyword. **STEP-UP REQUIRED**. → 201 with the row.
   * UPSERT on the normalised form: an existing row is updated in place rather
   * than duplicated, so "add" can silently be an edit — read the response back.
   * `keyword` is trimmed and hard-truncated to 100 chars server-side.
   * `severity` omitted ⇒ FLAG.
   */
  add({ keyword, severity = 'FLAG', note } = {}) {
    return http.post('/api/v1/admin/content/blocklist', {
      keyword, severity: String(severity || 'FLAG').toUpperCase(), note: note || undefined,
    })
  },

  /** Change severity/note. No step-up. `keyword` is IGNORED by the patch — to
   *  change the word itself, delete the row and add the new one. */
  update(id, { severity, note } = {}) {
    return http.patch(`/api/v1/admin/content/blocklist/${id}`, {
      severity: severity ? String(severity).toUpperCase() : undefined,
      note: note ?? undefined,
    })
  },

  /** → 204. Unlike the model deletes, an unknown id here is a real 404. */
  remove(id) { return http.del(`/api/v1/admin/content/blocklist/${id}`) },

  /**
   * Dry-run text against the deny-list. → `{ matched, matches }` where
   * `matches` entries are PRE-FORMATTED display strings (`"idiot (BLOCK)"`),
   * not objects — do not try to read `.severity` off them.
   */
  test(text) { return http.post('/api/v1/admin/content/blocklist/test', { text }) },
}

export const moderation = { review, settings, model, queue, blocklist }
