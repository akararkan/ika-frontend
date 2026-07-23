/* =========================================================
   What DELETE /conversations/{id} actually does — in one place.
   ---------------------------------------------------------
   The endpoint is overloaded, and the three outcomes are wildly
   different in blast radius (09-api-reference §1):

     · GROUP + you are the OWNER
         → soft-deletes the group FOR EVERYONE. Every member loses
           access and it vanishes from their inboxes. Irreversible.
     · GROUP + you are not the owner   ┐  "delete conversation for me"
     · DIRECT (either participant)     ┘
         → clears and hides the thread ON YOUR SIDE ONLY, via a
           per-member `clearedBeforeMessageId` high-water mark. It
           drops out of the inbox AND the archived list, is
           unpinned, unread is zeroed — and it comes BACK on its own
           (showing only messages newer than the clear point) the
           moment the other side sends again. The peer/group is
           untouched.

   One call site labelling that "Hide group" would let an owner
   destroy a group while believing they were tidying their inbox,
   so every surface derives its copy from here instead of writing
   its own. Distinct from `POST /archive`, which merely moves a
   conversation to the archived list where it is still visible.
   ========================================================= */

/**
 * @param {object} convo  a view conversation (needs isGroup / myRole / peer)
 * @returns {{destroysForEveryone: boolean, label: string, title: string,
 *            message: string, confirmLabel: string}}
 */
export function deleteIntentOf(convo) {
  const ownsGroup = !!convo?.isGroup && convo?.myRole === 'OWNER'
  /* A CHANNEL is a group-shaped conversation, so it takes the same two
     branches — but "group" is the wrong noun in front of a subscriber list,
     and understating what an owner is about to destroy is the exact failure
     this module exists to prevent. */
  const kind = convo?.isChannel ? 'channel' : 'group'
  const people = convo?.isChannel ? 'subscribers' : 'members'

  if (ownsGroup) {
    return {
      destroysForEveryone: true,
      label: `Delete ${kind}`,
      title: `Delete this ${kind}?`,
      message: `“${convo.displayTitle}” will be deleted for everyone. All ${
        convo.memberCount || 0
      } ${people} lose access and it disappears from their inboxes. This cannot be undone.`,
      confirmLabel: 'Delete for everyone',
    }
  }

  if (convo?.isGroup) {
    return {
      destroysForEveryone: false,
      label: 'Clear and hide',
      title: `Clear this ${kind} for you?`,
      message: `The ${kind} stays exactly as it is for everyone else — this only clears it `
        + 'from your side. It comes back, showing just the newer messages, as soon as '
        + `someone posts again. To actually leave, use “Leave ${kind}”.`,
      confirmLabel: 'Clear for me',
    }
  }

  const who = convo?.peer?.full || convo?.peer?.handle || 'They'
  return {
    destroysForEveryone: false,
    label: 'Delete chat',
    title: 'Delete this chat for you?',
    message: `This clears the conversation on your side only. ${who} keeps their copy and is `
      + 'not notified. The chat re-appears, showing only newer messages, if they write again.',
    confirmLabel: 'Delete for me',
  }
}

/**
 * Why I cannot post into this conversation — or `null` when I can.
 *
 * The precedence is the backend's own, in its order: membership first, then
 * restriction, then the group's send mode. Getting the order wrong tells a
 * removed member they are "restricted", which is both wrong and alarming.
 *
 * This lives here, shared, because **two** surfaces need the same answer and
 * they used to disagree. The composer asked the full question; the forward
 * picker asked only "am I an ACTIVE member?" — so it happily offered broadcast
 * channels and admins-only groups as forward targets, and the forward bounced
 * with `403 ADMINS_ONLY` after the user had already chosen. Forward re-runs
 * **full send permission against the target** (messages.md §2.3), so the picker
 * has to apply the identical test.
 *
 * Affordance only — the server re-checks every send. The point is not to
 * enforce anything, it is to never offer a door that is locked.
 *
 * @param {object} convo view conversation
 * @returns {string|null} human-readable reason, or null if sending is allowed
 */
export function sendBlockReason(convo) {
  if (!convo) return null
  if (convo.myStatus === 'LEFT' || convo.myStatus === 'REMOVED') {
    return 'You are no longer a member of this conversation.'
  }
  if (convo.myStatus === 'RESTRICTED') {
    return 'You are restricted from posting in this conversation.'
  }
  if (convo.isGroup && convo.settings?.sendMode === 'ADMINS_ONLY' && convo.myRole === 'MEMBER') {
    /* A channel is a group with an admins-only send mode, so this is its NORMAL
       state, not a restriction someone imposed — say so in the channel's own
       vocabulary rather than making a subscriber feel demoted. */
    return convo.isChannel
      ? 'This is a broadcast channel — only its admins can post.'
      : 'Only admins can post in this group.'
  }
  return null
}

/** Convenience predicate for list filters. */
export const canSendIn = (convo) => sendBlockReason(convo) === null

export default deleteIntentOf
