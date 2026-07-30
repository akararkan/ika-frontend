/* =========================================================
   Chat activity vocabulary — the Telegram/WhatsApp-style live
   states a participant can broadcast while composing.
   ---------------------------------------------------------
   One module so the header status line, the inbox preview and
   the in-thread indicator can never drift apart on wording.
   Phrases deliberately carry NO trailing "…" — the animated
   ellipsis is drawn by CSS (`.ch-ell`) so it can pulse.
   ========================================================= */

/* The full ChatAction vocabulary (realtime.md §2) — matched to the backend
   enum EXACTLY. The server normalizes Telegram-style UPLOADING_* synonyms to
   SENDING_* before broadcasting, so inbound values are always canonical;
   anything genuinely unknown still degrades to plain "typing" via phraseOf. */
export const ACTIVITY = {
  TYPING: 'TYPING',
  RECORDING_VOICE: 'RECORDING_VOICE',
  SENDING_VOICE: 'SENDING_VOICE',
  RECORDING_VIDEO_NOTE: 'RECORDING_VIDEO_NOTE',
  SENDING_VIDEO_NOTE: 'SENDING_VIDEO_NOTE',
  SENDING_PHOTO: 'SENDING_PHOTO',
  SENDING_VIDEO: 'SENDING_VIDEO',
  SENDING_FILE: 'SENDING_FILE',
  SENDING_AUDIO: 'SENDING_AUDIO',
  CHOOSING_STICKER: 'CHOOSING_STICKER',
  SENDING_LOCATION: 'SENDING_LOCATION',
}

/* verb phrase (no subject) + the icon drawn beside it. `null` icon = the
   classic three bouncing dots. */
const PHRASES = {
  TYPING: { verb: 'typing', icon: null },
  RECORDING_VOICE: { verb: 'recording a voice message', icon: 'mic' },
  SENDING_VOICE: { verb: 'sending a voice message', icon: 'mic' },
  RECORDING_VIDEO_NOTE: { verb: 'recording a video message', icon: 'video' },
  SENDING_VIDEO_NOTE: { verb: 'sending a video message', icon: 'video' },
  SENDING_PHOTO: { verb: 'sending a photo', icon: 'image' },
  SENDING_VIDEO: { verb: 'sending a video', icon: 'image' },
  SENDING_FILE: { verb: 'sending a file', icon: 'paperclip' },
  SENDING_AUDIO: { verb: 'sending music', icon: 'music' },
  CHOOSING_STICKER: { verb: 'choosing a sticker', icon: 'smile' },
  SENDING_LOCATION: { verb: 'sending a location', icon: 'pin' },
}

const phraseOf = (activity) => PHRASES[activity] || PHRASES.TYPING

/** The icon name for an activity, or null when plain dots say it best. */
export const activityIcon = (activity) => phraseOf(activity).icon

/** Bare verb phrase — "typing", "recording a voice message". */
export const activityVerb = (activity) => phraseOf(activity).verb

/* Recording beats sending beats typing when several people in a group are
   live at once — the rarest state is the most interesting one to surface.
   (Choosing a sticker ranks with typing: it is idling, not producing.) */
const WEIGHT = {
  RECORDING_VOICE: 3, RECORDING_VIDEO_NOTE: 3,
  SENDING_VOICE: 2, SENDING_VIDEO_NOTE: 2, SENDING_PHOTO: 2, SENDING_VIDEO: 2,
  SENDING_FILE: 2, SENDING_AUDIO: 2, SENDING_LOCATION: 2,
  TYPING: 1, CHOOSING_STICKER: 1,
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

/** What a batch of outgoing files announces while it uploads. ATTACHED audio
 *  is music (`SENDING_AUDIO`, per the realtime.md mapping) — a mic recording
 *  announces `SENDING_VOICE` explicitly from the Composer's voice path, never
 *  through here. */
export function uploadActivityOf(files) {
  const list = Array.from(files || [])
  if (!list.length) return ACTIVITY.SENDING_FILE
  const types = list.map(f => f?.type || '')
  if (types.every(t => t.startsWith('image/'))) return ACTIVITY.SENDING_PHOTO
  if (types.every(t => t.startsWith('video/'))) return ACTIVITY.SENDING_VIDEO
  if (types.every(t => t.startsWith('audio/'))) return ACTIVITY.SENDING_AUDIO
  if (types.every(t => t.startsWith('image/') || t.startsWith('video/'))) return ACTIVITY.SENDING_PHOTO
  return ACTIVITY.SENDING_FILE
}
