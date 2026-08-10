/* =========================================================
   A reel's sound: its label, and how loud each half of it is.

   THE MIX TRAVELS IN THE URL. The post API has no field for a
   per-post balance (BACKEND_NOTES #16) — only `audioTrackUrl`
   and `audioTrackName` — so the author's levels ride in the
   fragment of the track url they already store:

       /api/v1/media/sounds/xyz.mp3#mix=0.40,0.90
                                    └ original ┘└ music ┘

   A fragment is never sent to the server on a media request and
   never changes which bytes are fetched, so a client that knows
   nothing about it plays exactly the same sound — it just
   ignores the author's balance. That is the reason for choosing
   the fragment over, say, packing numbers into the track NAME,
   which every client renders as text under the reel.
   ========================================================= */

/** Original at full, added track a shade under it: an added sound is a bed,
 *  and speech in the clip has to stay intelligible over it. */
export const DEFAULT_MIX = { orig: 1, music: .7 }

export const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0))

/** "Title · Artist" — what the viewer prints under a reel, so it is also what
 *  the post stores as its track label. */
export const soundLabel = (s) => [s?.title, s?.artist].filter(Boolean).join(' · ') || 'Added sound'

/** Append the authored balance to a track url. */
export function withMix(url, mix) {
  if (!url) return url
  const base = String(url).split('#')[0]
  const m = mix || DEFAULT_MIX
  return `${base}#mix=${clamp01(m.orig).toFixed(2)},${clamp01(m.music).toFixed(2)}`
}

/** Read it back. null when the reel carries none — every reel posted before
 *  this existed, and every reel from a client that does not write it. */
export function readMix(url) {
  const frag = String(url || '').split('#')[1]
  if (!frag) return null
  const m = /(?:^|&)mix=([0-9.]+),([0-9.]+)/.exec(frag)
  if (!m) return null
  return { orig: clamp01(m[1]), music: clamp01(m[2]) }
}
