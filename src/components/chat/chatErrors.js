/* =========================================================
   The chat error catalog, in one place.
   ---------------------------------------------------------
   `api-reference.md` states the rule plainly: **switch on
   `errorCode`**, never on the message text. The server's
   `message` is a developer-facing string that can change
   wording between deploys and is not written for the person
   staring at a failed send.

   Every code below is one the chat API documents. They are
   mapped once, here, rather than at each `catch` — three
   reasons:

   1. The same code means the same thing everywhere. `BLOCKED`
      on a send, a forward, a call and a DM-create is one
      situation, and it must never be described three ways.
   2. The copy must never leak WHO blocked whom. The API is
      deliberately symmetric about this (a block reads the same
      from both sides); a well-meaning "they blocked you" here
      would undo that at the last step.
   3. Codes with real product meaning get real copy. The one
      that matters most is `REQUEST_LIMIT_REACHED`: a stranger
      gets three messages before the recipient answers, and the
      fourth is refused. Without an explanation that reads as a
      broken app rather than a working anti-spam rule.

   Usage: `showToast(chatError(e, 'Could not send'))`. The
   fallback is only reached for an undocumented code, and even
   then the server's own `message` wins over it.
   ========================================================= */

const COPY = {
  /* ---- authorization ---- */
  BLOCKED:
    'You can’t message this account.',
  NOT_A_MEMBER:
    'You’re no longer a member of this conversation.',
  READ_ONLY:
    'You’re muted in this group — you can read, but not post.',
  ADMINS_ONLY:
    'Only admins can do that in this group.',
  NOT_OWNER:
    'Only the owner can do that.',
  CANNOT_ACT_ON_ADMIN:
    'Admins can’t act on the owner or on each other.',
  ACCESS_FORBIDDEN:
    'You don’t have permission to do that.',

  /* ---- the stranger-contact cap ----
     Three messages before the recipient answers, then refused —
     and the same code comes back once a request is DECLINED,
     which is a quiet dead end by design (the requester is never
     told they were declined). One line has to cover both without
     revealing which one happened. */
  REQUEST_LIMIT_REACHED:
    'You’ve reached the limit for a first message. Wait for them to reply before sending more.',

  /* ---- invites ---- */
  INVITE_INVALID:
    'This invite link has expired, been revoked, or is fully used.',

  /* ---- not found ---- */
  CONVERSATION_NOT_FOUND:
    'This conversation no longer exists.',
  MESSAGE_NOT_FOUND:
    'That message isn’t available any more.',
  /* Spelled without the underscore the other *_NOT_FOUND codes use — that is
     the wire spelling in message-requests.md, not a typo here. */
  MESSAGEREQUEST_NOT_FOUND:
    'This request is no longer in your inbox.',

  /* ---- throttling ----
     http.js already flashes its own toast with the server's
     Retry-After on any 429, so a caller that also toasts will
     double up. Keep this short. */
  RATE_LIMIT_EXCEEDED:
    'You’re sending too fast — wait a moment.',
}

/**
 * Map a chat API failure onto copy a human can act on.
 *
 * @param {Error & {code?: string, message?: string}} e
 * @param {string} fallback  used only when the code is unknown AND the
 *                           server sent no message of its own
 * @returns {string}
 */
export function chatError(e, fallback = 'Something went wrong.') {
  const mapped = e?.code && COPY[e.code]
  if (mapped) return mapped
  /* BAD_REQUEST is deliberately absent from the table: it is a validation
     error whose *specifics* are the useful part ("body > 8000 chars",
     "scheduledAt is in the past"), and only the server knows them. Pass its
     message through rather than flattening every validation failure into one
     generic sentence. */
  return e?.message || fallback
}

/** True when the caller should stay silent — http.js already toasted. */
export const isThrottle = (e) => e?.status === 429

export default chatError
