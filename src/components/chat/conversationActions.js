/* =========================================================
   What DELETE /conversations/{id} actually does — in one place.
   ---------------------------------------------------------
   The endpoint is overloaded, and the four outcomes are wildly
   different in blast radius (conversations.md §DELETE,
   channels/inbox.md §"Leaving & deleting the channel"):

     · GROUP or CHANNEL + you are the OWNER
         → soft-deletes it FOR EVERYONE. Every member/subscriber
           loses access and it vanishes from their inboxes; a
           channel is de-indexed from discovery too. Irreversible.
     · CHANNEL + you are a subscriber
         → LEAVES the channel. The membership row is removed
           outright (no `LEFT` tombstone, no system message) and
           the chat is gone from your inbox FOR GOOD — unlike the
           group/DM branch below it does NOT resurface on the
           channel's next post, because you are no longer a
           member. Re-subscribing brings back the full history.
     · GROUP + you are not the owner   ┐  "delete conversation for me"
     · DIRECT (either participant)     ┘
         → clears and hides the thread ON YOUR SIDE ONLY, via a
           per-member `clearedBeforeMessageId` high-water mark. It
           drops out of the inbox AND the archived list, is
           unpinned, unread is zeroed — and it comes BACK on its own
           (showing only messages newer than the clear point) the
           moment the other side sends again. The peer/group is
           untouched.

   That third branch is the one worth reading twice: the SAME verb
   on the SAME shape of conversation is reversible in a group and
   permanent in a channel, so "it comes back when someone posts"
   is a promise this module must not make about a channel.

   One call site labelling any of this "Hide group" would let an
   owner destroy a room while believing they were tidying their
   inbox, so every surface derives its copy from here instead of
   writing its own. Distinct from `POST /archive`, which merely
   moves a conversation to the archived list where it is still
   visible.
   ========================================================= */

/**
 * @param {object} convo  a view conversation (needs isGroup / isChannel / myRole / peer)
 * @returns {{destroysForEveryone: boolean, leavesForGood: boolean, label: string,
 *            title: string, message: string, confirmLabel: string, toast: string,
 *            sub: string}}  `sub` is the one-line version, for a settings row
 */
export function deleteIntentOf(convo) {
  const ownsRoom = !!convo?.isGroup && convo?.myRole === 'OWNER'
  /* A CHANNEL is a group-shaped conversation, so it takes the same owner
     branch — but "group" is the wrong noun in front of a subscriber list,
     and understating what an owner is about to destroy is the exact failure
     this module exists to prevent. */
  const kind = convo?.isChannel ? 'channel' : 'group'
  const people = convo?.isChannel ? 'subscribers' : 'members'

  if (ownsRoom) {
    return {
      destroysForEveryone: true,
      leavesForGood: false,
      label: `Delete ${kind}`,
      title: `Delete this ${kind}?`,
      message: `“${convo.displayTitle}” will be deleted for everyone. All ${
        convo.memberCount || 0
      } ${people} lose access and it disappears from their inboxes${
        convo.isChannel ? ', and it is removed from channel discovery' : ''
      }. This cannot be undone.`,
      confirmLabel: 'Delete for everyone',
      toast: convo?.isChannel ? 'Channel deleted' : 'Group deleted',
      sub: `Deletes it for all ${convo.memberCount || 0} ${people}.`,
    }
  }

  /* A subscriber's DELETE is an unsubscribe, and unsubscribing is permanent in
     the one way that matters to the reader: the channel keeps posting and this
     chat never returns on its own. Say that, rather than borrowing the group's
     "it comes back" reassurance, which here would simply be false. */
  if (convo?.isChannel) {
    return {
      destroysForEveryone: false,
      leavesForGood: true,
      label: 'Leave channel',
      title: 'Leave this channel?',
      message: `You will stop receiving posts from “${convo.displayTitle}”, and it leaves your `
        + 'inbox for good — a channel chat does not come back on its own the way a group or a '
        + 'DM does. You can subscribe again at any time; the whole history comes back with you.',
      confirmLabel: 'Leave channel',
      toast: 'You left the channel',
      sub: 'You’ll stop receiving its posts.',
    }
  }

  if (convo?.isGroup) {
    return {
      destroysForEveryone: false,
      leavesForGood: false,
      label: 'Clear and hide',
      title: `Clear this ${kind} for you?`,
      message: `The ${kind} stays exactly as it is for everyone else — this only clears it `
        + 'from your side. It comes back, showing just the newer messages, as soon as '
        + `someone posts again. To actually leave, use “Leave ${kind}”.`,
      confirmLabel: 'Clear for me',
      toast: 'Conversation cleared',
      sub: 'Clears it on your side only.',
    }
  }

  const who = convo?.peer?.full || convo?.peer?.handle || 'They'
  return {
    destroysForEveryone: false,
    leavesForGood: false,
    label: 'Delete chat',
    title: 'Delete this chat for you?',
    message: `This clears the conversation on your side only. ${who} keeps their copy and is `
      + 'not notified. The chat re-appears, showing only newer messages, if they write again.',
    confirmLabel: 'Delete for me',
    toast: 'Conversation cleared',
    sub: 'Removes it from your inbox.',
  }
}

/* =========================================================
   …and what POST /conversations/{id}/leave does — same idea.
   ---------------------------------------------------------
   `leave` used to be group-only; on a channel id the server now
   delegates it to unsubscribe (groups.md §leave,
   channels/inbox.md), so ONE call site serves both and the only
   thing that differs is the vocabulary and who is allowed to
   press it:

     · GROUP member       → status LEFT, a `MEMBER_LEFT` system
                            message, the group carries on.
     · GROUP sole owner   → allowed, and the server soft-deletes
                            the group in the same transaction.
     · GROUP owner with company → `400`: transfer ownership or
                            delete the group. Not offered.
     · CHANNEL subscriber → the membership row is removed; the
                            chat is gone for good (above).
     · CHANNEL owner      → `403`, always, even alone. Not
                            offered — they transfer or delete.
     · DIRECT             → no such concept.

   `allowed: false` means "do not render the control": a button
   whose only possible outcome is a 4xx is worse than no button.
   ========================================================= */

/**
 * @param {object} convo  a view conversation
 * @returns {{allowed: boolean, label: string, title: string, message: string,
 *            confirmLabel: string, toast: string, sub: string}}
 */
export function leaveIntentOf(convo) {
  const isChannel = !!convo?.isChannel
  const kind = isChannel ? 'channel' : 'group'
  const owner = convo?.myRole === 'OWNER'
  /* The owner of a group MAY leave when nobody else is left (the server
     retires the group with them); the owner of a channel may never. */
  const allowed = !!convo?.isGroup
    && (!owner || (!isChannel && (convo.memberCount || 0) <= 1))

  return {
    allowed,
    label: `Leave ${kind}`,
    title: `Leave ${kind}`,
    message: isChannel
      ? `Leave “${convo?.displayTitle}”? You will stop receiving its posts and it leaves your `
        + 'inbox — subscribing again brings it back with its full history.'
      : `Leave “${convo?.displayTitle}”? You will stop receiving its messages.`
        + (owner ? ' You are the last member, so the group is retired with you.' : ''),
    confirmLabel: 'Leave',
    toast: isChannel ? 'You left the channel' : 'You left the group',
    sub: isChannel
      ? 'You’ll stop receiving its posts.'
      : owner
        ? 'You’re the last member — the group retires with you.'
        : 'You’ll stop receiving its messages.',
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
