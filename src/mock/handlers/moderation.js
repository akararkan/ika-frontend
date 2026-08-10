/* =========================================================
   Mock handlers — AUTOMATED CONTENT MODERATION
   ---------------------------------------------------------
   Two jobs in one file, because they are the two halves of one demo.

   1. A FAKE CLASSIFIER for the author-facing composers, so the three outcomes
      every create path now has to render can be seen with no backend, no model
      container and no live inference. There is no scoring here and there never
      should be — the verdict is a MARKER WORD:

          text matching  /\bblockme\b/i  →  400 CONTENT_REJECTED  (nothing saved)
          text matching  /\bholdme\b/i   →  2xx, held             (author-only)
          anything else                  →  clean

      Type either word into any composer wired to a mocked create path. Both are
      word-bounded so ordinary prose can never trip them, and both are
      deliberately silly and greppable: `git grep -i blockme` finds every place
      this demo aid is honoured. When the markers stop being enough, the fix is
      a third marker, NOT a heuristic — a mock classifier that guesses would
      make mock mode disagree with the server for reasons nobody can reproduce.

      The refusal is delivered in the shape the surface really answers with,
      quirks included: a MULTIPART post block arrives as a 500
      `post_create_failed` rather than a 400, because that is what the backend
      does (see multipartBlockedError). Smoothing that over here would leave the
      one message sniff in src/lib/moderation.js with no rehearsal anywhere.

   2. THE ADMIN CONSOLE API (`/api/v1/admin/moderation/**`), served from a
      fixture that lives in THIS MODULE rather than in data.json: it is
      staff-only scaffolding, no other screen reads a byte of it, and the shared
      fixture should not grow a top-level key that one surface owns. Writes land
      on `db._moderation` (the same escape hatch `extra.js` uses for email
      preferences), so a decision, a threshold edit or a promoted model sticks
      until the page is reloaded.

   Shapes are the Java DTOs verbatim, including the three things that are easy
   to get wrong and expensive to discover in production:

     · Spring's GLOBAL non_null inclusion — a null field is ABSENT from the JSON,
       not present-and-null (see compact()). A console that reads
       `row.decidedAt === null` has to break here, not on the live wire.
     · the entityType CASING SPLIT — `QueueRow.entityType` is the UPPERCASE enum
       name, while every settings / metrics / threshold key is the lowercase
       `key()` (`post_comment`, `chat_message`, …). One endpoint answers both
       spellings for the same enum; that is not a typo.
     · the redaction — CHAT_MESSAGE and LIVE_CHAT never hand their body to
       staff, on either the list preview or the field view.

   Enum spellings, labels and hold ceilings are IMPORTED from
   src/lib/moderation.js wherever it already publishes them, so the fixture and
   the UI can never drift into disagreeing about what a hold is called.
   ========================================================= */
import { agoIso, mockError, seeded, NO_CONTENT } from '../util.js'
import { routes as reelRoutes } from './reels.js'
import {
  BLOCKED_FALLBACK, CONTENT_REJECTED, ENTITY_LABEL, HOLD_CEILING_MS,
} from '../../lib/moderation.js'

/* =========================================================
   PART 1 — the fake classifier
   ========================================================= */

/* Exported so a handler in another fragment can screen its own create path
   without re-deriving the rule. Neither carries the /g flag: a global regex
   keeps `lastIndex` between calls and would then match every OTHER time. */
export const MOCK_BLOCK_MARKER = /\bblockme\b/i
export const MOCK_HOLD_MARKER = /\bholdme\b/i

/**
 * 'BLOCK' | 'HOLD' | null for any number of text parts (body, title, tags…).
 * Block wins over hold, exactly as a real verdict does: REJECT outranks REVIEW.
 */
export function fakeVerdict(...texts) {
  const joined = texts.filter(t => typeof t === 'string').join('\n')
  if (MOCK_BLOCK_MARKER.test(joined)) return 'BLOCK'
  if (MOCK_HOLD_MARKER.test(joined)) return 'HOLD'
  return null
}

/**
 * The refusal, in the exact envelope the live backend sends: 400 with
 * errorCode CONTENT_REJECTED. The copy is BLOCKED_FALLBACK imported from
 * src/lib/moderation.js — the same string the UI falls back to — so the two can
 * never drift apart, and a composer that (wrongly) branched on message text
 * would still be reading the real sentence.
 *
 * `throw blockedError()` — it returns, it does not throw, so the throw stays
 * visible at the call site.
 */
export function blockedError() {
  return mockError(400, CONTENT_REJECTED, BLOCKED_FALLBACK)
}

/**
 * The SAME refusal, arriving through the wrong door.
 *
 * `POST /api/v1/posts` with multipart/form-data wraps createPost in
 * `catch (Exception)`, so a moderation block — a BadRequestException — is
 * swallowed and re-emitted as
 *
 *     500 {"error":"post_create_failed","message":"<the moderation copy>","rolledBackFiles":N}
 *
 * with no errorCode and no 400. That leaves the message as the only thing
 * separating "we blocked you" from "the database fell over", and it is why
 * isBlocked() in src/lib/moderation.js carries its one sanctioned message sniff.
 *
 * Reproducing the quirk here rather than answering a clean 400 is the whole
 * point of mock mode: that sniff is the most fragile line in the feature, and
 * this is the only place it can be exercised without a live backend. A composer
 * that handles CONTENT_REJECTED but calls isBlocked() correctly still works; one
 * that branches on `e.code === 'CONTENT_REJECTED'` by hand finds out here.
 *
 * Delete this the day the backend narrows that catch — and delete the sniff too.
 */
export function multipartBlockedError() {
  const err = mockError(500, 'post_create_failed', BLOCKED_FALLBACK)
  /* http.js reads `errorCode` off the mock body, so the code above is what the
     ApiError carries; these two keys are here so the raw body a caller may
     inspect (`err.body`) looks like the real one rather than a tidied-up one. */
  err.__mockBody.error = 'post_create_failed'
  err.__mockBody.rolledBackFiles = 0
  return err
}

/**
 * How long a mocked hold lasts. Short enough that a reviewer sees the badge
 * clear inside one attention span, long enough that they see it AT ALL —
 * useHeldWatch's first re-check lands at 1200ms, so anything under ~2s would
 * clear before the badge finished animating in.
 */
export const MOCK_HOLD_MS = 6000

/* Internal bookkeeping parked on the fixture row. Underscore-prefixed like the
   fragment's other private fields (`_admins`, `_sinceAgo`): the wire builders
   list their keys explicitly, so nothing here can leak into a response. */
const HELD_AT = '_modHeldAt'
const HELD_PLAN = '_modHeldPlan'

/**
 * Mark a stored mock row as held and remember WHEN, so a later read can settle
 * it. No timer is used on purpose: a setTimeout would keep firing against a db
 * the reader may have already navigated away from, and it would settle a hold
 * nobody was watching. Holds expire when someone looks — which is also how the
 * real thing behaves from the client's side.
 */
export function holdRow(row, { field = 'status', held = 'PENDING_REVIEW', cleared = 'PUBLISHED' } = {}) {
  if (!row) return row
  row[field] = held
  row[HELD_AT] = Date.now()
  row[HELD_PLAN] = { field, cleared }
  return row
}

/**
 * Clear a hold that has outlived MOCK_HOLD_MS. Call it on the READ path — one
 * call in the wire builder covers every endpoint that can serve the row, which
 * is what makes the re-check loop in useHeldWatch actually resolve instead of
 * spinning to its ceiling and giving up.
 */
export function settleHold(row) {
  if (!row || !row[HELD_AT]) return row
  if (Date.now() - row[HELD_AT] < MOCK_HOLD_MS) return row
  const plan = row[HELD_PLAN] || { field: 'status', cleared: 'PUBLISHED' }
  row[plan.field] = plan.cleared
  delete row[HELD_AT]
  delete row[HELD_PLAN]
  return row
}

/* ---- stories -----------------------------------------------------------
   Story creation belongs to the REELS fragment (stories are its domain, not
   posts'), and the registry has no fall-through: the first pattern that matches
   answers, full stop. So to screen a story BEFORE a row is written, this module
   sits ABOVE reels in the table and hands the clean case straight back to the
   handler that owns the story's shape.

   Re-deriving StoryByAuthorEntity here instead would give mock mode two story
   builders that drift apart — precisely the failure the fixture exists to catch.
   Resolved by matching the PATH rather than by index, so reels can reorder its
   own table freely. */
function storyCreateHandler() {
  return reelRoutes.find(r => r.m === 'POST' && r.p.test('/api/v1/stories'))
}

/* =========================================================
   PART 2 — the admin console fixture
   ========================================================= */

/* ModerationLabel.wire(), in enum order. Every score map, threshold map and
   label total on this API is keyed by exactly these six, always all six. */
const LABELS = ['toxic', 'severe_toxic', 'obscene', 'threat', 'insult', 'identity_hate']

/* ModeratedEntityType, in enum order — lib/moderation.js already lists all 13
   because it needs their user-facing nouns. `key()` is the lowercased name
   (`post_comment`, not `post-comment`: the server parses it back with
   valueOf(), which is why a hyphen 400s). */
const ENTITY_TYPES = Object.keys(ENTITY_LABEL)
const key = (type) => type.toLowerCase()
const typeOfKey = (k) => ENTITY_TYPES.find(t => key(t) === String(k || '').toLowerCase()) || null

/* AdminAutoModerationController.REDACTED — byte for byte, em dash included.
   Staff never see a private message body, so the fixture must not either. */
const REDACTED = '[private message — body withheld from staff by policy]'
const PRIVATE_TEXT = new Set(['CHAT_MESSAGE', 'LIVE_CHAT'])

/* Ephemeral content is dropped rather than held past its own lifetime. */
const EPHEMERAL = new Set(['STORY', 'STORY_POLL', 'LIVE_CHAT'])

const round3 = (n) => Math.round(Number(n) * 1000) / 1000

/**
 * Spring's `default-property-inclusion: non_null`, reproduced. Drop every null
 * key rather than serialising it — the docs' examples show `"parentRef": null`
 * and the docs are wrong; the key is simply absent.
 */
function compact(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) if (v !== null && v !== undefined) out[k] = v
  return out
}

/* Ids are UUIDs on the wire, and a console will use them as React keys and put
   them in URLs, so the mock hands out real-shaped ones rather than `case-3`.
   Deterministic within a session; no dependency. */
let idSeq = 0
const mockUuid = () => `00000000-0000-4000-8000-${(++idSeq).toString(16).padStart(12, '0')}`

/* ---- the decision engine ----------------------------------------------
   Two bands per label: below `low` is APPROVE, at/above `high` is REJECT, and
   the gap between them is the hold. Reproducing it (rather than storing a
   verdict per row) is what makes the threshold editor and the dry-run screen
   mean something: move a band and the same stored scores really do flip. */
const DEFAULT_BANDS = {
  toxic: { low: 0.35, high: 0.80 },
  severe_toxic: { low: 0.25, high: 0.60 },
  obscene: { low: 0.40, high: 0.85 },
  threat: { low: 0.25, high: 0.55 },
  insult: { low: 0.40, high: 0.82 },
  identity_hate: { low: 0.25, high: 0.60 },
}

/** ModerationVerdict + the label that carried the case (`case.maxLabel`). */
function evaluate(scores, bands) {
  let verdict = 'APPROVE'
  let topLabel = null
  let topScore = 0
  for (const label of LABELS) {
    const s = Number(scores?.[label]) || 0
    if (s > topScore) { topScore = s; topLabel = label }
    const band = bands?.[label] || DEFAULT_BANDS[label]
    if (s >= band.high) verdict = 'REJECT'
    else if (s >= band.low && verdict !== 'REJECT') verdict = 'REVIEW'
  }
  return { verdict, topLabel, topScore: round3(topScore) }
}

/**
 * A full six-label score vector from one stored (label, score) pair.
 *
 * The other five are DERIVED, not stored: a real vector always has a value for
 * every label, and hand-writing twelve complete vectors would be noise nobody
 * reads. `seeded()` keeps them stable across reloads so the detail panel does
 * not reshuffle under the reviewer between two clicks.
 */
function scoreVector(seed, topLabel, topScore) {
  const out = {}
  for (const label of LABELS) {
    out[label] = label === topLabel ? round3(topScore) : round3(seeded(`${seed}:${label}`) * 0.26)
  }
  return out
}

/* ---- the queue fixture -------------------------------------------------
   Twelve cases spread across the entity types a moderator actually meets, with
   the awkward ones deliberately included: two redacted private-text cases, one
   blocklist hit with no model label at all, one INFERENCE_UNAVAILABLE case that
   was held because nothing answered, two already-decided rows, and three that
   have breached their SLA. A queue of twelve happy POSTs would let a console
   ship that cannot render any of the above.

   `entityRef` values point at real fixture rows wherever one exists, so a
   "open the content" link in the console lands on a page instead of a 404. */
const SEED_CASES = [
  {
    caseId: 'a1c07f7e-9d2b-4f31-9b41-0c1d5e2a7001',
    entityType: 'POST', entityRef: 'p-4', authorId: 'u-karwan',
    status: 'IN_REVIEW', reasonCode: 'MODEL', modelVersion: 'v2',
    submittedMinsAgo: 3, slaBreached: false, authorPriorRejections: 0,
    fields: [{
      fieldName: 'textContent', topLabel: 'insult', topScore: 0.71,
      text: 'Anyone still citing that 1998 edition is frankly beyond help and has no business teaching a seminar.',
    }],
  },
  {
    caseId: 'a1c07f7e-9d2b-4f31-9b41-0c1d5e2a7002',
    entityType: 'POST_COMMENT', entityRef: 'c-2', parentRef: 'p-1', authorId: 'u-omar',
    status: 'IN_REVIEW', reasonCode: 'MODEL', modelVersion: 'v2',
    submittedMinsAgo: 41, slaBreached: true, authorPriorRejections: 2,
    fields: [{
      fieldName: 'textContent', topLabel: 'toxic', topScore: 0.83,
      text: 'This is the single stupidest reading of the passage I have ever had the misfortune to scroll past.',
    }],
  },
  {
    /* Private text. The preview AND the field body are withheld — a moderator
       decides this one on scores and prior history alone, by policy. */
    caseId: 'a1c07f7e-9d2b-4f31-9b41-0c1d5e2a7003',
    entityType: 'CHAT_MESSAGE', entityRef: 'm-118', parentRef: 'cv-3', authorId: 'u-dilan',
    status: 'IN_REVIEW', reasonCode: 'MODEL', modelVersion: 'v2',
    submittedMinsAgo: 8, slaBreached: false, authorPriorRejections: 1,
    fields: [{
      fieldName: 'body', topLabel: 'threat', topScore: 0.66,
      text: 'If you post that again I will make sure you regret it.',
    }],
  },
  {
    caseId: 'a1c07f7e-9d2b-4f31-9b41-0c1d5e2a7004',
    entityType: 'QNA_ANSWER', entityRef: 'a-maslaha-2', parentRef: 'q-usul-maslaha', authorId: 'u-mehmet',
    status: 'IN_REVIEW', reasonCode: 'MODEL', modelVersion: 'v2',
    submittedMinsAgo: 19, slaBreached: false, authorPriorRejections: 0,
    fields: [{
      fieldName: 'body', topLabel: 'obscene', topScore: 0.52,
      text: 'The whole argument is garbage dressed up in footnotes, and the author knows it.',
    }],
  },
  {
    /* Nothing answered inside the ceiling, so FAIL_CLOSED held it. There is no
       model label and no score — the console must not assume either exists. */
    caseId: 'a1c07f7e-9d2b-4f31-9b41-0c1d5e2a7005',
    entityType: 'RESEARCH', entityRef: 'r-isnad-anatolia', authorId: 'u-zeynep',
    status: 'IN_REVIEW', reasonCode: 'INFERENCE_UNAVAILABLE',
    submittedMinsAgo: 74, slaBreached: true, authorPriorRejections: 0,
    fields: [{
      fieldName: 'abstract', topLabel: null, topScore: 0,
      text: 'A survey of isnad transmission across Anatolian madrasas between 1490 and 1560, with a revised chain table.',
    }],
  },
  {
    caseId: 'a1c07f7e-9d2b-4f31-9b41-0c1d5e2a7006',
    entityType: 'STORY', entityRef: 's-karwan-1', authorId: 'u-karwan',
    status: 'PENDING', reasonCode: 'MODEL', modelVersion: 'v2',
    submittedMinsAgo: 1, slaBreached: false, authorPriorRejections: 0,
    fields: [{
      fieldName: 'textContent', topLabel: 'identity_hate', topScore: 0.44,
      text: 'People from that valley have never contributed a single readable manuscript.',
    }],
  },
  {
    /* A blocklist hit: settled by the keyword list, so there is a
       `blocklistHit` and NO model label. reasonCode says which one decided. */
    caseId: 'a1c07f7e-9d2b-4f31-9b41-0c1d5e2a7007',
    entityType: 'CHANNEL', entityRef: 'ch-ethics', authorId: 'u-hana',
    status: 'IN_REVIEW', reasonCode: 'BLOCKLIST',
    blocklistHit: 'freeviagra', modelVersion: 'v2',
    submittedMinsAgo: 27, slaBreached: false, authorPriorRejections: 0,
    fields: [{
      fieldName: 'description', topLabel: null, topScore: 0, blocklistHit: 'freeviagra',
      text: 'Ethics reading group — weekly. freeviagra promo codes in the pinned post.',
    }],
  },
  {
    /* Private text again, and the severest score in the queue: this is the row
       that proves the console can rank on scores it cannot read the source of. */
    caseId: 'a1c07f7e-9d2b-4f31-9b41-0c1d5e2a7008',
    entityType: 'LIVE_CHAT', entityRef: 'lc-2201', parentRef: 's-usul-live', authorId: 'u-halil',
    status: 'IN_REVIEW', reasonCode: 'MODEL', modelVersion: 'v2',
    submittedMinsAgo: 55, slaBreached: true, authorPriorRejections: 4,
    fields: [{
      fieldName: 'text', topLabel: 'severe_toxic', topScore: 0.91,
      text: 'Get off this stream before someone makes you.',
    }],
  },
  {
    /* Already approved by a human — the row keeps `decidedAt` and flips its
       reasonCode to ADMIN. Present so the console's "decided" filter is not
       an empty screen on first load. */
    caseId: 'a1c07f7e-9d2b-4f31-9b41-0c1d5e2a7009',
    entityType: 'QNA_QUESTION', entityRef: 'q-hadith-mursal', authorId: 'u-yusuf',
    status: 'APPROVED', reasonCode: 'ADMIN', modelVersion: 'v2',
    submittedMinsAgo: 190, decidedMinsAgo: 172, slaBreached: false, authorPriorRejections: 0,
    reason: 'Sharp, not abusive. Cleared.',
    fields: [{
      fieldName: 'title', topLabel: 'insult', topScore: 0.46,
      text: 'Why do so many summaries of mursal hadith get the chain wrong?',
    }],
  },
  {
    caseId: 'a1c07f7e-9d2b-4f31-9b41-0c1d5e2a700a',
    entityType: 'RESEARCH_COMMENT', entityRef: 'rcm-2', parentRef: 'r-maqasid-councils', authorId: 'u-omar',
    status: 'REJECTED', reasonCode: 'ADMIN', modelVersion: 'v2',
    submittedMinsAgo: 320, decidedMinsAgo: 300, slaBreached: false, authorPriorRejections: 3,
    reason: 'Third strike on the same thread.',
    fields: [{
      fieldName: 'textContent', topLabel: 'insult', topScore: 0.88,
      text: 'You are a fraud and everyone in this field knows it.',
    }],
  },
  {
    caseId: 'a1c07f7e-9d2b-4f31-9b41-0c1d5e2a700b',
    entityType: 'STREAM_META', entityRef: 's-manuscript-lab', authorId: 'u-amina',
    status: 'IN_REVIEW', reasonCode: 'MODEL', modelVersion: 'v2',
    submittedMinsAgo: 12, slaBreached: false, authorPriorRejections: 0,
    fields: [
      { fieldName: 'title', topLabel: 'toxic', topScore: 0.39, text: 'Manuscript lab — bring your worst transcription' },
      { fieldName: 'description', topLabel: 'toxic', topScore: 0.21, text: 'Open session, no booking, cameras optional.' },
    ],
  },
  {
    /* A multi-field case with a repeated field: the index suffix on
       `option[1]` is the server's own naming and a console that assumes one
       field per case renders this one wrong. */
    caseId: 'a1c07f7e-9d2b-4f31-9b41-0c1d5e2a700c',
    entityType: 'STORY_POLL', entityRef: 'sp-14', parentRef: 's-amina-2', authorId: 'u-amina',
    status: 'PENDING', reasonCode: 'MODEL', modelVersion: 'v2',
    submittedMinsAgo: 2, slaBreached: false, authorPriorRejections: 0,
    fields: [
      { fieldName: 'question', topLabel: 'toxic', topScore: 0.18, text: 'Which edition should we drop?' },
      { fieldName: 'option[0]', topLabel: 'toxic', topScore: 0.12, text: 'The Cairo print' },
      { fieldName: 'option[1]', topLabel: 'insult', topScore: 0.47, text: 'The useless Istanbul reprint nobody proofread' },
    ],
  },
]

/* ---- training data ----------------------------------------------------
   Twenty-two rows, because the retrain endpoint refuses a dataset under twenty
   (`TRAINING_DATASET_TOO_SMALL`) and a mock where the primary button always
   errors teaches the wrong thing about the screen. Deleting three rows in the
   console puts you back under the floor, which is the honest way to see that
   error. Texts are blunt but non-slur on purpose — this is a fixture, not a
   corpus. */
const SEED_EXAMPLES = [
  { text: 'You are a complete idiot and everyone can see it.', labels: ['toxic', 'insult'], source: 'SEED_DATASET' },
  { text: 'What a pathetic excuse for an argument.', labels: ['toxic', 'insult'], source: 'SEED_DATASET' },
  { text: 'Shut up, nobody asked you.', labels: ['toxic'], source: 'SEED_DATASET' },
  { text: 'I will find you and you will regret posting that.', labels: ['toxic', 'threat', 'severe_toxic'], source: 'SEED_DATASET' },
  { text: 'People from that country should not be allowed to publish here.', labels: ['toxic', 'identity_hate'], source: 'SEED_DATASET' },
  { text: 'Your whole community is a plague on this field.', labels: ['toxic', 'identity_hate', 'severe_toxic'], source: 'SEED_DATASET' },
  { text: 'This edition is filthy garbage and so is its editor.', labels: ['toxic', 'obscene', 'insult'], source: 'SEED_DATASET' },
  { text: 'Get out before someone throws you out.', labels: ['toxic', 'threat'], source: 'SEED_DATASET' },
  { text: 'The chain of transmission is reconstructed from three surviving copies.', labels: [], source: 'SEED_DATASET' },
  { text: 'I disagree with the dating, but the argument is careful.', labels: [], source: 'SEED_DATASET' },
  { text: 'Could you share the colophon photograph at higher resolution?', labels: [], source: 'SEED_DATASET' },
  { text: 'This reading is weak and I think the footnotes show why.', labels: [], source: 'SEED_DATASET' },
  { text: 'Excellent catch on the marginalia — that changes the stemma.', labels: [], source: 'SEED_DATASET' },
  { text: 'The seminar starts at four in the small reading room.', labels: [], source: 'SEED_DATASET' },
  { text: 'Nobody in their right mind cites this rubbish.', labels: ['toxic', 'insult'], source: 'ADMIN_MANUAL', note: 'From the 2026-07 review sweep.' },
  { text: 'You are a fraud and everyone in this field knows it.', labels: ['toxic', 'insult'], source: 'ADMIN_CORRECTION', note: 'Promoted from case …700a.' },
  { text: 'Anyone still citing that edition is beyond help.', labels: ['insult'], source: 'ADMIN_CORRECTION', note: 'Promoted from case …7001.' },
  { text: 'Reported three times for the same slur pattern.', labels: ['toxic', 'identity_hate'], source: 'USER_REPORT_CONFIRMED' },
  { text: 'Repeated harassment across four threads.', labels: ['toxic', 'severe_toxic'], source: 'USER_REPORT_CONFIRMED' },
  { text: 'The transcription conventions follow the Leiden system.', labels: [], source: 'REVIEW_PROMOTION' },
  { text: 'Please stop replying to every one of my posts.', labels: [], source: 'REVIEW_PROMOTION', note: 'False positive; kept as a negative.' },
  /* The demo marker, in the dataset, so the tie between the fake classifier and
     the training screen is visible rather than folklore. */
  { text: 'blockme', labels: ['toxic', 'severe_toxic', 'obscene', 'insult'], source: 'ADMIN_MANUAL', note: 'Mock-mode marker word — see handlers/moderation.js.' },
]

const SEED_GOLDEN = [
  { text: 'You are a complete idiot and everyone can see it.', labels: ['toxic', 'insult'], note: 'Baseline insult.' },
  { text: 'I will find you and you will regret posting that.', labels: ['toxic', 'threat', 'severe_toxic'], note: 'Must never fall below REJECT.' },
  { text: 'This reading is weak and I think the footnotes show why.', labels: [], note: 'Must never be held — blunt but civil.' },
  { text: 'Could you share the colophon photograph at higher resolution?', labels: [], note: 'Clean control.' },
]

/* Four versions, chosen so every branch of the registry screen is reachable:
   v1 RETIRED is the rollback target, v2 is ACTIVE, v3 is READY and promotes
   cleanly, and v3-rc1 is READY but failed its gate — promoting it answers
   MODEL_GATE_FAILED until `force` is sent. No TRAINING row is seeded on
   purpose: one would make every retrain answer TRAINING_ALREADY_RUNNING and
   the happy path would be unreachable. */
const SEED_VERSIONS = [
  {
    id: 'b2d18a10-4e55-4a02-9c77-000000000001', version: 'v1', status: 'RETIRED',
    jobId: 'job-2026-05-11-01', baseCheckpoint: 'distilbert-base-multilingual',
    trainingExamples: 812, validationCount: 204, macroF1: 0.791, gatePassed: true,
    gateDetail: 'Passed: macro-F1 +0.000 vs baseline, 0 golden regressions.',
    artifactPath: 's3://ika-models/moderation/v1', notes: 'First production model.',
    trainedMinsAgo: 129600, completedMinsAgo: 129480, promotedMinsAgo: 129400,
  },
  {
    id: 'b2d18a10-4e55-4a02-9c77-000000000002', version: 'v2', status: 'ACTIVE',
    jobId: 'job-2026-06-30-03', baseCheckpoint: 'v1',
    trainingExamples: 1146, validationCount: 287, macroF1: 0.834, gatePassed: true,
    gateDetail: 'Passed: macro-F1 +0.043 vs v1, 0 golden regressions.',
    artifactPath: 's3://ika-models/moderation/v2', notes: 'Adds Kurdish and Turkish negatives.',
    trainedMinsAgo: 55000, completedMinsAgo: 54880, promotedMinsAgo: 54700,
  },
  {
    id: 'b2d18a10-4e55-4a02-9c77-000000000003', version: 'v3', status: 'READY',
    jobId: 'job-2026-08-02-01', baseCheckpoint: 'v2',
    trainingExamples: 1291, validationCount: 322, macroF1: 0.842, gatePassed: true,
    gateDetail: 'Passed: macro-F1 +0.008 vs v2, 0 golden regressions.',
    artifactPath: 's3://ika-models/moderation/v3', notes: 'Awaiting human promotion.',
    trainedMinsAgo: 8600, completedMinsAgo: 8480,
  },
  {
    id: 'b2d18a10-4e55-4a02-9c77-000000000004', version: 'v3-rc1', status: 'READY',
    jobId: 'job-2026-07-28-02', baseCheckpoint: 'v2',
    trainingExamples: 1204, validationCount: 301, macroF1: 0.802, gatePassed: false,
    gateDetail: 'Blocked: macro-F1 -0.032 vs v2 (limit -0.020); 2 golden-case regressions.',
    artifactPath: 's3://ika-models/moderation/v3-rc1', notes: 'Kept for comparison.',
    trainedMinsAgo: 15200, completedMinsAgo: 15060,
  },
]

/* A handful of raw override rows, so the settings screen does not open on an
   empty map. Values are ALWAYS strings — that is the storage column, and a
   console that expects a number here breaks against the real API too. */
const SEED_OVERRIDES = {
  'threshold.research.insult.low': '0.45',
  'hold.live_chat.ms': '4000',
  'fallback.live_chat': 'FAIL_OPEN_SHADOW',
}

/* ---- the mutable store ------------------------------------------------- */

function expandLabels(list) {
  const out = {}
  for (const label of LABELS) out[label] = list?.includes(label) ? 1 : 0
  return out
}

/** `trim().toLowerCase().replaceAll(/\s+/, ' ')` — the server's dedup key. */
const normalizeText = (text) => String(text || '').trim().toLowerCase().replace(/\s+/g, ' ')

/** Not a real SHA-256: the console only ever displays it or de-dupes on it, and
 *  shipping a hash implementation into a fixture would be absurd. Shaped like
 *  one (64 lowercase hex) because that is what the column holds. */
function textHash(text) {
  const norm = normalizeText(text)
  let out = ''
  for (let i = 0; out.length < 64; i++) {
    out += Math.floor(seeded(`${norm}#${i}`) * 0xffffffff).toString(16).padStart(8, '0')
  }
  return out.slice(0, 64)
}

function exampleRow(seed) {
  return {
    id: mockUuid(),
    text: seed.text,
    labels: expandLabels(seed.labels),
    source: seed.source || 'ADMIN_MANUAL',
    note: seed.note || null,
    trainedInVersion: seed.source === 'SEED_DATASET' ? 'v2' : null,
    addedMinsAgo: seed.addedMinsAgo ?? 4000 + Math.floor(seeded(seed.text) * 40000),
  }
}

function goldenRow(seed) {
  const labels = expandLabels(seed.labels)
  return {
    id: mockUuid(),
    text: seed.text,
    textHash: textHash(seed.text),
    toxic: labels.toxic,
    severeToxic: labels.severe_toxic,
    obscene: labels.obscene,
    threat: labels.threat,
    insult: labels.insult,
    identityHate: labels.identity_hate,
    note: seed.note || null,
    addedBy: 'u-amina',
    addedMinsAgo: seed.addedMinsAgo ?? 20000,
  }
}

/** The whole admin fixture, created once per session and mutated in place.
 *  Parked on `db` (not on a module variable) so the demo escape hatch
 *  `window.__ikaMockDb` can reach it and so a fixture reload really resets it. */
function store(db) {
  if (!db._moderation) {
    db._moderation = {
      cases: SEED_CASES.map(c => ({ ...c, fields: c.fields.map(f => ({ ...f })) })),
      examples: SEED_EXAMPLES.map(exampleRow),
      golden: SEED_GOLDEN.map(goldenRow),
      versions: SEED_VERSIONS.map(v => ({ ...v })),
      overrides: { ...SEED_OVERRIDES },
    }
  }
  return db._moderation
}

/* ---- effective settings ------------------------------------------------ */

const num = (v, fallback) => (v == null || v === '' || Number.isNaN(Number(v)) ? fallback : Number(v))

/** Bands for one entity type: per-type override beats global override beats
 *  the built-in default, label by label — the server resolves each of the four
 *  numbers independently, so a half-written override is a real state. */
function bandsFor(st, typeKey) {
  const ov = st.overrides
  const out = {}
  for (const label of LABELS) {
    const base = DEFAULT_BANDS[label]
    out[label] = {
      low: num(ov[`threshold.${typeKey}.${label}.low`] ?? ov[`threshold.${label}.low`], base.low),
      high: num(ov[`threshold.${typeKey}.${label}.high`] ?? ov[`threshold.${label}.high`], base.high),
    }
  }
  return out
}

const holdMsFor = (st, type) => num(st.overrides[`hold.${key(type)}.ms`], HOLD_CEILING_MS[type] ?? 30000)

/** `inlineMs` is validated NOWHERE on write and clamped only on read:
 *  max(100, min(value, max(200, ceiling / 2))). Reproduced so a console that
 *  writes 9_000_000 sees what the server would actually serve back. */
function inlineMsFor(st, type) {
  const hold = holdMsFor(st, type)
  const raw = num(st.overrides[`inline.${key(type)}.ms`], Math.round(hold / 4))
  return Math.max(100, Math.min(raw, Math.max(200, Math.round(hold / 2))))
}

/** FallbackPolicy. Hyphens survive the WRITE (a backend quirk: validation
 *  normalises, storage does not) and are re-normalised on the read side — so
 *  `overrides` can show `FAIL-OPEN-SHADOW` while `effective` shows the enum. */
const fallbackFor = (st, type) =>
  String(st.overrides[`fallback.${key(type)}`] || 'FAIL_CLOSED').toUpperCase().replace(/-/g, '_')

function effectiveSettings(st) {
  const entityTypes = {}
  for (const type of ENTITY_TYPES) {
    const k = key(type)
    entityTypes[k] = {
      enabled: st.overrides[`enabled.${k}`] !== 'false',
      holdMs: holdMsFor(st, type),
      inlineMs: inlineMsFor(st, type),
      fallback: fallbackFor(st, type),
      ephemeral: EPHEMERAL.has(type),
      thresholds: bandsFor(st, k),
    }
  }
  /* The dotted keys are LITERAL JSON keys, not nesting. Quoting them here is
     the only way to say that in JS, and it is what the wire looks like. */
  return {
    enabled: st.overrides.enabled !== 'false',
    'livechat.buffer.ms': num(st.overrides['livechat.buffer.ms'], 1500),
    'livechat.borderline.hidden': st.overrides['livechat.borderline.hidden'] !== 'false',
    'retrain.max-f1-drop': num(st.overrides['retrain.max-f1-drop'], 0.02),
    'retrain.require-human-promote': st.overrides['retrain.require-human-promote'] !== 'false',
    entityTypes,
  }
}

function modelHealth(st) {
  const active = st.versions.find(v => v.status === 'ACTIVE')
  return compact({
    inferenceUp: true,
    residentVersion: active?.version || null,
    circuit: 'CLOSED',
    calls: 18432,
    failures: 7,
    avgLatencyMs: 24,
    trainingUp: true,
    activeVersion: active ? {
      version: active.version,
      macroF1: active.macroF1,
      promotedAt: agoIso(active.promotedMinsAgo),
      trainingExamples: active.trainingExamples,
    } : null,
    registryInSync: true,
  })
}

/* ---- wire builders ----------------------------------------------------- */

/* A field with no top label never reached the model (a blocklist hit, or a case
   opened by an SLA breach while inference was down). The live API answers those
   with an EMPTY score map, and the console has a whole branch for it — "we could
   not read it" rather than six 0.00 bars. Fabricating a vector here would make
   that branch permanently unreachable and quietly assert the model always ran. */
const fieldScores = (c, f) => (f.topLabel ? scoreVector(`${c.caseId}:${f.fieldName}`, f.topLabel, f.topScore || 0) : {})

/** The strongest field carries the case — `case.maxLabel` / `case.maxScore`. */
function caseTop(c) {
  let topLabel = null
  let topScore = 0
  for (const f of c.fields || []) {
    if ((f.topScore || 0) > topScore) { topScore = f.topScore || 0; topLabel = f.topLabel || null }
  }
  return { topLabel, topScore: round3(topScore) }
}

/** 200 chars then a single ellipsis — and nothing at all for private text. */
function previewOf(c) {
  if (PRIVATE_TEXT.has(c.entityType)) return REDACTED
  const text = c.fields?.[0]?.text || ''
  return text.length <= 200 ? text : `${text.slice(0, 200)}…`
}

function queueRow(st, c) {
  const top = caseTop(c)
  return compact({
    caseId: c.caseId,
    entityType: c.entityType,                            // UPPERCASE enum name
    entityLabel: ENTITY_LABEL[c.entityType] || 'content',
    entityRef: c.entityRef,
    parentRef: c.parentRef ?? null,
    authorId: c.authorId ?? null,
    status: c.status,
    reasonCode: c.reasonCode ?? null,
    topLabel: top.topLabel,
    topScore: top.topScore,                              // Double, defaults 0.0
    blocklistHit: c.blocklistHit ?? null,
    slaBreached: !!c.slaBreached,                        // primitive: always present
    modelVersion: c.modelVersion ?? null,
    submittedAt: agoIso(c.submittedMinsAgo),
    /* submittedAt + the type's CURRENT ceiling, so editing a hold duration in
       the settings screen visibly moves the deadlines in the queue. */
    holdDeadline: agoIso(c.submittedMinsAgo - holdMsFor(st, c.entityType) / 60000),
    decidedAt: c.decidedMinsAgo == null ? null : agoIso(c.decidedMinsAgo),
    preview: previewOf(c),
    authorPriorRejections: c.authorPriorRejections || 0, // primitive: always present
  })
}

function fieldView(st, c, f) {
  const scores = fieldScores(c, f)
  /* No scores → no verdict to derive. `verdict` is nullable on the wire and
     compact() drops it, which is exactly what the server sends for a field the
     classifier never saw. */
  const verdict = Object.keys(scores).length
    ? evaluate(scores, bandsFor(st, key(c.entityType))).verdict
    : null
  return compact({
    fieldName: f.fieldName,
    /* Redaction is per ENTITY TYPE, not per field: a chat message has no
       public field, so every one of them is withheld. */
    text: PRIVATE_TEXT.has(c.entityType) ? REDACTED : f.text,
    verdict,
    topLabel: f.topLabel ?? null,
    topScore: round3(f.topScore || 0),
    scores,                                              // {} would still be a map
    blocklistHit: f.blocklistHit ?? null,
  })
}

function versionView(v) {
  return compact({
    id: v.id,
    version: v.version,
    status: v.status,
    jobId: v.jobId ?? null,
    baseCheckpoint: v.baseCheckpoint ?? null,
    trainingExamples: v.trainingExamples || 0,           // primitive
    validationCount: v.validationCount || 0,             // primitive
    macroF1: v.macroF1 ?? null,
    gatePassed: v.gatePassed ?? null,
    gateDetail: v.gateDetail ?? null,
    artifactPath: v.artifactPath ?? null,
    notes: v.notes ?? null,
    error: v.error ?? null,
    trainedAt: v.trainedMinsAgo == null ? null : agoIso(v.trainedMinsAgo),
    completedAt: v.completedMinsAgo == null ? null : agoIso(v.completedMinsAgo),
    promotedAt: v.promotedMinsAgo == null ? null : agoIso(v.promotedMinsAgo),
  })
}

const exampleView = (e) => compact({
  id: e.id,
  text: e.text,
  labels: e.labels,                                      // always all six, 0/1
  source: e.source,
  note: e.note ?? null,
  trainedInVersion: e.trainedInVersion ?? null,
  addedAt: agoIso(e.addedMinsAgo),
})

/** Golden cases serialise the RAW entity: camelCase columns, not wire labels.
 *  The request that creates one uses wire labels. That asymmetry is real. */
const goldenView = (g) => compact({
  id: g.id, text: g.text, textHash: g.textHash,
  toxic: g.toxic, severeToxic: g.severeToxic, obscene: g.obscene,
  threat: g.threat, insult: g.insult, identityHate: g.identityHate,
  note: g.note ?? null, addedBy: g.addedBy ?? null, addedAt: agoIso(g.addedMinsAgo),
})

/* ---- shared guards ----------------------------------------------------- */

const badSetting = (msg) => mockError(400, 'INVALID_MODERATION_SETTING', msg)

/** The step-up window is `db.security.stepUpArmedUntil`, armed by
 *  POST /security/step-up in the platform fragment. Re-checked (not imported)
 *  because `db` is the sanctioned channel between fragments and a four-line
 *  guard is cheaper than a cross-module dependency. */
function requireStepUp(db) {
  const until = db.security?.stepUpArmedUntil
  if (!until || Date.now() > until) {
    throw mockError(403, 'STEP_UP_REQUIRED', 'Confirm it is you before continuing.')
  }
}

function requireCase(st, caseId) {
  const c = st.cases.find(x => x.caseId === caseId)
  if (!c) throw mockError(400, 'MODERATION_CASE_NOT_FOUND', `Moderation case not found: ${caseId}`)
  return c
}

/** APPROVE | REJECT, or the server's exact refusal. */
function parseAction(raw) {
  const action = String(raw || '').trim().toUpperCase()
  if (action !== 'APPROVE' && action !== 'REJECT') {
    throw mockError(400, 'INVALID_MODERATION_ACTION', 'Unknown action. Allowed: APPROVE, REJECT.')
  }
  return action
}

/** `page`/`pageSize` with the per-endpoint default and Pages.clamp's [1,100]. */
function pageArgs(query = {}, defSize = 50) {
  const p = Math.max(0, Number(query.page ?? 0) || 0)
  const raw = Number(query.pageSize ?? query.size ?? defSize) || defSize
  return { p, size: Math.max(1, Math.min(raw, 100)) }
}

function applyDecision(st, c, action, reason, teachModel) {
  c.status = action === 'APPROVE' ? 'APPROVED' : 'REJECTED'
  c.reasonCode = 'ADMIN'
  c.reason = reason || null
  c.slaBreached = false                                  // a human decision clears the breach flag
  c.decidedMinsAgo = 0
  /* teachModel is SILENTLY IGNORED for private text — the body staff never saw
     cannot become a training row — and the call still reports success. */
  if (teachModel === true && !PRIVATE_TEXT.has(c.entityType)) {
    const text = c.fields?.[0]?.text
    if (text) {
      const top = caseTop(c)
      /* Through upsertExample, not a raw unshift: the server dedupes on a
         normalized hash of the text, so promoting the same case twice UPDATES
         one row rather than growing a second. A fixture that duplicates would
         teach this screen that the dataset counter moves when it does not. */
      upsertExample(st, {
        text,
        labels: action === 'REJECT' && top.topLabel ? ['toxic', top.topLabel] : [],
        source: 'ADMIN_CORRECTION',
        note: `Promoted from case ${c.caseId.slice(0, 8)}.`,
      })
    }
  }
  return c
}

/** Re-run the engine over the stored scores with the CURRENT bands. This is
 *  the tie that makes the threshold editor demoable: widen a band, rescore, and
 *  the same case really does settle differently. */
function rescoreCase(st, c) {
  const bands = bandsFor(st, key(c.entityType))
  let verdict = 'APPROVE'
  for (const f of c.fields || []) {
    const scores = fieldScores(c, f)
    if (!Object.keys(scores).length) continue     // never scored — an empty map is not an APPROVE
    const v = evaluate(scores, bands).verdict
    if (v === 'REJECT') verdict = 'REJECT'
    else if (v === 'REVIEW' && verdict !== 'REJECT') verdict = 'REVIEW'
  }
  c.status = verdict === 'REJECT' ? 'REJECTED' : verdict === 'REVIEW' ? 'IN_REVIEW' : 'APPROVED'
  c.reasonCode = 'MODEL'
  if (c.status !== 'IN_REVIEW') c.decidedMinsAgo = 0
  return c.status
}

function datasetSummary(st) {
  const labelTotals = {}
  for (const label of LABELS) labelTotals[label] = st.examples.filter(e => e.labels[label] === 1).length
  const bySource = {}
  for (const s of ['SEED_DATASET', 'ADMIN_MANUAL', 'ADMIN_CORRECTION', 'REVIEW_PROMOTION', 'USER_REPORT_CONFIRMED']) {
    bySource[s] = st.examples.filter(e => e.source === s).length
  }
  return {
    total: st.examples.length,
    untrained: st.examples.filter(e => !e.trainedInVersion).length,
    goldenCases: st.golden.length,
    labelTotals,
    bySource,
  }
}

/** Global, NOT filtered by the caller's query — the counts are the whole queue's
 *  and a console that recomputes them from `items` will disagree with the
 *  server the moment a filter is on. */
function queueCounts(st) {
  return {
    inReview: st.cases.filter(c => c.status === 'IN_REVIEW').length,
    pending: st.cases.filter(c => c.status === 'PENDING').length,
    slaBreached: st.cases.filter(c => c.status === 'IN_REVIEW' && c.slaBreached).length,
  }
}

/** Upsert on the normalised-text hash, exactly as the server does: re-posting
 *  the same sentence UPDATES its labels and resets `trainedInVersion`. */
function upsertExample(st, { text, labels, note, source = 'ADMIN_MANUAL' }) {
  const hash = textHash(text)
  const existing = st.examples.find(e => textHash(e.text) === hash)
  const row = existing || exampleRow({ text, labels: [], source, addedMinsAgo: 0 })
  row.text = text
  row.labels = coerceLabels(labels)
  row.note = note || row.note || null
  row.source = source
  row.trainedInVersion = null
  if (!existing) st.examples.unshift(row)
  return row
}

/** `flag()` — Boolean true, a Number above zero, or the strings "1"/"true".
 *  Anything else (including "yes", including 0) is a zero. Keys must be the
 *  six wire names EXACTLY; there is no alias lookup on this path. */
function coerceLabels(input) {
  const out = {}
  for (const label of LABELS) {
    const v = input?.[label]
    out[label] = (v === true || (typeof v === 'number' && v > 0) || v === '1' || v === 'true') ? 1 : 0
  }
  return out
}

/* =========================================================
   ROUTES — most specific pattern first.
   ---------------------------------------------------------
   `/review/metrics` and `/review/bulk` are literal segments that must be
   matched BEFORE `/review/{caseId}`, exactly as Spring's PathPattern matcher
   prefers them. Everything else is anchored, so ordering is cosmetic.
   ========================================================= */
const ADMIN = '\\/api\\/v1\\/admin\\/moderation'

export const routes = [
  /* ---- the fake classifier on the story create path -------------------
     See storyCreateHandler() above for why this route lives here and not in
     the fragment that owns stories. */
  {
    m: 'POST', p: /^\/api\/v1\/stories$/,
    fn: (db, ctx) => {
      const body = ctx.body
      const form = !!body && typeof body.get === 'function'
      const text = String((form ? body.get('textContent') : body?.textContent) || '')
      const verdict = fakeVerdict(text)
      if (verdict === 'BLOCK') throw blockedError()

      const owner = storyCreateHandler()
      if (!owner) throw mockError(500, 'MOCK_FIXTURE_BROKEN', 'The story create handler moved; moderation.js can no longer delegate to it.')
      const story = owner.fn(db, ctx)

      /* Stories carry `moderationStatus`, NOT `status` — StoryByAuthorEntity
         has its own column and the two spellings are not interchangeable
         (lib/moderation.js reads moderationStatus first for exactly this).

         The marker goes on the STORED row, not just on this response: reels'
         storyEntity() settles the hold on read and carries the marker through,
         so the by-author re-list keeps saying PENDING until the fake hold
         expires. Stamping only the response would make the very first re-check
         report "cleared" and the badge would blink out in under two seconds —
         a hold nobody can actually see is not a rehearsal of anything.
         holdRow's defaults are for posts, so the field/held/cleared triple is
         passed explicitly. */
      if (verdict !== 'HOLD') return story
      const row = (db.stories?.[story.authorId] || []).find(x => String(x.storyId) === String(story.storyId))
      if (row) holdRow(row, { field: 'moderationStatus', held: 'PENDING', cleared: null })
      return { ...story, moderationStatus: 'PENDING' }
    },
  },

  /* ---- §1 review queue ------------------------------------------------- */
  {
    m: 'GET', p: new RegExp(`^${ADMIN}\\/review\\/metrics$`),
    fn: (db, { query }) => {
      const st = store(db)
      /* `windowHours` is clamped to >= 1 for the window but ECHOED RAW, so a
         console sending 0 gets `windowHours: 0` back over a one-hour window. */
      const windowHours = Number(query.windowHours ?? 24) || 24
      const byEntityType = {}
      for (const type of ENTITY_TYPES) {
        const inner = {}
        for (const c of st.cases.filter(x => x.entityType === type)) {
          inner[c.status] = (inner[c.status] || 0) + 1
        }
        byEntityType[key(type)] = inner            // all 13 keys, inner may be {}
      }
      return {
        windowHours,
        enabled: st.overrides.enabled !== 'false',
        queue: queueCounts(st),
        /* Volume, bands, labels and SLA are STATIC demo aggregates. A twelve-row
           queue cannot produce a believable 24h histogram, and inventing one
           from it would put "submitted: 12" on a dashboard that is supposed to
           read like a busy platform. The queue counts and the dataset counts
           above and below ARE derived, so decisions still move real numbers. */
        volume: { submitted: 41207, byEntityType },
        bands: {
          autoApproved: 39118,
          autoRejected: 1642,
          sentToReview: 447,
          decidedByHuman: 391,
          autoDecidedPercent: 98.9,
        },
        labels: [
          { label: 'toxic', count: 1204, avgScore: 0.612 },
          { label: 'insult', count: 883, avgScore: 0.577 },
          { label: 'obscene', count: 421, avgScore: 0.548 },
          { label: 'identity_hate', count: 198, avgScore: 0.503 },
          { label: 'threat', count: 96, avgScore: 0.481 },
          { label: 'severe_toxic', count: 62, avgScore: 0.664 },
        ],
        sla: [
          { entityType: 'post', total: 12840, breached: 31, withinSlaPercent: 99.8 },
          { entityType: 'post_comment', total: 18902, breached: 74, withinSlaPercent: 99.6 },
          { entityType: 'chat_message', total: 6021, breached: 12, withinSlaPercent: 99.8 },
          { entityType: 'research', total: 214, breached: 9, withinSlaPercent: 95.8 },
          { entityType: 'live_chat', total: 3230, breached: 118, withinSlaPercent: 96.3 },
        ],
        model: modelHealth(st),
        dataset: (({ total, untrained, goldenCases }) => ({ examples: total, untrained, goldenCases }))(datasetSummary(st)),
      }
    },
  },
  {
    m: 'POST', p: new RegExp(`^${ADMIN}\\/review\\/bulk$`),
    fn: (db, { body }) => {
      requireStepUp(db)
      const st = store(db)
      const action = parseAction(body?.action)          // throws BEFORE the loop
      const ids = Array.isArray(body?.caseIds) ? body.caseIds : []
      /* Per-item failures never fail the call — the response is a BARE ARRAY in
         input order, and `error` carries a raw message, not an errorCode. */
      return ids.map((caseId) => {
        try {
          applyDecision(st, requireCase(st, caseId), action, body?.reason, body?.teachModel)
          return { caseId, outcome: 'ok' }
        } catch (e) {
          return { caseId, outcome: 'error', error: e?.message || 'failed' }
        }
      })
    },
  },
  {
    m: 'POST', p: new RegExp(`^${ADMIN}\\/review\\/([^/]+)\\/decide$`),
    fn: (db, { params, body }) => {
      const st = store(db)
      const c = requireCase(st, params[0])
      const action = parseAction(body?.action)
      return queueRow(st, applyDecision(st, c, action, body?.reason, body?.teachModel))
    },
  },
  {
    m: 'POST', p: new RegExp(`^${ADMIN}\\/review\\/([^/]+)\\/rescore$`),
    fn: (db, { params }) => {
      const st = store(db)
      const c = st.cases.find(x => x.caseId === params[0])
      /* "GONE" is a SYNTHETIC non-enum value for a case row that no longer
         exists. There is no 404 and no MODERATION_CASE_NOT_FOUND here. */
      if (!c) return { caseId: params[0], status: 'GONE' }
      return { caseId: c.caseId, status: rescoreCase(st, c) }
    },
  },
  {
    m: 'GET', p: new RegExp(`^${ADMIN}\\/review\\/([^/]+)$`),
    fn: (db, { params }) => {
      const st = store(db)
      const c = requireCase(st, params[0])
      const k = key(c.entityType)
      return {
        summary: queueRow(st, c),
        fields: (c.fields || []).map(f => fieldView(st, c, f)),
        thresholds: {
          entityType: k,                               // LOWERCASE here…
          bands: bandsFor(st, k),
          holdMs: holdMsFor(st, c.entityType),
          fallback: fallbackFor(st, c.entityType),
        },
      }
    },
  },
  {
    m: 'GET', p: new RegExp(`^${ADMIN}\\/review$`),
    fn: (db, { query }) => {
      const st = store(db)
      const status = String(query.status || 'IN_REVIEW').trim().toUpperCase()
      if (!['PENDING', 'APPROVED', 'REJECTED', 'IN_REVIEW'].includes(status)) {
        throw badSetting(`Unknown moderation setting key: ${query.status}`)
      }
      let rows = st.cases.filter(c => c.status === status)

      /* THE FILTER TRAP, reproduced on purpose: the three filters are an
         if/else-if chain and `slaBreached` wins, so sending both silently drops
         `entityType`. A console that renders both chips as active is lying, and
         this is where it finds out. */
      if (String(query.slaBreached) === 'true') {
        rows = rows.filter(c => c.slaBreached)
      } else if (query.entityType) {
        const type = typeOfKey(query.entityType)
        if (!type) throw badSetting(`Unknown moderation setting key: ${query.entityType}`)
        rows = rows.filter(c => c.entityType === type)
      }

      rows = rows.slice().sort(String(query.sort || 'risk').toLowerCase() === 'oldest'
        ? (a, b) => b.submittedMinsAgo - a.submittedMinsAgo          // submittedAt ASC
        : (a, b) => caseTop(b).topScore - caseTop(a).topScore)       // maxScore DESC

      const { p, size } = pageArgs(query, 50)
      return {
        items: rows.slice(p * size, p * size + size).map(c => queueRow(st, c)),
        page: p,
        pageSize: size,
        totalElements: rows.length,
        totalPages: Math.max(1, Math.ceil(rows.length / size)),
        counts: queueCounts(st),                       // GLOBAL, never filtered
      }
    },
  },

  /* ---- §2 settings ----------------------------------------------------- */
  {
    m: 'GET', p: new RegExp(`^${ADMIN}\\/settings\\/thresholds$`),
    fn: (db, { query }) => {
      const st = store(db)
      const raw = String(query.entityType || '').trim()
      const type = raw ? typeOfKey(raw) : 'POST'       // absent/blank defaults to POST
      if (!type) throw badSetting(`Unknown moderation setting key: ${raw}`)
      return { entityType: key(type), bands: bandsFor(st, key(type)) }
    },
  },
  {
    m: 'PUT', p: new RegExp(`^${ADMIN}\\/settings\\/thresholds$`),
    fn: (db, { body }) => {
      requireStepUp(db)
      const st = store(db)
      /* Blank entityType means GLOBAL scope here — the one place on this API
         where omitting it is legal (hold-durations 400s for the same omission). */
      const raw = String(body?.entityType || '').trim()
      const type = raw ? typeOfKey(raw) : null
      if (raw && !type) throw badSetting(`Unknown moderation setting key: ${raw}`)

      const labels = body?.labels || {}
      if (!Object.keys(labels).length) {
        throw mockError(400, 'INVALID_THRESHOLD', "Thresholds must be between 0 and 1, and 'high' must not be below 'low'.")
      }
      const applied = {}
      for (const [label, band] of Object.entries(labels)) {
        if (!LABELS.includes(label)) throw badSetting(`Unknown moderation setting key: ${label}`)
        const bad = (v) => v != null && (!Number.isFinite(Number(v)) || Number(v) < 0 || Number(v) > 1)
        if (bad(band?.low) || bad(band?.high)
          || (band?.low != null && band?.high != null && Number(band.high) < Number(band.low))) {
          throw mockError(400, 'INVALID_THRESHOLD', "Thresholds must be between 0 and 1, and 'high' must not be below 'low'.")
        }
        /* low and high are written INDEPENDENTLY — only the non-null one lands,
           so a patch really can leave a band half-overridden. */
        const prefix = `threshold.${type ? `${key(type)}.` : ''}${label}`
        if (band?.low != null) applied[`${prefix}.low`] = String(band.low)
        if (band?.high != null) applied[`${prefix}.high`] = String(band.high)
      }
      Object.assign(st.overrides, applied)
      return { applied, effective: effectiveSettings(st) }
    },
  },
  {
    m: 'PUT', p: new RegExp(`^${ADMIN}\\/settings\\/hold-durations$`),
    fn: (db, { body }) => {
      requireStepUp(db)
      const st = store(db)
      /* entityType is REQUIRED here, and the message really does interpolate
         the null: "Unknown moderation setting key: null". */
      const raw = body?.entityType == null ? 'null' : String(body.entityType).trim()
      const type = typeOfKey(raw)
      if (!type) throw badSetting(`Unknown moderation setting key: ${raw || 'null'}`)

      const applied = {}
      const k = key(type)
      if (body.holdMs != null) {
        const ms = Number(body.holdMs)
        if (!Number.isFinite(ms) || ms < 500 || ms > 600000) {
          throw badSetting('Hold ceiling must be between 500ms and 600000ms.')
        }
        applied[`hold.${k}.ms`] = String(ms)
      }
      /* inlineMs is validated NOWHERE on write — it is only clamped on read. */
      if (body.inlineMs != null) applied[`inline.${k}.ms`] = String(body.inlineMs)
      if (body.fallback != null) {
        const probe = String(body.fallback).trim().toUpperCase().replace(/-/g, '_')
        if (probe !== 'FAIL_CLOSED' && probe !== 'FAIL_OPEN_SHADOW') {
          throw badSetting(`Unknown moderation setting key: ${body.fallback}`)
        }
        /* Stored WITHOUT the hyphen replacement, so `fail-open-shadow` persists
           as `FAIL-OPEN-SHADOW` and shows up hyphenated in `overrides`. */
        applied[`fallback.${k}`] = String(body.fallback).trim().toUpperCase()
      }
      if (body.enabled != null) applied[`enabled.${k}`] = String(!!body.enabled)
      if (!Object.keys(applied).length) throw badSetting('Unknown moderation setting key: (empty patch)')

      Object.assign(st.overrides, applied)
      return { applied, effective: effectiveSettings(st) }
    },
  },
  {
    m: 'POST', p: new RegExp(`^${ADMIN}\\/settings\\/dry-run$`),
    fn: (db, { body }) => {
      const st = store(db)
      const raw = String(body?.entityType || '').trim()
      const type = raw ? typeOfKey(raw) : 'POST'
      if (!type) throw badSetting(`Unknown moderation setting key: ${raw}`)

      const current = bandsFor(st, key(type))
      const patched = { ...current }
      for (const [label, band] of Object.entries(body?.labels || {})) {
        if (!LABELS.includes(label)) throw badSetting(`Unknown moderation setting key: ${label}`)
        patched[label] = {
          low: band?.low != null ? Number(band.low) : current[label].low,
          high: band?.high != null ? Number(band.high) : current[label].high,
        }
        const b = patched[label]
        if (!Number.isFinite(b.low) || !Number.isFinite(b.high) || b.low < 0 || b.high > 1 || b.high < b.low) {
          throw mockError(400, 'INVALID_THRESHOLD', "Thresholds must be between 0 and 1, and 'high' must not be below 'low'.")
        }
      }

      /* No "recent cases" default: an empty or absent caseIds list evaluates
         NOTHING and answers zeroes. A console that forgets to send ids sees an
         honest empty result rather than a silent full-table scan. */
      const ids = Array.isArray(body?.caseIds) ? body.caseIds : []
      const changed = []
      let evaluated = 0
      let unchanged = 0
      for (const id of ids) {
        const c = st.cases.find(x => x.caseId === id)
        if (!c) continue
        for (const f of c.fields || []) {
          evaluated += 1
          const scores = fieldScores(c, f)
          const before = evaluate(scores, current)
          const after = evaluate(scores, patched)
          if (before.verdict === after.verdict) { unchanged += 1; continue }
          changed.push(compact({
            caseId: c.caseId,
            field: f.fieldName,
            before: before.verdict,
            after: after.verdict,
            topLabel: after.topLabel,                  // dropped when null
            topScore: after.topScore,
          }))
        }
      }
      return { entityType: key(type), evaluated, unchanged, changed }
    },
  },
  {
    m: 'GET', p: new RegExp(`^${ADMIN}\\/settings$`),
    fn: (db) => {
      const st = store(db)
      const health = modelHealth(st)
      const out = { overrides: { ...st.overrides }, effective: effectiveSettings(st), model: health }
      /* At most ONE warning, and both strings are the server's verbatim. */
      if (st.overrides.enabled === 'false') {
        out.warning = 'Automated moderation is DISABLED (app.moderation.enabled=false). Only the keyword blocklist is enforced.'
      } else if (!health.inferenceUp) {
        out.warning = 'The inference service is not answering. Content is following the configured fallback policy per entity type — check the ops board.'
      }
      return out
    },
  },

  /* ---- §3 model: training data ----------------------------------------- */
  {
    m: 'POST', p: new RegExp(`^${ADMIN}\\/model\\/training-examples\\/word$`),
    fn: (db, { body }) => {
      const st = store(db)
      const word = String(body?.word || '').trim()
      if (!word) throw mockError(400, 'INVALID_TRAINING_EXAMPLE', 'A training example needs non-empty text.')
      /* Exactly three template sentences, and the note is the server's own
         nudge towards the blocklist for anything that must bite immediately. */
      const created = ['You are a %s.', 'What a %s.', '%s']
        .map(t => upsertExample(st, {
          text: t.replace('%s', word),
          labels: body?.labels,
          note: body?.note || `expanded from word: ${word}`,
        }))
        .map(exampleView)
      return {
        word,
        created,
        note: 'The word was expanded into template sentences. For an instant, no-retrain ban add it to the blocklist as well.',
      }
    },
  },
  {
    m: 'GET', p: new RegExp(`^${ADMIN}\\/model\\/training-examples$`),
    fn: (db, { query }) => {
      const st = store(db)
      let rows = st.examples
      if (query.source) {
        const source = String(query.source).trim().toUpperCase()
        if (!['SEED_DATASET', 'ADMIN_MANUAL', 'ADMIN_CORRECTION', 'REVIEW_PROMOTION', 'USER_REPORT_CONFIRMED'].includes(source)) {
          throw badSetting(`Unknown moderation setting key: ${query.source}`)
        }
        rows = rows.filter(e => e.source === source)
      }
      const { p, size } = pageArgs(query, 50)
      /* No `totalPages` on this envelope — the review queue has one, this does
         not, and a shared paging component has to survive both. */
      return {
        items: rows.slice(p * size, p * size + size).map(exampleView),
        page: p,
        pageSize: size,
        totalElements: rows.length,
        summary: datasetSummary(st),
      }
    },
  },
  {
    m: 'POST', p: new RegExp(`^${ADMIN}\\/model\\/training-examples$`),
    fn: (db, { body }) => {
      const st = store(db)
      const text = String(body?.text || '').trim()
      if (!text) throw mockError(400, 'INVALID_TRAINING_EXAMPLE', 'A training example needs non-empty text.')
      return exampleView(upsertExample(st, { text, labels: body?.labels, note: body?.note }))
    },
  },
  {
    m: 'DELETE', p: new RegExp(`^${ADMIN}\\/model\\/training-examples\\/([^/]+)$`),
    fn: (db, { params }) => {
      const st = store(db)
      /* deleteById on a missing id is a silent no-op: an unknown id still 204s. */
      st.examples = st.examples.filter(e => e.id !== params[0])
      return NO_CONTENT
    },
  },

  /* ---- §3 model: golden cases ------------------------------------------ */
  {
    m: 'GET', p: new RegExp(`^${ADMIN}\\/model\\/golden-cases$`),
    fn: (db, { query }) => {
      const st = store(db)
      const { p, size } = pageArgs(query, 50)
      /* A BARE ARRAY — no envelope, no total. The only paged endpoint on this
         API that does not tell you how many there are. */
      return st.golden.slice(p * size, p * size + size).map(goldenView)
    },
  },
  {
    m: 'POST', p: new RegExp(`^${ADMIN}\\/model\\/golden-cases$`),
    fn: (db, { body }) => {
      const st = store(db)
      const text = String(body?.text || '').trim()
      if (!text) throw mockError(400, 'INVALID_TRAINING_EXAMPLE', 'A training example needs non-empty text.')
      const labels = coerceLabels(body?.labels)
      const hash = textHash(text)
      let row = st.golden.find(g => g.textHash === hash)
      if (!row) {
        row = goldenRow({ text, labels: [], note: body?.note, addedMinsAgo: 0 })
        st.golden.unshift(row)
      }
      /* Request keys are WIRE labels, the stored row is camelCase columns. */
      Object.assign(row, {
        text,
        textHash: hash,
        toxic: labels.toxic,
        severeToxic: labels.severe_toxic,
        obscene: labels.obscene,
        threat: labels.threat,
        insult: labels.insult,
        identityHate: labels.identity_hate,
        note: body?.note || row.note || null,
      })
      return goldenView(row)
    },
  },
  {
    m: 'DELETE', p: new RegExp(`^${ADMIN}\\/model\\/golden-cases\\/([^/]+)$`),
    fn: (db, { params }) => {
      const st = store(db)
      st.golden = st.golden.filter(g => g.id !== params[0])
      return NO_CONTENT
    },
  },

  /* ---- §3 model: registry ---------------------------------------------- */
  {
    m: 'GET', p: new RegExp(`^${ADMIN}\\/model\\/versions$`),
    fn: (db, { query }) => {
      const st = store(db)
      const { p, size } = pageArgs(query, 20)          // 20 here, not 50
      const rows = st.versions.slice().sort((a, b) => (a.trainedMinsAgo || 0) - (b.trainedMinsAgo || 0))
      return {
        items: rows.slice(p * size, p * size + size).map(versionView),
        totalElements: rows.length,                    // no page/pageSize/totalPages
        health: modelHealth(st),
      }
    },
  },
  {
    m: 'POST', p: new RegExp(`^${ADMIN}\\/model\\/retrain\\/refresh$`),
    fn: (db) => {
      const st = store(db)
      /* Settle whatever the last retrain started. In the real system this polls
         the training container; here it is the only way a mocked job ever
         finishes, so the promote path stays reachable after a retrain. */
      const running = st.versions.filter(v => v.status === 'TRAINING')
      running.forEach((v, i) => {
        v.status = 'READY'
        v.version = `v4-rc${i + 1}`
        v.macroF1 = round3(0.83 + seeded(v.jobId) * 0.03)
        v.validationCount = 331
        v.gatePassed = true
        v.gateDetail = 'Passed: macro-F1 within the drop limit, 0 golden regressions.'
        v.artifactPath = `s3://ika-models/moderation/${v.version}`
        v.completedMinsAgo = 0
      })
      return { settled: running.length }
    },
  },
  {
    m: 'POST', p: new RegExp(`^${ADMIN}\\/model\\/retrain$`),
    fn: (db, { body }) => {
      requireStepUp(db)
      const st = store(db)
      if (st.versions.some(v => v.status === 'TRAINING')) {
        throw mockError(400, 'TRAINING_ALREADY_RUNNING', 'A training run is already in progress.')
      }
      const summary = datasetSummary(st)
      if (summary.total < 20) {
        throw mockError(400, 'TRAINING_DATASET_TOO_SMALL',
          `The training dataset has ${summary.total} examples; at least 20 are needed for a meaningful run.`)
      }
      const jobId = `mock-${st.versions.length + 1}`
      const active = st.versions.find(v => v.status === 'ACTIVE')
      const row = {
        id: mockUuid(),
        /* The placeholder name really is `job-<jobId>` until the callback
           lands — the registry row exists before the model does. */
        version: `job-${jobId}`,
        status: 'TRAINING',
        jobId,
        baseCheckpoint: String(body?.baseVersion || active?.version || '') || null,
        trainingExamples: summary.total,
        validationCount: 0,
        notes: body?.notes || null,
        trainedMinsAgo: 0,
      }
      st.versions.unshift(row)
      return versionView(row)
    },
  },
  {
    m: 'POST', p: new RegExp(`^${ADMIN}\\/model\\/versions\\/([^/]+)\\/promote$`),
    fn: (db, { params, body }) => {
      requireStepUp(db)
      const st = store(db)
      /* Looked up by the registry-row UUID, NOT by the version name — the real
         path variable is the id, and accepting both would hide a console that
         sends the wrong one until it met the live API. */
      const row = st.versions.find(v => v.id === params[0])
      if (!row) throw mockError(400, 'MODEL_VERSION_NOT_FOUND', `Model version not found: ${params[0]}`)
      if (!['READY', 'SHADOW', 'RETIRED'].includes(row.status)) {
        throw mockError(400, 'MODEL_NOT_PROMOTABLE',
          `Only READY, SHADOW or RETIRED versions can be promoted; this one is ${row.status}.`)
      }
      /* The gate is advisory, not absolute: `force: true` overrides it. That is
         why the console needs a confirm step and not just a button. */
      if (row.gatePassed === false && body?.force !== true) {
        throw mockError(400, 'MODEL_GATE_FAILED', row.gateDetail || 'The candidate did not pass its evaluation gate.')
      }
      for (const v of st.versions) if (v.status === 'ACTIVE') v.status = 'RETIRED'
      row.status = 'ACTIVE'
      row.promotedMinsAgo = 0
      return versionView(row)
    },
  },
  {
    m: 'POST', p: new RegExp(`^${ADMIN}\\/model\\/versions\\/([^/]+)\\/shadow$`),
    fn: (db, { params }) => {
      const st = store(db)
      const row = st.versions.find(v => v.id === params[0])
      if (!row) throw mockError(400, 'MODEL_VERSION_NOT_FOUND', `Model version not found: ${params[0]}`)
      row.status = 'SHADOW'                            // no status precondition
      return versionView(row)
    },
  },
  {
    m: 'POST', p: new RegExp(`^${ADMIN}\\/model\\/rollback$`),
    fn: (db) => {
      requireStepUp(db)
      const st = store(db)
      const target = st.versions
        .filter(v => v.status === 'RETIRED' && v.promotedMinsAgo != null)
        .sort((a, b) => a.promotedMinsAgo - b.promotedMinsAgo)[0]
      if (!target) throw mockError(400, 'MODEL_VERSION_NOT_FOUND', 'Model version not found: no retired version')
      for (const v of st.versions) if (v.status === 'ACTIVE') v.status = 'RETIRED'
      target.status = 'ACTIVE'
      target.promotedMinsAgo = 0
      return versionView(target)
    },
  },
  {
    m: 'POST', p: new RegExp(`^${ADMIN}\\/model\\/score-probe$`),
    fn: (db, { body }) => {
      const st = store(db)
      const text = String(body?.text || '').trim()
      if (!text) throw mockError(400, 'INVALID_TRAINING_EXAMPLE', 'A training example needs non-empty text.')
      /* The probe is the one admin screen that can SEE the demo markers, which
         makes it the fastest way to explain the whole feature to somebody:
         paste `blockme` and watch every band go red. Everything else is a
         stable pseudo-random vector so the same text always probes the same. */
      const verdict = fakeVerdict(text)
      const scores = {}
      for (const label of LABELS) {
        const base = seeded(`probe:${normalizeText(text)}:${label}`)
        scores[label] = verdict === 'BLOCK' ? round3(0.86 + base * 0.13)
          : verdict === 'HOLD' ? round3(0.42 + base * 0.2)
            : round3(base * 0.3)
      }
      const active = st.versions.find(v => v.status === 'ACTIVE')
      return {
        modelVersion: active?.version || 'v2',
        inferenceMs: round3(12 + seeded(text) * 30),
        scores,
      }
    },
  },
]
