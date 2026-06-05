/* =========================================================
   Mixed home-feed cards — RESEARCH and QUESTION rows that
   appear alongside posts in the chronological home feed
   (HOME_FEED_FRONTEND_GUIDE). Posts keep rendering through
   <PostCard>; these render the light research/Q&A entries.

   The feed snapshot carries NO counters for research/Q&A
   ("the card is an invitation, the detail page is the truth"),
   so the cards show title + author + time + a kind badge + CTA.
   Live counters (guide §4) are fetched LAZILY, once, only when
   the card scrolls into view, and cached so a re-scroll is free.
   ========================================================= */
import React from 'react'
import { Icon, Avatar, Verify, fmt } from './ui.jsx'
import { authorOf } from '../lib/userView.js'
import { api, assetUrl } from '../api/index.js'

// id → { a, b, cover } resolved meta, shared across mounts so scrolling back
// up never refires the request.
const counterCache = new Map()

/** Lazy on-screen meta fetch (guide §4). Fires one detail GET the first time the
 *  card is visible: research → reactions + comments + the authoritative COVER
 *  image (the feed-fanout snapshot's mediaUrl is often empty, so we pull the cover
 *  from the detail endpoint here); question → answers + views. Failures (404
 *  removed / 403 went private) are swallowed → no numbers / fall back to gradient. */
function useLiveCounters(item) {
  const ref = React.useRef(null)
  const [counts, setCounts] = React.useState(() => counterCache.get(item.id) || null)

  React.useEffect(() => {
    if (counts) return
    if (counterCache.has(item.id)) { setCounts(counterCache.get(item.id)); return }
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    let done = false
    const io = new IntersectionObserver(entries => {
      if (done || !entries.some(e => e.isIntersecting)) return
      done = true; io.disconnect()
      const req = item.kind === 'RESEARCH'
        ? api.research.get(item.id).then(raw => ({
            a: raw?.reactionCount || 0,
            b: raw?.commentCount || 0,
            cover: raw?.coverImageUrl ? `center/cover no-repeat url("${assetUrl(raw.coverImageUrl)}")` : '',
          }))
        : api.qna.get(item.id).then(q => ({ a: q?.answers || 0, b: q?.views || 0 }))
      req.then(c => { counterCache.set(item.id, c); setCounts(c) }).catch(() => {})
    }, { rootMargin: '300px' })
    io.observe(el)
    return () => io.disconnect()
  }, [item.id, item.kind, counts])

  return { ref, counts }
}

/** RESEARCH feed card → opens /research/:id. */
export function FeedResearchCard({ item, navigate }) {
  const u = authorOf(item)
  const { ref, counts } = useLiveCounters(item)
  const open = () => navigate(`/research/${item.id}`)
  const goAuthor = e => { e.stopPropagation(); if (item.author) navigate(`/u/${item.author}`) }
  return (
    <article ref={ref} className="r-card rise feed-xcard" onClick={open}>
      <div className="r-cover" style={{ background: (counts && counts.cover) || item.cover }}>
        <span className="fx-kind"><Icon name="research" className="xs"/>Publication</span>
      </div>
      <div className="r-body">
        <div className="r-top">
          <span className="lk" role="button" onClick={goAuthor}><Avatar initials={u.initials} color={u.avc} size={30} src={u.profileImage}/></span>
          <div>
            <div className="rail-name lk" role="button" onClick={goAuthor}><b>{u.full}</b> {u.verified && <Verify scholar/>}</div>
            <small className="muted">{item.time}</small>
          </div>
          <span className="fx-badge research" style={{ marginLeft:'auto' }}><Icon name="research" className="xs"/>Research</span>
        </div>
        <h3>{item.title}</h3>
        <footer className="r-foot">
          {counts && <>
            <span><Icon name="heart" className="xs"/>{fmt(counts.a)}</span>
            <span><Icon name="comment" className="xs"/>{fmt(counts.b)}</span>
          </>}
          <a className="fx-cta" onClick={e => { e.stopPropagation(); open() }}>Open paper<Icon name="chevright" className="xs"/></a>
        </footer>
      </div>
    </article>
  )
}

/** QUESTION feed card → opens /qna/:id. */
export function FeedQuestionCard({ item, navigate }) {
  const u = authorOf(item)
  const { ref, counts } = useLiveCounters(item)
  const open = () => navigate(`/qna/${item.id}`)
  const goAuthor = e => { e.stopPropagation(); if (item.author) navigate(`/u/${item.author}`) }
  return (
    <article ref={ref} className="qna-card rise feed-xcard" onClick={open}>
      <header>
        <span className="lk" role="button" onClick={goAuthor}><Avatar initials={u.initials} color={u.avc} size={38} src={u.profileImage}/></span>
        <div>
          <div className="qna-name lk" role="button" onClick={goAuthor}><b>{u.full}</b> {u.verified && <Verify scholar={u.role==='SCHOLAR'}/>}</div>
          <div className="qna-sub">@{u.handle} · {item.time}</div>
        </div>
        <span className="fx-badge question" style={{ marginLeft:'auto' }}><Icon name="qna" className="xs"/>Question</span>
      </header>
      <h3>{item.title}</h3>
      <footer>
        {counts ? <span className="qna-ans"><Icon name="comment" className="xs"/>{fmt(counts.a)} answers</span> : <span className="qna-ans muted">Open question</span>}
        <a className="fx-cta" onClick={e => { e.stopPropagation(); open() }}>Answer this<Icon name="chevright" className="xs"/></a>
      </footer>
    </article>
  )
}
