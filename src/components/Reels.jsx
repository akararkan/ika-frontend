/* =========================================================
   Reels — full-screen vertical viewer (live).
   • For you  → global reels discover feed   (FEED_API §6, reels_by_day)
   • Following → home timeline, reels only    (FEED_API §4, feed_by_user)
   Plays the actual reel <video> with a bottom playback progress bar,
   records reel-watch views, toggles reactions/saves through the API.
   ========================================================= */
import React from 'react'
import { useNavigate, NavLink } from 'react-router-dom'
import { Icon, Avatar, Verify, linkify, fmt, showToast } from './ui.jsx'
import { openShare } from './ShareSheet.jsx'
import { uiPrompt } from './Dialog.jsx'
import { authorOf } from '../lib/userView.js'
import { useAuth } from '../context/AuthContext.jsx'
import { api, applyPostDelta } from '../api/index.js'
import { useRealtime } from '../hooks/useRealtime.js'
import { PlayableVideo } from './PlayableVideo.jsx'

export function Reels({ onClose, initialId }) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [followed, setFollowed] = React.useState({})   // authorId → following?
  const [tab, setTab] = React.useState('FOR_YOU')   // FOR_YOU | FOLLOWING
  const [reels, setReels] = React.useState([])
  const [idx, setIdx] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [muted, setMuted] = React.useState(false)   // sound ON by default (per request)
  const [needsSound, setNeedsSound] = React.useState(false) // unmuted autoplay blocked → nudge
  const [playing, setPlaying] = React.useState(true)
  const [buffering, setBuffering] = React.useState(false)
  const [videoErr, setVideoErr] = React.useState(false)
  const [progress, setProgress] = React.useState(0) // 0..1 of the active clip
  const [capOpen, setCapOpen] = React.useState(false) // caption expanded?
  const [burst, setBurst] = React.useState(null)    // {x,y,key} double-tap heart
  const videoRef = React.useRef(null)

  // Load the list for the active tab. Prefer the dedicated ranked / following
  // endpoints, but ALWAYS fall back so existing reels never read "No reels yet":
  //   For you   → ranked /reels/for-you, else walk the day-bucket discover feed
  //   Following → /reels/following, else home-feed filtered to reels
  React.useEffect(() => {
    let alive = true
    setLoading(true); setIdx(0)
    ;(async () => {
      // deep-linked reel (/reels/:id) → fetch it and show it first
      let head = []
      if (initialId) { try { const r = await api.posts.get(initialId); if (r) head = [r] } catch { /* fall back to feed */ } }

      let list = []
      if (tab === 'FOLLOWING') {
        try { list = await api.reels.following() } catch { /* fall through */ }
        if (!list?.length) {
          try { const feed = await api.posts.feed({ limit: 50 }); list = (feed || []).filter(r => r.type === 'REEL') } catch { /* ignore */ }
        }
      } else {
        try { list = await api.reels.forYou() } catch { /* fall through */ }
        if (!list?.length) {
          // FEED_API §6 — no cross-day cursor, so walk UTC day buckets back.
          const day = new Date()
          for (let back = 0; back <= 14 && alive && !list?.length; back++) {
            const iso = day.toISOString().slice(0, 10)
            try { const r = await api.reels.feed({ day: iso }); if (r?.length) list = r } catch { /* try previous day */ }
            day.setUTCDate(day.getUTCDate() - 1)
          }
        }
      }
      const seen = new Set(head.map(x => x.id))
      if (alive) { setReels([...head, ...(list || []).filter(x => !seen.has(x.id))]); setLoading(false) }
    })()
    return () => { alive = false }
  }, [tab, initialId])

  const reel = reels[idx]
  const m0 = reel?.media?.[0]
  const videoUrl = m0 && m0.type === 'VIDEO' ? m0.url : null
  const u = reel ? authorOf(reel) : null

  // Advancing used to buffer from scratch because only the active cell mounts a
  // player. Warm the NEXT clip in a hidden, muted, never-played element so its
  // data is already buffered by the time it becomes active. One clip ahead only
  // — preloading more would fight the active stream for bandwidth.
  const nextReel = reels[idx + 1]
  const nextM = nextReel?.media?.[0]
  const nextVideoUrl = nextM && nextM.type === 'VIDEO' ? nextM.url : null

  // Old rows have no videoUrl and may carry an image cover → on load error,
  // hydrate the full post once (mediaUrls/mediaTypes have the real VIDEO).
  const hydrated = React.useRef(new Set())
  const onVideoError = () => {
    if (reel && !hydrated.current.has(reel.id)) {
      hydrated.current.add(reel.id)
      api.posts.get(reel.id)
        .then(full => {
          const vid = (full.media || []).find(m => m.type === 'VIDEO' && m.url)
          if (vid) patch(r => ({ ...r, media: [vid] }))   // re-renders → video retries
          else setVideoErr(true)
        })
        .catch(() => setVideoErr(true))
    } else setVideoErr(true)
  }

  // Reel-watch view (§13.1/§26) + reset transient video state on reel change.
  const seenAt = React.useRef(0)
  React.useEffect(() => {
    seenAt.current = Date.now()
    setVideoErr(false); setPlaying(true); setProgress(0); setBuffering(false); setCapOpen(false); setBurst(null)
    if (reel) api.posts.recordView(reel.id).catch(() => {})   // counts the view (§11) — watch ≠ view
    return () => {
      if (reel) {
        const watched = Math.round((Date.now() - seenAt.current) / 1000)
        api.reels.recordWatch(reel.id, watched).catch(() => {})   // watch-history session (§12.1)
      }
    }
  }, [reel?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // keep the element's muted prop authoritative (React's `muted` attr is flaky)
  React.useEffect(() => { if (videoRef.current) videoRef.current.muted = muted }, [muted, reel?.id])

  // Sound ON by default: try to autoplay WITH audio. Browsers block unmuted
  // autoplay until a user gesture, so on rejection we fall back to muted
  // playback and raise a "tap for sound" nudge that the next tap clears.
  React.useEffect(() => {
    const v = videoRef.current
    if (!v || !videoUrl) return
    let cancelled = false
    v.muted = muted
    const p = v.play()
    if (p && p.catch) p.catch(() => {
      if (cancelled || muted) return
      v.muted = true; setMuted(true); setNeedsSound(true)
      v.play().catch(() => {})
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reel?.id, videoUrl])

  // While the unmute nudge is up, the very next gesture anywhere flips sound on.
  React.useEffect(() => {
    if (!needsSound) return
    const enable = () => {
      const v = videoRef.current
      if (v) { v.muted = false; v.play().catch(() => {}) }
      setMuted(false); setNeedsSound(false)
    }
    window.addEventListener('pointerdown', enable, { once: true })
    return () => window.removeEventListener('pointerdown', enable)
  }, [needsSound])

  // Momentary play/pause glyph — instant feedback for space-bar and taps.
  const [flash, setFlash] = React.useState(null)
  const togglePlay = () => {
    const v = videoRef.current; if (!v) return
    if (v.paused) { setFlash({ type: 'play', key: performance.now() }); v.play().then(() => setPlaying(true)).catch(() => {}) }
    else { setFlash({ type: 'pause', key: performance.now() }); v.pause(); setPlaying(false) }
  }
  const toggleMute = () => { setNeedsSound(false); setMuted(m => !m) }
  // Chunked / duration-less streams report duration:Infinity (or NaN before
  // metadata) — fall back to the end of the seekable range so the progress
  // fill and scrubbing work on every source the backend can produce.
  const durOf = (v) => {
    if (!v) return 0
    if (isFinite(v.duration) && v.duration > 0) return v.duration
    try { if (v.seekable && v.seekable.length) return v.seekable.end(v.seekable.length - 1) } catch { /* detached */ }
    return 0
  }
  const [buffered, setBuffered] = React.useState(0)
  /* The clip's duration, mirrored into state from the video's own events.
     The scrub readout used to call `durOf(videoRef.current)` inline in the
     JSX — a ref read DURING RENDER, which React cannot track: the element it
     points at can change without re-rendering, so the timestamp could show a
     stale duration (or 0) with nothing to invalidate it. Feeding it through
     state makes the readout a function of rendered data like everything else. */
  const [duration, setDuration] = React.useState(0)
  const onTime = (e) => {
    const v = e.target, d = durOf(v)
    if (!d) return
    setDuration(prev => (prev === d ? prev : d))     // functional: no churn, no stale closure
    try { if (v.buffered && v.buffered.length) setBuffered(Math.min(1, v.buffered.end(v.buffered.length - 1) / d)) } catch { /* ignore */ }
    if (!scrubbing.current) setProgress(v.currentTime / d)
  }

  // Single tap → play/pause · double tap → like + heart burst (Instagram-style).
  const lastTap = React.useRef(0)
  const onTap = (e) => {
    const now = e.timeStamp                       // pure: event-provided timestamp
    const stage = e.currentTarget.getBoundingClientRect()
    if (now - lastTap.current < 280) {            // second tap → like
      lastTap.current = 0
      togglePlay()                                // revert the first tap's toggle — playback continues
      if (!reel.liked) like()                     // double-tap only ever likes, never unlikes
      setBurst({ x: e.clientX - stage.left, y: e.clientY - stage.top, key: now })
    } else {
      lastTap.current = now
      togglePlay()                                // instant response; a second tap reverts it
    }
  }

  // Drag-scrub seek bar (pointer events so touch + mouse both feel native).
  // scrubUI mirrors the ref into state so CSS can dim the chrome and show the
  // time bubble while the finger is down.
  const scrubbing = React.useRef(false)
  const [scrubUI, setScrubUI] = React.useState(false)
  const fmtT = (s) => { if (!isFinite(s) || s <= 0) return '0:00'; const m = Math.floor(s / 60); return m + ':' + String(Math.floor(s % 60)).padStart(2, '0') }
  const seekTo = (clientX, el) => {
    const v = videoRef.current; if (!v) return
    const rect = el.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    setProgress(frac)
    const d = durOf(v); if (!d) return
    const t = Math.min(frac * d, Math.max(0, d - .05))
    try {
      if (scrubbing.current && typeof v.fastSeek === 'function') v.fastSeek(t)   // keyframe-fast while dragging
      else v.currentTime = t
    } catch { /* not seekable yet */ }
  }
  const onSeekDown = (e) => { scrubbing.current = true; setScrubUI(true); e.currentTarget.setPointerCapture?.(e.pointerId); seekTo(e.clientX, e.currentTarget) }
  const onSeekMove = (e) => { if (scrubbing.current) seekTo(e.clientX, e.currentTarget) }
  const onSeekUp = () => {
    scrubbing.current = false; setScrubUI(false)
    const v = videoRef.current, d = durOf(v)                                     // land precisely where the finger left
    if (v && d) try { v.currentTime = Math.min(progress * d, Math.max(0, d - .05)) } catch { /* ignore */ }
  }

  const patch = (fn) => setReels(rs => rs.map((r, i) => i === idx ? fn(r) : r))
  const like = () => {
    const was = reel.liked
    patch(r => ({ ...r, liked: !r.liked, likes: r.likes + (r.liked ? -1 : 1) }))
    api.posts.toggleReaction(reel.id).catch(() => patch(r => ({ ...r, liked: was, likes: r.likes + (was ? 1 : -1) })))   // roll back
  }
  const save = () => {
    const was = reel.saved
    patch(r => ({ ...r, saved: !r.saved, saves: r.saves + (r.saved ? -1 : 1) }))
    showToast(was ? 'Removed from saved' : 'Saved')
    api.posts.toggleSave(reel.id)
      .then(res => { if (res && typeof res.saved === 'boolean') patch(r => ({ ...r, saved: res.saved })) })
      .catch(() => { patch(r => ({ ...r, saved: was, saves: r.saves + (was ? 1 : -1) })); showToast('Could not update saved') })
  }
  // §16 — open the share sheet (previews the real link, records on share)
  const share = () => openShare({
    kind: 'post', id: reel.id, title: reel.body ? reel.body.slice(0, 90) : 'this reel',
    count: reel.shares, onShared: (c) => patch(r => ({ ...r, shares: c })),
  })
  // REPOST — a new post that references this reel (§6.1); self-repost allowed (§28)
  const repost = async () => {
    const caption = await uiPrompt({ title:'Repost to your profile', label:'Add a note (optional)', placeholder:'Why is this worth sharing?', multiline:true, icon:'repost', confirmLabel:'Repost' })
    if (caption === null) return   // cancelled
    api.posts.create({ postType: 'REPOST', visibility: 'PUBLIC', sharedPostId: reel.id, textContent: caption || '', mediaUrls: [], mediaTypes: [] })
      .then(() => showToast('Reposted to your profile'))
      .catch(() => showToast('Could not repost'))
  }
  // Reflect the REAL follow state for the current reel's author (so the button
  // reads "Following" when you already follow them, "Follow" otherwise).
  React.useEffect(() => {
    const id = reel?.author
    if (!id || !user?.id || String(id) === String(user.id)) return
    if (followed[id] !== undefined) return                        // already known
    api.users.socialStatus(id).then(s => setFollowed(f => ({ ...f, [id]: !!s.isFollowing }))).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reel?.author, user?.id])

  const step = (d) => setIdx(i => Math.max(0, Math.min(reels.length - 1, i + d)))
  // Desktop paging: one wheel/trackpad gesture = one reel (throttled), and
  // arrow keys page too — same feel as the touch swipe below.
  const wheelLock = React.useRef(0)
  const wheelLast = React.useRef(0)
  const onWheel = (e) => {
    const now = Date.now()
    const sinceLast = now - wheelLast.current
    wheelLast.current = now
    if (Math.abs(e.deltaY) < 24) return
    // momentum tail arrives <90ms apart — only a fresh gesture may page,
    // and never more than one page per 550ms
    if (now - wheelLock.current < 550 || sinceLast < 90) return
    wheelLock.current = now
    step(e.deltaY > 0 ? 1 : -1)
  }
  /* Comments-sheet state, declared ABOVE the keydown effect that closes over
     `setCmtOpen`. It read fine before only because the listener runs after the
     first render, by which point the binding is initialised — but the source
     order said "used before declared", which is a real trip hazard the next
     time someone moves code here. Declaration order now matches use order. */
  const [cmtOpen, setCmtOpen] = React.useState(false)
  const [cmts, setCmts] = React.useState(null)          // null = not loaded yet
  const [cmtFor, setCmtFor] = React.useState(null)      // which reel the sheet was opened for — pins the SSE subscription
  const cmtForRef = React.useRef(null)                  // same value for async guards (a fetch resolving after a swipe)
  const seenCR = React.useRef(new Set())                // comment ids whose +1 already ran (fetch-seeded; replay exactly-once)
  const delCR = React.useRef(new Set())                 // comment ids whose -1 already ran
  const [cText, setCText] = React.useState('')
  const [cBusy, setCBusy] = React.useState(false)

  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { setCmtOpen(false); return }        // always works, even while typing
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.key === 'ArrowDown') { e.preventDefault(); step(1) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1) }
      else if (e.key === ' ' || e.code === 'Space') {
        if (t && t.closest && t.closest('button,a,[role="button"]')) return   // keep native Space activation on focused controls
        e.preventDefault(); togglePlay()
      }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const v = videoRef.current, d = durOf(v)
        if (v && d) { e.preventDefault(); try { v.currentTime = Math.min(Math.max(0, v.currentTime + (e.key === 'ArrowRight' ? 5 : -5)), d - .05) } catch { /* ignore */ } }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reels.length])
  // Finger-follow paging: the track tracks the drag live (rubber-banding at
  // the ends), then springs to the settled reel on release. A small delta is
  // a tap (handled by the video's togglePlay), so only page past ~60px.
  const touchY = React.useRef(null)
  const trackRef = React.useRef(null)
  const rafId = React.useRef(0)
  const [dragging, setDragging] = React.useState(false)
  // write the settled transform directly so the DOM and React's next render agree
  const settleTrack = (targetIdx) => { if (trackRef.current) trackRef.current.style.transform = `translateY(${targetIdx * -100}%)` }
  const onTouchStart = (e) => {
    if (scrubbing.current || e.target.closest?.('.rvm-caption.open')) return   // expanded caption scrolls natively
    touchY.current = e.touches[0]?.clientY ?? null
    setDragging(true)
  }
  const onTouchMove = (e) => {
    if (scrubbing.current || touchY.current == null) return
    let dy = (e.touches[0]?.clientY ?? touchY.current) - touchY.current
    if ((idx === 0 && dy > 0) || (idx === reels.length - 1 && dy < 0)) dy *= .35
    cancelAnimationFrame(rafId.current)                 // imperative drag: zero React re-renders per frame
    rafId.current = requestAnimationFrame(() => {
      if (trackRef.current) trackRef.current.style.transform = `translateY(calc(${idx * -100}% + ${dy}px))`
    })
  }
  const endDrag = (e) => {
    setDragging(false)
    cancelAnimationFrame(rafId.current)
    if (touchY.current == null) return
    const endY = e?.changedTouches?.[0]?.clientY ?? touchY.current
    const dy = endY - touchY.current
    touchY.current = null
    const target = dy < -60 ? Math.min(idx + 1, reels.length - 1) : dy > 60 ? Math.max(idx - 1, 0) : idx
    settleTrack(target)
    if (target !== idx) setIdx(target)
  }
  const onTouchEnd = (e) => endDrag(e)
  const onTouchCancel = () => endDrag(null)             // OS-interrupted gesture springs home
  const isSelf = !!(reel && user?.id && String(reel.author) === String(user.id))
  // Navigating already changes the route away from /reels (so the overlay unmounts) —
  // do NOT also call onClose(), which is navigate('/') and would race us to the home page.
  const goAuthor = () => { if (reel?.author) navigate(`/u/${reel.author}`) }
  const followAuthor = () => {
    const id = reel.author, now = !followed[id]
    setFollowed(f => ({ ...f, [id]: now }))
    ;(now ? api.users.follow(id) : api.users.unfollow(id)).catch(() => setFollowed(f => ({ ...f, [id]: !now })))
  }

  // ---- In-place comments sheet (state hoisted above the keydown effect) ----
  React.useEffect(() => { setCmtOpen(false); setCmtFor(null); cmtForRef.current = null; setCmts(null); setCText(''); setProgress(0); setBuffered(0); setDuration(0) }, [reel?.id])
  /* Live sheet: while comments are OPEN, the reel's post stream keeps them
     moving — someone else's comment appears in place, deletions vanish, and
     the reel's counters ride the deltas. A closed sheet holds no socket: a
     swipe-heavy surface must not churn one connection per reel. Pinned to
     `cmtFor` (the reel the sheet was OPENED for), not the current reel — a
     swipe with the sheet open renders one frame where reel has advanced but
     cmtOpen hasn't reset yet, and keying on reel.id would dial a throwaway
     socket to the new reel (and let a late old-stream event patch it). The
     handler double-checks the pin for the same one-frame reason. The server
     filters our own echoes; the ledgers make replayed deliveries count
     exactly once (rows were already deduped by id — counters must match). */
  useRealtime('posts', cmtOpen && cmtFor ? cmtFor : null, {
    onEvent: (evt) => {
      if (!reel || reel.id !== cmtFor) return
      const t = evt.eventType
      if (t === 'COMMENT_CREATED' && evt.commentId) {
        if (seenCR.current.has(evt.commentId)) return
        seenCR.current.add(evt.commentId)
        patch(r => ({ ...r, comments: (r.comments || 0) + 1 }))
        setCmts(cs => !cs || cs.some(c => c.id === evt.commentId) ? cs : [...cs, {
          id: evt.commentId,
          _author: { full: evt.actorUsername || 'Someone', handle: evt.actorUsername || 'member',
                     initials: (evt.actorUsername || 'M').slice(0, 2).toUpperCase(), avc: 'linear-gradient(135deg,#1f4e7e,#00172f)' },
          body: evt.textContent || '', time: 'now',
        }])
      } else if (t === 'COMMENT_DELETED' && evt.commentId) {
        if (delCR.current.has(evt.commentId)) return
        delCR.current.add(evt.commentId)
        patch(r => ({ ...r, comments: Math.max(0, (r.comments || 0) - 1) }))
        setCmts(cs => cs ? cs.filter(c => c.id !== evt.commentId) : cs)
      } else if (t !== 'REPLY_CREATED') {
        // REPLY_CREATED is deliberately counter-only-skipped too (the sheet
        // renders no reply threads and a replayed +1 could never be audited);
        // everything else — reactions, views, shares — rides the delta helper.
        patch(r => applyPostDelta(r, evt))
      }
    },
  })
  const openComments = () => {
    const rid = reel.id
    setCmtOpen(true)
    setCmtFor(rid)
    cmtForRef.current = rid
    /* Refetch on EVERY open — the sheet holds no socket while closed, so
       comments that landed in between would otherwise never appear (the old
       `cmts == null` guard kept a stale list forever). Existing rows stay on
       screen while the fresh page loads; the counter reconciles to at least
       the fetched truth. A swipe mid-fetch nulls cmtForRef, so a late resolve
       can never resurrect the previous reel's list onto the new one. */
    api.posts.comments(rid, { pageSize: 30 }).then(r => {
      if (cmtForRef.current !== rid) return
      const list = r || []
      list.forEach(c => seenCR.current.add(c.id))
      setCmts(list)
      patch(x => ({ ...x, comments: Math.max(x.comments || 0, list.length) }))
    }).catch(() => setCmts(cs => cs || []))
  }
  const postCmt = () => {
    const v = cText.trim(); if (!v || cBusy) return
    setCBusy(true); setCText('')
    const tmp = { id: 'tmp-' + performance.now(), _author: user, author: user?.id, body: v, time: 'now' }
    setCmts(cs => [...(cs || []), tmp])
    patch(r => ({ ...r, comments: (r.comments || 0) + 1 }))
    api.posts.addComment(reel.id, { text: v })
      .then(saved => { if (saved?.id) setCmts(cs => (cs || []).map(c => c.id === tmp.id ? saved : c)) })
      .catch(() => showToast('Could not post comment'))
      .finally(() => setCBusy(false))
  }

  return (
    <div className="reels-view">
      <div className="rv-top">
        <span className="rv-top-spacer" aria-hidden="true"/>
        <div className="rv-segs">
          <button className={'rv-tab ' + (tab === 'FOR_YOU' ? 'on' : '')} onClick={() => setTab('FOR_YOU')}>For you</button>
          <button className={'rv-tab ' + (tab === 'FOLLOWING' ? 'on' : '')} onClick={() => setTab('FOLLOWING')}>Following</button>
        </div>
        <button className="rv-close" onClick={onClose} aria-label="Close reels"><Icon name="close"/></button>
      </div>

      {loading ? (
        <div className="rv-stage">
          <div className="rv-card rv-skel" role="status" aria-label="Loading reels">
            <span className="rv-skel-sheen" aria-hidden="true"/>
            <div className="rv-spin" aria-hidden="true"><i/></div>
          </div>
        </div>
      ) : !reel ? (
        <div className="rv-stage" style={{ color:'#fff' }}>
          <div style={{ textAlign:'center' }}>{tab === 'FOLLOWING' ? 'No reels from people you follow yet.' : 'No reels yet.'}</div>
        </div>
      ) : (
        <div className={'rv-stage' + (scrubUI ? ' is-scrubbing' : '')} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={onTouchCancel} onWheel={onWheel}>
          {/* The track holds every reel as a full-height cell and slides to the
              active index — it follows the finger live, then springs to rest.
              Only the active cell mounts the real player; its neighbours show
              their poster so the frame is already there mid-scroll. */}
          {/* buffers the next clip so advancing is instant (see nextVideoUrl) */}
          {nextVideoUrl && (
            <video key={'pre-' + (nextReel.id || idx + 1)} className="rv-preload" src={nextVideoUrl}
              preload="auto" muted playsInline aria-hidden="true" tabIndex={-1}/>
          )}
          <div ref={trackRef} className={'rv-track' + (dragging ? ' dragging' : '')} style={{ transform: `translateY(${idx * -100}%)` }}>
          {reels.map((r, i) => (
          <div key={r.id || i} className="rv-cell" style={{ '--i': i }}>
          {i !== idx ? (Math.abs(i - idx) === 1 ? (
            <div className="rv-card rv-peek" aria-hidden="true">
              {r.media?.[0]?.poster
                ? <div className="rv-bg" style={{ backgroundImage: `url(${r.media[0].poster})`, backgroundSize: 'cover', backgroundPosition: 'center' }}/>
                : <div className="rv-bg" style={{ background: r.media?.[0]?.bg || 'linear-gradient(160deg,#1b2939,#080e16)' }}/>}
            </div>
          ) : null) : (
          <div className="rv-card">
            {videoUrl && !videoErr ? (
              <div className="rv-video-wrap" onClick={onTap}>
                {/* Ambient backdrop — the poster, blurred into a glow, fills the
                    letterbox so the original aspect ratio shows uncropped. */}
                <div className="rv-ambient" aria-hidden="true" style={m0?.poster ? { backgroundImage: `url(${m0.poster})` } : undefined}/>
                <PlayableVideo
                  key={reel.id}
                  videoRef={videoRef}
                  onTimeUpdate={onTime}
                  src={videoUrl}
                  poster={m0?.poster || undefined}
                  className="rv-video"
                  controls={false}
                  autoPlay
                  loop
                  muted={muted}
                  preload="auto"
                  onError={onVideoError}
                  onCanPlay={() => { setBuffering(false) }}
                  onWaiting={() => setBuffering(true)}
                  onPlaying={() => setBuffering(false)}
                  style={{ borderRadius:0 }}
                />
              </div>
            ) : (
              <>
                <div className="rv-bg" style={{ background: m0?.bg || 'linear-gradient(160deg,#1b2939,#080e16)' }}/>
                <div className="rv-center">{reel.body?.slice(0, 80)}</div>
              </>
            )}

            {/* gradient scrim — keeps caption/rail legible over any clip */}
            {videoUrl && !videoErr && <div className="rv-scrim" aria-hidden="true"/>}

            {/* buffering spinner */}
            {videoUrl && !videoErr && buffering && playing && (
              <div className="rv-spin" aria-hidden="true"><i/></div>
            )}

            {/* double-tap heart burst */}
            {burst && (
              <span key={burst.key} className="rv-burst" style={{ left:burst.x, top:burst.y }} onAnimationEnd={() => setBurst(null)} aria-hidden="true">
                <Icon name="heart"/>
              </span>
            )}

            {/* paused glyph — non-interactive so it never blocks the rail */}
            {videoUrl && !videoErr && !playing && !buffering && !flash && (
              <div className="rv-pausewrap" aria-hidden="true">
                <span className="rv-pause"><Icon name="play" className="lg"/></span>
              </div>
            )}

            {/* momentary play/pause flash — instant feedback for space & taps */}
            {flash && (
              <div key={flash.key} className="rv-flash" onAnimationEnd={() => setFlash(null)} aria-hidden="true">
                <Icon name={flash.type}/>
              </div>
            )}

            {/* "tap for sound" nudge — only when the browser blocked unmuted autoplay */}
            {videoUrl && !videoErr && needsSound && (
              <button className="rv-soundcue" onClick={toggleMute}>
                <Icon name="volume" className="xs"/>Tap for sound
              </button>
            )}

            {/* mute toggle */}
            {videoUrl && !videoErr && (
              <button className={'rv-mute' + (muted ? ' off' : '')} onClick={toggleMute} title={muted ? 'Unmute' : 'Mute'} aria-label={muted ? 'Unmute' : 'Mute'}>
                <Icon name={muted ? 'mute' : 'volume'} className="sm"/>
              </button>
            )}

            <div className="rv-meta">
              <div className="rvm-author">
                <span role="button" style={{ cursor:'pointer' }} onClick={goAuthor}><Avatar initials={u.initials} color={u.avc} size={40} src={u.profileImage}/></span>
                <div role="button" style={{ cursor:'pointer' }} onClick={goAuthor}>
                  <div className="rvm-name"><b>@{u.handle}</b>{u.verified && <Verify scholar={u.role==='SCHOLAR'}/>}</div>
                  <div className="rvm-time">{reel.time} · {fmt(reel.views)} views</div>
                </div>
                {!isSelf && <button className={'rvm-follow' + (followed[reel.author] ? ' on' : '')} onClick={followAuthor}>{followed[reel.author] ? 'Following' : 'Follow'}</button>}
              </div>
              {reel.body && (
                <div className="rvm-cap">
                  <p className={'rvm-caption' + (capOpen ? ' open' : '')}>{linkify(reel.body)}</p>
                  {(reel.body || '').length > 90 && (
                    <button className="rvm-more" onClick={() => setCapOpen(o => !o)}>{capOpen ? 'show less' : 'more'}</button>
                  )}
                </div>
              )}
              {/* No invented "Original audio" claim: the reels feed does not
                  carry the attached sound's metadata, so there is nothing
                  truthful to print here. Restore this row when the API
                  hydrates the reel's sound (title · artist). */}
            </div>

            <div className="rv-rail">
              <button className={'rvr ' + (reel.liked ? 'on' : '')} onClick={like}>
                <span><Icon name="heart" className="lg"/></span><small className="font-mono">{fmt(reel.likes)}</small>
              </button>
              <button className={'rvr' + (cmtOpen ? ' cv' : '')} onClick={openComments} aria-label="Comments">
                <span><Icon name="comment" className="lg"/></span><small className="font-mono">{fmt(reel.comments)}</small>
              </button>
              <button className={'rvr ' + (reel.saved ? 'sv' : '')} onClick={save}>
                <span><Icon name="bookmark" className="lg"/></span><small className="font-mono">{fmt(reel.saves)}</small>
              </button>
              <button className="rvr" onClick={repost}>
                <span><Icon name="repost" className="lg"/></span><small>Repost</small>
              </button>
              <button className="rvr" onClick={share}>
                <span><Icon name="share" className="lg"/></span><small className="font-mono">{fmt(reel.shares)}</small>
              </button>
            </div>

            {/* playback timeline — drag to scrub, pinned to the bottom of the reel */}
            {videoUrl && !videoErr && (
              <div className="rv-seek" onPointerDown={onSeekDown} onPointerMove={onSeekMove} onPointerUp={onSeekUp} onPointerCancel={onSeekUp}>
                {scrubUI && (
                  <span className="rv-seek-time" style={{ '--x': `${Math.round(progress * 100)}%` }}>
                    {fmtT(progress * duration)}<i>/ {fmtT(duration)}</i>
                  </span>
                )}
                <div className="rv-seek-track">
                  <div className="rv-seek-buf" style={{ width:`${Math.round(buffered * 100)}%` }}/>
                  <div className="rv-seek-fill" style={{ width:`${Math.round(progress * 100)}%` }}/>
                  <span className="rv-seek-thumb" style={{ left:`${Math.round(progress * 100)}%` }}/>
                </div>
              </div>
            )}
          </div>
          )}
          </div>
          ))}
          </div>

          <div className="rv-nav">
            <button onClick={() => step(-1)} disabled={idx===0}><Icon name="chevup"/></button>
            <button onClick={() => step(1)} disabled={idx===reels.length-1}><Icon name="chevdown"/></button>
          </div>
        </div>
      )}

      {/* In-place comments — night bottom sheet (phones) / side panel (desktop) */}
      {cmtOpen && reel && (
        <div className="rvc-scrim" onClick={() => setCmtOpen(false)}>
          <aside className="rvc" onClick={e => e.stopPropagation()} role="dialog" aria-label="Comments">
            <header className="rvc-head">
              <b>Comments</b><span className="rvc-n">{fmt(reel.comments)}</span>
              <button className="rvc-x" onClick={() => setCmtOpen(false)} aria-label="Close comments"><Icon name="close" className="sm"/></button>
            </header>
            <div className="rvc-list">
              {cmts == null ? <div className="rvc-empty">Loading comments…</div>
                : !cmts.length ? <div className="rvc-empty">No comments yet — be the first.</div>
                : cmts.map(c => {
                    const cu = authorOf(c)
                    return (
                      <div key={c.id} className="rvc-row">
                        {/* Live-synthesized rows carry no author id (the thin
                            wire has no actorId) — never navigate to /u/undefined. */}
                        <span role={c.author ? 'button' : undefined}
                          style={c.author ? { cursor:'pointer' } : undefined}
                          onClick={() => c.author && navigate(`/u/${c.author}`)}>
                          <Avatar initials={cu.initials} color={cu.avc} size={30} src={cu.profileImage}/>
                        </span>
                        <div className="rvc-col">
                          <div className="rvc-name"><b>{cu.full}</b>{cu.verified && <Verify scholar={cu.role==='SCHOLAR'}/>}<i>{c.time}</i></div>
                          <p dir="auto">{linkify(c.body)}</p>
                        </div>
                      </div>
                    )
                  })}
            </div>
            <div className="rvc-box">
              <Avatar initials={(user?.full || 'Y').slice(0,1).toUpperCase()} color="linear-gradient(135deg,#1f4e7e,#00172f)" size={30} src={user?.profileImage}/>
              <input className="rvc-field" dir="auto" placeholder="Add a comment…" value={cText}
                onChange={e => setCText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') postCmt() }}/>
              <button className="rvc-send" disabled={cBusy || !cText.trim()} onClick={postCmt} aria-label="Post comment"><Icon name="send" className="sm"/></button>
            </div>
          </aside>
        </div>
      )}

      {/* Mobile-only glass tab bar — the real botnav is covered by this overlay,
          so mirror it here so reels is never a navigational dead-end. */}
      <nav className="rv-mtabbar">
        <NavLink to="/" end aria-label="Home"><Icon name="home"/><small>Home</small></NavLink>
        <NavLink to="/explore" aria-label="Explore"><Icon name="search"/><small>Explore</small></NavLink>
        <a className="mid" onClick={() => window.dispatchEvent(new CustomEvent('ika:compose', { detail:'TEXT' }))} aria-label="Create">
          <span className="plus"><Icon name="compose"/></span>
        </a>
        <NavLink to="/qna" aria-label="Q&A"><Icon name="qna"/><small>Q&amp;A</small></NavLink>
        <NavLink to="/profile" aria-label="Profile"><Icon name="user"/><small>You</small></NavLink>
      </nav>
    </div>
  )
}
