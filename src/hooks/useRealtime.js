/* =========================================================
   useRealtime — React hook wrapping the SSE stream.
   Opens a live stream for one entity and forwards every event
   to `onEvent`. Cleans up (closes EventSource) on unmount or
   id change.
   ========================================================= */
import { useEffect, useRef } from 'react'
import { openStream } from '../api/realtime.js'

/**
 * @param {'posts'|'questions'|'researches'} domain
 * @param {string|null} id  entity id (null/undefined = don't subscribe)
 * @param {object} handlers { onEvent, onConnected, onError }
 */
export function useRealtime(domain, id, handlers = {}) {
  const ref = useRef(handlers)
  useEffect(() => { ref.current = handlers })

  useEffect(() => {
    if (!id) return
    const close = openStream(domain, id, {
      onEvent: (e) => ref.current.onEvent?.(e),
      onConnected: (d) => ref.current.onConnected?.(d),
      onError: (e) => ref.current.onError?.(e),
    })
    return close
  }, [domain, id])
}
