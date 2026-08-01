/* =========================================================
   FollowButton — one follow control, one follow model
   ---------------------------------------------------------
   The app had grown three hand-rolled copies of this (reels,
   the research hero, the profile page) and they did not agree
   on the two things that matter:

   · WHERE THE TRUTH COMES FROM. Follow state is never guessed
     and never carried over from a list row — it is read once
     from `GET /users/{id}/social-status`, which is the only
     endpoint that answers "does THIS viewer follow them?".
     Until it answers, the button renders in an indeterminate
     state rather than defaulting to "Follow", because a button
     that says Follow to someone who already follows is worse
     than a button that says nothing for 200ms.
   · SELF AND ANONYMOUS. You cannot follow yourself and an
     anonymous viewer cannot follow anyone, so both render
     NOTHING. Every copy of this that forgot the self-check
     shipped a Follow button on your own content.

   Optimistic with rollback: the flip is instant, a failure puts
   it back and says so, because a follow that silently didn't
   happen is indistinguishable from one that did.
   ========================================================= */
import React from 'react'
import { Icon, showToast } from './ui.jsx'
import { api } from '../api/index.js'

/**
 * Follow state for one user.
 * @returns {{following: boolean|null, busy: boolean, canFollow: boolean, toggle: () => void}}
 *          `following` is null until social-status answers.
 */
export function useFollowState(userId, meId) {
  const [following, setFollowing] = React.useState(null)
  const [busy, setBusy] = React.useState(false)

  const canFollow = !!userId && !!meId && String(userId) !== String(meId)

  React.useEffect(() => {
    if (!canFollow) { setFollowing(null); return undefined }
    let alive = true
    api.users.socialStatus(userId)
      .then(s => { if (alive) setFollowing(!!s?.isFollowing) })
      // A dead status read must not hide the button — the action still works,
      // and "Follow" is the safe default when we genuinely don't know.
      .catch(() => { if (alive) setFollowing(false) })
    return () => { alive = false }
  }, [userId, meId, canFollow])

  const toggle = React.useCallback(() => {
    if (!canFollow || busy || following === null) return
    const next = !following
    setFollowing(next)
    setBusy(true)
    ;(next ? api.users.follow(userId) : api.users.unfollow(userId))
      .catch(() => { setFollowing(!next); showToast('Could not update following') })
      .finally(() => setBusy(false))
  }, [canFollow, busy, following, userId])

  return { following, busy, canFollow, toggle }
}

/**
 * @param userId   the person to follow
 * @param meId     the signed-in viewer (null = anonymous → renders nothing)
 * @param size     'sm' for compact surfaces
 * @param label    override the resting label ("Follow")
 */
export function FollowButton({ userId, meId, size = 'sm', label = 'Follow', className = '' }) {
  const { following, busy, canFollow, toggle } = useFollowState(userId, meId)
  if (!canFollow) return null
  // Indeterminate: keep the footprint so the row doesn't reflow when it lands.
  const pending = following === null
  return (
    <button
      type="button"
      className={`btn ${size === 'sm' ? 'btn-sm ' : ''}${following ? 'btn-secondary' : 'btn-primary'} ${className}`}
      disabled={busy || pending}
      aria-busy={busy || pending}
      onClick={toggle}
      title={following ? 'Unfollow' : 'Follow'}
    >
      <Icon name={following ? 'followed' : 'follow'} className="xs"/>
      {pending ? '…' : following ? 'Following' : label}
    </button>
  )
}

export default FollowButton
