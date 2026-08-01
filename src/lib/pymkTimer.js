/* =========================================================
   pymkTimer — how often "People you may know" may interrupt
   ---------------------------------------------------------
   The right-rail list is furniture: it sits beside the feed and
   costs the reader nothing. The IN-FEED strip is different — it
   is an interruption in a timeline, and an interruption that
   appears on every single load stops reading as a suggestion
   and starts reading as an ad.

   So the strip is on a clock, the way Facebook's is: it earns a
   slot at most once per COOLDOWN, and the rest of the time the
   feed is just the feed. Three properties make that honest:

   · The decision is made ONCE, at mount, and frozen. If it were
     re-evaluated on every render the strip could vanish
     mid-scroll as the clock ticked past — content disappearing
     under the reader's thumb.
   · The clock only starts when the strip ACTUALLY RENDERS. A
     load where the engine returned nobody must not burn the
     window, or a user whose suggestions were briefly empty
     would go hours without ever seeing one.
   · Dismissing the strip starts the same clock. "Not now" and
     "you've seen this" are the same state, so there is only one
     timestamp and no way for the two to disagree.

   localStorage, not memory: the whole point is to survive the
   reload. A blocked/absent store (private mode, embedded
   webview) fails OPEN — showing the strip is the ordinary
   behaviour, and no persistence must never mean no suggestions.
   ========================================================= */

const KEY = 'ika:pymk-shown-at'

/** How long the feed stays free of the strip after one has been seen. */
export const PYMK_COOLDOWN_MS = 3 * 60 * 60 * 1000   // 3 hours

function readAt() {
  try {
    const v = Number(localStorage.getItem(KEY))
    return Number.isFinite(v) && v > 0 ? v : 0
  } catch { return 0 }        // storage blocked → treat as "never shown"
}

/** True when the in-feed strip is allowed to appear right now. */
export function pymkDue(now = Date.now()) {
  const last = readAt()
  // A clock that jumped backwards (timezone change, a device with a bad clock)
  // would otherwise lock the strip out until the future caught up.
  if (last > now) return true
  return now - last >= PYMK_COOLDOWN_MS
}

/** Start the cooldown. Called when the strip renders, and when it's dismissed. */
export function markPymkShown(now = Date.now()) {
  try { localStorage.setItem(KEY, String(now)) } catch { /* nothing to persist to */ }
}

/** Milliseconds until the strip is allowed back — 0 when it is due now. */
export function pymkWaitMs(now = Date.now()) {
  const last = readAt()
  if (last > now) return 0
  return Math.max(0, PYMK_COOLDOWN_MS - (now - last))
}

/** Test/debug seam: forget the timer so the next mount shows the strip. */
export function resetPymkTimer() {
  try { localStorage.removeItem(KEY) } catch { /* noop */ }
}
