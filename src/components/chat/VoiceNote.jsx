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
  isVoicePlayed, markVoicePlayed, pauseOtherVoices, playNextVoice,
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
  const draggingRef = React.useRef(false)
  const resumeRef = React.useRef(false)      // was it playing when the drag started?

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

  /* ----- the render loop: one CSS var + one text node, no re-render ----- */
  const paint = React.useCallback(() => {
    const a = audioRef.current
    const wrap = wrapRef.current
    if (!a || !wrap) return
    const total = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : (dur || 0)
    const p = total ? Math.min(1, a.currentTime / total) : 0
    wrap.style.setProperty('--p', String(p))
    if (clockRef.current) {
      // Elapsed while it has a position, total while it is untouched — the
      // same convention every messenger uses, and the reason the clock is
      // written imperatively rather than derived in render.
      clockRef.current.textContent = durationOf((p > 0 ? a.currentTime : total) * 1000)
    }
    /* The slider's value is written here too, for the same reason: a
       `role="slider"` whose aria-valuenow never moves reports a dead control
       to a screen reader, and re-rendering it 60×/second is what this whole
       loop exists to avoid. */
    if (waveRef.current) {
      waveRef.current.setAttribute('aria-valuenow', String(Math.round(a.currentTime)))
      waveRef.current.setAttribute('aria-valuetext',
        `${durationOf(a.currentTime * 1000)} of ${durationOf(total * 1000)}`)
    }
  }, [dur])

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

  React.useEffect(() => () => cancelAnimationFrame(rafRef.current), [])

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
    if (!a || failed) return
    if (a.paused) {
      // Two voice notes talking over each other is never what anyone wanted.
      pauseOtherVoices(a)
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
    const total = Number.isFinite(a?.duration) && a.duration > 0 ? a.duration : dur
    if (!a || !total) return
    a.currentTime = ratio * total
    paint()
  }

  const onPointerDown = (e) => {
    if (e.button != null && e.button !== 0) return
    const a = audioRef.current
    if (!a || failed) return
    e.stopPropagation()
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
    if (!a) return
    const total = Number.isFinite(a.duration) ? a.duration : dur
    if (e.key === 'ArrowRight') { e.preventDefault(); a.currentTime = Math.min(total || 0, a.currentTime + 3); paint() }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); a.currentTime = Math.max(0, a.currentTime - 3); paint() }
    else if (e.key === 'Home') { e.preventDefault(); a.currentTime = 0; paint() }
    else if (e.key === 'End' && total) { e.preventDefault(); a.currentTime = total; paint() }
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(e) }
  }

  /* MediaRecorder WebM has no duration header: Chromium reports Infinity until
     the element has seeked past the end once. Nudging currentTime to a
     ludicrous value forces the demuxer to walk the cluster index, after which
     `duration` is real and we rewind. Guarded so it runs once per element. */
  const fixInfiniteDuration = (a) => {
    if (Number.isFinite(a.duration) || a.dataset.durFixed) return
    a.dataset.durFixed = '1'
    const onSeeked = () => {
      a.removeEventListener('timeupdate', onSeeked)
      if (Number.isFinite(a.duration)) setDur(a.duration)
      a.currentTime = 0
      paint()
    }
    a.addEventListener('timeupdate', onSeeked)
    try { a.currentTime = 1e101 } catch { a.removeEventListener('timeupdate', onSeeked) }
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
          setPlaying(true)
          if (!heard) { markVoicePlayed(messageId); setHeard(true) }
        }}
        onPause={() => setPlaying(false)}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => setBuffering(false)}
        onCanPlay={() => setBuffering(false)}
        onError={() => { setFailed(true); setPlaying(false) }}
        onEnded={(e) => {
          setPlaying(false)
          const a = e.currentTarget
          a.currentTime = 0
          paint()
          // Continuous playback: roll on to the next note in the thread, the
          // way a voice backlog is actually listened to.
          playNextVoice(a)
        }}
        onLoadedMetadata={(e) => {
          const a = e.currentTarget
          applyRate(a, rate)
          if (Number.isFinite(a.duration) && a.duration > 0) setDur(a.duration)
          /* Self-recorded WebM reports Infinity here. When the wire carried a
             real durationMs the scrubber already has its total — running the
             seek-to-the-end fix anyway forces a FULL download of every note
             in the thread at mount (preload="metadata" fires this handler for
             each bubble) just to relearn a number we were given. Only a note
             with no known length at all still pays for the walk. */
          else if (!media.durationMs) fixInfiniteDuration(a)
        }}
        onTimeUpdate={() => { if (!playing) paint() }}
      />

      <button
        type="button"
        className="ch-voice-play"
        onClick={toggle}
        disabled={failed}
        aria-label={failed
          ? 'This voice message could not be loaded'
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
          aria-valuemax={Math.round(total) || 0}
          aria-valuenow={0}
          aria-valuetext={durationOf(total * 1000)}
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
