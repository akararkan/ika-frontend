/* =========================================================
   usePostViews — batch view markers for channel posts
   ---------------------------------------------------------
   Clients report which posts entered the viewport; the server
   dedupes each (post, viewer) pair through a Redis HyperLogLog
   before it ever reaches the Cassandra counter. Two things
   follow from that, and they are the whole design here:

     · Re-reporting is FREE. There is no need to remember across
       reloads what has already been counted, so this hook keeps
       only a per-session `seen` set — enough to stop the same
       row being re-sent every scroll tick, and nothing more.
     · A lost report costs a view, not correctness. Every failure
       is swallowed: a viewer count is not worth a toast, and
       certainly not worth interrupting reading.

   The endpoint takes at most 100 ids, so the queue is drained in
   hundreds. Reports are debounced rather than sent per row —
   flicking through a long channel would otherwise fire one
   request per bubble.
   ========================================================= */
import React from 'react'
import { api } from '../../api/index.js'

const FLUSH_MS = 900
const MAX_PER_CALL = 100

/**
 * @param channelId  the channel = the conversation id; null disables the hook
 * @param enabled    false for a non-channel conversation (the endpoint 404s)
 * @returns observe(el, messageId) — call from a ref callback on each row
 */
export function usePostViews(channelId, enabled) {
  const seenRef = React.useRef(new Set())
  const queueRef = React.useRef(new Set())
  const timerRef = React.useRef(null)
  const ioRef = React.useRef(null)
  const nodesRef = React.useRef(new Map())     // element → messageId

  const flush = React.useCallback(async () => {
    const ids = [...queueRef.current]
    queueRef.current.clear()
    if (!ids.length || !channelId) return
    for (let i = 0; i < ids.length; i += MAX_PER_CALL) {
      // Sequential, not parallel: a channel being scrolled fast should not
      // open ten sockets to report something this cheap.
      await api.channels.markViews(channelId, ids.slice(i, i + MAX_PER_CALL)).catch(() => {})
    }
  }, [channelId])

  /* A new conversation is a new set of posts — carrying `seen` across would
     suppress the first screen of the next channel. */
  React.useEffect(() => {
    seenRef.current = new Set()
    queueRef.current = new Set()
  }, [channelId])

  React.useEffect(() => {
    if (!enabled || !channelId) return undefined

    const io = new IntersectionObserver((entries) => {
      let queued = false
      for (const e of entries) {
        if (!e.isIntersecting) continue
        const id = nodesRef.current.get(e.target)
        // A pending (optimistic) row has a temporary id the server would 400
        // on, and my own just-sent post is already counted for me anyway.
        if (!id || String(id).startsWith('tmp') || seenRef.current.has(id)) continue
        seenRef.current.add(id)
        queueRef.current.add(id)
        queued = true
        io.unobserve(e.target)          // counted once — stop watching it
      }
      if (!queued) return
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(flush, FLUSH_MS)
    }, { threshold: 0.5 })              // half the bubble, not a pixel of it

    ioRef.current = io
    return () => {
      clearTimeout(timerRef.current)
      // Send what is already queued rather than dropping it — this fires on
      // every conversation switch, which is exactly when a reader has just
      // finished looking at a screenful.
      flush()
      io.disconnect()
      ioRef.current = null
      nodesRef.current = new Map()
    }
  }, [enabled, channelId, flush])

  /** Ref callback for a message row. Safe to call with null (unmount). */
  return React.useCallback((el, messageId) => {
    const io = ioRef.current
    if (!el || !io || !messageId) return
    if (seenRef.current.has(messageId)) return
    nodesRef.current.set(el, messageId)
    io.observe(el)
  }, [])
}
