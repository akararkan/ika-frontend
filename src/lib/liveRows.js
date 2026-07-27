/* =========================================================
   liveRows — folding the stream.* frames into what is on screen
   ---------------------------------------------------------
   Three surfaces watch the same four `stream.*` frames off the ONE
   per-user socket (chat.js → ChatContext → subscribe): the "following
   is live" rail, the discovery grid, and the room itself. They had
   three hand-rolled copies of the same reducer, and the copies did not
   agree. This is the single one.

   Two rules live here because both were bugs in the hand-rolled copies:

   1. A frame PATCHES, it does not replace. `liveStreamFrom` always
      returns every key, filling what the payload omits with `null` —
      so assigning `evt.stream` wholesale over a card is not a merge,
      it is an erase. A `stream.viewer` frame that arrives without the
      URLs (they are minted on `join`, and `whipUrl`/`ingestUrl` are
      host-only in the first place) would blank `playbackUrl` on the
      room mid-stream, re-run the attach effect on the change, and tear
      down the video every time somebody else walked in.

   2. `stream.viewer` never INSERTS. Someone joining a stream we are
      not showing must not conjure a card: `live()` is most-watched-
      first and `followingLive()` is people-you-follow-only, and an
      unfiltered insert quietly breaks both contracts.
   ========================================================= */

const sameId = (a, b) => a != null && b != null && String(a) === String(b)

/**
 * Fold `next` onto `prev`, keeping what `prev` already knows wherever `next`
 * carries nothing for it.
 *
 * "Nothing" is `null`, `undefined` **or** `''`: the mapper's own defaults for
 * an absent string are `null` (urls, avatar) and `''` (description), so an
 * empty string on the wire is indistinguishable from a field the payload left
 * out — and keeping the description we already rendered beats blanking it.
 * `0` is a real viewer count and is always taken.
 */
export function patchStream(prev, next) {
  if (!prev) return next || null
  if (!next) return prev
  const out = { ...prev }
  for (const k of Object.keys(next)) {
    const v = next[k]
    if (v === null || v === undefined || v === '') continue
    out[k] = v
  }
  return out
}

/**
 * Apply one adapted `stream.*` event to a list of live cards.
 *
 * Returns the SAME array reference when the event changes nothing, so a
 * subscriber can hand this straight to a setState updater without forcing a
 * re-render on every unrelated frame on the socket.
 *
 * @param rows              current cards
 * @param evt               adapted event from `subscribe()`
 * @param opts.skipHostId   drop `stream.started` hosted by this user. The
 *                          "following" rail passes the signed-in id: you do
 *                          not follow yourself, so your own broadcast landing
 *                          in a row labelled "people you follow" is a lie.
 *                          The discovery grid passes nothing — it wants it.
 */
export function applyStreamEvent(rows, evt, { skipHostId = null } = {}) {
  const list = Array.isArray(rows) ? rows : []

  switch (evt?.type) {
    case 'stream.started': {
      const s = evt.stream
      if (!s?.id) return list
      if (skipHostId && sameId(s.hostId, skipHostId)) return list
      // Newest-live-first, and never twice: a re-delivered frame (the socket
      // reconnects, the server replays) moves the card to the front instead
      // of cloning it.
      return [s, ...list.filter(r => !sameId(r.id, s.id))]
    }

    case 'stream.ended': {
      const id = evt.streamId || evt.stream?.id
      if (!id) return list
      const next = list.filter(r => !sameId(r.id, id))
      return next.length === list.length ? list : next
    }

    /* Both are patch-only — see rule 2 above.
       `stream.viewer` carries the ALREADY-UPDATED `viewerCount`, so the counter
       is rendered straight from the frame with no re-fetch. `stream.updated`
       is the host editing title/description mid-broadcast; it reaches a
       stream's current viewers, so it lands here only for a card that is
       already on screen. Neither may insert. */
    case 'stream.viewer':
    case 'stream.updated': {
      const s = evt.stream
      const id = s?.id || evt.streamId
      if (!id || !s) return list
      let hit = false
      const next = list.map(r => {
        if (!sameId(r.id, id)) return r
        hit = true
        return patchStream(r, s)
      })
      return hit ? next : list
    }

    default:                              // stream.chat and anything unknown
      return list
  }
}
