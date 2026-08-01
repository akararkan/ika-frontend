/* =========================================================
   storyTray — who has an unexpired story right now
   ---------------------------------------------------------
   THE GAP THIS FILLS. The backend has no tray LIST endpoint.
   `/api/v1/stories/tray/stream` is SSE-only (verified in
   CassandraStoryTrayController — it binds `/stream` and
   nothing else), and the only read is
   `/stories/by-author/{authorId}`. So a client that listens to
   the stream alone starts EMPTY on every load and only gains a
   ring when somebody posts while the tab is open — which is
   exactly what the old rail did, and why it always looked
   broken.

   So the tray is assembled client-side, and the shape of that
   assembly is dictated by cost:

     · one page of the viewer's following list (capped at
       MAX_AUTHORS), not the whole graph;
     · one `by-author` read per author, in parallel, each
       fail-open — a 403/404 for one person drops that person,
       never the rail;
     · a module-level cache with a short TTL, so moving between
       tabs and back does not re-run the fan-out;
     · the SSE stream still folds in on top, so a story posted
       while you are looking arrives instantly, exactly as
       before.

   If the backend ever ships a real tray endpoint this whole
   file collapses into one request — `loadTray` is the only
   thing that would change.
   ========================================================= */
import React from 'react'
import { api, adapters, assetUrl } from '../api/index.js'

/** How many followed accounts we are willing to probe per refresh. */
const MAX_AUTHORS = 24
/** How long a completed fan-out stays good. Stories live 24h; a minute of
 *  staleness on a rail is invisible, a re-fan-out on every mount is not. */
const TTL_MS = 60000

let cache = { at: 0, viewer: null, rows: null, inflight: null }

/** One tray entry = one AUTHOR (not one story) — the rail shows people. */
function entryOf(author, stories) {
  const withMedia = stories.find(s => s.thumbnailUrl || s.mediaUrl) || stories[0]
  const cover = withMedia?.thumbnailUrl || withMedia?.mediaUrl || null
  // Newest story wins the timestamp: the rail sorts by "who posted most
  // recently", which is the only ordering a story rail can justify.
  const newest = stories.reduce((max, s) => {
    const t = s.createdAt ? new Date(s.createdAt).getTime() : 0
    return t > max ? t : max
  }, 0)
  return {
    authorId: author.id,
    author,
    cover: cover ? assetUrl(cover) : null,
    count: stories.length,
    at: newest,
    time: adapters.timeAgo(new Date(newest).toISOString()),
  }
}

/**
 * Fan out over the viewer's following list and keep whoever has an active
 * story. Fail-open at every level: a dead following call yields an empty rail,
 * not an error state — a story rail is a garnish, never a blocker.
 */
export async function loadTray(viewerId) {
  if (!viewerId) return []
  const fresh = cache.viewer === viewerId && cache.rows && (Date.now() - cache.at) < TTL_MS
  if (fresh) return cache.rows
  // Coalesce concurrent callers (the feed mounts the rail while a tab switch
  // is already loading it) onto ONE fan-out.
  if (cache.inflight && cache.viewer === viewerId) return cache.inflight

  const run = (async () => {
    let following
    try {
      const res = await api.users.following(viewerId, { size: MAX_AUTHORS })
      following = (res?.items || []).slice(0, MAX_AUTHORS)
    } catch { return [] }
    if (!following.length) return []

    const settled = await Promise.allSettled(
      following.map(u => api.stories.byAuthor(u.id).then(rows => [u, rows || []])),
    )
    const rows = []
    for (const s of settled) {
      if (s.status !== 'fulfilled') continue
      const [u, stories] = s.value
      if (!stories.length) continue
      rows.push(entryOf(u, stories))
    }
    rows.sort((a, b) => b.at - a.at)
    return rows
  })()

  cache = { at: Date.now(), viewer: viewerId, rows: cache.rows, inflight: run }
  const rows = await run.catch(() => [])
  cache = { at: Date.now(), viewer: viewerId, rows, inflight: null }
  return rows
}

/** Drop the cache — call after posting or deleting a story of your own. */
export function invalidateTray() {
  cache = { at: 0, viewer: null, rows: null, inflight: null }
}

/** How many of your own frames we will probe for viewers. A story rail is not
 *  worth an unbounded fan-out, and a person with 20 frames still learns the
 *  only thing the ring reports: whether ANYONE has seen them. */
const MAX_VIEW_PROBE = 5
/** How often the viewer count is re-read while the rail is on screen. Long on
 *  purpose: this is a status light, not a live counter. */
const VIEW_POLL_MS = 60000

/**
 * Distinct people who have viewed YOUR story, across its frames.
 *
 * There is no view counter on a story row — `stories_by_author` carries the
 * frame and nothing else — so the only source is the author-only viewer log at
 * `GET /stories/{id}/views`. One call per frame, capped, all fail-open.
 *
 * A view arriving is the thing that RELIGHTS your ring, so this can't be a
 * one-shot read: it re-probes on `epoch` (the story viewer closing) and on a
 * slow beat while the tab is actually being looked at.
 *
 * @returns {{views: number|null, refresh: () => void}} `views` is null while
 *          unknown / unreadable — null is NOT zero: rendering "nobody has seen
 *          this" because a request failed would be a lie.
 */
export function useMyStoryViews(stories, epoch = 0) {
  const [views, setViews] = React.useState(null)
  const [beat, setBeat] = React.useState(0)

  // Key on the ids themselves: `stories` is a fresh array on every poll, and
  // depending on it directly would re-probe on every render.
  const ids = React.useMemo(
    () => (stories || []).map(s => s?.storyId).filter(Boolean).slice(0, MAX_VIEW_PROBE).join(','),
    [stories],
  )

  React.useEffect(() => {
    const list = ids ? ids.split(',') : []
    if (!list.length) { setViews(null); return undefined }
    let alive = true
    Promise.allSettled(list.map(id => api.stories.viewers(id, 50)))
      .then(results => {
        if (!alive) return
        // Distinct viewers, not a sum: one person who watched three frames is
        // one person who has seen your story.
        const seen = new Set()
        let answered = false
        for (const r of results) {
          if (r.status !== 'fulfilled') continue
          answered = true
          for (const v of r.value || []) if (v?.viewerId) seen.add(String(v.viewerId))
        }
        setViews(answered ? seen.size : null)
      })
    return () => { alive = false }
  }, [ids, epoch, beat])

  /* The slow beat. Only while there is a story to ask about and the tab is
     visible — a backgrounded rail nobody is looking at has no business polling,
     and the moment it comes back is exactly when a stale ring would be seen. */
  React.useEffect(() => {
    if (!ids) return undefined
    const tick = () => { if (!document.hidden) setBeat(n => n + 1) }
    const t = setInterval(tick, VIEW_POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', tick) }
  }, [ids])

  const refresh = React.useCallback(() => setBeat(n => n + 1), [])
  return { views, refresh }
}

/**
 * The rail's data: followed authors with an active story, live-folded.
 *
 * The SSE frames stay authoritative for ARRIVALS (instant, no poll), and the
 * fan-out is what makes the rail non-empty on load. A `new_story` for someone
 * already in the list moves them to the front rather than duplicating them —
 * the same rule the live rail uses for a re-delivered `stream.started`.
 */
export function useStoryTray(viewerId) {
  const [tray, setTray] = React.useState([])

  React.useEffect(() => {
    if (!viewerId) return undefined
    let alive = true
    loadTray(viewerId).then(rows => { if (alive) setTray(rows) })
    return () => { alive = false }
  }, [viewerId])

  React.useEffect(() => {
    if (!viewerId) return undefined
    return api.stories.trayStream({
      onNewStory: (ev) => {
        if (!ev?.authorId || String(ev.authorId) === String(viewerId)) return
        const author = adapters.authorFrom({
          id: ev.authorId, username: ev.authorUsername, profileImage: ev.authorAvatarUrl,
        })
        setTray(rows => [
          {
            authorId: ev.authorId,
            author,
            cover: ev.thumbnailUrl ? assetUrl(ev.thumbnailUrl) : null,
            count: 1,
            at: Date.now(),
            time: 'now',
            // A pushed row carries only what the frame carried. Keeping the
            // richer cached row's cover when we already had one avoids a card
            // that goes from a real image to a blank plate on a new post.
            ...(rows.find(r => String(r.authorId) === String(ev.authorId))?.cover && !ev.thumbnailUrl
              ? { cover: rows.find(r => String(r.authorId) === String(ev.authorId)).cover }
              : null),
          },
          ...rows.filter(r => String(r.authorId) !== String(ev.authorId)),
        ])
        invalidateTray()
      },
      onStoryRemoved: (ev) => {
        if (!ev?.authorId) return
        setTray(rows => rows.filter(r => String(r.authorId) !== String(ev.authorId)))
        invalidateTray()
      },
    })
  }, [viewerId])

  return tray
}
