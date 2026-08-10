/* =========================================================
   Reels — full-screen vertical viewer (live).
   • For you  → global reels discover feed   (FEED_API §6, reels_by_day)
   • Following → home timeline, reels only    (FEED_API §4, feed_by_user)
   Plays the actual reel <video> with a bottom playback progress bar,
   records reel-watch views, toggles reactions/saves through the API.

   MODERATION. A reel is an ordinary post (postType REEL) on the ordinary post
   endpoints, so it inherits the post contract exactly: a hold shows up as
   `status: "PENDING_REVIEW"` and a refusal as 400 CONTENT_REJECTED. Two
   consequences shape what is below:

     · A held reel reaches this screen ONLY by deep link (/reels/:id → GET
       /posts/{id}, the one read that lets an author see their own held post).
       Every list here — for-you, following, by-day, the home-feed fallback —
       runs through the server's isServable filter, which has no author
       exception and drops the row for its own author too. So the badge is for
       exactly one case: you opened the link to a reel you just posted.
     · Comments are the opposite: the response of a held comment is
       byte-identical to a clean one (CommentResponse carries no moderation
       field at all), so the composer handles the refusal and nothing else —
       there is no honest badge to draw, and inventing one would mark clean
       comments as pending.
   ========================================================= */
import React from 'react'
import { useNavigate, NavLink } from 'react-router-dom'
import { Icon, Avatar, Verify, linkify, fmt, showToast } from './ui.jsx'
import { openShare } from './ShareSheet.jsx'
import { openReport } from './ReportDialog.jsx'
import { uiPrompt } from './Dialog.jsx'
import { ModerationBadge, ModerationAlert, useHeldWatch } from './Moderation.jsx'
import { moderationState, isHeld, isModerationError, moderationText } from '../lib/moderation.js'
import { authorOf } from '../lib/userView.js'
import { useAuth } from '../context/AuthContext.jsx'
import { api, applyPostDelta } from '../api/index.js'
import { useRealtime } from '../hooks/useRealtime.js'
import { PlayableVideo } from './PlayableVideo.jsx'
import { ReelMixer } from './ReelMixer.jsx'
import { useReelAudio } from '../hooks/useReelAudio.js'
import { StillClock } from '../lib/stillClock.js'
import { readMix as readAuthoredMix } from '../lib/soundMix.js'

/* How long a PHOTO reel plays before it loops. A still has no duration of its
   own, so the viewer supplies one — and it has to match what the composer
   promised the author when they attached the photo. */
const STILL_SECS = 30

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
  const [mixOpen, setMixOpen] = React.useState(false)  // audio mixer panel
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
  /* A STILL reel — a photo posted as a reel. It has no video and therefore no
     audio of its own: it plays for STILL_SECS on a StillClock, and whatever
     sound is attached is the only thing there is to hear. */
  const stillUrl = m0 && m0.type === 'IMAGE' ? m0.url : null
  const u = reel ? authorOf(reel) : null

  // Advancing used to buffer from scratch because only the active cell mounts a
  // player. Warm the NEXT clip in a hidden, muted, never-played element so its
  // data is already buffered by the time it becomes active. One clip ahead only
  // — preloading more would fight the active stream for bandwidth.
  const nextReel = reels[idx + 1]
  const nextM = nextReel?.media?.[0]
  const nextVideoUrl = nextM && nextM.type === 'VIDEO' ? nextM.url : null
  const nextStillUrl = nextM && nextM.type === 'IMAGE' ? nextM.url : null

  /* Bumped when a still reel's clock is installed — see the StillClock effect.
     Async work below patches rows BY ID, not by index: a fetch that resolves
     after a swipe would otherwise write the answer onto whichever reel happens
     to be on screen. */
  const [stillReady, setStillReady] = React.useState(0)
  const patchById = (id, fn) => setReels(rs => rs.map(r => (r.id === id ? fn(r) : r)))

  /* ---- The reel's ADDED sound (§19) ----------------------------------
     A reel keeps its own recorded audio in the video file; a sound picked at
     compose time is a SECOND track, carried as `audioTrackUrl`. No list
     endpoint returns it — FeedItemResponse has no audio field at all — so the
     only place it can come from is the reel's own GET /posts/{id}. That read
     is made once per reel, for the ACTIVE clip only, and cached by id so
     swiping back does not repeat it. The 200ms wait keeps a fast flick
     through ten reels from firing ten reads for clips nobody stopped on. */
  const [tracks, setTracks] = React.useState({})   // reelId → {url,name} | null (null = looked, none)
  const ownTrack = reel?.soundUrl ? { url: reel.soundUrl, name: reel.soundName || '' } : null
  const track = ownTrack || tracks[reel?.id] || null
  /* `…#mix=orig,music` — the levels the author set in the composer. A url
     fragment, because the API has no field for them (BACKEND_NOTES #16); it
     never reaches the server and older reels simply carry none. */
  const authoredMix = React.useMemo(() => readAuthoredMix(track?.url), [track?.url])
  React.useEffect(() => {
    if (!reel || (!videoUrl && !stillUrl) || ownTrack || tracks[reel.id] !== undefined) return
    let alive = true
    const t = setTimeout(() => {
      api.posts.get(reel.id)
        .then(full => {
          if (!alive) return
          setTracks(s => ({ ...s, [reel.id]: full?.soundUrl ? { url: full.soundUrl, name: full.soundName || '' } : null }))
          /* The same read settles what the reel IS. A row whose media the feed
             could not classify (no `videoUrl`, no extension on the cover) is
             optimistically played as video; if the canonical post turns out to
             hold only a photo, it is a still reel — say so now rather than
             waiting for the <video> to fail. */
          const media = full?.media || []
          if (!media.some(m => m.type === 'VIDEO' && m.url)) {
            const img = media.find(m => m.type === 'IMAGE' && m.url)
            if (img) patchById(reel.id, r => (r.media?.[0]?.type === 'IMAGE' ? r : { ...r, media: [img] }))
          }
        })
        .catch(() => { if (alive) setTracks(s => ({ ...s, [reel.id]: null })) })
    }, 200)
    return () => { alive = false; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reel?.id, videoUrl, stillUrl])

  /* Both tracks play together and are balanced independently; the hook owns
     every write to either element's volume/muted (see hooks/useReelAudio.js).
     For a still reel the "clip" is a StillClock — same interface, no audio of
     its own — so the added track rides the still's 30 seconds unchanged. */
  const audio = useReelAudio({
    videoRef,
    trackUrl: track?.url || null,
    /* Three things re-key the mirror, because all three swap what videoRef
       points at: the reel itself; a clip that DIES (its <video> unmounts
       without the reel changing, and the track must not play on over a dead
       frame); and the still clock arriving, which happens one render after the
       image does. */
    srcKey: `${reel?.id || ''}${videoErr ? ':err' : ''}:${stillReady}`,
    muted,
    onBlocked: () => setNeedsSound(true),
    // the balance its author set before posting, if they set one
    authored: authoredMix,
  })

  // Old rows have no videoUrl and may carry an image cover → on load error,
  // hydrate the full post once (mediaUrls/mediaTypes have the real VIDEO).
  const hydrated = React.useRef(new Set())
  const onVideoError = () => {
    if (reel && !hydrated.current.has(reel.id)) {
      hydrated.current.add(reel.id)
      const id = reel.id
      api.posts.get(id)
        .then(full => {
          const vid = (full.media || []).find(m => m.type === 'VIDEO' && m.url)
          if (vid) { patchById(id, r => ({ ...r, media: [vid] })); return }   // re-renders → video retries
          /* Not a broken clip — a PHOTO reel the feed row could not label. It
             plays as a still, so this is a resolution, not a failure. */
          const img = (full.media || []).find(m => m.type === 'IMAGE' && m.url)
          if (img) { patchById(id, r => ({ ...r, media: [img] })); setVideoErr(false); return }
          setVideoErr(true)
        })
        .catch(() => setVideoErr(true))
    } else setVideoErr(true)
  }

  // Reel-watch view (§13.1/§26) + reset transient video state on reel change.
  const seenAt = React.useRef(0)
  React.useEffect(() => {
    seenAt.current = Date.now()
    setVideoErr(false); setPlaying(true); setProgress(0); setBuffering(false); setCapOpen(false); setBurst(null); setMixOpen(false)
    if (reel) api.posts.recordView(reel.id).catch(() => {})   // counts the view (§11) — watch ≠ view
    return () => {
      if (reel) {
        const watched = Math.round((Date.now() - seenAt.current) / 1000)
        api.reels.recordWatch(reel.id, watched).catch(() => {})   // watch-history session (§12.1)
      }
    }
  }, [reel?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  /* The element's muted/volume are set imperatively (React's `muted` attr is
     flaky) — but by useReelAudio, which is the single writer of both: master
     mute, the per-track mute and the per-track level all resolve there, and
     it re-asserts them on every reel change. A second effect writing
     `video.muted = muted` here would silently undo the "original sound off,
     added track on" case. */

  // Sound ON by default: try to autoplay WITH audio. Browsers block unmuted
  // autoplay until a user gesture, so on rejection we fall back to muted
  // playback and raise a "tap for sound" nudge that the next tap clears.
  React.useEffect(() => {
    const v = videoRef.current
    if (!v || !videoUrl) return
    let cancelled = false
    audio.apply()
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
      // NOT plain `muted = false`: a listener who silenced the original track
      // in the mixer asked for exactly that, gesture or no gesture.
      if (v) { v.muted = audio.mix.origOff; v.play().catch(() => {}) }
      setMuted(false); setNeedsSound(false)
      audio.resume()          // the added track was blocked by the same policy
    }
    window.addEventListener('pointerdown', enable, { once: true })
    return () => window.removeEventListener('pointerdown', enable)
    // `audio` is a fresh object every render; listing it would re-arm this
    // one-shot listener continuously. Only `mix.origOff` is read from the
    // closure — resume() reads the live levels through the hook's own refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /* ---- A photo reel's transport --------------------------------------
     There is no <video> to run a still, so it gets a StillClock: the same
     interface (duration / currentTime / paused / play / pause / timeupdate),
     30 seconds long, looping. It is installed on the SAME ref the video would
     have used, which is what lets the seek bar, the space bar, the arrow keys,
     the tap-to-pause and the sound mirror keep working with no still-specific
     branches anywhere. `stillReady` re-keys the audio mirror, because the
     clock lands one render after the image does. */
  React.useEffect(() => {
    if (!stillUrl) return
    const clock = new StillClock(STILL_SECS)
    videoRef.current = clock
    const tick = () => onTime({ target: clock })
    clock.addEventListener('timeupdate', tick)
    clock.addEventListener('seeked', tick)
    clock.play()
    setPlaying(true)
    setStillReady(n => n + 1)
    return () => {
      clock.removeEventListener('timeupdate', tick)
      clock.removeEventListener('seeked', tick)
      clock.destroy()
      if (videoRef.current === clock) videoRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stillUrl, reel?.id])

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
  /* The landing position, mirrored out of state. `onSeekUp` used to re-read
     `progress` from its closure — which, on a QUICK TAP, is still the position
     from BEFORE the tap: pointerdown's setProgress has not committed a render
     by the time pointerup runs, so releasing snapped the clip straight back to
     where it started. A drag hid the bug (the intermediate moves re-rendered);
     a tap on the bar never worked. */
  const scrubFrac = React.useRef(0)
  const [scrubUI, setScrubUI] = React.useState(false)
  const fmtT = (s) => { if (!isFinite(s) || s <= 0) return '0:00'; const m = Math.floor(s / 60); return m + ':' + String(Math.floor(s % 60)).padStart(2, '0') }
  const seekTo = (clientX, el) => {
    const v = videoRef.current; if (!v) return
    const rect = el.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    scrubFrac.current = frac
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
    if (v && d) try { v.currentTime = Math.min(scrubFrac.current * d, Math.max(0, d - .05)) } catch { /* ignore */ }
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
  /* REPOST — a new post that references this reel (§6.1); self-repost allowed (§28).
     The note is scored like any post body, so it can come back refused. It used
     to be typed into a dialog that had already closed by the time the toast
     landed, which meant the words were simply gone. Now the prompt re-opens
     PRE-FILLED, carrying the server's sentence above the field — verbatim, no
     category, no offending phrase — because editing is the only way past a
     block and you cannot edit what you cannot see. */
  const repost = async () => {
    let draft = ''
    let notice = null
    for (;;) {
      const caption = await uiPrompt({
        title:'Repost to your profile', label:'Add a note (optional)',
        placeholder:'Why is this worth sharing?', multiline:true, icon:'repost',
        confirmLabel:'Repost', initial: draft, message: notice,
      })
      /* Passing `initial` also un-disables Repost on an empty note, which is
         what the label ("optional") and the `caption || ''` below always
         claimed — before this the button sat disabled until you typed. */
      if (caption === null) return   // cancelled
      draft = caption
      try {
        const created = await api.posts.create({ postType: 'REPOST', visibility: 'PUBLIC', sharedPostId: reel.id, textContent: caption || '', mediaUrls: [], mediaTypes: [] })
        /* A held repost answers 200 with status PENDING_REVIEW and never fans
           out. Saying "Reposted to your profile" for that would be a lie the
           author only discovers by going and finding nothing there. */
        showToast(isHeld(created) ? 'Reposted — it goes out as soon as it clears a check' : 'Reposted to your profile',
          isHeld(created) ? 'warn' : 'ok')
        return
      } catch (e) {
        if (!isModerationError(e)) { showToast('Could not repost'); return }
        notice = moderationText(e)
      }
    }
  }
  /* The rail is a reel's only action surface — there is no ⋯ menu here — and a
     reel IS a post, so it reports as one. Pause first: a reel talking over the
     report form is exactly what the viewer is trying to get away from. */
  const report = () => {
    const v = videoRef.current
    if (v && !v.paused) { v.pause(); setPlaying(false) }
    openReport({ targetType: 'POST', targetId: reel.id, targetLabel: 'this reel' })
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
    if (e.target.closest?.('.rv-mix')) return       // scrolling inside the mixer is not paging
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
  const [cErr, setCErr] = React.useState(null)          // a refused comment, shown inside the sheet

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
    // expanded caption scrolls natively; the mixer's sliders must not page the
    // feed out from under the finger that is dragging one
    if (scrubbing.current || e.target.closest?.('.rvm-caption.open, .rv-mix')) return
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
  /* Something is on screen and running (a clip, or a photo on its clock) → the
     scrim, the pause glyph and the seek bar all belong to it. */
  const hasFrame = (!!videoUrl && !videoErr) || !!stillUrl
  /* Something can be HEARD: a clip always can (its own recording), a photo only
     if a sound was attached. */
  const hasAudio = hasFrame && (!stillUrl || !!track)

  /* Held reel — see the head note: this can only be my own, and only because I
     arrived by deep link. `status` is "PENDING_REVIEW" for both PENDING and
     IN_REVIEW (the post wire collapses them), so the chip can honestly say no
     more than "Checking…" here — which moderationState() already does. */
  const reelState = moderationState(reel)
  const reelHeld = isSelf && isHeld(reel)
  /* A hold clears silently — no realtime moderation event exists anywhere, and
     the "your content is live" bell only fires for content that actually
     waited. So the one read that serves an author their own held post,
     GET /posts/{id}, is re-run on the POST back-off until the status moves.
     Only `status` is merged back: the row was built by a different adapter
     than this response and wholesale replacement would swap media shapes
     mid-playback. */
  useHeldWatch(reelHeld, 'POST', async () => {
    const fresh = await api.posts.get(reel.id)
    if (!fresh?.status) return
    patch(r => ({ ...r, status: fresh.status }))
    // The badge flip is silent otherwise — no verdict is ever pushed.
    if (moderationState(fresh) === 'live') showToast('Your reel is live — everyone can see it now.')
  })
  // Navigating already changes the route away from /reels (so the overlay unmounts) —
  // do NOT also call onClose(), which is navigate('/') and would race us to the home page.
  const goAuthor = () => { if (reel?.author) navigate(`/u/${reel.author}`) }
  const followAuthor = () => {
    const id = reel.author, now = !followed[id]
    setFollowed(f => ({ ...f, [id]: now }))
    ;(now ? api.users.follow(id) : api.users.unfollow(id)).catch(() => setFollowed(f => ({ ...f, [id]: !now })))
  }

  // ---- In-place comments sheet (state hoisted above the keydown effect) ----
  React.useEffect(() => { setCmtOpen(false); setCmtFor(null); cmtForRef.current = null; setCmts(null); setCText(''); setCErr(null); setProgress(0); setBuffered(0); setDuration(0) }, [reel?.id])
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
  /* Posting a comment.
     Three things were wrong here the moment a comment could be REFUSED, and a
     moderation block is what makes all three visible: the box was cleared
     before the request was even sent, the optimistic `tmp-` bubble was never
     taken back off the list, and the +1 on the reel's counter was never rolled
     back. The result of a 400 was a phantom comment nobody else could see,
     an inflated count, and the author's sentence deleted. So: clear the box
     only once the server has actually accepted it, and undo BOTH optimistic
     writes on any failure.

     A HELD comment is indistinguishable from a clean one on this wire —
     CommentResponse carries no moderation field and none of its mappers write
     one — so there is nothing to badge and nothing to poll. The author simply
     keeps seeing their own row (the server's read filter carves them out) and
     everyone else silently does not. That is a backend gap, not something to
     paper over with a guess. */
  const postCmt = () => {
    const v = cText.trim(); if (!v || cBusy) return
    setCBusy(true); setCErr(null)
    const tmp = { id: 'tmp-' + performance.now(), _author: user, author: user?.id, body: v, time: 'now' }
    setCmts(cs => [...(cs || []), tmp])
    patch(r => ({ ...r, comments: (r.comments || 0) + 1 }))
    api.posts.addComment(reel.id, { text: v })
      .then(saved => {
        setCText('')
        if (saved?.id) setCmts(cs => (cs || []).map(c => c.id === tmp.id ? saved : c))
      })
      .catch(e => {
        setCmts(cs => (cs || []).filter(c => c.id !== tmp.id))
        patch(r => ({ ...r, comments: Math.max(0, (r.comments || 0) - 1) }))
        /* A refusal is shown in the sheet, next to the words it is about and
           with those words still in the box. Verbatim, and with no retry
           control: the same text can only be refused the same way. */
        if (isModerationError(e)) setCErr(e)
        else showToast('Could not post comment')
      })
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
          {/* same idea for a photo reel: fetch the image now, not on arrival */}
          {nextStillUrl && (
            <img key={'pres-' + (nextReel.id || idx + 1)} className="rv-preload" src={nextStillUrl}
              alt="" aria-hidden="true" tabIndex={-1}/>
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
            ) : stillUrl ? (
              /* PHOTO REEL — the same stage as a clip: ambient letterbox glow,
                 tap to pause, double-tap to like. The image itself never
                 "plays", so the slow drift is what tells the eye this is a
                 reel and not a stuck video; the StillClock supplies the 30
                 seconds the seek bar and the sound run against. */
              <div className="rv-video-wrap" onClick={onTap}>
                <div className="rv-ambient" aria-hidden="true" style={{ backgroundImage: `url(${stillUrl})` }}/>
                <img className={'rv-video rv-still' + (playing ? ' is-live' : '')} src={stillUrl}
                  alt={reel.body ? reel.body.slice(0, 120) : 'Photo reel'} draggable={false}/>
              </div>
            ) : (
              <>
                <div className="rv-bg" style={{ background: m0?.bg || 'linear-gradient(160deg,#1b2939,#080e16)' }}/>
                <div className="rv-center">{reel.body?.slice(0, 80)}</div>
              </>
            )}

            {/* gradient scrim — keeps caption/rail legible over any clip */}
            {hasFrame && <div className="rv-scrim" aria-hidden="true"/>}

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
            {hasFrame && !playing && !buffering && !flash && (
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
            {hasFrame && needsSound && (
              <button className="rv-soundcue" onClick={toggleMute}>
                <Icon name="volume" className="xs"/>Tap for sound
              </button>
            )}

            {/* Mute toggle — master: it silences BOTH tracks at once. A photo
                reel with no sound attached has nothing to silence, so neither
                control is drawn for it. */}
            {hasAudio && (
              <button className={'rv-mute' + (muted ? ' off' : '')} onClick={toggleMute} title={muted ? 'Unmute' : 'Mute'} aria-label={muted ? 'Unmute' : 'Mute'}>
                <Icon name={muted ? 'mute' : 'volume'} className="sm"/>
              </button>
            )}

            {/* audio mixer — the two tracks, balanced separately */}
            {hasAudio && (
              <button className={'rv-mixbtn' + (mixOpen ? ' on' : '') + (track ? ' has-music' : '')}
                onClick={() => setMixOpen(o => !o)} aria-expanded={mixOpen}
                title={track ? 'Audio mixer' : 'Volume'} aria-label={track ? 'Audio mixer' : 'Volume'}>
                <Icon name={track ? 'music' : 'volumelow'} className="sm"/>
              </button>
            )}
            {hasAudio && mixOpen && (
              <ReelMixer audio={audio} muted={muted} onUnmute={toggleMute}
                /* A still has no recorded audio of its own — the mixer must not
                   offer a level for a track that does not exist. */
                hasOriginal={!!videoUrl && !videoErr}
                trackName={track?.name || ''} onClose={() => setMixOpen(false)}/>
            )}

            <div className="rv-meta">
              {/* The frame plays as normal; only the claim that it is out there
                  is withdrawn. Sits above the author row because that is where
                  the eye already is, and because the rail beside it is dimmed
                  at the same time — the two have to read as one statement. */}
              {reelHeld && (
                <div style={{ marginBottom: 8 }}>
                  <ModerationBadge state={reelState}/>
                  <span style={{ display: 'block', marginTop: 5, fontSize: 12.5, lineHeight: 1.45, color: '#f2f0f0', textShadow: '0 1px 3px rgba(0,0,0,.6)' }}>
                    Only you can see this reel until it clears.
                  </span>
                </div>
              )}
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
              {/* The attached sound, named only once it is actually known —
                  the feed row carries no audio metadata, so this appears when
                  the reel's own read lands (see `tracks` above) and never as a
                  guessed "Original audio" label. Tapping it opens the mixer,
                  which is where the two tracks are balanced. */}
              {track && (
                <button className="rvm-sound" onClick={() => setMixOpen(o => !o)}
                  title="Audio mixer" aria-label={`Audio mixer — ${track.name || 'added sound'}`}>
                  <Icon name="music" className="xs"/>
                  <span className="rvm-marquee">{track.name || 'Added sound'}</span>
                </button>
              )}
            </div>

            {/* Nobody can like, comment on or share what nobody can see yet.
                .mod-off keeps the whole rail in the DOM and merely inert, so
                the frame does not reflow the instant a verdict lands. */}
            <div className={'rv-rail' + (reelHeld ? ' mod-off' : '')}>
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
              {!isSelf && (
                <button className="rvr" onClick={report} aria-label="Report this reel">
                  <span><Icon name="flag" className="lg"/></span><small>Report</small>
                </button>
              )}
            </div>

            {/* playback timeline — drag to scrub, pinned to the bottom of the reel */}
            {hasFrame && (
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
                          <div className="rvc-name"><b>{cu.full}</b>{cu.verified && <Verify scholar={cu.role==='SCHOLAR'}/>}<i>{c.time}</i>
                            {/* Same synthesized-row caveat as the avatar above: without an
                                author id we cannot tell whose comment it is, and a live row
                                may carry no server id for moderators to resolve. */}
                            {c.id && c.author && c.author !== user?.id && (
                              <button type="button" title="Report comment" aria-label="Report comment"
                                onClick={() => openReport({ targetType:'COMMENT', targetId:c.id, targetLabel:'this comment', subject:c.body })}
                                style={{ marginInlineStart:'auto', background:'none', border:0, padding:2, color:'var(--muted)', cursor:'pointer' }}>
                                <Icon name="flag" className="xs"/>
                              </button>
                            )}
                          </div>
                          <p dir="auto">{linkify(c.body)}</p>
                        </div>
                      </div>
                    )
                  })}
            </div>
            {cErr && (
              <div style={{ padding: '0 12px' }}>
                <ModerationAlert error={cErr} onDismiss={() => setCErr(null)}/>
              </div>
            )}
            <div className="rvc-box">
              <Avatar initials={(user?.full || 'Y').slice(0,1).toUpperCase()} color="linear-gradient(135deg,#1f4e7e,#00172f)" size={30} src={user?.profileImage}/>
              <input className="rvc-field" dir="auto" placeholder="Add a comment…" value={cText}
                onChange={e => { setCText(e.target.value); if (cErr) setCErr(null) }}   // the refusal was about the OLD text
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
