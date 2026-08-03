/* =========================================================
   Mock mode — the whole app, running off one fixture file.
   ---------------------------------------------------------
   WHY IT LIVES HERE, AT THE HTTP FUNNEL

   Every REST call in this app goes through `request()` in
   src/api/http.js. Intercepting there means one switch covers
   every screen, and — this is the part that matters — the
   response still travels the real path: the same adapters, the
   same defensive parsing, the same error envelopes. A fixture
   in the WRONG SHAPE breaks the screen exactly the way a
   backend change would. Mock mode is therefore a rehearsal,
   not a diorama.

   TURNING IT ON
     .env            VITE_USE_MOCK=true
     browser console localStorage.ika_mock = 'on'   (per-device override)
                     localStorage.ika_mock = 'off'  (force real API)
   The localStorage key wins, so one person can demo against
   fixtures while the same build talks to a live server for
   everyone else. Off is the default, and off costs nothing:
   the handlers are behind a dynamic import that a production
   build tree-shakes away when the flag is statically false.

   LANGUAGE
     .env            VITE_MOCK_LANG=en | ar | ku | tr
     console         localStorage.ika_mock_lang = 'ar'
   The fixture stores every human string as {en, ar, ku, tr};
   `localize()` collapses it to the chosen language on the way
   out, so the wire looks exactly like a real single-language
   response.

   WHAT IS NOT MOCKED
   Server-sent events (src/api/realtime.js) and presigned media
   PUTs do not pass through `request()`. The realtime layer is
   given a small scripted replay instead — see mockStream().
   ========================================================= */
import { localize } from './util.js'
import { mockEnabled, mockLang, MOCK_DELAY as DELAY } from './flag.js'

export { mockEnabled, mockLang }

/* ---------- the registry ---------- */

/* A miss is `{hit:false}` and a hit is `{hit:true, value}` — a plain object,
   so http.js does not have to import anything just to recognise one. On a miss
   `request()` falls through to the network, and a half-built fixture therefore
   degrades to the real API rather than to a blank screen. */
const MISS = { hit: false }

let loaded = null            // { db, routes } once the handlers are imported

async function load() {
  if (loaded) return loaded
  const [{ default: raw }, handlers] = await Promise.all([
    import('./data.json'),
    import('./handlers/index.js'),
  ])
  /* Collapse the multilingual fixture ONCE per session. Re-localising on every
     request would be pure waste — the language cannot change without a reload. */
  const db = localize(raw, mockLang())
  loaded = { db, routes: handlers.routes }
  if (typeof window !== 'undefined') window.__ikaMockDb = db      // demo escape hatch
  return loaded
}

/** Warm the fixture before first paint, so the opening screen does not flash
 *  a loader while a 300 KB JSON parses. Safe to call when mocking is off. */
export function preloadMocks() {
  if (mockEnabled()) load().catch(() => {})
}

const wait = (ms) => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve())

/** Resolve one request against the fixture.
 *  `{hit:false}` when nothing matches; handlers may throw `mockError(...)` to
 *  exercise a failure path. */
export async function resolveMock(method, path, opts = {}) {
  const { db, routes } = await load()
  const clean = path.split('?')[0]
  for (const route of routes) {
    if (route.m !== method && route.m !== '*') continue
    const m = route.p.exec(clean)
    if (!m) continue
    await wait(DELAY)
    const ctx = {
      params: m.slice(1).map(v => (v == null ? v : decodeURIComponent(v))),
      query: opts.query || {},
      body: opts.body,
      method,
      path: clean,
      lang: mockLang(),
    }
    const value = route.fn(db, ctx)
    return { hit: true, value: value === undefined ? null : value }
  }
  return MISS
}

/** Live-chat rows for every stream, already in `LiveChatMessage` wire shape.
 *  Live chat is broadcast-only on the real backend — POST to send, SSE to
 *  receive, no GET, never persisted — so this is the one part of the fixture
 *  that cannot be reached through a REST route. `chat.js`'s mock stream shim
 *  replays these as `stream.chat` frames so the rail is not empty on arrival. */
export async function liveChatFrames() {
  const { db } = await load()
  const byId = new Map((db.users || []).map(u => [u.id, u]))

  const perStream = []
  for (const [streamId, rows] of Object.entries(db.live?.chat || {})) {
    if (!rows?.length) continue
    perStream.push(rows.map((r) => {
      const u = byId.get(r.userId)
      return {
        streamId,
        userId: r.userId,
        username: u?.username || '',
        text: r.text,
        sentAt: new Date(Date.now() - (r.agoMin || 0) * 60_000).toISOString(),
      }
    }))
  }

  /* ROUND-ROBIN across streams, not stream-by-stream. The replay is one cycle
     over a single per-user socket, so a flat concatenation makes the last
     stream's first line arrive only after every earlier stream has emptied —
     ~13s of an empty rail for whichever room you happened to open. Interleaved,
     every room sees its first line within a few seconds. */
  const out = []
  const depth = Math.max(0, ...perStream.map(s => s.length))
  for (let i = 0; i < depth; i++) {
    for (const s of perStream) if (s[i]) out.push(s[i])
  }
  return out
}

/** A scripted event replay for src/api/realtime.js, which opens an
 *  EventSource rather than calling request(). Returns an unsubscribe fn.
 *  Events fire slowly and stop; a demo wants a sign of life, not a firehose. */
export function mockStream(handlers = {}) {
  let stopped = false
  const timers = []
  const at = (ms, fn) => timers.push(setTimeout(() => { if (!stopped) fn() }, ms))

  /* Replay through the REST handler rather than off the raw fixture rows.
     The stored rows are storage shape (they keep age as `minutesAgo`); it is
     the handler that renders them into NotificationResponse with a real
     `createdAt`. Reading the array directly would push rows the adapter can
     only render with a blank timestamp. */
  resolveMock('GET', '/api/v1/notifications', { query: { page: 0, size: 3 } })
    .then((res) => {
      if (stopped || !res?.hit) return
      handlers.onConnected?.()
      const rows = res.value?.content || res.value?.items || []
      rows.slice(0, 3).forEach((n, i) => {
        at(4000 + i * 9000, () => {
          handlers.onNotification?.({ ...n, isRead: false })
          handlers.onUnreadCount?.(i + 1)
        })
      })
    })
    .catch(() => {})

  return () => { stopped = true; timers.forEach(clearTimeout) }
}
