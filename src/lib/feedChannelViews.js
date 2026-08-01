/* =========================================================
   feedChannelViews — batch view markers for channel posts
   that appear in the HOME FEED
   ---------------------------------------------------------
   The chat surface already has `usePostViews` (components/chat),
   but it is bound to ONE conversation: the channel screen only
   ever reports posts belonging to the channel it is showing. The
   home feed is the opposite — a screenful of channel cards can
   come from eight different channels, and the endpoint is
   per-channel (`POST /channels/{id}/posts/views`).

   So this hook keeps the same two server truths and re-groups
   around them:

     · Each (post, viewer) pair is deduped server-side through a
       Redis HyperLogLog, so re-reporting is FREE — a per-session
       `seen` set is enough, nothing has to survive a reload.
     · A lost report costs a view, not correctness. Every failure
       is swallowed; a viewer count is not worth a toast.

   Reports are debounced and then grouped by channel, one request
   per channel per flush (≤100 ids each, the documented cap).
   ========================================================= */
import React from 'react'
import { api } from '../api/index.js'

const FLUSH_MS = 900
const MAX_PER_CALL = 100

/**
 * @returns observe(el, channelId, channelPostId) — call from a ref callback on
 *          each channel card. Safe to call with null (unmount).
 */
export function useFeedChannelViews() {
  const seenRef = React.useRef(new Set())        // "channelId:postId" already sent
  const queueRef = React.useRef(new Map())       // channelId → Set(postId)
  const timerRef = React.useRef(null)
  const ioRef = React.useRef(null)
  const nodesRef = React.useRef(new Map())       // element → { channelId, postId }

  const flush = React.useCallback(async () => {
    const groups = [...queueRef.current.entries()]
    queueRef.current = new Map()
    for (const [channelId, ids] of groups) {
      const list = [...ids]
      for (let i = 0; i < list.length; i += MAX_PER_CALL) {
        // Sequential per channel: scrolling a feed fast should not open a
        // socket per card for something this cheap.
        await api.channels.markViews(channelId, list.slice(i, i + MAX_PER_CALL)).catch(() => {})
      }
    }
  }, [])

  React.useEffect(() => {
    const io = new IntersectionObserver((entries) => {
      let queued = false
      for (const e of entries) {
        if (!e.isIntersecting) continue
        const hit = nodesRef.current.get(e.target)
        if (!hit) continue
        const key = `${hit.channelId}:${hit.postId}`
        if (seenRef.current.has(key)) continue
        seenRef.current.add(key)
        const set = queueRef.current.get(hit.channelId) || new Set()
        set.add(hit.postId)
        queueRef.current.set(hit.channelId, set)
        queued = true
        io.unobserve(e.target)                  // counted once — stop watching it
        nodesRef.current.delete(e.target)
      }
      if (!queued) return
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(flush, FLUSH_MS)
    }, { threshold: 0.5 })                      // half the card, not a pixel of it

    ioRef.current = io
    return () => {
      clearTimeout(timerRef.current)
      // Send what is queued rather than dropping it — unmount happens exactly
      // when the reader has just finished looking at a screenful.
      flush()
      io.disconnect()
      ioRef.current = null
      nodesRef.current = new Map()
    }
  }, [flush])

  return React.useCallback((el, channelId, postId) => {
    const io = ioRef.current
    if (!el || !io || !channelId || !postId) return
    if (seenRef.current.has(`${channelId}:${postId}`)) return
    nodesRef.current.set(el, { channelId, postId: String(postId) })
    io.observe(el)
  }, [])
}
