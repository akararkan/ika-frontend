/* =========================================================
   VoicePlayer — the feed's waveform voice-note player (.vnp).
   Used by voice posts and Q&A voice answers / reanswers.

   Architecture is borrowed from the chat player (VoiceNote.jsx),
   because it is the proven one:
   · PROGRESS IS NOT REACT STATE. A rAF loop writes ONE custom
     property (--p) on the wave and one textContent on the clock;
     the played colouring is a second, pre-coloured bar layer
     clipped to --p. 46 bars animate at display refresh rate
     without a single re-render.
   · Speed is the SAME shared preference as chat voice notes
     (mediaPrefs.voiceRate) — 1.5× set on a feed post carries to
     the next chat note and back, with pitch preserved.
   · The ended line FINISHES: paint 100%, hold a beat, then rest.
   · Scrubbing is a pointer drag with capture (not just click),
     mirrored under RTL.
   ========================================================= */
import React from 'react'
import { Icon } from './ui.jsx'
import {
  SPEEDS, speedLabel, getMediaPrefs, setMediaPref, subscribeMediaPrefs,
  pauseOtherVoices, measureDuration,
} from './chat/mediaPrefs.js'

const N = 46   // waveform bars

/* Deterministic waveform envelope seeded by the src, so each note
   looks distinct but stable across re-renders (no real DSP needed). */
function waveform(seed = '') {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  const out = []
  for (let i = 0; i < N; i++) {
    const env = Math.sin((i / N) * Math.PI * 3) * 0.5 + 0.5
    const r = Math.abs((Math.sin((i + 1) * (12.9898 + (h % 9))) * 43758.5453) % 1)
    out.push(0.24 + env * 0.55 + r * 0.22)
  }
  return out
}

function fmt(s) {
  if (!isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60), sec = Math.floor(s % 60)
  return m + ':' + String(sec).padStart(2, '0')
}

/* Rate application keeps pitch on every engine (Safari needs the prefix). */
function applyRate(a, rate) {
  a.playbackRate = rate
  a.preservesPitch = true
  a.webkitPreservesPitch = true
}

export function VoicePlayer({ src, duration, className = '', resolveSrc = null }) {
  const audioRef = React.useRef(null)
  const waveRef = React.useRef(null)
  const clockRef = React.useRef(null)
  const rafRef = React.useRef(0)
  const endHoldRef = React.useRef(0)
  const draggingRef = React.useRef(false)
  const resumeRef = React.useRef(false)
  const wantPlayRef = React.useRef(false)
  const startedRef = React.useRef(false)   // has this note ever been played?

  const [playing, setPlaying] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const [dur, setDur] = React.useState(typeof duration === 'number' ? duration : 0)
  /* The feed's VOICE_POST items arrive without an audio URL (the detail
     response carries it) — `resolveSrc` fetches it on the first tap, so a
     feed voice note plays in place instead of shipping a dead button. */
  const [lazySrc, setLazySrc] = React.useState(null)
  const [resolving, setResolving] = React.useState(false)
  const activeSrc = src || lazySrc
  const bars = React.useMemo(() => waveform(src || lazySrc || ''), [src, lazySrc])

  const rate = React.useSyncExternalStore(
    subscribeMediaPrefs,
    () => getMediaPrefs().voiceRate,
    () => 1,
  )

  /* Same ladder as the chat player, and for the same reasons: the element's
     duration when finite, else a GUARDED seekable end (Chromium answers
     `Infinity` for a header-less file), else the known/measured length.
     No currentTime rung — that computes a ratio of 1 on the first frame and
     pins the line full while the sound plays on. 0 means unknown. */
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

  /* When nothing can state the length (Firefox's own WebM recordings), decode
     the bytes for it on the first play. Lazy, cached per URL, silent on
     failure. */
  const measuredRef = React.useRef(false)
  // Written from an effect, read only from async callbacks — never in render.
  const srcRef = React.useRef(activeSrc)
  React.useEffect(() => { srcRef.current = activeSrc }, [activeSrc])
  // Reset when the source changes — including the lazy feed resolve, where
  // the first latch would otherwise happen before any URL existed.
  React.useEffect(() => { measuredRef.current = false }, [activeSrc])
  const ensureMeasured = React.useCallback(() => {
    if (measuredRef.current || !activeSrc || totalOf(audioRef.current)) return
    measuredRef.current = true
    const url = activeSrc
    measureDuration(url).then(d => {
      if (srcRef.current !== url) return   // source swapped mid-flight
      if (d) setDur(d)
      else measuredRef.current = false     // a network blip stays retryable
    })
  }, [activeSrc, totalOf])

  /* ----- the render loop: one CSS var + one text node, no re-render ----- */
  const paint = React.useCallback(() => {
    const a = audioRef.current
    const wave = waveRef.current
    if (!a || !wave) return
    const total = totalOf(a)
    const p = a.ended ? 1 : total ? Math.min(1, a.currentTime / total) : 0
    wave.style.setProperty('--p', String(p))
    // From the LIVE total, not React state — CSS stands the playhead down
    // rather than parking it at zero while the sound runs.
    wave.dataset.nolength = total ? '' : '1'
    wave.setAttribute('aria-valuenow', String(Math.round(a.currentTime)))
    if (total) {
      wave.setAttribute('aria-valuemax', String(Math.round(total)))
      wave.setAttribute('aria-valuetext', `${fmt(a.currentTime)} of ${fmt(total)}`)
    } else {
      // valuenow may never exceed valuemax — that is an invalid ARIA state.
      wave.setAttribute('aria-valuemax', String(Math.max(1, Math.round(a.currentTime))))
      wave.setAttribute('aria-valuetext', fmt(a.currentTime))
    }
    if (clockRef.current) {
      // The total is the at-rest label only; once there is a position the
      // clock is elapsed, so scrubbing to zero cannot read as "full length".
      const atRest = total && a.paused && a.currentTime === 0 && !startedRef.current
      clockRef.current.textContent = fmt(atRest ? total : a.currentTime)
    }
  }, [totalOf])

  React.useEffect(() => {
    if (!playing) { cancelAnimationFrame(rafRef.current); paint(); return undefined }
    const tick = () => { paint(); rafRef.current = requestAnimationFrame(tick) }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [playing, paint])

  React.useEffect(() => () => {
    cancelAnimationFrame(rafRef.current)
    clearTimeout(endHoldRef.current)
  }, [])

  React.useEffect(() => { paint() }, [dur, paint])

  /* paint() owns the slider's values, but it bails before the <audio> exists
     (it is rendered only once a src is known — the feed's lazy case). Seed
     them here so a screen reader never meets a slider with no value. */
  React.useEffect(() => {
    const w = waveRef.current
    if (!w || audioRef.current) return
    w.setAttribute('aria-valuenow', '0')
    w.setAttribute('aria-valuemax', String(Math.round(dur) || 1))
    w.setAttribute('aria-valuetext', fmt(dur))
  }, [dur, activeSrc])

  React.useEffect(() => {
    const a = audioRef.current
    if (a) applyRate(a, rate)
  }, [rate])

  const toggle = () => {
    if (failed) {
      /* A failed load is RETRYABLE — a blip, an expired proxy URL, a server
         mid-deploy. Reset the error ladder and run the normal flow again
         (including the lazy feed resolve); a genuine failure lands straight
         back here, so this cannot loop on its own. */
      setFailed(false)
      retriedRef.current = false
      recoverRef.current = 0
      unseekableRef.current = false
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
      pauseOtherVoices(a)          // one voice at a time, app-wide (chat included)
      // play() on an ended element rewinds by spec — a seek this file cannot
      // do. Reload returns it to the start cleanly.
      if (unseekableRef.current && (a.ended || a.currentTime > 0)) {
        try { a.load() } catch { /* noop */ }
      }
      applyRate(a, rate)
      a.play().catch(() => setFailed(true))
    } else a.pause()
  }

  /* Play as soon as the lazily resolved audio mounts. The fetch broke the
     click's gesture chain, so a strict autoplay policy may refuse — that is
     a silent no-op (the next tap plays normally), never a failure. */
  React.useEffect(() => {
    if (!lazySrc || !wantPlayRef.current) return
    wantPlayRef.current = false
    const a = audioRef.current
    if (!a) return
    pauseOtherVoices(a)
    applyRate(a, rate)
    // This path skips toggle(), and it is the ONE feed case where the length
    // is genuinely unknown — measure it here or the fill never moves.
    a.play().catch(() => {})
  }, [lazySrc, rate])

  const cycleSpeed = () => {
    const i = SPEEDS.indexOf(rate)
    setMediaPref({ voiceRate: SPEEDS[(i + 1) % SPEEDS.length] })
  }

  /* ----- scrubbing: drag with pointer capture, RTL-mirrored ----- */
  const ratioAt = (clientX, el) => {
    const rect = el.getBoundingClientRect()
    if (!rect.width) return 0
    let r = (clientX - rect.left) / rect.width
    if (getComputedStyle(el).direction === 'rtl') r = 1 - r
    return Math.max(0, Math.min(1, r))
  }
  const seekTo = (ratio) => {
    const a = audioRef.current
    const total = totalOf(a)
    if (!a || !total || unseekableRef.current) return
    a.currentTime = ratio * total
    paint()
  }
  const onPointerDown = (e) => {
    if (e.button != null && e.button !== 0) return
    const a = audioRef.current
    if (!a || failed || !totalOf(a)) return
    clearTimeout(endHoldRef.current)
    e.currentTarget.setPointerCapture?.(e.pointerId)
    draggingRef.current = true
    resumeRef.current = !a.paused
    if (!a.paused) a.pause()
    seekTo(ratioAt(e.clientX, e.currentTarget))
  }
  const onPointerMove = (e) => {
    if (!draggingRef.current) return
    seekTo(ratioAt(e.clientX, e.currentTarget))
  }
  const endDrag = (e) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    if (resumeRef.current) audioRef.current?.play?.().catch(() => {})
  }
  const onKeyDown = (e) => {
    const a = audioRef.current
    if (!a || unseekableRef.current) return
    const total = totalOf(a)
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      a.currentTime = total ? Math.min(total, a.currentTime + 5) : a.currentTime + 5
      paint()
    }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); a.currentTime = Math.max(0, a.currentTime - 5); paint() }
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle() }
  }

  const retriedRef = React.useRef(false)
  /* Chrome demuxes a header-less WebM (a Firefox recording) LINEARLY but dies
     on any seek, even fully buffered — so a file can be perfectly playable and
     still unseekable. Once proven, every seek is skipped rather than retried
     into a dead pipeline. */
  const unseekableRef = React.useRef(false)
  /* Has this pipeline EVER produced a readable source? The discriminator the
     error handler runs on: an error on a source that never loaded is a dead
     note and must SAY so — treating it as the benign post-playback seek error
     leaves a healthy-looking player that silently produces no sound. */
  const loadedRef = React.useRef(false)
  React.useEffect(() => { loadedRef.current = false }, [activeSrc])
  const recoverRef = React.useRef(0)
  const onMediaError = (e) => {
    const a = e.currentTarget
    /* First failure: Chrome gives up when only part of a header-less file is
       buffered. The same bytes play once the whole file is there. */
    if (!retriedRef.current && a.preload !== 'auto') {
      retriedRef.current = true
      const wasPlaying = !a.paused || startedRef.current
      a.preload = 'auto'
      const resume = () => {
        a.removeEventListener('canplay', resume)
        if (wasPlaying) a.play().catch(() => {})
      }
      a.addEventListener('canplay', resume)
      try { a.load() } catch { /* nothing more to try */ }
      return
    }
    /* An error while nothing is playing ON A SOURCE THAT ONCE LOADED is our
       OWN seek on such a file — the rewind that closes a finished note. It is
       not dead: it just played to the end. A source that NEVER loaded falls
       through — that error is the load itself failing, whatever the paused
       flag says. */
    if (a.paused && loadedRef.current) {
      unseekableRef.current = true
      setPlaying(false)
      if (recoverRef.current < 2) { recoverRef.current += 1; try { a.load() } catch { /* noop */ } }
      return
    }
    setFailed(true)
    setPlaying(false)
  }

  const total = dur || (typeof duration === 'number' ? duration : 0)
  const totalLabel = total ? fmt(total) : (typeof duration === 'string' ? duration : '0:00')

  return (
    <div className={'vnp ' + (playing ? 'playing ' : '') + (failed ? 'failed ' : '') + className}>
      <div className="vnp-top">
        <button className={'vnp-play' + (playing ? ' playing' : '')} onClick={toggle}
          disabled={resolving || (!activeSrc && !resolveSrc)}
          title={failed ? 'Couldn’t load — tap to retry' : playing ? 'Pause' : 'Play'}
          aria-label={failed ? 'Audio unavailable. Retry' : playing ? 'Pause voice note' : 'Play voice note'}>
          <Icon name={failed ? 'mute' : playing ? 'pause' : 'play'}/>
        </button>
        <div
          className="vnp-wave"
          ref={waveRef}
          style={{ '--p': 0 }}
          role="slider"
          tabIndex={activeSrc && !failed ? 0 : -1}
          aria-label="Seek voice note"
          aria-valuemin={0}
          /* Owned by paint() — see the chat player: rendering them here as
             well lets a re-render reset the live slider. */
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
        >
          {/* Two identical layers: the top one is pre-coloured "played" and
              clipped to --p — the fill moves at display refresh rate with
              zero React renders. */}
          <div className="vnp-wave-layer" aria-hidden="true">
            {bars.map((h, i) => <i key={i} style={{ height: (h * 100) + '%' }}/>)}
          </div>
          <div className="vnp-wave-layer played" aria-hidden="true">
            {bars.map((h, i) => <i key={i} style={{ height: (h * 100) + '%' }}/>)}
          </div>
          <span className="vnp-head" aria-hidden="true"/>
        </div>
      </div>
      <div className="vnp-bot">
        <span className="vnp-tag"><Icon name="mic"/>Voice note</span>
        <button type="button" className={'vnp-rate' + (rate !== 1 ? ' on' : '')} onClick={cycleSpeed}
          title="Playback speed" aria-label={`Playback speed ${speedLabel(rate)}. Change`}>
          {speedLabel(rate)}
        </button>
        <span className="vnp-time" ref={clockRef}>{totalLabel}</span>
      </div>
      {activeSrc && (
        <audio ref={audioRef} src={activeSrc} preload="metadata" style={{ display: 'none' }}
          data-ika-voice="" data-heard="1"   /* joins app-wide one-at-a-time; never auto-chained */
          onLoadedMetadata={(e) => {
            const a = e.currentTarget
            loadedRef.current = true
            applyRate(a, rate)
            if (Number.isFinite(a.duration) && a.duration > 0) setDur(a.duration)
          }}
          onCanPlay={() => { loadedRef.current = true }}
          onDurationChange={(e) => {
            const d = e.currentTarget.duration
            if (Number.isFinite(d) && d > 0) setDur(d)
          }}
          onPlay={() => {
            clearTimeout(endHoldRef.current)
            // Every entry point lands here, including the lazy feed resolve.
            ensureMeasured()
            startedRef.current = true
            setPlaying(true)
          }}
          onPause={() => setPlaying(false)}
          onTimeUpdate={() => { if (!playing) paint() }}
          onError={onMediaError}
          onEnded={(e) => {
            setPlaying(false)
            const a = e.currentTarget
            /* Let the line finish: hold the 100% frame for a beat before
               resting — same convention as the chat player. */
            paint()
            clearTimeout(endHoldRef.current)
            endHoldRef.current = setTimeout(() => {
              if (!unseekableRef.current) {
                try { a.currentTime = 0 } catch { unseekableRef.current = true }
              }
              startedRef.current = false   // back at rest: show the length again
              paint()
            }, 350)
          }}/>
      )}
    </div>
  )
}
