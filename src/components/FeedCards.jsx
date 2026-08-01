/* =========================================================
   Mixed home-feed cards — the RESEARCH, QUESTION and
   CHANNEL_POST rows that appear alongside posts in the ranked
   home feed (HOME_FEED_FRONTEND_GUIDE §2). Posts keep rendering
   through <PostCard>; these render everything else.

   The feed snapshot carries NO counters for research/Q&A
   ("the card is an invitation, the detail page is the truth"),
   so the cards show title + author + time + a kind badge + CTA.
   Live counters (guide §4) are fetched LAZILY, once, only when
   the card scrolls into view, and cached so a re-scroll is free.

   CHANNEL_POST is the exception: its counters DO arrive with the
   row (from message_counters), they just mean different things —
   views, FORWARDS and discussion comments — so that card renders
   them straight and never hydrates.
   ========================================================= */
import React from 'react'
import { Icon, Avatar, Verify, fmt, linkify } from './ui.jsx'
import { PlayableVideo } from './PlayableVideo.jsx'
import { tintOf, crestOf } from './channels/channelArt.js'
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
            v: raw?.viewCount || 0,
            cover: raw?.coverImageUrl ? `center/cover no-repeat url("${assetUrl(raw.coverImageUrl)}")` : '',
          }))
        : api.qna.get(item.id).then(q => ({ a: q?.answers || 0, v: q?.views || 0 }))
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
            <span title={`${fmt(counts.v)} views`}><Icon name="eye" className="xs"/>{fmt(counts.v)}</span>
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
        {counts ? (
          <>
            <span className="qna-ans"><Icon name="comment" className="xs"/>{fmt(counts.a)} answers</span>
            <span className="qna-views" title={`${fmt(counts.v)} views`}><Icon name="eye" className="xs"/>{fmt(counts.v)} views</span>
          </>
        ) : <span className="qna-ans muted">Open question</span>}
        <a className="fx-cta" onClick={e => { e.stopPropagation(); open() }}>Answer this<Icon name="chevright" className="xs"/></a>
      </footer>
    </article>
  )
}

/** CHANNEL_POST feed card — a broadcast, not a person's post.
 *
 *  What makes it a different card rather than a <PostCard> with a flag:
 *
 *  · The CHANNEL signs it. `item.author` is null by contract, so the header is
 *    the channel's plate + title + verified badge — there is no member to
 *    render and no /u/:id to link to.
 *  · There are no like or save affordances. Channels carry their own reaction
 *    system inside the channel screen, and the feed row has no counter for it;
 *    offering a heart here would be a button that cannot work.
 *  · The counters mean views / FORWARDS / discussion comments (guide §2).
 *    `comments` is only rendered when non-zero — it is null-meaning-"off" on a
 *    channel with no linked discussion group, and a hard "0 comments" would
 *    advertise a conversation that does not exist.
 *  · Click-through is the channel TIMELINE scrolled to this post, which is the
 *    conversation route with the message id in `?m=` — never a /posts/:id
 *    page, which a channel post does not have. The id stays a STRING: it is a
 *    snowflake well past Number.MAX_SAFE_INTEGER.
 *
 *  `observeView` is the ref callback from useFeedChannelViews — the card
 *  reports itself once it is half on screen and the hook batches per channel.
 */
export function FeedChannelCard({ item, navigate, observeView }) {
  const ch = item.channel
  const media = (item.media || [])[0]
  const [mediaDead, setMediaDead] = React.useState(false)
  const openPost = () => {
    if (!ch?.id) return
    navigate(item.channelPostId ? `/chat/${ch.id}?m=${encodeURIComponent(item.channelPostId)}` : `/chat/${ch.id}`)
  }
  const openChannel = (e) => { e.stopPropagation(); if (ch?.id) navigate(`/channels/${ch.id}`) }

  const channelId = ch?.id || null
  const postId = item.channelPostId || null
  const ref = React.useCallback(
    (el) => { if (observeView && channelId && postId) observeView(el, channelId, postId) },
    [observeView, channelId, postId],
  )

  if (!ch) return null
  return (
    <article
      ref={ref}
      className="fch-card rise"
      role="button"
      tabIndex={0}
      aria-label={`Open “${ch.title}” at this post`}
      onClick={openPost}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPost() } }}
    >
      <header className="fch-head">
        {/* Same derived art the channels surface wears: `tint-N` is keyed on
            the channel id, so a channel looks identical here, on its card and
            in the manage console — and an avatar that appears or disappears
            never shifts the plate underneath it. */}
        <span className={'fch-crest lk tint-' + tintOf(ch.id)} role="button" onClick={openChannel} aria-label={ch.title}>
          {ch.avatarUrl ? <img src={ch.avatarUrl} alt="" loading="lazy"/> : crestOf(ch)}
        </span>
        <div className="fch-who">
          <div className="fch-name lk" role="button" onClick={openChannel}>
            <b>{ch.title}</b>
            {ch.verified && <Verify/>}
          </div>
          {/* One string, not three flex children: the container is a flex row
              with a gap, so bare text nodes would each become their own item
              and the separators would drift apart from their words. */}
          <div className="fch-sub">
            <span>{[
              ch.handle ? `@${ch.handle}` : 'Channel',
              ch.subscriberCount > 0 ? `${fmt(ch.subscriberCount)} subscribers` : null,
            ].filter(Boolean).join(' · ')}</span>
            <span className="fch-dot"/>
            <span>{item.time}</span>
          </div>
        </div>
        <span className="fx-badge channel"><Icon name="megaphone" className="xs"/>Channel</span>
      </header>

      {item.body && <div className="fch-body" dir="auto">{linkify(item.body)}</div>}

      {media && !mediaDead && (
        <div className="fch-media" style={{ aspectRatio: media.ratio || '16/10' }}>
          {media.type === 'VIDEO'
            ? <PlayableVideo src={media.url} poster={media.poster} controls preload="metadata"
                style={{ width:'100%', height:'100%', objectFit:'cover', display:'block' }} modal/>
            /* The cover is whatever the first attachment resolved to — which
               on a document or audio post is not an image at all. A dead load
               retires the plate rather than leaving a broken-image box. */
            : <img src={media.url} alt="" loading="lazy" onError={() => setMediaDead(true)}/>}
        </div>
      )}

      <footer className="fch-foot">
        <span title={`${fmt(item.views)} views`}><Icon name="eye" className="xs"/>{fmt(item.views)}</span>
        <span title={`${fmt(item.shares)} forwards`}><Icon name="share" className="xs"/>{fmt(item.shares)}</span>
        {item.comments > 0 && (
          <span title={`${fmt(item.comments)} comments`}><Icon name="comment" className="xs"/>{fmt(item.comments)}</span>
        )}
        <a className="fx-cta" onClick={e => { e.stopPropagation(); openPost() }}>Open in channel<Icon name="chevright" className="xs"/></a>
      </footer>
    </article>
  )
}
