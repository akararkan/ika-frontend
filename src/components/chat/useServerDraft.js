/* =========================================================
   useServerDraft — the half-written message, per conversation
   ---------------------------------------------------------
   One draft row per (conversation, user), stored server-side so
   a message begun on a phone is waiting on the desktop. Three
   rules make this behave rather than fight the composer:

   1. RESTORE ONCE, AND ONLY OVER AN EMPTY BOX. The fetch is
      async; if the reader started typing while it was in flight,
      landing the stored draft would delete what they just wrote.
      So the restore is skipped whenever the local box is
      non-empty, and it never runs twice for the same
      conversation.

   2. SAVING IS DEBOUNCED AND ECHO-FREE. `PUT …/draft`
      overwrites, so there is nothing to merge — but writing on
      every keystroke would be one request per character. The
      write is trailing-debounced, and the last value written is
      remembered so an unchanged draft is not re-sent when the
      conversation is merely revisited.

   3. SENDING CLEARS IT SERVER-SIDE, so the client must NOT save
      afterwards. A save racing behind a send would resurrect the
      row the server had just deleted, and the next visit would
      restore a message that was already delivered. `markSent`
      is how the composer says "the server has cleared this" —
      it cancels the pending write instead of issuing one.
   ========================================================= */
import React from 'react'
import { api } from '../../api/index.js'

const SAVE_MS = 700

export function useServerDraft(conversationId, { value, onRestore, enabled = true } = {}) {
  const timerRef = React.useRef(null)
  const lastSavedRef = React.useRef('')
  const restoredForRef = React.useRef(null)
  const valueRef = React.useRef(value)
  React.useEffect(() => { valueRef.current = value })

  /* ---- restore ---- */
  React.useEffect(() => {
    if (!conversationId || !enabled) return undefined
    if (restoredForRef.current === conversationId) return undefined
    restoredForRef.current = conversationId
    lastSavedRef.current = ''
    let alive = true
    api.chat.drafts.get(conversationId)
      .then(d => {
        // Rule 1: never overwrite something the reader has already typed.
        if (!alive || !d?.body || valueRef.current) return
        lastSavedRef.current = d.body
        onRestore?.(d.body)
      })
      .catch(() => { /* a missing draft is the normal case */ })
    return () => { alive = false }
  }, [conversationId, enabled, onRestore])

  /* ---- save ---- */
  React.useEffect(() => {
    if (!conversationId || !enabled) return undefined
    if (restoredForRef.current !== conversationId) return undefined   // don't save before restoring
    const body = value || ''
    if (body === lastSavedRef.current) return undefined

    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      lastSavedRef.current = body
      const write = body
        ? api.chat.drafts.save(conversationId, { body })
        : api.chat.drafts.discard(conversationId)
      write.catch(() => { lastSavedRef.current = '' })   // let the next keystroke retry
    }, SAVE_MS)

    return () => clearTimeout(timerRef.current)
  }, [conversationId, value, enabled])

  /** The message was sent — the server already dropped the row. */
  return React.useCallback(() => {
    clearTimeout(timerRef.current)
    lastSavedRef.current = ''
  }, [])
}
