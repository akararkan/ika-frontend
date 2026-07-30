/* =========================================================
   VoiceNote — the voice-message player.
   ---------------------------------------------------------
   Lives in its own file because it is no longer "an <audio> with
   a bar": it is a scrubber, a speed control, a heard-marker and
   the continuous-playback handoff, and all four have traps.

   The four decisions worth knowing before editing:

   1. PROGRESS IS NOT REACT STATE. `timeupdate` fires ~4×/second,
      which is a visibly stuttering playhead, and driving it from
      state re-renders a leaf inside a memo-ed list 60×/second.
      Instead a rAF loop writes ONE custom property (`--p`) on the
      wrapper and one textContent on the clock. The bars never
      re-render; CSS clips a second, pre-coloured copy of the
      waveform to `--p`. React state holds only what actually
      changes shape: playing / duration / buffering / error.

   2. SPEED IS GLOBAL AND PERSISTED. See mediaPrefs.js — a rate
      that resets on the next bubble is worse than no rate control
      at all. It is re-applied after every `loadedmetadata`
      because Safari resets `playbackRate` when a source loads.

   3. MediaRecorder BLOBS REPORT `Infinity` DURATION. Chromium
      writes WebM without a duration header, so a voice note this
      very app recorded has `duration === Infinity` until it has
      been played through. The seek-to-the-end hack in
      `onLoadedMetadata` is what makes the scrubber work at all on
      your own notes — without it the bar is dead and the clock
      shows the placeholder forever.

   4. THE WAVEFORM IS DETERMINISTIC. When the server sends no
      peaks we synthesise them from the message id, so the same
      note draws the same shape on every device. A random shape
      per render would shimmer on every re-render.
   ========================================================= */
import React from 'react'
import { Icon, showToast } from '../ui.jsx'
import {
  SPEEDS, speedLabel, durationOf, getMediaPrefs, setMediaPref, subscribeMediaPrefs,
  isVoicePlayed, markVoicePlayed, pauseOtherVoices, playNextVoice, measureDuration,
} from './mediaPrefs.js'

/** Bars in the waveform. 40 reads as an amplitude trace at bubble width and
 *  still keeps each bar ≥2px on the narrowest phone. */
const WAVE_BARS = 40

/** Rate is applied from three places (the pref effect, play, loadedmetadata —
 *  Safari resets it when a source loads). Pitch must survive all of them:
 *  Chrome defaults preservesPitch on, Safari needs the webkit- prefix, and a
 *  sped-up voice that chipmunks is worse than no speed control at all. */
function applyRate(a, rate) {
  a.playbackRate = rate
  a.preservesPitch = true
  a.webkitPreservesPitch = true
}

/* The backend ships `waveform` as base64 peaks. When it is missing or
   unparseable we synthesise a stable pseudo-random set from the message id, so
   the bubble never renders an empty box and every client shows the SAME shape.
   The result is normalised: a quiet recording whose real peaks all sit under
   0.2 would otherwise draw as a flat line. */
function peaksOf(waveform, seed) {
  const out = []
  if (typeof waveform === 'string' && waveform.length > 8) {
    try {
      const bin = atob(waveform)
      const step = Math.max(1, Math.floor(bin.length / WAVE_BARS))
      for (let i = 0; i < WAVE_BARS; i++) {
        out.push(Math.min(1, (bin.charCodeAt(i * step) || 0) / 255))
      }
      const peak = Math.max(...out)
      if (peak > 0.05) return out.map(v => Math.min(1, v / peak))
    } catch { /* fall through to the synthetic shape */ }
  }
  // Deterministic pseudo-random from the id — same bars on every device.
  // The id is a Snowflake STRING; Number() on it is lossy but that is fine
  // here (we want a stable seed, not the id back) — and the low digits, which
  // is what a lossy double keeps, are the ones that vary between messages.
  let s = Math.abs(Number(String(seed).slice(-9)) || 1) % 2147483647
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 }
  for (let i = 0; i < WAVE_BARS; i++) {
    // Two octaves: a slow envelope so the shape has phrases, plus per-bar
    // grain. A flat rand() looks like static, not like speech.
    const env = 0.45 + 0.55 * Math.abs(Math.sin((i / WAVE_BARS) * Math.PI * 2.7 + s % 3))
    out.push(Math.min(1, 0.18 + rnd() * 0.5 * env + env * 0.35))
  }
  return out
}

export function VoiceNote({ media, messageId, mine, senderName }) {
  const audioRef = React.useRef(null)
  const wrapRef = React.useRef(null)
  const clockRef = React.useRef(null)
  const waveRef = React.useRef(null)
  const rafRef = React.useRef(0)
  const endHoldRef = React.useRef(0)         // the finished-line beat before rewind
  const draggingRef = React.useRef(false)
  const resumeRef = React.useRef(false)      // was it playing when the drag started?

  const startedRef = React.useRef(false)   // has this note ever been played?
  const [playing, setPlaying] = React.useState(false)
  const [buffering, setBuffering] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const [dur, setDur] = React.useState(media.durationMs ? media.durationMs / 1000 : 0)
  const [heard, setHeard] = React.useState(() => isVoicePlayed(messageId))

  const rate = React.useSyncExternalStore(
    subscribeMediaPrefs,
    () => getMediaPrefs().voiceRate,
    () => 1,
  )

  const peaks = React.useMemo(() => peaksOf(media.waveform, messageId), [media.waveform, messageId])

  /* The length to scrub against, in order of trustworthiness:
       1. the element's own duration, when it is finite and positive;
       2. what the buffer says it can seek to — guarded, because Chromium
          reports `Infinity` here for a header-less file, and an infinite
          total makes every ratio 0 (a line that never moves) and prints
          the clock as "Infinity:NaN:NaN";
       3. the length that came with the message, or one measured by decode.
     There is deliberately NO "fall back to currentTime" rung: with nothing
     else known that computes currentTime/currentTime = 1, which pins the
     played line at 100% on its first frame while the sound plays on — the
     exact Firefox symptom this ladder exists to prevent.
     0 means UNKNOWN, and the player renders no fill rather than a lie. */
  const totalOf = React.useCallback((a) => {
    if (!a) return dur || 0
    const d = a.duration
    if (Number.isFinite(d) && d > 0) return d
    if (a.seekable?.length) {
      try {
        const end = a.seekable.end(a.seekable.length - 1)
        if (Number.isFinite(end) && end > 0) return end
      } catch { /* an empty/!detached range throws — fall through */ }
    }
    return dur || 0
  }, [dur])

  /* Firefox's own recordings state no length at all (Infinity duration, empty
     seekable, and a durationchange that arrives only after the last sample),
     so when the first play finds nothing knowable, decode the bytes for the
     real figure. Lazy, cached per URL, and silent when it fails. */
  const measuredRef = React.useRef(false)
  // Written from an effect, read only from async callbacks — never in render.
  const urlRef = React.useRef(media.url)
  React.useEffect(() => { urlRef.current = media.url }, [media.url])
  // A recycled bubble (the list re-keys as messages stream in) must be allowed
  // to measure its NEW audio; without this the latch from the previous note
  // suppresses it forever.
  React.useEffect(() => { measuredRef.current = false }, [media.url])
  const ensureMeasured = React.useCallback(() => {
    const a = audioRef.current
    if (measuredRef.current || !media.url || totalOf(a)) return
    measuredRef.current = true
    const url = media.url
    measureDuration(url).then(d => {
      // The source may have been swapped under a recycled bubble while this
      // was in flight — a stale length would be worse than none.
      if (urlRef.current !== url) return   // source swapped under a recycled bubble
      if (d) setDur(d)
      else measuredRef.current = false     // a network blip stays retryable
    })
  }, [media.url, totalOf])

  /* The at-rest clock has to be right BEFORE anyone presses play, and a
     header-less recording can only answer by being decoded. That is done when
     the bubble is actually on screen — never for a whole thread at once — and
     the bytes are normally already in the HTTP cache, because the element's
     own metadata scan had to read the file to learn anything at all. */
  const visibleRef = React.useRef(false)
  React.useEffect(() => {
    const el = wrapRef.current
    if (!el || dur > 0 || !media.url) return undefined
    const io = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) return
      io.disconnect()
      visibleRef.current = true
      /* Only measure once the element has had its say. The observer fires
         BEFORE `loadedmetadata`, so acting on visibility alone decodes files
         that carry a perfectly good duration header — the per-bubble download
         at thread open that this architecture exists to avoid. */
      const a = audioRef.current
      if (a && a.readyState >= 1) ensureMeasured()
    }, { rootMargin: '200px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [dur, media.url, ensureMeasured])

  /* ----- the render loop: one CSS var + one text node, no re-render ----- */
  const paint = React.useCallback(() => {
    const a = audioRef.current
    const wrap = wrapRef.current
    if (!a || !wrap) return
    const total = totalOf(a)
    /* `ended` pins the line to the END, whatever the clocks say: `total` can
       sit a hair above the last decodable sample (header rounding, Firefox's
       late duration), and currentTime/total then tops out at ~97% — a played
       line that never finishes. The element knows when it is done; trust it. */
    const p = a.ended ? 1 : total ? Math.min(1, a.currentTime / total) : 0
    wrap.style.setProperty('--p', String(p))
    /* Driven from the LIVE total, not from React state: `dur` knows nothing
       about the seekable rung, so a state-derived class disagrees with the
       fill it is meant to describe. */
    wrap.dataset.nolength = total ? '' : '1'
    if (clockRef.current) {
      // Elapsed while it has a position, total while it is untouched — the
      // same convention every messenger uses, and the reason the clock is
      // written imperatively rather than derived in render.
      /* The total is the AT-REST label only — parked at the start, untouched.
         Once there is a position (or the thing is playing) the clock is the
         elapsed time, so scrubbing to zero or pressing Home cannot make it
         claim the full length as elapsed. */
      const atRest = total && a.paused && a.currentTime === 0 && !startedRef.current
      clockRef.current.textContent = durationOf((atRest ? total : a.currentTime) * 1000)
    }
    /* The slider's value is written here too, for the same reason: a
       `role="slider"` whose aria-valuenow never moves reports a dead control
       to a screen reader, and re-rendering it 60×/second is what this whole
       loop exists to avoid. */
    if (waveRef.current) {
      const w = waveRef.current
      w.setAttribute('aria-valuenow', String(Math.round(a.currentTime)))
      /* valuemax is written here too. Rendered from state it stays 0 while the
         length is unknown, and a slider whose valuenow climbs past its max is
         an invalid ARIA state that screen readers announce as nonsense. */
      if (total) {
        w.setAttribute('aria-valuemax', String(Math.round(total)))
        w.setAttribute('aria-valuetext',
          `${durationOf(a.currentTime * 1000)} of ${durationOf(total * 1000)}`)
      } else {
        w.setAttribute('aria-valuemax', String(Math.max(1, Math.round(a.currentTime))))
        w.setAttribute('aria-valuetext', durationOf(a.currentTime * 1000))
      }
    }
  }, [totalOf])

  /* The tick function is created INSIDE the effect and re-arms through the
     ref, not through its own identity: a `useCallback` that schedules itself
     is a closure that cannot see its own latest version, and the linter is
     right to reject it. */
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

  // Repaint when the duration finally resolves (metadata, or the Infinity fix).
  React.useEffect(() => { paint() }, [dur, paint])

  /* Speed is a shared preference, so it can change while this note is playing
     — from another bubble, or another tab's storage event. Apply it on every
     change, not only on mount. */
  React.useEffect(() => {
    const a = audioRef.current
    if (a) applyRate(a, rate)
  }, [rate])

  const cycleSpeed = (e) => {
    e.stopPropagation()
    const i = SPEEDS.indexOf(rate)
    setMediaPref({ voiceRate: SPEEDS[(i + 1) % SPEEDS.length] })
  }

  const toggle = (e) => {
    e?.stopPropagation?.()
    const a = audioRef.current
    if (!a) return
    if (failed) {
      /* A failed load is RETRYABLE — a network blip, an expired proxy URL a
         fresh request re-signs, a server mid-deploy. The tap resets the whole
         error ladder and tries again from the top; a genuine failure lands
         straight back here, so this can never loop on its own. */
      setFailed(false)
      retriedRef.current = false
      recoverRef.current = 0
      unseekableRef.current = false
      try { a.load() } catch { /* the play() below reports it */ }
    }
    if (a.paused) {
      // Two voice notes talking over each other is never what anyone wanted.
      pauseOtherVoices(a)
      /* play() on an ended element rewinds by spec — a SEEK, which is exactly
         what this file cannot do. Reloading returns it to the start cleanly. */
      if (unseekableRef.current && (a.ended || a.currentTime > 0)) {
        try { a.load() } catch { /* noop */ }
      }
      applyRate(a, rate)
      a.play().catch(() => { setFailed(true); showToast('Could not play this voice note') })
    } else a.pause()
  }

  /* ----- scrubbing -----
     Pointer events (not click) so a drag scrubs continuously, with pointer
     capture so the gesture survives leaving the bar — releasing outside the
     bubble must not strand the scrubber mid-drag. */
  const ratioAt = (clientX, el) => {
    const rect = el.getBoundingClientRect()
    if (!rect.width) return 0
    let r = (clientX - rect.left) / rect.width
    // The bubble can be laid out RTL (Arabic/Kurdish threads): the start edge
    // is then on the right, so the ratio has to be mirrored.
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
    if (!a || failed) return
    e.stopPropagation()
    /* A pending end-hold rewind would fire mid-drag, throwing the note back to
       0:00 and chain-starting the next one under the finger. */
    clearTimeout(endHoldRef.current)
    e.currentTarget.setPointerCapture?.(e.pointerId)
    draggingRef.current = true
    resumeRef.current = !a.paused
    if (!a.paused) a.pause()
    seekTo(ratioAt(e.clientX, e.currentTarget))
  }

  const onPointerMove = (e) => {
    if (!draggingRef.current) return
    e.stopPropagation()
    seekTo(ratioAt(e.clientX, e.currentTarget))
  }

  const endDrag = (e) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    if (resumeRef.current) {
      const a = audioRef.current
      a?.play?.().catch(() => {})
    }
  }

  const onKeyDown = (e) => {
    const a = audioRef.current
    if (!a || unseekableRef.current) return
    const total = totalOf(a)
    // `total` of 0 means UNKNOWN, not "zero long" — clamping to it turned a
    // 3-second nudge into a rewind to the start.
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      a.currentTime = total ? Math.min(total, a.currentTime + 3) : a.currentTime + 3
      paint()
    }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); a.currentTime = Math.max(0, a.currentTime - 3); paint() }
    else if (e.key === 'Home') { e.preventDefault(); a.currentTime = 0; paint() }
    else if (e.key === 'End' && total) { e.preventDefault(); a.currentTime = total; paint() }
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(e) }
  }

  const retriedRef = React.useRef(false)
  /* Chrome demuxes a header-less WebM (a Firefox recording) LINEARLY but dies
     on any seek, even fully buffered — so a file can be perfectly playable and
     still unseekable. Once proven, every seek is skipped rather than retried
     into a dead pipeline. */
  const unseekableRef = React.useRef(false)
  /* Has this pipeline EVER produced a readable source (metadata or better)?
     This is the discriminator the error handler runs on: an error on a source
     that never loaded is a dead note (404, expired URL, undecodable codec) and
     must SAY so — treating it as the benign post-playback seek error leaves a
     healthy-looking player that silently produces no sound, which is the exact
     "voice doesn't work and nothing says why" failure this flag closes. */
  const loadedRef = React.useRef(false)
  React.useEffect(() => { loadedRef.current = false }, [media.url])
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
       OWN seek on such a file — the rewind that closes a finished note. The
       note is not dead: it just played to the end. Remember it cannot seek,
       reload a clean pipeline, and leave the UI alone instead of stamping it
       "could not be loaded". A source that NEVER loaded falls through: that
       error is the load itself failing, whatever the paused flag says. */
    if (a.paused && loadedRef.current) {
      unseekableRef.current = true
      setPlaying(false)
      if (recoverRef.current < 2) { recoverRef.current += 1; try { a.load() } catch { /* noop */ } }
      return
    }
    setFailed(true)
    setPlaying(false)
  }

  const total = dur || (media.durationMs || 0) / 1000
  const unplayed = !mine && !heard && !!media.url

  return (
    <div
      className={'ch-voice' + (playing ? ' playing' : '') + (failed ? ' failed' : '')}
      ref={wrapRef}
      style={{ '--p': 0 }}
    >
      <audio
        ref={audioRef}
        data-ika-voice=""
        /* Mirrored onto the element so the continuous-playback handoff can
           see it without a store: it walks the DOM, not the React tree. */
        data-heard={heard ? '1' : '0'}
        src={media.url || undefined}
        preload="metadata"
        onPlay={() => {
          /* A replay during the finished-line beat must cancel the pending
             rewind — firing it mid-play would yank the note back to 0:00 and
             chain-start the next one. (play() on an ended element rewinds by
             itself, per spec.) */
          clearTimeout(endHoldRef.current)
          // Every entry point lands here — the button, the chain-start from the
          // previous note, and any programmatic play.
          ensureMeasured()
          startedRef.current = true
          setPlaying(true)
          if (!heard) { markVoicePlayed(messageId); setHeard(true) }
        }}
        onPause={() => setPlaying(false)}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => { setBuffering(false); loadedRef.current = true }}
        onCanPlay={() => { setBuffering(false); loadedRef.current = true }}
        onError={onMediaError}
        onEnded={(e) => {
          setPlaying(false)
          const a = e.currentTarget
          /* Let the line FINISH. Rewinding on the same tick as `ended` means
             the 100%-full frame never renders — the scrub dies at ~97% and
             snaps to zero, which reads as "it never completed". So: paint the
             finished frame, then rewind a beat later.
             The handoff to the next note stays INSIDE this handler, not in the
             timer: it inherits the gesture of the play the user started, and
             WebKit's autoplay policy is per-element and does not survive a
             setTimeout boundary. */
          paint()
          playNextVoice(a)
          clearTimeout(endHoldRef.current)
          endHoldRef.current = setTimeout(() => {
            if (!unseekableRef.current) {
              try { a.currentTime = 0 } catch { unseekableRef.current = true }
            }
            startedRef.current = false   // back at rest: the clock shows the length
            paint()
          }, 350)
        }}
        onLoadedMetadata={(e) => {
          const a = e.currentTarget
          loadedRef.current = true
          applyRate(a, rate)
          /* A header-less recording reports Infinity here. It is NOT chased at
             mount any more: the old seek-to-1e101 trick forced the demuxer to
             walk the whole file to EOF — a full download per bubble, at thread
             open, for a number `measureDuration` now fetches once, lazily, on
             the first play that actually needs it. */
          if (Number.isFinite(a.duration) && a.duration > 0) setDur(a.duration)
          else if (visibleRef.current) ensureMeasured()
        }}
        onTimeUpdate={() => { if (!playing) paint() }}
        /* Firefox resolves a header-less WebM's duration LATE — sometimes
           only once decode has walked the file — and revises it through this
           event rather than loadedmetadata. Without tracking it the played
           line runs against a stale total and finishes early or short. */
        onDurationChange={(e) => {
          const d = e.currentTarget.duration
          if (Number.isFinite(d) && d > 0) setDur(d)
        }}
      />

      <button
        type="button"
        className="ch-voice-play"
        onClick={toggle}
        title={failed ? 'Couldn’t load — tap to retry' : undefined}
        aria-label={failed
          ? 'This voice message could not be loaded. Retry'
          : playing ? 'Pause voice message' : `Play voice message${senderName ? ` from ${senderName}` : ''}`}
      >
        {buffering && playing
          ? <span className="ch-voice-spin" aria-hidden="true"/>
          : <Icon name={failed ? 'mute' : playing ? 'pause' : 'play'}/>}
      </button>

      <div className="ch-voice-body">
        <div
          className="ch-wave"
          ref={waveRef}
          role="slider"
          tabIndex={failed ? -1 : 0}
          aria-label="Seek voice message"
          aria-valuemin={0}
          /* valuemax / valuenow / valuetext are written by paint() and by
             nothing else: rendering them here too means a re-render resets a
             live slider to zero mid-playback. */
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
        >
          {/* Two identical bar layers. The top one is pre-coloured "played"
              and clipped to `--p`, which is why the playhead moves at display
              refresh rate without a single React render. */}
          <div className="ch-wave-layer" aria-hidden="true">
            {peaks.map((p, i) => (
              <span key={i} className="ch-wave-bar" style={{ height: `${Math.max(14, Math.round(p * 100))}%` }}/>
            ))}
          </div>
          <div className="ch-wave-layer played" aria-hidden="true">
            {peaks.map((p, i) => (
              <span key={i} className="ch-wave-bar" style={{ height: `${Math.max(14, Math.round(p * 100))}%` }}/>
            ))}
          </div>
          <span className="ch-wave-head" aria-hidden="true"/>
        </div>

        <div className="ch-voice-foot">
          <span className="ch-voice-time" ref={clockRef}>{durationOf(total * 1000)}</span>
          {unplayed && <span className="ch-voice-new" title="Not played yet" aria-label="Not played yet"/>}
          <span className="ch-voice-sp">
            {/* One button, five states — a menu for five values is more taps
                than the values are worth, and the label IS the state. */}
            <button
              type="button"
              className={'ch-voice-rate' + (rate !== 1 ? ' on' : '')}
              onClick={cycleSpeed}
              title="Playback speed"
              aria-label={`Playback speed ${speedLabel(rate)}. Change`}
            >
              {speedLabel(rate)}
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}

export default VoiceNote
