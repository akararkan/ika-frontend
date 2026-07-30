/* =========================================================
   Mentions service — /api/v1/mentions (per platform/mentions.md)
   ---------------------------------------------------------
   The platform-wide @mention surface: compose-box helpers
   (suggest / click / parse) and the owner-scoped unified
   "everywhere I was mentioned" feed.

   · suggest is the RIGHT autocomplete source — ranked, ~30s
     server-cached, block-aware (you can't mention someone who
     blocked you and blockers never see their target), deleted/
     locked accounts and yourself excluded. Generic user search
     filters none of that.
   · click is a lock-in signal only — it records the pick as a
     MENTION_LOOKUP activity row. Notifications fire from the
     server pipeline when the composed text is SAVED, never here.
   · /mentions/me covers posts, comments, research (+comments),
     questions and answers. CHAT mentions are deliberately absent
     (messages can be deleted or disappearing) — they surface as
     MESSAGE_MENTION notifications only.

   (The legacy GET /users/{id}/mentions feed is gone from here —
   posts-only, self-only on the wire now, superseded by /me.)
   ========================================================= */
import { http } from './http.js'
import { authorFrom, timeAgo } from './adapters.js'

/* /mentions/me deepLinks use API-side resource paths; three differ from the
   client's routes — the same rewrite the notifications inbox applies. */
const clientPath = (d) => d
  ? d.replace(/^\/researches\//, '/research/')
    .replace(/^\/questions\//, '/qna/')
    .replace(/^\/users\//, '/u/')
  : null

/** MentionOfMeResponse → view row. `createdAt` mirrors `mentionedAt` so the
 *  shared date-bucket grouping (which reads createdAt) works unchanged. */
export function mentionRowFrom(r) {
  if (!r) return null
  return {
    key: `${r.sourceType || 'POST'}:${r.sourceId}`,
    sourceType: r.sourceType || 'POST',   // legacy rows with no stored type read as POST
    sourceId: r.sourceId,
    parentId: r.parentId || null,
    snippet: r.snippet || '',
    mentionedAt: r.mentionedAt || null,   // ALSO the keyset cursor for the next page
    createdAt: r.mentionedAt || null,
    time: timeAgo(r.mentionedAt),
    deepLink: clientPath(r.deepLink),
    _actor: authorFrom({
      id: r.actor?.id,
      username: r.actor?.username,
      fullName: r.actor?.fullName,
      profileImage: r.actor?.avatarUrl,
      role: r.actor?.role,
    }),
  }
}

export const mentions = {
  /** Ranked autocomplete candidates for a partial handle (leading `@` is
   *  stripped server-side). Returns author-shaped rows. */
  async suggest(q, limit = 6) {
    const rows = await http.get('/api/v1/mentions/suggest', { q, limit })
    return (rows || []).map(u => authorFrom({
      id: u.id, username: u.username, fullName: u.fullName,
      profileImage: u.avatarUrl, role: u.role,
    }))
  },

  /** The user picked a candidate from the picker. Fire-and-forget. */
  click(query, targetUserId) {
    return http.post('/api/v1/mentions/click', { query: query || undefined, targetUserId })
  },

  /** Server-grammar token extraction with offsets (`@followers` included) —
   *  for previews that must match the pipeline exactly. Pure analysis. */
  parse(text) { return http.post('/api/v1/mentions/parse', { text }) },

  /** Everywhere I was DIRECTLY mentioned, newest first. Keyset paging: pass
   *  the last row's `mentionedAt` back as `cursor` for the strictly-older
   *  page. `@followers` fan-outs and chat mentions are not rows here. */
  async me({ limit = 20, cursor } = {}) {
    const rows = await http.get('/api/v1/mentions/me', { limit, cursor: cursor || undefined })
    return (rows || []).map(mentionRowFrom).filter(Boolean)
  },
}
