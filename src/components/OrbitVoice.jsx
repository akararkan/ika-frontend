/* =========================================================
   OrbitVoice — the feed's voice-POST player: the "Orbit" ring.
   ---------------------------------------------------------
   Visual design ported from the user's OrbitPlayer mock (canvas
   ring of waveform bars, breathing glow, inner progress arc with
   a knob, drag-anywhere-on-the-ring scrubbing, mono clocks) —
   but mounted on the app's PROVEN <audio> engine instead of the
   mock's fetch+decodeAudioData playback, because:

   · the media route's CORS has broken JS fetches in production
     before (doubled ACAO headers) — an <audio> element streams
     regardless, a fetch-based player would go silent;
   · the element engine brings the shared voice-rate preference
     (with pitch preserved), one-voice-at-a-time app-wide, the
     duration ladder for header-less recordings, and the hardened
     error path (retry with preload=auto, unseekable latching,
     tap-to-retry failed state) — all battle-tested in
     VoiceNote/VoicePlayer;
   · feed items arrive without an audio URL — `resolveSrc`
     fetches it on the first tap (same contract as VoicePlayer).

   The ring waveform is a DETERMINISTIC 700-point envelope seeded
   by the src, so the same post draws the same shape on every
   device and re-render (real peaks would need the CORS-fragile
   byte fetch; the envelope reads as speech and never shimmers).

   The rAF loop runs ONLY while playing or dragging — at rest the
   ring is drawn once per state change, so a feed of voice posts
   costs no idle frames. Wobble/glow honor prefers-reduced-motion.
   ========================================================= */
import React from 'react'
import { Icon } from './ui.jsx'
import {
  SPEEDS, speedLabel, durationOf, getMediaPrefs, setMediaPref, subscribeMediaPrefs,
  pauseOtherVoices, measureDuration,
} from './chat/mediaPrefs.js'

const BARS = 96

/* The MOCK's exact palette — the user asked for the identical UI, so these
   are OrbitPlayer.jsx's literals verbatim, not Oxford re-tints. */
const ACCENT = '#2f6fed'
const GLOW_RGB = '47,111,237'
const REST = 'rgba(19,35,61,.16)'
const FAINT = 'rgba(19,35,61,.1)'
const KNOB = '#13233d'

/* Deterministic speech-like peak envelope — the FALLBACK when the real bytes
   cannot be fetched (prod media CORS). Same seed, same ring, forever. */
function orbitPeaks(seed = '') {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) }
  let s = (h >>> 0) % 2147483647 || 1
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 }
  const N = 700
  const pk = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const env = 0.45 + 0.55 * Math.abs(Math.sin((i / N) * Math.PI * 5.3 + (s % 7)))
    pk[i] = Math.min(1, 0.14 + rnd() * 0.5 * env + env * 0.36)
  }
  return pk
}

/* REAL peaks, the mock's exact algorithm: 700-point max-envelope (stride 8)
   normalised with pow .75 — this is what gives the ring its true audio
   texture. Best-effort: any fetch/decode failure resolves null and the
   synthetic envelope stands (the media route's CORS has broken JS fetches in
   prod before; the <audio> playback is unaffected either way). Cached per
   URL, deduped in flight, capped like measureDuration. */
const PEAKS_CACHE = new Map()
const PEAKS_INFLIGHT = new Map()
function realPeaksOf(url) {
  if (!url) return Promise.resolve(null)
  if (PEAKS_CACHE.has(url)) return Promise.resolve(PEAKS_CACHE.get(url))
  if (PEAKS_INFLIGHT.has(url)) return PEAKS_INFLIGHT.get(url)
  const Ctx = typeof window !== 'undefined' ? (window.OfflineAudioContext || window.webkitOfflineAudioContext) : null
  if (!Ctx) return Promise.resolve(null)
  const p = (async () => {
    try {
      const res = await fetch(url)
      if (!res.ok) { PEAKS_CACHE.set(url, null); return null }
      const buf = await res.arrayBuffer()
      if (buf.byteLength > 12 * 1024 * 1024) { PEAKS_CACHE.set(url, null); return null }
      const audio = await new Ctx(1, 1, 8000).decodeAudioData(buf)
      const ch = audio.getChannelData(0), N = 700, pk = new Float32Array(N), step = ch.length / N
      for (let i = 0; i < N; i++) {
        let m = 0
        for (let j = Math.floor(i * step); j < (i + 1) * step; j += 8) m = Math.max(m, Math.abs(ch[j]))
        pk[i] = m
      }
      let m = 0
      for (let i = 0; i < N; i++) m = Math.max(m, pk[i])
      for (let i = 0; i < N; i++) pk[i] = Math.pow(pk[i] / (m || 1), 0.75)
      if (PEAKS_CACHE.size > 100) PEAKS_CACHE.delete(PEAKS_CACHE.keys().next().value)
      PEAKS_CACHE.set(url, pk)
      return pk
    } catch { return null } finally { PEAKS_INFLIGHT.delete(url) }
  })()
  PEAKS_INFLIGHT.set(url, p)
  return p
}

export function OrbitVoice({ src, duration, resolveSrc = null, seed = null, className = '' }) {
  const cvRef = React.useRef(null)
  const ringRef = React.useRef(null)
  const audioRef = React.useRef(null)
  const curRef = React.useRef(null)
  const rafRef = React.useRef(0)
  const endHoldRef = React.useRef(0)
  const draggingRef = React.useRef(false)
  const resumeRef = React.useRef(false)
  const wantPlayRef = React.useRef(false)
  const startedRef = React.useRef(false)

  const [playing, setPlaying] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const [dur, setDur] = React.useState(typeof duration === 'number' ? duration : 0)
  const [lazySrc, setLazySrc] = React.useState(null)
  const [resolving, setResolving] = React.useState(false)
  const activeSrc = src || lazySrc
  /* Real decoded peaks when the bytes are reachable (identical to the mock's
     ring); the seed-stable synthetic envelope until then / where they aren't. */
  const [realPeaks, setRealPeaks] = React.useState(null)
  React.useEffect(() => {
    let alive = true
    setRealPeaks(null)
    if (activeSrc) realPeaksOf(activeSrc).then(pk => { if (alive && pk) setRealPeaks(pk) })
    return () => { alive = false }
  }, [activeSrc])
  const peaks = React.useMemo(
    () => realPeaks || orbitPeaks(seed || activeSrc || 'voice'),
    [realPeaks, seed, activeSrc],
  )

  const rate = React.useSyncExternalStore(subscribeMediaPrefs, () => getMediaPrefs().voiceRate, () => 1)

  // Live, not a one-shot read: toggling the OS setting mid-session must calm
  // the ring like it calms every CSS animation.
  const reduceMotion = React.useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia?.('(prefers-reduced-motion: reduce)')
      m?.addEventListener?.('change', cb)
      return () => m?.removeEventListener?.('change', cb)
    },
    () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    () => false,
  )

  /* Duration ladder — element duration → guarded seekable end → known/measured.
     0 means UNKNOWN (no fill, no lying). Same rules as VoiceNote/VoicePlayer. */
  const totalOf = React.useCallback((a) => {
    if (!a) return dur || 0
    const d = a.duration
    if (Number.isFinite(d) && d > 0) return d
    if (a.seekable?.length) {
      try {
        const end = a.seekable.end(a.seekable.length - 1)
        if (Number.isFinite(end) && end > 0) return end
      } catch { /* empty range throws — fall through */ }
    }
    return dur || 0
  }, [dur])

  const measuredRef = React.useRef(false)
  const srcRef = React.useRef(activeSrc)
  React.useEffect(() => { srcRef.current = activeSrc; measuredRef.current = false }, [activeSrc])
  const ensureMeasured = React.useCallback(() => {
    if (measuredRef.current || !activeSrc || totalOf(audioRef.current)) return
    measuredRef.current = true
    const url = activeSrc
    measureDuration(url).then(d => {
      if (srcRef.current !== url) return
      if (d) setDur(d)
      else measuredRef.current = false
    })
  }, [activeSrc, totalOf])

  const applyRate = (a, r) => { a.playbackRate = r; a.preservesPitch = true; a.webkitPreservesPitch = true }
  React.useEffect(() => { const a = audioRef.current; if (a) applyRate(a, rate) }, [rate])

  /* ---------- the ring ---------- */
  const draw = React.useCallback(() => {
    const a = audioRef.current
    const total = a ? totalOf(a) : (dur || 0)
    const t = a ? a.currentTime : 0
    const fr = a?.ended ? 1 : total ? Math.min(1, t / total) : 0

    /* Clock + slider values FIRST — they must be truthful even when the
       canvas has no layout box yet (a role=slider without aria values is a
       dead control to a screen reader). Imperative on purpose: the rAF loop
       exists so no frame ever causes a React render. */
    if (curRef.current) curRef.current.textContent = durationOf((startedRef.current || t > 0 ? t : total) * 1000)
    const ring = ringRef.current
    if (ring) {
      ring.setAttribute('aria-valuenow', String(Math.round(t)))
      if (total) {
        ring.setAttribute('aria-valuemax', String(Math.round(total)))
        ring.setAttribute('aria-valuetext', `${durationOf(t * 1000)} of ${durationOf(total * 1000)}`)
      } else {
        ring.setAttribute('aria-valuemax', String(Math.max(1, Math.round(t))))
        ring.setAttribute('aria-valuetext', durationOf(t * 1000))
      }
    }

    const cv = cvRef.current
    if (!cv) return
    const w = cv.clientWidth, h = cv.clientHeight
    if (!w || !h) return
    const dpr = window.devicePixelRatio || 1
    // Both axes — a height-only change (or a monitor-move DPR change) must
    // re-cut the bitmap or the ring CSS-stretches into a blurry ellipse.
    if (cv.width !== Math.floor(w * dpr) || cv.height !== Math.floor(h * dpr)) {
      cv.width = Math.floor(w * dpr); cv.height = Math.floor(h * dpr)
    }
    const x = cv.getContext('2d')
    x.setTransform(dpr, 0, 0, dpr, 0, 0)
    x.clearRect(0, 0, w, h)
    /* Geometry is the MOCK's verbatim from here down: R = half - 44, bars
       6 + v*30, inner arc at R - 24, glow to R + 40 - identical UI was the ask. */
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 44
    const now = performance.now()
    const isLive = playing && !reduceMotion

    // breathing glow behind the ring, scaled by the amplitude at the playhead
    const amp = peaks[Math.floor(fr * (peaks.length - 1))] || 0
    if (isLive) {
      const gl = x.createRadialGradient(cx, cy, R * 0.3, cx, cy, R + 40)
      gl.addColorStop(0, `rgba(${GLOW_RGB},0)`)
      gl.addColorStop(0.8, `rgba(${GLOW_RGB},${0.05 + amp * 0.13})`)
      gl.addColorStop(1, `rgba(${GLOW_RGB},0)`)
      x.fillStyle = gl
      x.fillRect(0, 0, w, h)
    }

    // the bar ring — played bars in accent, the rest in quiet ink; bars near
    // the playhead swell while playing (a gaussian bump + gentle shimmer)
    for (let i = 0; i < BARS; i++) {
      const frac = i / BARS
      const ang = -Math.PI / 2 + frac * 2 * Math.PI
      const v = peaks[Math.floor(frac * (peaks.length - 1))]
      let len = 6 + v * 30
      if (isLive) {
        const di = Math.min(Math.abs(frac - fr), 1 - Math.abs(frac - fr))
        len *= 1 + 0.6 * Math.exp(-di * di * 900) * (0.6 + 0.4 * Math.sin(now / 80 + i))
      }
      const wob = isLive ? Math.sin(now / 300 + i * 0.7) * 1.5 : 0
      x.strokeStyle = frac <= fr && total ? ACCENT : REST
      x.lineWidth = 3
      x.lineCap = 'round'
      x.beginPath()
      x.moveTo(cx + Math.cos(ang) * (R - len / 2 + wob), cy + Math.sin(ang) * (R - len / 2 + wob))
      x.lineTo(cx + Math.cos(ang) * (R + len / 2 + wob), cy + Math.sin(ang) * (R + len / 2 + wob))
      x.stroke()
    }

    // inner track + played arc + knob (the scrub affordance)
    x.strokeStyle = FAINT; x.lineWidth = 1
    x.beginPath(); x.arc(cx, cy, R - 24, 0, 7); x.stroke()
    if (total) {
      x.strokeStyle = ACCENT; x.lineWidth = 3; x.lineCap = 'round'
      x.beginPath(); x.arc(cx, cy, R - 24, -Math.PI / 2, -Math.PI / 2 + fr * 2 * Math.PI); x.stroke()
      const pa = -Math.PI / 2 + fr * 2 * Math.PI
      x.fillStyle = KNOB
      x.beginPath(); x.arc(cx + Math.cos(pa) * (R - 24), cy + Math.sin(pa) * (R - 24), 5, 0, 7); x.fill()
    }

  }, [peaks, playing, reduceMotion, totalOf, dur])

  React.useEffect(() => {
    if (!playing && !draggingRef.current) { cancelAnimationFrame(rafRef.current); draw(); return undefined }
    const tick = () => { draw(); rafRef.current = requestAnimationFrame(tick) }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [playing, draw])
  React.useEffect(() => { draw() }, [dur, failed, resolving, activeSrc, draw])
  React.useEffect(() => () => { cancelAnimationFrame(rafRef.current); clearTimeout(endHoldRef.current) }, [])
  /* At rest nothing redraws on its own — a rotation/window resize would leave
     the old bitmap CSS-stretched into a blurry ellipse until the next state
     change. Observe the canvas box and re-cut. */
  React.useEffect(() => {
    const cv = cvRef.current
    if (!cv || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => draw())
    ro.observe(cv)
    return () => ro.disconnect()
  }, [draw])

  /* ---------- error path (ported from the chat players) ---------- */
  const retriedRef = React.useRef(false)
  const recoverRef = React.useRef(0)
  const unseekableRef = React.useRef(false)
  // Render-facing mirror of unseekableRef (the hint line) — a ref must not be
  // read during render; the ref stays the source of truth for handlers.
  const [noScrub, setNoScrub] = React.useState(false)
  const markUnseekable = () => { unseekableRef.current = true; setNoScrub(true) }
  const loadedRef = React.useRef(false)
  React.useEffect(() => { loadedRef.current = false; unseekableRef.current = false; retriedRef.current = false; recoverRef.current = 0; setNoScrub(false) }, [activeSrc])
  const onMediaError = (e) => {
    const a = e.currentTarget
    if (!retriedRef.current && a.preload !== 'auto') {
      retriedRef.current = true
      const wasPlaying = !a.paused || startedRef.current
      a.preload = 'auto'
      const resume = () => { a.removeEventListener('canplay', resume); if (wasPlaying) a.play().catch(() => {}) }
      a.addEventListener('canplay', resume)
      try { a.load() } catch { /* nothing more to try */ }
      return
    }
    if (a.paused && loadedRef.current) {
      markUnseekable()
      setPlaying(false)
      if (recoverRef.current < 2) { recoverRef.current += 1; try { a.load() } catch { /* noop */ } }
      return
    }
    setFailed(true)
    setPlaying(false)
  }

  const toggle = () => {
    if (failed) {
      setFailed(false)
      retriedRef.current = false
      recoverRef.current = 0
      unseekableRef.current = false
      setNoScrub(false)
      if (activeSrc) { try { audioRef.current?.load() } catch { /* play() reports it */ } }
    }
    if (!activeSrc) {
      if (!resolveSrc || resolving) return
      setResolving(true)
      wantPlayRef.current = true
      resolveSrc()
        .then(u => { if (u) setLazySrc(u); else setFailed(true) })
        .catch(() => setFailed(true))
        .finally(() => setResolving(false))
      return
    }
    const a = audioRef.current
    if (!a) return
    if (a.paused) {
      pauseOtherVoices(a)
      if (unseekableRef.current && (a.ended || a.currentTime > 0)) { try { a.load() } catch { /* noop */ } }
      applyRate(a, rate)
      a.play().catch(() => setFailed(true))
    } else a.pause()
  }

  React.useEffect(() => {
    if (!lazySrc || !wantPlayRef.current) return
    wantPlayRef.current = false
    const a = audioRef.current
    if (!a) return
    pauseOtherVoices(a)
    applyRate(a, rate)
    a.play().catch(() => {})   // strict autoplay policy → the next tap plays
  }, [lazySrc, rate])

  /* ---------- ring scrubbing: angle → time, gated to the ring BAND ----------
     The stage fills the card, but only the annulus the bars occupy is a scrub
     surface — a whole-card touch-action:none target would turn every voice
     post into a mobile scroll trap that also silently seeks. Out-of-band
     touches fall through (CSS pan-y lets them scroll). During a drag the
     angle is PINNED at the 12-o'clock seam: crossing the top must clamp to
     0:00 / the end, never snap the playhead across the whole note. */
  const geomAt = (e) => {
    const r = ringRef.current.getBoundingClientRect()
    const dx = e.clientX - (r.left + r.width / 2)
    const dy = e.clientY - (r.top + r.height / 2)
    let ang = Math.atan2(dy, dx) + Math.PI / 2
    if (ang < 0) ang += 2 * Math.PI
    return { frac: ang / (2 * Math.PI), dist: Math.hypot(dx, dy), R: Math.min(r.width, r.height) / 2 - 44 }
  }
  const dragFrRef = React.useRef(0)
  const canScrub = () => !failed && !unseekableRef.current && !!audioRef.current && !!totalOf(audioRef.current)
  const seekFrac = (f) => {
    const a = audioRef.current
    const total = totalOf(a)
    if (!a || !total) return
    a.currentTime = Math.min(f, 0.999) * total
  }
  const onPointerDown = (e) => {
    if (e.button != null && e.button !== 0) return
    if (!canScrub()) return
    const g = geomAt(e)
    if (g.dist < g.R - 40 || g.dist > g.R + 40) return   // off the band → not a scrub
    e.currentTarget.setPointerCapture?.(e.pointerId)
    clearTimeout(endHoldRef.current)
    draggingRef.current = true
    dragFrRef.current = g.frac
    const a = audioRef.current
    resumeRef.current = !a.paused
    if (!a.paused) a.pause()
    seekFrac(g.frac)
    draw()
  }
  const onPointerMove = (e) => {
    if (!draggingRef.current) return
    let f = geomAt(e).frac
    const prev = dragFrRef.current
    if (Math.abs(f - prev) > 0.5) f = prev > 0.5 ? 1 : 0   // seam crossing → pin at the end/start
    else dragFrRef.current = f
    seekFrac(f)
    draw()
  }
  const endDrag = (e) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    if (resumeRef.current) {
      // A rejected resume fires no pause event — nothing would re-render, so
      // stand the loop down ourselves exactly like the not-resuming arm.
      audioRef.current?.play?.().catch(() => { cancelAnimationFrame(rafRef.current); draw() })
    } else {
      // The loop can be armed mid-drag (a dur resolve re-ran the effect while
      // draggingRef was true); ending at rest re-renders nothing — cancel it.
      cancelAnimationFrame(rafRef.current)
      draw()
    }
  }
  const onKeyDown = (e) => {
    const a = audioRef.current
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); return }
    if (!a || !canScrub()) return
    const total = totalOf(a)
    // Up/Down mirror Right/Left — the WAI-ARIA slider pattern expects all
    // four, and on a circular control the vertical pair is the natural one.
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); a.currentTime = Math.min(total, a.currentTime + 5); draw() }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); a.currentTime = Math.max(0, a.currentTime - 5); draw() }
    else if (e.key === 'Home') { e.preventDefault(); a.currentTime = 0; draw() }
    else if (e.key === 'End') { e.preventDefault(); a.currentTime = total; draw() }
  }

  const cycleSpeed = (e) => {
    e.stopPropagation()
    const i = SPEEDS.indexOf(rate)
    setMediaPref({ voiceRate: SPEEDS[(i + 1) % SPEEDS.length] })
  }

  const total = dur || (typeof duration === 'number' ? duration : 0)
  const hint = failed ? 'TAP TO RETRY'
    : resolving ? 'LOADING…'
    : !activeSrc ? (resolveSrc ? 'TAP TO PLAY' : 'NO AUDIO')
    : noScrub ? 'THIS RECORDING CAN’T SCRUB'
    // Length unknown (header-less recording, pre-measure): scrubbing is a
    // no-op, so don't instruct it — the honest label is just what this is.
    : !total ? 'VOICE POST'
    : 'DRAG THE RING TO SCRUB'

  return (
    <div className={'ovp ' + className}>
      <div className="ovp-stage">
        <div
          className="ovp-ring"
          ref={ringRef}
          role="slider"
          tabIndex={activeSrc && !failed ? 0 : -1}
          aria-label="Seek voice post"
          aria-valuemin={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
        >
          <canvas ref={cvRef} className="ovp-canvas"/>
        </div>
        <button
          type="button"
          className="ovp-play"
          onClick={toggle}
          disabled={resolving || (!activeSrc && !resolveSrc)}
          title={failed ? 'Couldn’t load — tap to retry' : playing ? 'Pause' : 'Play'}
          aria-label={failed ? 'Audio unavailable. Retry' : playing ? 'Pause voice post' : 'Play voice post'}
        >
          <Icon name={failed ? 'mute' : playing ? 'pause' : 'play'} className="lg"/>
        </button>
      </div>
      {/* anchored to the CARD corner, outside the centered square stage */}
      <button type="button" className={'ovp-rate' + (rate !== 1 ? ' on' : '')} onClick={cycleSpeed}
        title="Playback speed" aria-label={`Playback speed ${speedLabel(rate)}. Change`}>
        {speedLabel(rate)}
      </button>
      <div className="ovp-foot">
        <span className="ovp-time" ref={curRef}>{durationOf(total * 1000)}</span>
        <span className="ovp-hint">{hint}</span>
        <span className="ovp-time is-total">{durationOf(total * 1000)}</span>
      </div>
      {activeSrc && (
        <audio ref={audioRef} src={activeSrc} preload="metadata" style={{ display: 'none' }}
          data-ika-voice="" data-heard="1"
          onLoadedMetadata={(e) => {
            const a = e.currentTarget
            loadedRef.current = true
            applyRate(a, rate)
            if (Number.isFinite(a.duration) && a.duration > 0) setDur(a.duration)
          }}
          onCanPlay={() => { loadedRef.current = true }}
          onDurationChange={(e) => { const d = e.currentTarget.duration; if (Number.isFinite(d) && d > 0) setDur(d) }}
          onPlay={() => { clearTimeout(endHoldRef.current); ensureMeasured(); startedRef.current = true; setPlaying(true) }}
          onPause={() => setPlaying(false)}
          /* currentTime moves the component didn't initiate (the recover
             load(), the preload=auto retry) must repaint the at-rest ring. */
          onTimeUpdate={() => { if (!playing && !draggingRef.current) draw() }}
          onError={onMediaError}
          onEnded={(e) => {
            setPlaying(false)
            const a = e.currentTarget
            draw()   // the 100% frame renders before the rewind
            clearTimeout(endHoldRef.current)
            endHoldRef.current = setTimeout(() => {
              if (!unseekableRef.current) { try { a.currentTime = 0 } catch { markUnseekable() } }
              startedRef.current = false
              draw()
            }, 350)
          }}/>
      )}
    </div>
  )
}

export default OrbitVoice
