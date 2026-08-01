/* =========================================================
   StoriesRail — the Facebook-style story tiles
   ---------------------------------------------------------
   Replaces the small circular-avatar rail. The card form is
   not decoration: a circle can only show a face, while a tile
   shows the STORY — which is the thing being offered — with
   the face as an authorship mark in the corner. That is the
   whole reason Facebook's rail looks like this.

   The anatomy, and why each part is where it is:

     · "Create story" is the first tile and is shaped like the
       others (same 9:16 plate) rather than a bare +, so the
       rail reads as one row of cards. Its top is your own
       photo; the white foot carries the blue + and the label.
     · Every other tile is the story's own cover, full-bleed,
       with a bottom scrim so white text survives a light
       image. No scrim = unreadable names on pale covers, which
       is the single most common failure of this pattern.
     · The author ring sits top-left, lit in Sky while unseen.
       It is an ordinary avatar, not a cropped cover, so you can
       tell WHO posted without reading. "Unseen" means two
       different things depending on whose story it is — see
       lib/storySeen.js — and both resolve to the same ring:
         someone else's  you haven't opened it yet
         your own        nobody has viewed it yet
     · A count pill appears only above 1 — "1" on a single
       story is noise.

   Horizontal scroll with real arrow buttons on pointer
   devices; the arrows hide themselves at the ends and vanish
   entirely on touch, where the rail is swiped.
   ========================================================= */
import React from 'react'
import { Icon, Avatar } from './ui.jsx'
import { useMyStoryViews } from '../lib/storyTray.js'
import { isStoryUnseen, markStorySeen, isMyStoryUnseen, markMyStorySeen } from '../lib/storySeen.js'
import { assetUrl } from '../api/index.js'

/** Scroll-position state for the arrow affordances. */
function useRailScroll() {
  const ref = React.useRef(null)
  const [edges, setEdges] = React.useState({ start: true, end: true })

  const measure = React.useCallback(() => {
    const el = ref.current
    if (!el) return
    // `scrollLeft` is NEGATIVE in RTL on every engine that matters, so the
    // magnitude is what tells us how far we are from the start.
    const x = Math.abs(el.scrollLeft)
    const max = el.scrollWidth - el.clientWidth
    setEdges({ start: x <= 2, end: x >= max - 2 })
  }, [])

  React.useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    return () => { el.removeEventListener('scroll', measure); ro?.disconnect() }
  }, [measure])

  const by = (dir) => {
    const el = ref.current
    if (!el) return
    const rtl = getComputedStyle(el).direction === 'rtl'
    el.scrollBy({ left: (rtl ? -dir : dir) * Math.max(240, el.clientWidth * 0.85), behavior: 'smooth' })
  }

  return { ref, edges, by, measure }
}

/** One story tile. `cover` may be null — the tile then wears a derived plate
 *  rather than an empty grey box, because a story with a text-only frame is
 *  ordinary and must still look deliberate. */
function StoryTile({ cover, ring, label, sub, unseen = true, count = 0, onOpen }) {
  return (
    <button className={'fbst' + (unseen ? ' is-unseen' : '')} onClick={onOpen}
      aria-label={sub ? `${label} — ${sub}` : label}>
      <span className="fbst-cover" style={cover ? { backgroundImage: `url("${cover}")` } : undefined}>
        {!cover && <span className="fbst-cover-fb" style={{ background: ring.avc }} aria-hidden="true">{ring.initials}</span>}
      </span>
      <span className="fbst-scrim" aria-hidden="true"/>
      <span className="fbst-ring">
        <Avatar initials={ring.initials} color={ring.avc} size={38} src={ring.profileImage}/>
      </span>
      {count > 1 && <span className="fbst-count" aria-hidden="true">{count}</span>}
      <span className="fbst-name" dir="auto">{label}</span>
    </button>
  )
}

/**
 * @param me          the signed-in user (view shape)
 * @param myStories   raw story rows for `me` (from /stories/by-author/{me})
 * @param tray        rows from useStoryTray — one per author with a live story
 * @param onCreate    open the story composer
 * @param onOpen      (authorId, author) → open the viewer
 * @param openFor     the authorId whose viewer is currently open, or null.
 *                    The rail watches this go back to null: that transition is
 *                    "the reader is done looking", which is when a ring is
 *                    acknowledged for real and the view count is re-probed.
 */
export function StoriesRail({ me, myStories = [], tray = [], onCreate, onOpen, openFor = null }) {
  const { ref, edges, by } = useRailScroll()

  /* The newest of my own frames that actually carries media — the same rule
     the tray uses for everyone else, so my tile and theirs are built alike. */
  const myCover = React.useMemo(() => {
    const s = (myStories || []).find(x => x.thumbnailUrl || x.mediaUrl)
    return s ? assetUrl(s.thumbnailUrl || s.mediaUrl) : null
  }, [myStories])

  const hasMine = (myStories || []).length > 0
  const myNewestAt = React.useMemo(
    () => (myStories || []).reduce((max, s) => Math.max(max, s?.createdAt ? new Date(s.createdAt).getTime() : 0), 0),
    [myStories],
  )

  /* Every ring re-reads its local record when this bumps: opening a story,
     closing the viewer, a fresh view count landing. */
  const [seenEpoch, setSeenEpoch] = React.useState(0)

  /* How many people have seen MY story. `null` while unknown — the ring only
     claims "nobody has seen this" once the viewer log has actually answered.
     Re-probed when the viewer closes (`viewerClosed`) and on a slow beat, since
     a NEW view is what relights the ring. */
  const [viewerClosed, setViewerClosed] = React.useState(0)
  const { views: myViews } = useMyStoryViews(myStories, viewerClosed)

  /* The viewer closing is the moment "I have seen who saw it" becomes true, so
     the acknowledgement is written on CLOSE with the count as of then — the
     open-time write is only there to darken the ring under the tap. */
  const wasOpen = React.useRef(false)
  const myOpenedRef = React.useRef(false)
  React.useEffect(() => {
    const isOpen = !!openFor
    if (wasOpen.current && !isOpen) {
      if (myOpenedRef.current) { markMyStorySeen(myNewestAt, myViews); myOpenedRef.current = false }
      setViewerClosed(n => n + 1)     // re-probe: a view may have landed while it was open
      setSeenEpoch(n => n + 1)        // re-read every ring's record
    }
    wasOpen.current = isOpen
  }, [openFor, myNewestAt, myViews])

  /* Lit while there is something about my own story I haven't looked at:
     a frame I just posted, or views that arrived since I last checked.
     Memoised rather than read inline because the record lives in localStorage —
     `seenEpoch` is what says "read it again". */
  const myUnseen = React.useMemo(
    () => hasMine && isMyStoryUnseen(myNewestAt, myViews),
    [hasMine, myNewestAt, myViews, seenEpoch],   // eslint-disable-line react-hooks/exhaustive-deps
  )

  /* Friends' rows, with the ordering the reader actually wants: anything you
     have not opened first (newest first), everything already watched sunk to
     the end. Seen stories are still reachable — they are just no longer in the
     way of the ones that are new. */
  const rows = React.useMemo(() => {
    const list = (tray || []).map(t => ({ ...t, unseen: isStoryUnseen(t.authorId, t.at) }))
    return list.sort((a, b) => (a.unseen === b.unseen ? b.at - a.at : (a.unseen ? -1 : 1)))
  }, [tray, seenEpoch])   // eslint-disable-line react-hooks/exhaustive-deps -- seenEpoch is the re-read trigger

  const open = (authorId, author, newestAt) => {
    markStorySeen(authorId, newestAt)
    setSeenEpoch(n => n + 1)
    onOpen(authorId, author)
  }
  const openMine = () => {
    myOpenedRef.current = true
    markMyStorySeen(myNewestAt, myViews)   // darken now; corrected on close
    setSeenEpoch(n => n + 1)
    onOpen(me.id, me)
  }

  return (
    <section className="fbst-rail rise" aria-label="Stories">
      <button className={'fbst-nav prev' + (edges.start ? ' is-off' : '')} aria-label="Scroll back"
        tabIndex={edges.start ? -1 : 0} onClick={() => by(-1)}><Icon name="chevleft" className="sm"/></button>

      <div className="fbst-row" ref={ref}>
        {/* Create — the composer, shaped like a story so the row reads as one
            set. Your own photo fills the plate; the foot carries the action. */}
        <button className="fbst fbst-add" onClick={onCreate} aria-label="Create a story">
          <span className="fbst-cover" style={myCover || me.profileImage ? { backgroundImage: `url("${myCover || me.profileImage}")` } : undefined}>
            {!(myCover || me.profileImage) && (
              <span className="fbst-cover-fb" style={{ background: me.avc }} aria-hidden="true">{me.initials}</span>
            )}
          </span>
          <span className="fbst-add-foot">
            <span className="fbst-plus" aria-hidden="true"><Icon name="compose"/></span>
            <b>Create story</b>
          </span>
        </button>

        {/* Mine, when I have one — so tapping my own ring opens my viewer
            instead of the composer. Here the lit ring means "nobody has viewed
            this yet", so it goes quiet the moment the first person watches. */}
        {hasMine && (
          <StoryTile
            cover={myCover}
            ring={me}
            label="Your story"
            sub={myViews === 0 ? 'No views yet' : myViews > 0 ? `${myViews} ${myViews === 1 ? 'view' : 'views'}` : undefined}
            count={myStories.length}
            unseen={myUnseen}
            onOpen={openMine}
          />
        )}

        {rows.map(t => (
          <StoryTile
            key={t.authorId}
            cover={t.cover}
            ring={t.author}
            label={t.author.full || `@${t.author.handle}`}
            sub={t.time}
            count={t.count}
            unseen={t.unseen}
            onOpen={() => open(t.authorId, t.author, t.at)}
          />
        ))}
      </div>

      <button className={'fbst-nav next' + (edges.end ? ' is-off' : '')} aria-label="Scroll forward"
        tabIndex={edges.end ? -1 : 0} onClick={() => by(1)}><Icon name="chevright" className="sm"/></button>
    </section>
  )
}

export default StoriesRail
