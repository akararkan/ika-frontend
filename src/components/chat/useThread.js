/* =========================================================
   useThread — the per-conversation message store.
   ---------------------------------------------------------
   Holds one conversation's messages as a Map keyed by messageId
   (dedupe is free) and derives an ASCENDING array for render.
   It owns: cursor paging (older), optimistic send/reconcile,
   edit/delete/react deltas, forward/pin, gap-sync on reconnect,
   delivered receipts, and the debounced read marker.

   Realtime arrives through useChat().subscribe(...) — the ONE
   app socket lives in ChatProvider; this hook only filters the
   firehose by conversationId. Counters are applied as +1/-1
   deltas (the wire carries no absolute counts), and the sender's
   own devices ALSO receive message.new, so everything dedupes by
   messageId and reconciles optimistic sends by clientNonce.
   ========================================================= */
import React from 'react'
import { api, adapters } from '../../api/index.js'
import { showToast } from '../ui.jsx'
import { useAuth } from '../../context/AuthContext.jsx'
import { useChat } from '../../context/ChatContext.jsx'
import { chatError, isThrottle } from './chatErrors.js'
import { newTmpId, isTmpId, cmpId, gtId } from '../../api/ids.js'

/* Message ids are Snowflake STRINGS (see api/ids.js): 18 digits, well past
   Number.MAX_SAFE_INTEGER. Optimistic bubbles get a `t<seq>` id instead —
   unmistakably local, and sorted last by cmpId because a pending message is
   always the newest thing in the thread. */
const tmpId = newTmpId

/** Ascending by id — pending (temp) ids sort after every real message. */
const cmpMsg = (a, b) => cmpId(a.id, b.id)

/** File → message media kind. */
function kindOfFile(f) {
  const t = f?.type || ''
  if (t.startsWith('image/')) return 'IMAGE'
  if (t.startsWith('video/')) return 'VIDEO'
  if (t.startsWith('audio/')) return 'VOICE'
  return 'FILE'
}

/** Newest REAL (server-assigned, non-pending) message id in the map, else null. */
function highestRealId(map) {
  let max = null
  for (const m of map.values()) {
    if (!m.pending && !isTmpId(m.id) && m.id != null && gtId(m.id, max)) max = m.id
  }
  return max
}

/** Apply a single ±1 reaction delta to a reactions array (immutable copy). */
function applyReactionDelta(reactions, emoji, add, mine) {
  const arr = (reactions || []).map(r => ({ ...r }))
  const i = arr.findIndex(r => r.emoji === emoji)
  if (add) {
    if (i >= 0) { arr[i].count += 1; if (mine) arr[i].reactedByMe = true }
    else arr.push({ emoji, count: 1, reactedByMe: !!mine })
  } else if (i >= 0) {
    arr[i].count = Math.max(0, arr[i].count - 1)
    if (mine) arr[i].reactedByMe = false
    if (arr[i].count === 0) arr.splice(i, 1)
  }
  return arr
}

/**
 * Move one user from `from` to `to` in a reactions array.
 *
 * CHAT REACTIONS ARE ONE EMOJI PER USER — unlike the post module's
 * single-LIKE model, and unlike every "add a reaction" API you have probably
 * met. Reacting again with a different emoji **changes** your reaction; there
 * is exactly one row per (message, user).
 *
 * The trap: the wire reports an add and a change **identically**, as a single
 * `message.reaction` with `added: true` for the NEW emoji. There is no paired
 * `added: false` for the old one. So a consumer that only ever increments
 * leaves the previous bucket standing forever — the counts drift upward and
 * never come back down, on every reaction anybody changes their mind about.
 *
 * `from` is null when we never observed this user's previous choice (a page
 * loaded after they reacted); the caller invalidates the exact-flag in that
 * case so the lazy re-hydration repairs it on the next hover.
 */
function applyReactionSwitch(reactions, { from, to, mine }) {
  let arr = reactions || []
  if (from && from !== to) arr = applyReactionDelta(arr, from, false, mine)
  if (to) arr = applyReactionDelta(arr, to, true, mine)
  return arr
}

export function useThread(conversationId, { onConvoPatch } = {}) {
  const { user } = useAuth()
  const { subscribe, markRead } = useChat()

  const [msgMap, setMsgMap] = React.useState(() => new Map())
  const [loading, setLoading] = React.useState(true)
  const [loadingOlder, setLoadingOlder] = React.useState(false)
  const [hasMore, setHasMore] = React.useState(false)
  const [cursor, setCursor] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [pinned, setPinned] = React.useState([])
  const [scheduled, setScheduled] = React.useState([])   // my PENDING send-later queue

  // ----- refs (read synchronously inside handlers, no stale closures) -----
  const myIdRef = React.useRef(null)
  const msgMapRef = React.useRef(msgMap)
  const cursorRef = React.useRef(null)
  const hasMoreRef = React.useRef(false)
  const loadingOlderRef = React.useRef(false)
  const highestRef = React.useRef(null)              // highest known real id (gap-sync anchor)
  const deliveredRef = React.useRef(new Set())       // foreign ids we've already ack'd
  const lastReadSentRef = React.useRef(null)         // never send an older read marker than this
  const pendingUrlsRef = React.useRef(new Map())     // clientNonce -> [objectUrl] (revoke on reconcile)
  const outboxRef = React.useRef(new Map())          // clientNonce -> resend payload (retry)
  const readTimerRef = React.useRef(null)
  const convIdRef = React.useRef(conversationId)
  const scheduledCountRef = React.useRef(0)          // "is anything queued?" — read inside the stream handler
  /* messageId -> (userId -> emoji). The reaction summary carries COUNTS, not
     member lists, so this is the only record of who currently holds what —
     built purely from observed events, which is why a reactor we never saw
     falls back to re-hydration instead of a guess. */
  const reactorsRef = React.useRef(new Map())
  const onConvoPatchRef = React.useRef(onConvoPatch)   // ref so an inline callback can't churn scheduleRead → reload

  React.useEffect(() => { onConvoPatchRef.current = onConvoPatch })
  React.useEffect(() => { myIdRef.current = user?.id ?? null }, [user])
  React.useEffect(() => { msgMapRef.current = msgMap }, [msgMap])
  React.useEffect(() => { cursorRef.current = cursor }, [cursor])
  React.useEffect(() => { hasMoreRef.current = hasMore }, [hasMore])
  React.useEffect(() => { loadingOlderRef.current = loadingOlder }, [loadingOlder])
  React.useEffect(() => { convIdRef.current = conversationId }, [conversationId])
  React.useEffect(() => { scheduledCountRef.current = scheduled.length }, [scheduled])

  const messages = React.useMemo(() => [...msgMap.values()].sort(cmpMsg), [msgMap])

  const meAuthor = React.useMemo(
    () => adapters.authorFrom({
      id: user?.id, username: user?.handle, fullName: user?.full,
      profileImage: user?.profileImage, verified: user?.verified, role: user?.role,
    }),
    [user],
  )

  /* ---------------- object-url bookkeeping ---------------- */

  const revokeUrls = React.useCallback((nonce) => {
    const urls = pendingUrlsRef.current.get(nonce)
    if (urls) { urls.forEach(u => { try { URL.revokeObjectURL(u) } catch { /* noop */ } }); pendingUrlsRef.current.delete(nonce) }
  }, [])

  /* ---------------- delivered receipt (once per foreign message) ---------------- */

  const markDelivered = React.useCallback((m) => {
    if (!m || m.pending || m.id == null) return
    if (String(m.senderId) === String(myIdRef.current)) return
    if (deliveredRef.current.has(m.id)) return
    deliveredRef.current.add(m.id)
    api.chat.messages.delivered(m.id).catch(() => {})
  }, [])

  /* ---------------- read marker (debounced, visible-only, forward-only) ---------------- */

  const scheduleRead = React.useCallback(() => {
    clearTimeout(readTimerRef.current)
    readTimerRef.current = setTimeout(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      const top = highestRealId(msgMapRef.current)
      if (top && gtId(top, lastReadSentRef.current)) {
        lastReadSentRef.current = top
        markRead(convIdRef.current, top)              // POST /read + badge zero (context)
        onConvoPatchRef.current?.({ lastReadMessageId: top, unreadCount: 0, hasUnread: false })
      }
    }, 600)
  }, [markRead])

  /* ---------------- incoming realtime message ---------------- */

  const addIncoming = React.useCallback((m) => {
    if (!m || m.id == null) return
    setMsgMap(prev => {
      const next = new Map(prev)
      if (!next.has(m.id) && String(m.senderId) === String(myIdRef.current)) {
        // My own echo (may arrive before the 201) — drop the matching pending bubble.
        for (const [k, v] of next) {
          if (v.pending && String(v.senderId) === String(myIdRef.current) && (v.body || '') === (m.body || '')) {
            revokeUrls(v.clientNonce); next.delete(k); break
          }
        }
      }
      next.set(m.id, { ...(next.get(m.id) || {}), ...m })
      return next
    })
    if (!isTmpId(m.id) && gtId(m.id, highestRef.current)) highestRef.current = m.id
  }, [revokeUrls])

  const patchMsg = React.useCallback((id, patch) => {
    setMsgMap(prev => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.set(id, { ...next.get(id), ...patch })
      return next
    })
  }, [])

  /* ---------------- loaders ---------------- */

  const reload = React.useCallback(async () => {
    if (!conversationId) return
    setLoading(true); setError(null)
    try {
      const res = await api.chat.messages.page(conversationId, { limit: 40 })
      const map = new Map()
      for (const m of res.items) map.set(m.id, m)     // items are newest→older; Map order doesn't matter (we sort)
      setMsgMap(map)
      setCursor(res.nextCursor); cursorRef.current = res.nextCursor
      setHasMore(res.hasMore); hasMoreRef.current = res.hasMore
      highestRef.current = highestRealId(map)
      scheduleRead()
    } catch (e) {
      setError(e?.message || 'Could not load messages')
    } finally {
      setLoading(false)
    }
  }, [conversationId, scheduleRead])

  const loadOlder = React.useCallback(async () => {
    if (loadingOlderRef.current || !hasMoreRef.current || !cursorRef.current) return
    setLoadingOlder(true)
    try {
      const res = await api.chat.messages.page(conversationId, { cursor: cursorRef.current, limit: 40 })
      setMsgMap(prev => {
        const next = new Map(prev)
        for (const m of res.items) if (!next.has(m.id)) next.set(m.id, m)   // never clobber a fresher copy
        return next
      })
      setCursor(res.nextCursor); cursorRef.current = res.nextCursor
      setHasMore(res.hasMore); hasMoreRef.current = res.hasMore
    } catch (e) {
      showToast(chatError(e, 'Could not load older messages'))
    } finally {
      setLoadingOlder(false)
    }
  }, [conversationId])

  const reloadPinned = React.useCallback(async () => {
    if (!conversationId) return
    try { setPinned(await api.chat.messages.pinned(conversationId)) }
    catch { /* pinned bar is non-critical */ }
  }, [conversationId])

  const reloadScheduled = React.useCallback(async () => {
    if (!conversationId) return
    try { setScheduled(await api.chat.scheduled.list(conversationId)) }
    catch { /* the queue is an extra, never a blocker */ }
  }, [conversationId])

  /* ---------------- reconcile an optimistic send ---------------- */

  const reconcile = React.useCallback((nonce, real) => {
    revokeUrls(nonce)
    outboxRef.current.delete(nonce)
    if (!real) return
    deliveredRef.current.add(real.id)               // it's mine — never self-ack delivered
    if (!isTmpId(real.id) && gtId(real.id, highestRef.current)) highestRef.current = real.id
    setMsgMap(prev => {
      const next = new Map(prev)
      for (const [k, v] of next) if (v.pending && v.clientNonce === nonce) next.delete(k)
      next.set(real.id, real)
      return next
    })
  }, [revokeUrls])

  const markFailed = React.useCallback((nonce) => {
    setMsgMap(prev => {
      const next = new Map(prev)
      for (const [k, v] of next) if (v.clientNonce === nonce) next.set(k, { ...v, pending: false, failed: true })
      return next
    })
  }, [])

  /** Build an optimistic bubble that matches the msgFrom view shape. */
  const buildOptimistic = React.useCallback((nonce, { type, body, replyToId, media }) => {
    const rt = replyToId ? msgMapRef.current.get(replyToId) : null
    return {
      id: tmpId(),
      clientNonce: nonce,
      conversationId,
      senderId: user?.id ?? null,
      sender: meAuthor,
      type: type || 'TEXT',
      body: body || '',
      media: media || [],
      replyToId: replyToId ?? null,
      replyTo: rt ? { messageId: rt.id, senderId: rt.senderId, type: rt.type, snippet: (rt.body || '').slice(0, 120), deleted: !!rt.deleted } : null,
      forwardedFrom: null,
      mentions: [],
      reactions: [],
      editedAt: null,
      deleted: false,
      systemEvent: null,
      createdAt: new Date().toISOString(),
      isSystem: false,
      time: 'now',
      pending: true,
      failed: false,
    }
  }, [conversationId, user, meAuthor])

  /* ---------------- send ---------------- */

  const sendText = React.useCallback(async ({ body, replyToId } = {}) => {
    const text = (body || '').trim()
    if (!text || !conversationId) return
    const nonce = api.chat.newNonce()
    const optimistic = buildOptimistic(nonce, { type: 'TEXT', body: text, replyToId })
    outboxRef.current.set(nonce, { kind: 'text', body: text, replyToId })
    setMsgMap(prev => new Map(prev).set(optimistic.id, optimistic))
    try {
      const real = await api.chat.messages.send(conversationId, { clientNonce: nonce, type: 'TEXT', body: text, replyToId })
      reconcile(nonce, real)
    } catch (e) {
      markFailed(nonce)
      if (!isThrottle(e)) showToast(chatError(e, 'Message failed to send'))
    }
  }, [conversationId, buildOptimistic, reconcile, markFailed])

  const sendFiles = React.useCallback(async ({ files, body, replyToId, durationMs } = {}) => {
    const list = Array.from(files || [])
    if (!list.length || !conversationId) return
    const nonce = api.chat.newNonce()
    const urls = []
    const media = list.map(f => {
      const url = URL.createObjectURL(f); urls.push(url)
      return {
        kind: kindOfFile(f), url, thumbnailUrl: null,
        mime: f.type || '', bytes: f.size || 0, fileName: f.name || '', altText: '',
        // Carried for the optimistic bubble only: the multipart endpoint has
        // no duration part, so the server re-derives it. Without this the
        // pending voice bubble would render 0:00 until the echo arrives.
        durationMs: durationMs ?? null,
      }
    })
    pendingUrlsRef.current.set(nonce, urls)
    outboxRef.current.set(nonce, { kind: 'files', body: body || '', files: list, replyToId, durationMs })
    const optimistic = buildOptimistic(nonce, { type: media[0]?.kind || 'FILE', body, media, replyToId })
    setMsgMap(prev => new Map(prev).set(optimistic.id, optimistic))
    try {
      const real = await api.chat.messages.sendFiles(conversationId, {
        clientNonce: nonce, body, files: list, replyToId,
      })
      reconcile(nonce, real)
    } catch (e) {
      markFailed(nonce)
      if (!isThrottle(e)) showToast(chatError(e, 'Upload failed'))
    }
  }, [conversationId, buildOptimistic, reconcile, markFailed])

  const retry = React.useCallback(async (msg) => {
    const nonce = msg?.clientNonce
    const entry = nonce && outboxRef.current.get(nonce)
    if (!entry) return
    patchMsg(msg.id, { pending: true, failed: false })
    try {
      const real = entry.kind === 'files'
        ? await api.chat.messages.sendFiles(conversationId, {
            clientNonce: nonce, body: entry.body, files: entry.files, replyToId: entry.replyToId,
          })
        : await api.chat.messages.send(conversationId, { clientNonce: nonce, type: 'TEXT', body: entry.body, replyToId: entry.replyToId })
      reconcile(nonce, real)
    } catch (e) {
      markFailed(nonce)
      if (!isThrottle(e)) showToast(chatError(e, 'Still could not send'))
    }
  }, [conversationId, patchMsg, reconcile, markFailed])

  /* ---------------- edit / delete ---------------- */

  const editMessage = React.useCallback(async (id, body) => {
    const prev = msgMapRef.current.get(id)
    if (!prev) return
    const text = (body || '').trim()
    patchMsg(id, { body: text, editedAt: new Date().toISOString() })
    try {
      const real = await api.chat.messages.edit(id, text)
      if (real) patchMsg(id, real)
    } catch (e) {
      patchMsg(id, { body: prev.body, editedAt: prev.editedAt })
      showToast(chatError(e, 'Could not edit message'))
    }
  }, [patchMsg])

  /**
   * Two different deletes behind one verb.
   *  - `everyone` (default): tombstone for all members. The row stays in the
   *    timeline as a "message deleted" stub, so it is PATCHED, not removed.
   *  - `me`: hides the row from my page/sync/search/starred only. Nothing is
   *    broadcast and nobody else is affected, so it is DROPPED from the map —
   *    leaving a tombstone would claim a deletion the group never saw.
   */
  const deleteMessage = React.useCallback(async (id, scope = 'everyone') => {
    const prev = msgMapRef.current.get(id)
    if (!prev) return
    if (scope === 'me') {
      setMsgMap(m => { const next = new Map(m); next.delete(id); return next })
      setPinned(list => list.filter(p => p.id !== id))
      try { await api.chat.messages.remove(id, 'me') }
      catch (e) {
        setMsgMap(m => new Map(m).set(id, prev))     // put it back — it is still readable
        showToast(chatError(e, 'Could not hide the message'))
      }
      return
    }
    // Stamped locally too: my own delete has no round trip to learn the actor
    // from, and the echo that carries it may never arrive on this device.
    patchMsg(id, { deleted: true, body: '', media: [], starred: false, deletedBy: myIdRef.current })
    /* Soft-deleting a message also UNPINS it server-side, and the pinned list
       is a separate fetch that nothing here would otherwise refresh — leaving
       a tombstoned message quoted in the pin bar until the next reload. */
    const wasPinned = pinned.some(p => p.id === id)
    if (wasPinned) setPinned(list => list.filter(p => p.id !== id))
    try { await api.chat.messages.remove(id, 'everyone') }
    catch (e) {
      patchMsg(id, {
        deleted: prev.deleted, body: prev.body, media: prev.media,
        starred: prev.starred, deletedBy: prev.deletedBy ?? null,
      })
      if (wasPinned) reloadPinned()
      showToast(chatError(e, 'Could not delete message'))
    }
  }, [patchMsg, pinned, reloadPinned])

  /* ---------------- star (private bookmark) ---------------- */

  const toggleStar = React.useCallback(async (id) => {
    const m = msgMapRef.current.get(id)
    if (!m || m.pending) return
    const next = !m.starred
    patchMsg(id, { starred: next })
    try {
      await (next ? api.chat.messages.star(id) : api.chat.messages.unstar(id))
      showToast(next ? 'Added to starred' : 'Removed from starred')
    } catch (e) {
      patchMsg(id, { starred: m.starred })
      showToast(chatError(e, 'Could not update starred'))
    }
  }, [patchMsg])

  /* ---------------- reactions ---------------- */

  /* The timeline page hydrates reaction COUNTS from Redis and hard-codes
     `reactedByMe: false` on every row — only GET /messages/{id}/reactions
     reads the Cassandra source of truth. Without this, after a reload your own
     reaction is no longer highlighted and toggling it POSTs `/react` again
     instead of DELETEing, so removing it costs two taps. Refresh the flag
     on demand (the bubble asks when its reaction strip is opened) and cache
     the answer on the row. A 404 means the message is below the caller's
     floor — "not available to you", not an error worth retrying. */
  const refreshReactions = React.useCallback(async (id) => {
    const m = msgMapRef.current.get(id)
    if (!m || m.pending || m.deleted || m._reactionsExact) return
    if (!(m.reactions || []).length) { patchMsg(id, { _reactionsExact: true }); return }
    try {
      const rows = await api.chat.messages.reactions(id)
      patchMsg(id, { reactions: rows, _reactionsExact: true })
    } catch { /* floored or gone — keep the counts we have */ }
  }, [patchMsg])

  const toggleReaction = React.useCallback(async (id, emoji) => {
    const m = msgMapRef.current.get(id)
    if (!m || m.pending) return
    const had = (m.reactions || []).some(r => r.emoji === emoji && r.reactedByMe)
    /* My own current pick, if any — one emoji per user, so tapping a DIFFERENT
       one is a move, not a second reaction. Without retiring the old bucket the
       optimistic frame shows me holding two reactions at once until the
       response lands. */
    const minePrev = (m.reactions || []).find(r => r.reactedByMe)?.emoji || null

    patchMsg(id, {
      reactions: had
        ? applyReactionDelta(m.reactions, emoji, false, true)              // un-react
        : applyReactionSwitch(m.reactions, { from: minePrev, to: emoji, mine: true }),
    })
    try {
      const rows = had ? await api.chat.messages.unreact(id) : await api.chat.messages.react(id, emoji)
      // The response IS the authoritative per-viewer summary, so the row is
      // exact from here on — no follow-up GET needed.
      patchMsg(id, { reactions: rows, _reactionsExact: true })
    } catch (e) {
      patchMsg(id, { reactions: m.reactions })
      showToast(chatError(e, 'Could not react'))
    }
  }, [patchMsg])

  /* ---------------- scheduled (send-later) ---------------- */

  /* No optimistic bubble here on purpose: a scheduled message does not exist
     in the timeline until the poller fires it (~15s granularity) through the
     normal send path. Showing one now would be a lie the thread could not
     reconcile, and a permission change before the fire time legitimately
     turns the row FAILED rather than delivering it. */
  const scheduleMessage = React.useCallback(async ({ body, replyToId, scheduledAt } = {}) => {
    const text = (body || '').trim()
    if (!text || !conversationId || !scheduledAt) return null
    try {
      const row = await api.chat.scheduled.create(conversationId, {
        scheduledAt, clientNonce: api.chat.newNonce(), type: 'TEXT', body: text, replyToId,
      })
      if (row) setScheduled(prev => [...prev, row].sort((a, b) => Date.parse(a.scheduledAt || 0) - Date.parse(b.scheduledAt || 0)))
      return row
    } catch (e) {
      showToast(chatError(e, 'Could not schedule the message'))
      throw e
    }
  }, [conversationId])

  const cancelScheduled = React.useCallback(async (scheduledId) => {
    const snapshot = scheduled
    setScheduled(prev => prev.filter(s => s.id !== scheduledId))
    try { await api.chat.scheduled.cancel(scheduledId) }
    catch (e) { setScheduled(snapshot); showToast(chatError(e, 'Could not cancel')) }
  }, [scheduled])

  /* ---------------- forward / pin ---------------- */

  const forwardMessage = React.useCallback(async (id, targetConvId) => {
    try { await api.chat.messages.forward(id, targetConvId, api.chat.newNonce()); showToast('Forwarded') }
    catch (e) { showToast(chatError(e, 'Could not forward')); throw e }
  }, [])

  const pinMessage = React.useCallback(async (id) => {
    try { await api.chat.messages.pin(conversationId, id); reloadPinned() }
    catch (e) { showToast(chatError(e, 'Could not pin message')) }
  }, [conversationId, reloadPinned])

  const unpinMessage = React.useCallback(async (id) => {
    setPinned(prev => prev.filter(p => p.id !== id))
    try { await api.chat.messages.unpin(conversationId, id) }
    catch (e) { showToast(chatError(e, 'Could not unpin message')); reloadPinned() }
  }, [conversationId, reloadPinned])

  /* ---------------- jumpTo (page back until the message is loaded) ---------------- */

  const jumpTo = React.useCallback(async (messageId) => {
    if (msgMapRef.current.has(messageId)) return true
    let curCursor = cursorRef.current
    let more = hasMoreRef.current
    let guard = 0
    while (more && curCursor && guard < 20) {
      guard++
      let res
      try { res = await api.chat.messages.page(conversationId, { cursor: curCursor, limit: 50 }) }
      catch { return false }
      setMsgMap(prev => {
        const next = new Map(prev)
        for (const m of res.items) if (!next.has(m.id)) next.set(m.id, m)
        return next
      })
      curCursor = res.nextCursor; more = res.hasMore
      setCursor(curCursor); cursorRef.current = curCursor
      setHasMore(more); hasMoreRef.current = more
      if (res.items.some(m => m.id === messageId)) return true
    }
    return msgMapRef.current.has(messageId)
  }, [conversationId])

  /* ---------------- gap-sync on (re)connect ---------------- */

  const gapSync = React.useCallback(async () => {
    const after = highestRef.current
    if (!after || !convIdRef.current) return
    try {
      const rows = await api.chat.messages.sync(convIdRef.current, after, 100)
      if (!rows.length) return
      setMsgMap(prev => {
        const next = new Map(prev)
        for (const m of rows) if (!next.has(m.id)) next.set(m.id, m)
        return next
      })
      for (const m of rows) {
        if (!isTmpId(m.id) && gtId(m.id, highestRef.current)) highestRef.current = m.id
        markDelivered(m)
      }
      scheduleRead()
    } catch { /* the next reconnect retries */ }
  }, [markDelivered, scheduleRead])

  /* ---------------- lifecycle: (re)load + reset on conversation change ---------------- */

  React.useEffect(() => {
    // reset per-conversation state
    lastReadSentRef.current = null
    highestRef.current = null
    deliveredRef.current = new Set()
    reactorsRef.current = new Map()
    // revoke any object urls carried over (defensive; new convo won't reuse them)
    for (const [nonce] of pendingUrlsRef.current) revokeUrls(nonce)
    pendingUrlsRef.current.clear()
    outboxRef.current.clear()
    setMsgMap(new Map())
    setPinned([])
    setScheduled([])
    setCursor(null); cursorRef.current = null
    setHasMore(false); hasMoreRef.current = false
    reload()
    reloadPinned()
    reloadScheduled()
    return () => { clearTimeout(readTimerRef.current) }
  }, [conversationId, reload, reloadPinned, reloadScheduled, revokeUrls])

  /* ---------------- realtime subscription (filter the firehose by convId) ---------------- */

  React.useEffect(() => {
    if (!conversationId) return undefined
    const off = subscribe((evt) => {
      switch (evt.type) {
        case 'connected':
          gapSync()
          break
        case 'message.new':
          if (evt.conversationId !== conversationId) return
          addIncoming(evt.message)
          markDelivered(evt.message)
          scheduleRead()
          /* A queued send-later fires through the NORMAL send path, so its
             only tell on the client is one of my own messages arriving that I
             did not just type. Re-pull the queue so the fired row leaves it —
             but only while something is actually queued. */
          if (scheduledCountRef.current
            && String(evt.message?.senderId) === String(myIdRef.current)
            && !outboxRef.current.size) {
            reloadScheduled()
          }
          break
        case 'message.edited':
          if (evt.conversationId !== conversationId) return
          patchMsg(evt.messageId, { body: evt.body, editedAt: evt.editedAt })
          break
        case 'message.deleted':
          if (evt.conversationId !== conversationId) return
          /* `deletedBy` is only ever knowable from this frame — the message
             row carries no actor. Stamp it so the tombstone can say WHO
             removed it (mine → "You deleted this message"), and leave the
             field alone when the server sent no actor rather than writing
             `null` over a value an earlier frame supplied. */
          patchMsg(evt.messageId, {
            deleted: true, body: '', media: [],
            ...(evt.userId ? { deletedBy: evt.userId } : null),
          })
          break
        case 'message.reaction': {
          if (evt.conversationId !== conversationId) return
          if (String(evt.userId) === String(myIdRef.current)) return   // my own is already applied optimistically
          const m = msgMapRef.current.get(evt.messageId)
          if (!m) break
          /* One emoji per user, and a CHANGE arrives as a bare `added:true`
             with no removal for the old one — so retire this reactor's
             previous choice ourselves or the old bucket never comes down.
             `who` is what makes that possible: the reaction summary carries
             counts, not member lists, so the only record of who picked what
             is the events we have watched go by. */
          const perMsg = reactorsRef.current.get(evt.messageId)
            || reactorsRef.current.set(evt.messageId, new Map()).get(evt.messageId)
          const who = String(evt.userId)
          const previous = perMsg.get(who) || null

          if (evt.added) {
            patchMsg(evt.messageId, {
              reactions: applyReactionSwitch(m.reactions, { from: previous, to: evt.emoji, mine: false }),
              // Only trustworthy when we knew their previous pick. Otherwise
              // let the next hover re-pull the exact buckets.
              ...(previous ? {} : { _reactionsExact: false }),
            })
            perMsg.set(who, evt.emoji)
          } else {
            patchMsg(evt.messageId, { reactions: applyReactionDelta(m.reactions, evt.emoji, false, false) })
            perMsg.delete(who)
          }
          break
        }
        case 'conversation.updated':
          // PINNED / UNPINNED ride this event with a `memberChange`
          // discriminator (see 09-api-reference §5). Without this the pinned
          // bar only ever reflected pins made by THIS client.
          if (evt.conversationId !== conversationId) return
          if (evt.memberChange === 'PINNED' || evt.memberChange === 'UNPINNED') reloadPinned()
          break
        default:
          break
      }
    })
    return off
  }, [conversationId, subscribe, gapSync, addIncoming, markDelivered, scheduleRead, patchMsg,
      reloadPinned, reloadScheduled])

  /* ---------------- advance the read marker when the tab becomes visible ---------------- */

  React.useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') scheduleRead() }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [scheduleRead])

  /* ---------------- unmount: revoke every outstanding object url ---------------- */

  React.useEffect(() => () => {
    for (const [nonce] of pendingUrlsRef.current) revokeUrls(nonce)
    pendingUrlsRef.current.clear()
    clearTimeout(readTimerRef.current)
  }, [revokeUrls])

  return {
    messages, loading, loadingOlder, hasMore, error,
    loadOlder, reload,
    sendText, sendFiles,
    editMessage, deleteMessage,
    toggleReaction, refreshReactions,
    toggleStar,
    forwardMessage,
    pinMessage, unpinMessage,
    pinned, reloadPinned,
    scheduled, scheduleMessage, cancelScheduled, reloadScheduled,
    retry,
    jumpTo,
  }
}
