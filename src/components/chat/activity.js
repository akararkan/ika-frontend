/* =========================================================
   Chat activity vocabulary — the Telegram/WhatsApp-style live
   states a participant can broadcast while composing.
   ---------------------------------------------------------
   One module so the header status line, the inbox preview and
   the in-thread indicator can never drift apart on wording.
   Phrases deliberately carry NO trailing "…" — the animated
   ellipsis is drawn by CSS (`.ch-ell`) so it can pulse.
   ========================================================= */

export const ACTIVITY = {
  TYPING: 'TYPING',
  RECORDING_VOICE: 'RECORDING_VOICE',
  SENDING_PHOTO: 'SENDING_PHOTO',
  SENDING_VIDEO: 'SENDING_VIDEO',
  SENDING_VOICE: 'SENDING_VOICE',
  SENDING_FILE: 'SENDING_FILE',
}

/* verb phrase (no subject) + the icon drawn beside it. `null` icon = the
   classic three bouncing dots. */
const PHRASES = {
  TYPING: { verb: 'typing', icon: null },
  RECORDING_VOICE: { verb: 'recording a voice message', icon: 'mic' },
  SENDING_PHOTO: { verb: 'sending a photo', icon: 'image' },
  SENDING_VIDEO: { verb: 'sending a video', icon: 'image' },
  SENDING_VOICE: { verb: 'sending a voice message', icon: 'mic' },
  SENDING_FILE: { verb: 'sending a file', icon: 'paperclip' },
}

const phraseOf = (activity) => PHRASES[activity] || PHRASES.TYPING

/** The icon name for an activity, or null when plain dots say it best. */
export const activityIcon = (activity) => phraseOf(activity).icon

/** Bare verb phrase — "typing", "recording a voice message". */
export const activityVerb = (activity) => phraseOf(activity).verb

/* Recording beats sending beats typing when several people in a group are
   live at once — the rarest state is the most interesting one to surface. */
const WEIGHT = {
  RECORDING_VOICE: 3, SENDING_VOICE: 2, SENDING_PHOTO: 2, SENDING_VIDEO: 2, SENDING_FILE: 2, TYPING: 1,
}
export function dominantActivity(typers) {
  let best = 'TYPING', w = 0
  for (const t of typers || []) {
    const tw = WEIGHT[t?.activity] || 1
    if (tw > w) { w = tw; best = t.activity || 'TYPING' }
  }
  return best
}

/**
 * Sentence for a set of typers, e.g.
 *   DM:    "typing" · "recording a voice message"
 *   group: "Aisha is typing" · "Aisha and Omar are typing" · "3 people are typing"
 * `names` aligns with `typers`; unresolved entries may be null.
 */
export function typingSentence(typers, { isGroup, names = [] } = {}) {
  const list = typers || []
  if (!list.length) return null
  if (!isGroup) return activityVerb(list[0].activity)
  const known = names.filter(Boolean)
  if (list.length === 1) {
    return `${known[0] || 'Someone'} is ${activityVerb(list[0].activity)}`
  }
  if (list.length === 2 && known.length === 2) {
    return `${known[0]} and ${known[1]} are ${activityVerb(dominantActivity(list))}`
  }
  return `${list.length} people are ${activityVerb(dominantActivity(list))}`
}

/** What a batch of outgoing files announces while it uploads. */
export function uploadActivityOf(files) {
  const list = Array.from(files || [])
  if (!list.length) return ACTIVITY.SENDING_FILE
  const types = list.map(f => f?.type || '')
  if (types.every(t => t.startsWith('image/'))) return ACTIVITY.SENDING_PHOTO
  if (types.every(t => t.startsWith('video/'))) return ACTIVITY.SENDING_VIDEO
  if (types.every(t => t.startsWith('audio/'))) return ACTIVITY.SENDING_VOICE
  if (types.every(t => t.startsWith('image/') || t.startsWith('video/'))) return ACTIVITY.SENDING_PHOTO
  return ACTIVITY.SENDING_FILE
}
