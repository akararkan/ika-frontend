/* =========================================================
   SYSTEM timeline messages — the fallback vocabulary.
   ---------------------------------------------------------
   Nearly every membership and metadata change writes a `SYSTEM`
   message into the timeline, and the server composes readable
   text for it ("@actor added @user", "… set disappearing
   messages to 7d"). That text is ALWAYS preferred: it is the only
   thing that knows the names, and it is already localised the way
   the rest of the thread is.

   What this module covers is the case where `body` arrives empty
   but `systemEvent` does not. The bubble used to render a single
   flat "Conversation updated" for every one of them, which turns
   an ownership transfer and a title tweak into the same sentence.
   The enum is right there on the DTO; use it.

   The event names come from the conversations / groups / messages
   API docs. An unknown one falls back to the generic line rather
   than rendering an enum constant at the reader.
   ========================================================= */

/** systemEvent → { text, icon }. `icon` is a name from ui.jsx's set. */
const SYSTEM_EVENTS = {
  /* ---- lifecycle ---- */
  GROUP_CREATED:          { text: 'Group created',                         icon: 'users' },
  CHANNEL_CREATED:        { text: 'Channel created',                       icon: 'broadcast' },

  /* ---- membership ---- */
  MEMBER_ADDED:           { text: 'A member was added',                    icon: 'follow' },
  MEMBER_REMOVED:         { text: 'A member was removed',                  icon: 'userminus' },
  MEMBER_LEFT:            { text: 'A member left',                         icon: 'logout' },
  ROLE_CHANGED:           { text: 'A member’s role changed',               icon: 'crown' },
  OWNERSHIP_TRANSFERRED:  { text: 'Ownership was transferred',             icon: 'crown' },

  /* ---- metadata ---- */
  TITLE_CHANGED:          { text: 'The name was changed',                  icon: 'edit' },
  DESCRIPTION_CHANGED:    { text: 'The description was changed',           icon: 'edit' },
  AVATAR_CHANGED:         { text: 'The picture was changed',               icon: 'image' },

  /* ---- messages ---- */
  PINNED:                 { text: 'A message was pinned',                  icon: 'pin' },
  UNPINNED:               { text: 'A message was unpinned',                icon: 'pinoff' },

  /* ---- privacy ----
     The server's own text carries the duration ("set disappearing messages to
     7d"); this fallback deliberately does not invent one. */
  DISAPPEARING_CHANGED:   { text: 'The disappearing-messages timer changed', icon: 'hourglass' },
}

const GENERIC = { text: 'Conversation updated', icon: 'info' }

/**
 * Resolve a SYSTEM message to its rendered text + icon.
 * The server's `body` always wins; the map is only the fallback.
 *
 * @param {{body?: string, systemEvent?: string}} msg
 * @returns {{ text: string, icon: string }}
 */
export function systemNoticeOf(msg) {
  const known = msg?.systemEvent ? SYSTEM_EVENTS[msg.systemEvent] : null
  const body = (msg?.body || '').trim()
  if (body) return { text: body, icon: known?.icon || GENERIC.icon }
  return known || GENERIC
}

export default systemNoticeOf
