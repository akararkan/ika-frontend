/* =========================================================
   Call log — the local history of voice/video calls.
   ---------------------------------------------------------
   WHY THIS IS A CLIENT STORE AND NOT AN ENDPOINT.

   The backend owns the call LIFECYCLE (ring → answer → end) and
   relays WebRTC signalling, but it writes nothing into the
   message timeline for a call and exposes no history endpoint:
   `GET /calls/{id}` answers about ONE call you already know the
   id of, and the `call.*` frames are ephemeral. So "you called
   Sara three times today, the last one lasted 4:12" exists
   nowhere except in the client that watched it happen.

   This module is that memory. Every call this device took part
   in — placed, answered, declined, missed — is written here as
   it ends, keyed by conversation, and read back by two surfaces:

     · the thread, where an ended call renders as a timeline card
       between the messages, at the minute it happened;
     · the info panel, which totals them ("12 calls · 1h 46m").

   Consequences to be honest about, and the reason the info panel
   says "on this device":
     · it is per-device — a call taken on a phone is not in this
       browser's log;
     · it is per-account (the key carries the user id), so two
       accounts sharing a browser never see each other's calls;
     · clearing site data clears it.

   The day the API grows a call-history endpoint, keep this shape
   and swap `load()` for the fetch: everything downstream reads
   `entriesFor` / `statsFor` and nothing reads localStorage.
   ========================================================= */

import React from 'react'

const KEY_BASE = 'ika.chat.calllog'
/** Newest-first, hard-capped: a log is a convenience, not an archive. */
const MAX_ENTRIES = 300

let ownerId = null           // whose log is loaded
let entries = []             // newest first
let cacheStamp = 0           // bumped on every write; invalidates `byConvo`
const subs = new Set()

const keyFor = (uid) => `${KEY_BASE}.${uid || 'anon'}`

function load(uid) {
  try {
    const raw = JSON.parse(localStorage.getItem(keyFor(uid)) || '[]')
    return Array.isArray(raw) ? raw.filter(e => e && e.id && e.convId) : []
  } catch { return [] }
}

function persist() {
  try { localStorage.setItem(keyFor(ownerId), JSON.stringify(entries)) } catch { /* memory-only */ }
}

function emit() {
  // The per-conversation cache is invalidated BEFORE any listener runs: a
  // subscriber reads `entriesFor` synchronously inside its callback, and an
  // invalidation registered as just another listener would race it.
  cacheStamp++
  for (const fn of subs) { try { fn() } catch { /* one bad listener can't stop the rest */ } }
}

/** Point the log at an account. Called once the signed-in user is known;
 *  switching accounts swaps the whole store rather than merging. */
export function openCallLog(userId) {
  const uid = userId ? String(userId) : null
  if (ownerId === uid) return
  ownerId = uid
  entries = uid ? load(uid) : []
  emit()
}

/**
 * Commit one finished call.
 *
 * Idempotent on `id`: the same call can end twice on this client (my own
 * `hangUp` races the server's `call.ended` frame), and two cards for one call
 * is a bug the reader would notice immediately. The later write WINS on the
 * fields it carries — the server frame knows the real terminal status, my
 * local hang-up knows the duration.
 *
 * @param {{
 *   id: string, convId: string, video?: boolean, outgoing?: boolean,
 *   outcome: 'answered'|'missed'|'declined'|'cancelled'|'noanswer'|'failed',
 *   startedAt: number, endedAt?: number, durationMs?: number, peerIds?: string[]
 * }} entry
 */
export function recordCall(entry) {
  if (!entry?.id || !entry?.convId) return
  const row = {
    id: String(entry.id),
    convId: String(entry.convId),
    video: !!entry.video,
    outgoing: !!entry.outgoing,
    outcome: entry.outcome || 'answered',
    startedAt: entry.startedAt || Date.now(),
    endedAt: entry.endedAt || Date.now(),
    durationMs: Math.max(0, entry.durationMs || 0),
    peerIds: (entry.peerIds || []).map(String),
  }
  const at = entries.findIndex(e => e.id === row.id)
  if (at >= 0) entries[at] = { ...entries[at], ...row }
  else entries = [row, ...entries].slice(0, MAX_ENTRIES)
  // Newest first, always — a late write for an older call must not jump the
  // queue and make the thread cards appear out of order.
  entries.sort((a, b) => b.endedAt - a.endedAt)
  persist()
  emit()
}

export function subscribeCallLog(fn) {
  subs.add(fn)
  return () => subs.delete(fn)
}

/** Whole log, newest first. Stable identity between writes. */
export function allCalls() { return entries }

const EMPTY = []
const byConvo = new Map()      // convId -> memoised array, rebuilt after a write
let lastStamp = -1

/** Calls in one conversation, OLDEST first — timeline order.
 *  Memoised per conversation so `useSyncExternalStore` sees a stable
 *  reference between writes (a fresh array every call is an infinite loop). */
export function entriesFor(convId) {
  if (!convId) return EMPTY
  if (lastStamp !== cacheStamp) { byConvo.clear(); lastStamp = cacheStamp }
  const hit = byConvo.get(convId)
  if (hit) return hit
  const rows = entries.filter(e => e.convId === String(convId)).sort((a, b) => a.endedAt - b.endedAt)
  const out = rows.length ? rows : EMPTY
  byConvo.set(convId, out)
  return out
}

/** Totals for the info panel. Talk time counts ANSWERED calls only — a
 *  30-second ring is not 30 seconds of conversation. Takes the ROWS, not a
 *  conversation id, so the React hook can memoise on the same array identity
 *  the store already hands out. */
export function statsOf(rows) {
  let outgoing = 0, incoming = 0, missed = 0, talkMs = 0, answered = 0
  for (const e of rows) {
    if (e.outgoing) outgoing++; else incoming++
    if (e.outcome === 'missed' || e.outcome === 'noanswer') missed++
    if (e.outcome === 'answered') { answered++; talkMs += e.durationMs }
  }
  return {
    total: rows.length,
    outgoing, incoming, missed, answered, talkMs,
    last: rows.length ? rows[rows.length - 1] : null,
    longest: rows.reduce((best, e) => (e.durationMs > (best?.durationMs || 0) ? e : best), null),
  }
}

export const statsFor = (convId) => statsOf(entriesFor(convId))

/** Drop one conversation's history (offered in the info panel). */
export function clearCallsFor(convId) {
  const before = entries.length
  entries = entries.filter(e => e.convId !== String(convId))
  if (entries.length !== before) { persist(); emit() }
}

/* ---------------------------------------------------------
   React bindings.
   `entriesFor` is memoised per conversation precisely so these
   snapshots are referentially stable between writes —
   useSyncExternalStore re-renders forever on a fresh array.
   --------------------------------------------------------- */

export function useConversationCalls(convId) {
  const get = React.useCallback(() => entriesFor(convId), [convId])
  return React.useSyncExternalStore(subscribeCallLog, get, get)
}

export function useCallStats(convId) {
  const rows = useConversationCalls(convId)
  return React.useMemo(() => statsOf(rows), [rows])
}

/* ---------------------------------------------------------
   Presentation helpers — shared by the timeline card and the
   info panel so the two can never disagree about what an
   outcome is called.
   --------------------------------------------------------- */

/** ms → "4:12" / "1:02:11" / "0:07". */
export function callDuration(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

/** "1h 46m" / "12m" / "45s" — the *summary* gauge, not a stopwatch. */
export function talkTime(ms) {
  const total = Math.round((ms || 0) / 1000)
  if (total < 60) return `${total}s`
  const h = Math.floor(total / 3600)
  const m = Math.round((total % 3600) / 60)
  return h ? `${h}h ${m}m` : `${m}m`
}

/**
 * One call → { icon, tone, title, detail }.
 *
 * The same terminal state means opposite things to the two ends — a call the
 * caller cancelled is a MISSED call to the callee — so `outgoing` is part of
 * the input, never inferred later. `tone` drives the colour: only a call that
 * was genuinely lost reads as an alert.
 */
export function describeCall(e) {
  const kind = e.video ? 'Video call' : 'Voice call'
  if (e.outcome === 'answered') {
    return {
      icon: e.outgoing ? 'phoneout' : 'phonein',
      tone: 'ok',
      title: `${e.outgoing ? 'Outgoing' : 'Incoming'} ${kind.toLowerCase()}`,
      detail: callDuration(e.durationMs),
    }
  }
  if (e.outcome === 'declined') {
    return {
      icon: 'phonemiss',
      tone: e.outgoing ? 'warn' : 'muted',
      title: e.outgoing ? `${kind} declined` : `You declined a ${kind.toLowerCase()}`,
      detail: null,
    }
  }
  if (e.outcome === 'cancelled') {
    return {
      icon: e.outgoing ? 'phoneout' : 'phonemiss',
      tone: e.outgoing ? 'muted' : 'warn',
      title: e.outgoing ? `${kind} cancelled` : `Missed ${kind.toLowerCase()}`,
      detail: null,
    }
  }
  if (e.outcome === 'noanswer') {
    return { icon: 'phoneout', tone: 'warn', title: `${kind} — no answer`, detail: null }
  }
  if (e.outcome === 'failed') {
    return { icon: 'phonemiss', tone: 'warn', title: `${kind} failed to connect`, detail: null }
  }
  return { icon: 'phonemiss', tone: 'warn', title: `Missed ${kind.toLowerCase()}`, detail: null }
}
