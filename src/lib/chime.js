/* =========================================================
   Notification chime — synthesized, autoplay-safe, one pref.
   ---------------------------------------------------------
   Why synthesis and not an mp3: the sound is two sine notes with
   an exponential decay — a WebAudio graph a few lines long. No
   asset to load, cache, or 404; no licensing; and the same chime
   on every install.

   Autoplay policy: an AudioContext starts "suspended" until the
   page has seen a user gesture. `initChime()` (called once from
   Layout) arms one-shot listeners that create + resume the
   context on the first pointer/key interaction, so by the time a
   notification arrives the context is usually running. When it
   is not (a notification lands before any interaction), play is
   silently skipped — the browser would refuse anyway, and a
   console warning per event is just noise.

   Two voices, deliberately distinct:
     · 'notification' — an ascending two-note bell (the inbox)
     · 'message'      — one soft short note (live chat traffic,
       which is frequent — the full bell would be exhausting)

   The preference is app-wide, persisted, and read through a
   subscribe/snapshot pair so a `useSyncExternalStore` toggle
   re-renders every consumer the moment it flips.
   ========================================================= */

const KEY = 'ika.notifsound'

let ctx = null
let lastPlay = 0
const subs = new Set()

/* ---------- preference ---------- */

export function soundEnabled() {
  try { return localStorage.getItem(KEY) !== 'off' } catch { return true }
}

export function setSoundEnabled(on) {
  try { localStorage.setItem(KEY, on ? 'on' : 'off') } catch { /* memory-only */ }
  for (const fn of subs) { try { fn() } catch { /* one bad listener can't stop the rest */ } }
}

export function subscribeSound(fn) {
  subs.add(fn)
  return () => subs.delete(fn)
}

/* ---------- the audio graph ---------- */

function ensureCtx() {
  if (typeof window === 'undefined') return null
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (!Ctx) return null
  if (!ctx) { try { ctx = new Ctx() } catch { return null } }
  if (ctx.state === 'suspended') { try { ctx.resume() } catch { /* not unlocked yet */ } }
  return ctx
}

/** One-time unlock: create/resume the context on the first user gesture, so a
 *  later SSE-driven play finds it already running. Idempotent. */
export function initChime() {
  if (typeof window === 'undefined') return
  const unlock = () => { ensureCtx() }
  window.addEventListener('pointerdown', unlock, { once: true, capture: true, passive: true })
  window.addEventListener('keydown', unlock, { once: true, capture: true })
}

/** One bell note: a sine fundamental plus a quiet octave partial, fast attack,
 *  exponential decay. The partial is what makes it read "bell" not "beep". */
function note(ac, when, freq, peak, dur) {
  const env = ac.createGain()
  env.gain.setValueAtTime(0.0001, when)
  env.gain.linearRampToValueAtTime(peak, when + 0.012)
  env.gain.exponentialRampToValueAtTime(0.0001, when + dur)
  env.connect(ac.destination)
  for (const [mult, g] of [[1, 1], [2, 0.28]]) {
    const osc = ac.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = freq * mult
    const part = ac.createGain()
    part.gain.value = g
    osc.connect(part)
    part.connect(env)
    osc.start(when)
    osc.stop(when + dur + 0.05)
  }
}

/**
 * Play the chime. Silently a no-op when the pref is off, the context is not
 * unlocked yet, or the last play was under 1.2s ago (a coalescing burst must
 * not machine-gun the speaker — one ding says everything N would).
 */
export function playChime(kind = 'notification') {
  if (!soundEnabled()) return
  const now = Date.now()
  if (now - lastPlay < 1200) return
  const ac = ensureCtx()
  if (!ac || ac.state !== 'running') return
  lastPlay = now
  const t = ac.currentTime + 0.02
  if (kind === 'message') {
    note(ac, t, 659.25, 0.10, 0.28)                 // E5 — one soft tap
  } else {
    note(ac, t, 783.99, 0.13, 0.42)                 // G5…
    note(ac, t + 0.11, 1046.50, 0.11, 0.5)          // …C6, an ascending fourth
  }
}
