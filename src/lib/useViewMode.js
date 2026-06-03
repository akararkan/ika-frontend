/* =========================================================
   useViewMode — remembers a list page's layout (list / grid /
   compact) in localStorage, keyed per page. The stored value is
   validated against the allowlist on read so a stale / tampered
   key can never put a list into an unknown layout.
   ========================================================= */
import React from 'react'

export const VIEW_MODES = ['feed', 'grid', 'compact', 'grouped']

export function useViewMode(page, fallback = 'feed') {
  const key = 'ika:view:' + page
  const [view, setView] = React.useState(() => {
    try { const s = localStorage.getItem(key); return VIEW_MODES.includes(s) ? s : fallback }
    catch { return fallback }
  })
  React.useEffect(() => {
    try { localStorage.setItem(key, view) } catch { /* private mode / quota — keep in-memory */ }
  }, [key, view])
  return [view, setView]
}
