/* =========================================================
   Moderation UI atoms — the four things every surface needs
   (contract + copy: src/lib/moderation.js)

     <ModerationBadge/>   the quiet chip on a held item, for its author
     <ModerationNotice/>  the explaining banner on a detail page
     <ModerationAlert/>   the composer-side refusal, draft-preserving
     useHeldWatch()       re-checks a held item until it clears

   One rule threads through all of them: a refusal is shown VERBATIM and is
   never decorated with a category, a score, or the offending phrase. The server
   is deliberately vague so an author cannot probe the classifier by trial and
   error, and re-adding the detail on the client would hand back exactly what the
   backend withheld.
   ========================================================= */
/* eslint-disable react-refresh/only-export-components */
import React from 'react'
import { Link } from 'react-router-dom'
import { Icon } from './ui.jsx'
import {
  MODERATION_COPY, isUnderReview, moderationText, recheckDelays,
} from '../lib/moderation.js'

const STATE_ICON = { checking: 'hourglass', review: 'eyeoff', removed: 'shield' }

/**
 * The chip that sits on the author's own held item. Deliberately small and
 * unalarming: a hold is not a punishment and most clear in under a second.
 *
 * `title` carries the full explanation so the chip can stay one word wide in a
 * card corner without becoming a mystery.
 */
export function ModerationBadge({ state, className = '' }) {
  const copy = MODERATION_COPY[state]
  if (!copy) return null
  return (
    <span className={`mod-badge mod-${state} ${className}`} title={copy.note}>
      <Icon name={STATE_ICON[state]} className="xs"/>
      <span className="mod-badge-tx">{copy.badge}</span>
    </span>
  )
}

/**
 * The full-width explainer for a detail page or a composer's own item.
 *
 * Says three things, in this order, because that is the order the user asks
 * them in: what state it is in, who can see it, and what happens next.
 */
export function ModerationNotice({ state, kind, className = '' }) {
  const copy = MODERATION_COPY[state]
  if (!copy) return null
  const noun = kind ? ` ${kind}` : ''
  return (
    <div className={`mod-note mod-${state} ${className}`} role="status">
      <span className="mod-note-ic" aria-hidden="true"><Icon name={STATE_ICON[state]} className="sm"/></span>
      <div className="mod-note-body">
        <strong className="mod-note-title">{copy.title}</strong>
        <p className="mod-note-tx">
          {state === 'removed'
            ? copy.note
            : `Your${noun} is visible only to you while this runs. ${copy.note}`}
        </p>
        {state === 'removed' && (
          <Link className="mod-note-link" to="/settings/safety">Appeal from Settings → Safety</Link>
        )}
      </div>
    </div>
  )
}

/**
 * The composer-side refusal. Render it INSIDE the composer, next to the submit
 * control, and leave the draft exactly where it is.
 *
 * Two shapes, because the backend distinguishes two situations that feel very
 * different to a person:
 *
 *   blocked (CONTENT_REJECTED) — this text will never post. There is nothing to
 *     retry, so there is no retry button; the way forward is editing.
 *   under review (CONTENT_UNDER_REVIEW) — the change simply has not landed yet
 *     and the same text may well succeed in a moment. That one DOES get a retry,
 *     because retrying is the correct action. It is the only moderation state
 *     where a retry button is honest.
 */
export function ModerationAlert({ error, onRetry, onDismiss, className = '' }) {
  if (!error) return null
  const pending = isUnderReview(error)
  return (
    <div className={`mod-alert ${pending ? 'mod-pending' : 'mod-blocked'} ${className}`} role="alert">
      <span className="mod-alert-ic" aria-hidden="true">
        <Icon name={pending ? 'hourglass' : 'shield'} className="sm"/>
      </span>
      <div className="mod-alert-body">
        {/* Verbatim. Nothing is appended that could hint at what tripped. */}
        <p className="mod-alert-tx">{moderationText(error)}</p>
        <div className="mod-alert-acts">
          {pending && onRetry && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>Try again</button>
          )}
          {!pending && (
            <Link className="mod-alert-link" to="/settings/safety">Appeal</Link>
          )}
          {onDismiss && (
            <button type="button" className="mod-alert-x" onClick={onDismiss} aria-label="Dismiss">
              <Icon name="close" className="xs"/>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Re-check a held item until it clears.
 *
 * Necessary because nothing pushes: there is no realtime moderation event on any
 * stream, and the "your content is live" notification fires only for content
 * that actually waited — anything that clears inline is silent by design. So the
 * only way a held card becomes a live card without a manual reload is this.
 *
 * `check` should re-fetch the single item and return the fresh entity (or null
 * when nothing is known yet); returning something no longer held stops the
 * watch. Keeping it a callback rather than a URL is what lets one hook serve a
 * post (`GET /posts/{id}`), a story (re-list by author) and a research paper
 * (`GET /researches/{id}`), which have nothing else in common.
 *
 * `key` restarts the back-off. A caller watching a SET (several held papers, a
 * tray of held stories) stays `active` while that set's membership changes, so
 * without an identity for it a newly held item would silently join a chain that
 * may already have run out to its ceiling — and be polled zero times. Pass the
 * joined ids; per-entity callers can leave it alone.
 */
export function useHeldWatch(active, kind, check, key = '') {
  /* The callback is almost always a fresh closure each render; parking it in a
     ref keeps the timer chain from being torn down and restarted on every
     parent render, which would otherwise reset the back-off to zero forever. */
  const checkRef = React.useRef(check)
  React.useEffect(() => { checkRef.current = check })

  React.useEffect(() => {
    if (!active) return undefined
    const offsets = recheckDelays(kind)
    let step = 0
    let timer = null
    let cancelled = false

    const arm = () => {
      if (cancelled || step >= offsets.length) return
      const gap = offsets[step] - (step ? offsets[step - 1] : 0)
      timer = setTimeout(async () => {
        step += 1
        try { await checkRef.current?.() } catch { /* a failed re-check is not an error state — try again on the next tick */ }
        arm()
      }, gap)
    }
    arm()

    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [active, kind, key])
}
