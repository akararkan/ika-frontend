/* =========================================================
   useCooldown — the 429 countdown primitive (error guide §2.3).

   UI contract for RATE_LIMITED / MEDIA_QUOTA_EXCEEDED: disable
   the submit control for the server's hint, keep the visible
   seconds ticking, keep the user's draft intact, re-enable when
   the clock runs out. Never auto-retry in a loop.

     const [cooldown, startCooldown] = useCooldown()
     …catch (e) { startCooldown(e); … }        // no-op unless 429
     <button disabled={busy || cooldown > 0}>
       {cooldown > 0 ? `Wait ${cooldown}s` : 'Publish'}
     </button>
   ========================================================= */
import React from 'react'
import { cooldownSecondsFrom } from '../api/errors.js'

export function useCooldown() {
  const [left, setLeft] = React.useState(0)
  const timer = React.useRef(null)

  const clear = () => {
    if (timer.current) { clearInterval(timer.current); timer.current = null }
  }

  /** Accepts a caught error (reads its 429 hints; ignores anything else) or a
   *  plain number of seconds. Returns true when a countdown actually started. */
  const start = React.useCallback((secondsOrError) => {
    const s = typeof secondsOrError === 'number' ? secondsOrError : cooldownSecondsFrom(secondsOrError)
    if (!s || s <= 0) return false
    clear()
    setLeft(Math.ceil(s))
    timer.current = setInterval(() => {
      setLeft(prev => {
        if (prev <= 1) { clear(); return 0 }
        return prev - 1
      })
    }, 1000)
    return true
  }, [])

  React.useEffect(() => clear, [])
  return [left, start]
}
