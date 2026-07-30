/* =========================================================
   Media preferences — one store for every player in chat.
   ---------------------------------------------------------
   Voice notes and videos are rendered by dozens of independent
   components (one per bubble, plus the lightbox), and a playback
   preference is emphatically NOT per-bubble: setting 1.5× on one
   voice note and hearing the next one snap back to 1× is the
   single most complained-about behaviour in every messenger that
   has ever shipped it that way.

   So the preference lives here — module state, persisted to
   localStorage, with a subscription so every mounted player
   re-renders the moment one of them changes it. React context
   would work too, but the players are leaf nodes under a memo-ed
   list; a context bump would re-render the whole thread on a
   volume drag.

   Three separate concerns, deliberately in one file because they
   share the persistence plumbing:
     · prefs      — speed / volume / muted, written by the players
     · playedVoice — which voice notes have been heard (the dot)
     · nextVoice  — DOM-order handoff for continuous playback

   Everything degrades to in-memory state when storage throws
   (Safari private mode, a full quota, a locked-down iframe).
   ========================================================= */

const KEY = 'ika.chat.media'
const PLAYED_KEY = 'ika.chat.voiceplayed'

/** The speed ladder, in the order the cycle button walks it.
 *  1× → 1.25× → 1.5× → 1.75× → 2× → back to 1×. */
export const SPEEDS = [1, 1.25, 1.5, 1.75, 2]

/** ms → "0:07" / "1:42" / "1:02:11". Shared by both players and the bubble's
 *  video-duration chip, so a clock never reads differently in two places. */
export function durationOf(ms) {
  /* `Infinity` reaches here from a media element that cannot state its own
     length (a MediaRecorder file with no duration header). Unguarded, the
     arithmetic below renders the literal clock "Infinity:NaN:NaN". */
  const n = Number(ms)
  const total = Number.isFinite(n) ? Math.max(0, Math.round(n / 1000)) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

/** "1.25" but "1" stays "1" — the button is 34px wide and "1.00×" does not fit. */
export function speedLabel(rate) {
  return `${Number(rate) % 1 === 0 ? Number(rate) : Number(rate).toFixed(2).replace(/0$/, '')}×`
}

const DEFAULTS = {
  voiceRate: 1,        // voice notes: shared across every note in every thread
  videoRate: 1,        // video: a separate ladder — 1.5× speech ≠ 1.5× film
  videoVolume: 1,      // 0..1
  videoMuted: false,
}

function read() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw)
    return { ...DEFAULTS, ...(parsed && typeof parsed === 'object' ? parsed : null) }
  } catch { return { ...DEFAULTS } }
}

let state = read()
const subs = new Set()

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(state)) } catch { /* memory-only is fine */ }
}

/** Current snapshot. Stable identity between writes, so it is safe as a
 *  `useSyncExternalStore` getter (React bails out when it is unchanged). */
export function getMediaPrefs() { return state }

export function setMediaPref(patch) {
  const next = { ...state, ...patch }
  // Bail on a no-op write: a volume drag fires ~60 events a second and every
  // one of them would otherwise re-render every mounted player.
  if (Object.keys(patch).every(k => Object.is(state[k], next[k]))) return
  state = next
  persist()
  for (const fn of subs) { try { fn() } catch { /* one bad listener can't stop the rest */ } }
}

export function subscribeMediaPrefs(fn) {
  subs.add(fn)
  return () => subs.delete(fn)
}

/* ---------------------------------------------------------
   Heard voice notes.
   ---------------------------------------------------------
   The unplayed dot is a *local* fact — the server has no "did
   this device hear it" concept and a read receipt does not mean
   the audio was played. Capped at MAX_PLAYED ids in insertion
   order (oldest evicted), because an uncapped Set of Snowflakes
   in localStorage grows without bound and eventually throws the
   quota error that takes the whole preference blob with it.
   --------------------------------------------------------- */

const MAX_PLAYED = 400
let played = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(PLAYED_KEY) || '[]')
    return new Set(Array.isArray(raw) ? raw.map(String) : [])
  } catch { return new Set() }
})()

export function isVoicePlayed(id) { return played.has(String(id)) }

export function markVoicePlayed(id) {
  const key = String(id || '')
  if (!key || played.has(key)) return
  played.add(key)
  if (played.size > MAX_PLAYED) {
    // Sets iterate in insertion order, so the first key is the oldest.
    const drop = played.size - MAX_PLAYED
    let i = 0
    for (const k of played) { if (i++ >= drop) break; played.delete(k) }
  }
  try { localStorage.setItem(PLAYED_KEY, JSON.stringify([...played])) } catch { /* noop */ }
  for (const fn of subs) { try { fn() } catch { /* noop */ } }
}

/* ---------------------------------------------------------
   Continuous playback handoff.
   ---------------------------------------------------------
   When a voice note ends, messengers play the NEXT one — that is
   how you listen through a backlog without touching the phone.
   Finding "the next one" through React would mean lifting every
   voice note's identity into the thread store; the DOM already
   holds the answer in the right order, so ask it.

   `data-ika-voice` marks every voice <audio> in the thread. The
   handoff only ever moves FORWARD and only within the same
   scroll container, so it can never jump conversations or loop.
   --------------------------------------------------------- */

export function pauseOtherVoices(exceptEl) {
  for (const el of document.querySelectorAll('audio[data-ika-voice]')) {
    if (el !== exceptEl && !el.paused) el.pause()
  }
}

/**
 * Play the next voice note after `el`, if there is one — and only if it has
 * NOT been heard yet (`data-heard`, mirrored onto the element by VoiceNote).
 *
 * That guard is the difference between "listening through a backlog" and
 * "the thread starts replaying itself at you": without it, finishing one note
 * would restart old notes you played days ago simply because they sit lower
 * in the DOM.
 */
export function playNextVoice(el) {
  if (!el) return false
  const all = [...document.querySelectorAll('audio[data-ika-voice]')]
  const i = all.indexOf(el)
  const next = i >= 0 ? all[i + 1] : null
  if (!next) return false
  if (next.dataset.heard === '1') return false
  // Autoplay policy: this runs inside the ended handler of an element the user
  // already started, so the gesture is inherited. A rejection is not an error.
  const p = next.play?.()
  if (p?.catch) p.catch(() => {})
  return true
}

/* ---------------------------------------------------------
   Measured durations — the last resort when a file cannot
   state its own length.
   ---------------------------------------------------------
   Firefox's MediaRecorder writes WebM with no duration header
   AND no cues, so its own recordings arrive with
   `duration === Infinity`, an EMPTY `seekable` range, and a
   `durationchange` that only fires once the last sample has
   already played. Every rung a player can read from the element
   is therefore blank for the whole of playback — there is no
   number to scrub against, and inventing one from `currentTime`
   makes the progress line read 100% on its first frame.

   Decoding the bytes gives the exact length. It costs one fetch
   (already in the HTTP cache — the element just streamed it) and
   one decode, so it is done LAZILY on the first play of a note
   whose length is otherwise unknowable, memoised per URL, and
   de-duplicated while in flight. Every failure path returns 0,
   which the players read as "still unknown" and handle.
   --------------------------------------------------------- */

const DUR_CACHE = new Map()
const DUR_INFLIGHT = new Map()
/** Per-URL fetch-failure tally — see the catch below. */
const DUR_FAILS = new Map()
/** Capped like every other store in this file — an uncapped Map keyed by URL
 *  grows for the life of the tab. 200 notes is far past any session's reach. */
const MAX_MEASURED = 200
/** A URL whose bytes cannot be decoded (an Opus note opened in Safari) is
 *  remembered as 0 too, so every subsequent play does not re-download it. */
function rememberDuration(url, seconds) {
  if (DUR_CACHE.size >= MAX_MEASURED) {
    const oldest = DUR_CACHE.keys().next().value
    if (oldest !== undefined) DUR_CACHE.delete(oldest)
  }
  DUR_CACHE.set(url, seconds)
}

/** Decode-measured length in seconds, or 0 when it is not (yet) known. */
export function measureDuration(url) {
  if (!url) return Promise.resolve(0)
  if (DUR_CACHE.has(url)) return Promise.resolve(DUR_CACHE.get(url))
  if (DUR_INFLIGHT.has(url)) return DUR_INFLIGHT.get(url)

  const Ctx = typeof window !== 'undefined'
    ? (window.OfflineAudioContext || window.webkitOfflineAudioContext)
    : null
  if (!Ctx) return Promise.resolve(0)

  const p = (async () => {
    let fetched = false
    try {
      const res = await fetch(url)
      /* 4xx is the server's final answer — remembering it stops an endless
         re-fetch of a note that will never decode. 5xx and network faults
         stay retryable. */
      if (!res.ok) { if (res.status >= 400 && res.status < 500) rememberDuration(url, 0); return 0 }
      /* The size is checked from the HEADER, before the body is read. Testing
         `byteLength` after `arrayBuffer()` would mean the whole object had
         already been pulled over the user's connection and into memory — the
         cap has to refuse the download, not the decode. A voice note is
         capped at five minutes: ~1.2MB of Opus, ~4.7MB of AAC. */
      const len = Number(res.headers.get('content-length') || 0)
      if (len > 12 * 1024 * 1024) { rememberDuration(url, 0); return 0 }
      const buf = await res.arrayBuffer()
      fetched = true
      if (buf.byteLength > 12 * 1024 * 1024) { rememberDuration(url, 0); return 0 }
      const decoded = await new Ctx(1, 1, 8000).decodeAudioData(buf)
      const d = Number.isFinite(decoded?.duration) && decoded.duration > 0 ? decoded.duration : 0
      /* A file this engine cannot decode will not decode on the next tap
         either, so 0 is remembered — but ONLY once the bytes were actually
         in hand. A network blip must stay retryable: caching it would brick
         the note's length for the rest of the tab with no way back. */
      rememberDuration(url, d)
      return d
    } catch {
      if (fetched) rememberDuration(url, 0)   // decode failed: permanent
      else {
        /* Fetch failed: retryable — but not FOREVER. A deployment where the
           media route's CORS is broken (it has been: doubled
           Access-Control-Allow-Origin headers) refuses every JS fetch for the
           whole session, and the route ignores Range, so each retry pulls the
           entire file again on every play. Three strikes, then this URL is
           remembered as unknowable; the players already render fine without
           a measured length. */
        const n = (DUR_FAILS.get(url) || 0) + 1
        if (DUR_FAILS.size > 300) DUR_FAILS.clear()
        DUR_FAILS.set(url, n)
        if (n >= 3) rememberDuration(url, 0)
      }
      return 0
    } finally {
      DUR_INFLIGHT.delete(url)
    }
  })()

  DUR_INFLIGHT.set(url, p)
  return p
}
