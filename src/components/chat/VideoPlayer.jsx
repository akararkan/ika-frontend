/* =========================================================
   VideoPlayer — the in-chat video surface.
   ---------------------------------------------------------
   Replaces `<video controls>` for one reason that is not
   cosmetic: the native control bar is a closed shadow tree. It
   cannot be themed, it cannot carry a speed ladder, it steals
   Space and the arrow keys from the dialog that hosts it, and on
   iOS it hijacks the whole viewport into the system player — out
   of the lightbox, out of the conversation.

   What it owns:
     · transport (play/pause, ±10s, keyboard, tap zones)
     · a scrubber with buffered ranges, drag-seek and hover
       preview times
     · volume + mute, speed 0.5…2×, Picture-in-Picture, fullscreen
     · auto-hiding chrome that never hides while paused, hovered
       or keyboard-focused

   Same architectural rule as VoiceNote: PLAYBACK POSITION IS NOT
   REACT STATE. A rAF loop writes one custom property and two text
   nodes; React state is only for things that change the shape of
   the tree. `timeupdate` at 4Hz would visibly stutter, and a
   60Hz state write would re-render the lightbox on every frame.

   Volume and speed are shared and persisted (mediaPrefs.js): a
   viewer who muted the last clip does not want the next one at
   full blast in a quiet room.
   ========================================================= */
import React from 'react'
import { Icon } from '../ui.jsx'
import { Popover } from './Popover.jsx'
import {
  getMediaPrefs, setMediaPref, subscribeMediaPrefs, speedLabel, durationOf,
} from './mediaPrefs.js'

/** Video gets a wider ladder than voice: 0.5× is a real review speed for a
 *  recorded demo, which is meaningless for speech. */
const VIDEO_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

/** How long the chrome stays up after the last pointer movement. */
const HIDE_MS = 2600
/** Skip step for the transport buttons, the tap zones and j/l. */
const SKIP = 10

const isFine = () => window.matchMedia?.('(hover: hover) and (pointer: fine)')?.matches ?? true

export function VideoPlayer({
  src,
  poster,
  autoPlay = false,
  fileName,
  className = '',
  onDoubleClick,          // the lightbox uses this to toggle its own zoom/close
}) {
  const wrapRef = React.useRef(null)
  const videoRef = React.useRef(null)
  const barRef = React.useRef(null)
  const clockRef = React.useRef(null)
  const rafRef = React.useRef(0)
  const hideTimerRef = React.useRef(null)
  const draggingRef = React.useRef(false)
  const resumeRef = React.useRef(false)
  const tapRef = React.useRef({ at: 0, side: null })

  const [playing, setPlaying] = React.useState(false)
  /* Only an autoplaying clip starts in the buffering state. With
     `preload="metadata"` and no autoplay, `canplay` may not fire until playback
     is actually attempted — starting at `true` there left a spinner spinning
     forever over a video that was perfectly ready, and hid the play button
     that would have started it. */
  const [buffering, setBuffering] = React.useState(!!autoPlay)
  const [failed, setFailed] = React.useState(false)
  const [dur, setDur] = React.useState(0)
  const [buffered, setBuffered] = React.useState(0)     // 0..1, the end of the range under the playhead
  const [chrome, setChrome] = React.useState(true)      // are the controls visible?
  const [speedOpen, setSpeedOpen] = React.useState(false)
  const [pip, setPip] = React.useState(false)
  const [full, setFull] = React.useState(false)
  const [nudge, setNudge] = React.useState(null)        // {side:'back'|'fwd', n} — the double-tap badge
  const speedBtnRef = React.useRef(null)

  const prefs = React.useSyncExternalStore(subscribeMediaPrefs, getMediaPrefs, getMediaPrefs)
  const { videoRate: rate, videoVolume: volume, videoMuted: muted } = prefs

  /* ----- the paint loop ----- */
  const paint = React.useCallback(() => {
    const v = videoRef.current
    const wrap = wrapRef.current
    if (!v || !wrap) return
    const total = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0
    wrap.style.setProperty('--p', String(total ? Math.min(1, v.currentTime / total) : 0))
    if (clockRef.current) clockRef.current.textContent = durationOf(v.currentTime * 1000)
    // Same reasoning as the clock: the slider's reported value has to move for
    // assistive tech, and it cannot cost a render per frame to do it.
    if (barRef.current) {
      barRef.current.setAttribute('aria-valuenow', String(Math.round(v.currentTime)))
      barRef.current.setAttribute('aria-valuetext',
        `${durationOf(v.currentTime * 1000)} of ${durationOf(total * 1000)}`)
    }
  }, [])

  /* Created inside the effect and re-armed through the ref — a self-scheduling
     useCallback closes over a stale copy of itself. */
  React.useEffect(() => {
    if (!playing) { cancelAnimationFrame(rafRef.current); paint(); return undefined }
    const tick = () => { paint(); rafRef.current = requestAnimationFrame(tick) }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [playing, paint])
  React.useEffect(() => () => { cancelAnimationFrame(rafRef.current); clearTimeout(hideTimerRef.current) }, [])

  /* ----- apply the shared preferences ----- */
  React.useEffect(() => { const v = videoRef.current; if (v) v.playbackRate = rate }, [rate])
  React.useEffect(() => {
    const v = videoRef.current
    if (!v) return
    v.volume = Math.max(0, Math.min(1, volume))
    v.muted = muted
  }, [volume, muted])

  /* ----- chrome auto-hide -----
     Never while paused (a paused frame with no controls looks broken), never
     while a menu is open, and never while the keyboard is inside the player. */
  const wake = React.useCallback(() => {
    setChrome(true)
    clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => {
      const wrap = wrapRef.current
      const keyboardInside = wrap?.contains(document.activeElement) && document.activeElement !== wrap
      if (videoRef.current?.paused || speedOpen || keyboardInside) return
      setChrome(false)
    }, HIDE_MS)
  }, [speedOpen])

  React.useEffect(() => { wake() }, [playing, speedOpen, wake])

  /* ----- transport ----- */
  const toggle = React.useCallback(() => {
    const v = videoRef.current
    if (!v || failed) return
    if (v.paused) { v.playbackRate = rate; v.play().catch(() => {}) } else v.pause()
    wake()
  }, [failed, rate, wake])

  const skip = React.useCallback((delta) => {
    const v = videoRef.current
    if (!v) return
    const total = Number.isFinite(v.duration) ? v.duration : 0
    v.currentTime = Math.max(0, Math.min(total || v.currentTime, v.currentTime + delta))
    paint()
    setNudge({ side: delta < 0 ? 'back' : 'fwd', n: Math.abs(delta), at: performance.now() })
    wake()
  }, [paint, wake])

  // The nudge badge clears itself; keyed on `at` so a second tap restarts it.
  React.useEffect(() => {
    if (!nudge) return undefined
    const t = setTimeout(() => setNudge(null), 620)
    return () => clearTimeout(t)
  }, [nudge])

  /* ----- scrubbing ----- */
  const ratioAt = (clientX, el) => {
    const rect = el.getBoundingClientRect()
    if (!rect.width) return 0
    let r = (clientX - rect.left) / rect.width
    if (getComputedStyle(el).direction === 'rtl') r = 1 - r
    return Math.max(0, Math.min(1, r))
  }

  const seekRatio = (r) => {
    const v = videoRef.current
    const total = Number.isFinite(v?.duration) ? v.duration : 0
    if (!v || !total) return
    v.currentTime = r * total
    paint()
  }

  const onBarDown = (e) => {
    if (e.button != null && e.button !== 0) return
    const v = videoRef.current
    if (!v) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    draggingRef.current = true
    resumeRef.current = !v.paused
    if (!v.paused) v.pause()
    seekRatio(ratioAt(e.clientX, e.currentTarget))
  }
  const onBarMove = (e) => {
    const el = e.currentTarget
    // Hover preview: the tooltip position and its label are both CSS-driven,
    // so a mouse crossing the bar costs no React work at all.
    const r = ratioAt(e.clientX, el)
    el.style.setProperty('--h', String(r))
    const total = Number.isFinite(videoRef.current?.duration) ? videoRef.current.duration : 0
    // The tooltip's text is written straight into its node. `content:attr()`
    // can only read an attribute off the pseudo-element's OWN element, so a
    // data-attribute on the track could never reach a child's ::before.
    const tip = el.querySelector('.vp-hover')
    if (tip) tip.textContent = durationOf(r * total * 1000)
    if (draggingRef.current) { e.stopPropagation(); seekRatio(r) }
  }
  const onBarUp = (e) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    if (resumeRef.current) videoRef.current?.play?.().catch(() => {})
  }

  /* ----- surface gestures -----
     Desktop: a click toggles playback. Touch: a double-tap on the start/end
     third seeks ±10s (the YouTube gesture), a single tap toggles the chrome.
     The two are separated by pointer type, not by a timer race. */
  const onSurfaceClick = (e) => {
    if (draggingRef.current) return
    if (isFine()) { toggle(); return }
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const side = x < 0.33 ? 'back' : x > 0.67 ? 'fwd' : 'mid'
    const now = performance.now()
    const doubled = now - tapRef.current.at < 320 && tapRef.current.side === side
    tapRef.current = { at: now, side }
    if (doubled && side !== 'mid') { skip(side === 'back' ? -SKIP : SKIP); return }
    if (side === 'mid') { toggle(); return }
    setChrome(c => !c)
    wake()
  }

  /* ----- fullscreen / PiP ----- */
  const toggleFull = React.useCallback(async () => {
    const wrap = wrapRef.current
    const v = videoRef.current
    try {
      if (document.fullscreenElement) { await document.exitFullscreen(); return }
      if (wrap?.requestFullscreen) { await wrap.requestFullscreen(); return }
      // iOS Safari has no element fullscreen — the <video> owns it there, and
      // this is the one place the native player is the right answer.
      v?.webkitEnterFullscreen?.()
    } catch { /* a denied request is not worth a toast */ }
  }, [])

  React.useEffect(() => {
    const onFs = () => setFull(document.fullscreenElement === wrapRef.current)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  /* React has NO synthetic picture-in-picture events — passing
     onEnterPictureInPicture/onLeavePictureInPicture as JSX props is silently
     ignored (console warning), so the `pip` flag never updated and the PiP
     button's pressed state was dead. Native listeners are the only way to
     observe entry/exit — including an exit made from the browser's own PiP
     window chrome, which never goes through togglePip. */
  React.useEffect(() => {
    const v = videoRef.current
    if (!v) return undefined
    const onEnter = () => setPip(true)
    const onLeave = () => setPip(false)
    v.addEventListener('enterpictureinpicture', onEnter)
    v.addEventListener('leavepictureinpicture', onLeave)
    return () => {
      v.removeEventListener('enterpictureinpicture', onEnter)
      v.removeEventListener('leavepictureinpicture', onLeave)
    }
  }, [])

  const togglePip = React.useCallback(async () => {
    const v = videoRef.current
    if (!v || !document.pictureInPictureEnabled) return
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture()
      else await v.requestPictureInPicture()
    } catch { /* not allowed for this source */ }
  }, [])

  /* ----- keyboard -----
     Bound to the wrapper, not the window: the lightbox owns Escape and arrow
     navigation between items, and a window listener here would fight it. */
  const onKeyDown = (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const v = videoRef.current
    if (!v) return
    const k = e.key
    if (k === ' ' || k === 'k') { e.preventDefault(); e.stopPropagation(); toggle(); return }
    if (k === 'ArrowRight' || k === 'l') { e.preventDefault(); e.stopPropagation(); skip(k === 'l' ? SKIP : 5); return }
    if (k === 'ArrowLeft' || k === 'j') { e.preventDefault(); e.stopPropagation(); skip(k === 'j' ? -SKIP : -5); return }
    if (k === 'ArrowUp') { e.preventDefault(); setMediaPref({ videoVolume: Math.min(1, volume + 0.1), videoMuted: false }); wake(); return }
    if (k === 'ArrowDown') { e.preventDefault(); setMediaPref({ videoVolume: Math.max(0, volume - 0.1) }); wake(); return }
    if (k === 'm') { e.preventDefault(); setMediaPref({ videoMuted: !muted }); wake(); return }
    if (k === 'f') { e.preventDefault(); toggleFull(); return }
    if (k === 'p') { e.preventDefault(); togglePip(); return }
    if (k >= '0' && k <= '9') {
      const total = Number.isFinite(v.duration) ? v.duration : 0
      if (total) { e.preventDefault(); v.currentTime = total * (Number(k) / 10); paint(); wake() }
    }
  }

  const volIcon = muted || volume === 0 ? 'mute' : volume < 0.5 ? 'volumelow' : 'volume'

  return (
    <div
      ref={wrapRef}
      className={
        'vp' + (className ? ' ' + className : '')
        + (chrome ? ' vp-chrome' : '')
        + (playing ? ' vp-playing' : '')
        + (full ? ' vp-full' : '')
      }
      style={{ '--p': 0 }}
      tabIndex={0}
      role="group"
      aria-label={fileName ? `Video: ${fileName}` : 'Video'}
      onKeyDown={onKeyDown}
      onPointerMove={wake}
      onPointerLeave={() => { if (playing && !speedOpen) setChrome(false) }}
      onFocus={wake}
    >
      <video
        ref={videoRef}
        className="vp-video"
        src={src || undefined}
        poster={poster || undefined}
        playsInline
        autoPlay={autoPlay}
        preload="metadata"
        onClick={onSurfaceClick}
        onDoubleClick={onDoubleClick}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => { setBuffering(false); setFailed(false) }}
        onCanPlay={() => setBuffering(false)}
        onError={() => { setFailed(true); setBuffering(false) }}
        onEnded={() => { setPlaying(false); setChrome(true) }}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget
          v.playbackRate = rate
          v.volume = Math.max(0, Math.min(1, volume))
          v.muted = muted
          if (Number.isFinite(v.duration)) setDur(v.duration)
          if (!autoPlay) setBuffering(false)
          paint()
        }}
        onProgress={(e) => {
          const v = e.currentTarget
          const total = Number.isFinite(v.duration) ? v.duration : 0
          if (!total || !v.buffered?.length) return
          // The range that CONTAINS the playhead — the last range is wrong
          // after a seek into unbuffered territory.
          let end = 0
          for (let i = 0; i < v.buffered.length; i++) {
            if (v.buffered.start(i) <= v.currentTime && v.buffered.end(i) >= v.currentTime) end = v.buffered.end(i)
          }
          setBuffered(Math.min(1, end / total))
        }}
        onTimeUpdate={() => { if (!playing) paint() }}
      />

      {/* Centre states. The big play button is a real control, not a veil —
          it is the primary affordance on touch, where the bar is small. */}
      {failed ? (
        <div className="vp-center vp-fail" role="status">
          <Icon name="videooff"/>
          <span>This video could not be played</span>
        </div>
      ) : buffering ? (
        <div className="vp-center" role="status" aria-live="polite">
          <span className="vp-spin" aria-hidden="true"/>
          <span className="sr-only">Buffering</span>
        </div>
      ) : !playing ? (
        <button type="button" className="vp-big" onClick={toggle} aria-label="Play video">
          <Icon name="play"/>
        </button>
      ) : null}

      {nudge && (
        <div className={'vp-nudge ' + nudge.side} aria-hidden="true">
          <Icon name={nudge.side === 'back' ? 'skipback' : 'skipfwd'}/>
          <span>{nudge.n}s</span>
        </div>
      )}

      <div className="vp-bar" onPointerDown={(e) => e.stopPropagation()}>
        <div
          className="vp-track"
          ref={barRef}
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(dur) || 0}
          aria-valuenow={0}
          aria-valuetext={durationOf(dur * 1000)}
          style={{ '--b': buffered }}
          onPointerDown={onBarDown}
          onPointerMove={onBarMove}
          onPointerUp={onBarUp}
          onPointerCancel={onBarUp}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); skip(5) }
            if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); skip(-5) }
          }}
        >
          <span className="vp-buffered" aria-hidden="true"/>
          <span className="vp-played" aria-hidden="true"/>
          <span className="vp-knob" aria-hidden="true"/>
          <span className="vp-hover" aria-hidden="true"/>
        </div>

        <div className="vp-ctls">
          <button type="button" className="vp-btn" onClick={toggle}
            aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (k)' : 'Play (k)'}>
            <Icon name={playing ? 'pause' : 'play'}/>
          </button>
          <button type="button" className="vp-btn dim" onClick={() => skip(-SKIP)}
            aria-label="Back 10 seconds" title="Back 10s (j)">
            <Icon name="skipback"/>
          </button>
          <button type="button" className="vp-btn dim" onClick={() => skip(SKIP)}
            aria-label="Forward 10 seconds" title="Forward 10s (l)">
            <Icon name="skipfwd"/>
          </button>

          {/* The slider is revealed by hover/focus on the group, so the bar
              stays compact on a phone but is one gesture away on a desktop. */}
          <div className="vp-vol">
            <button type="button" className="vp-btn dim" onClick={() => setMediaPref({ videoMuted: !muted })}
              aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute (m)' : 'Mute (m)'}>
              <Icon name={volIcon}/>
            </button>
            <input
              className="vp-volrange"
              type="range" min={0} max={1} step={0.02}
              value={muted ? 0 : volume}
              onChange={(e) => setMediaPref({ videoVolume: Number(e.target.value), videoMuted: Number(e.target.value) === 0 })}
              aria-label="Volume"
              style={{ '--v': muted ? 0 : volume }}
            />
          </div>

          <span className="vp-time">
            <b ref={clockRef}>0:00</b>
            <i>/</i>
            <span>{durationOf(dur * 1000)}</span>
          </span>

          <span className="vp-spacer"/>

          <button type="button" className={'vp-btn dim vp-rate' + (rate !== 1 ? ' on' : '')}
            ref={speedBtnRef}
            onClick={() => setSpeedOpen(v => !v)}
            aria-haspopup="menu" aria-expanded={speedOpen}
            aria-label={`Playback speed ${speedLabel(rate)}`} title="Playback speed">
            {rate === 1 ? <Icon name="speed"/> : <span className="vp-ratetag">{speedLabel(rate)}</span>}
          </button>
          <Popover
            anchorRef={speedBtnRef}
            open={speedOpen}
            onClose={() => setSpeedOpen(false)}
            className="vp-speedmenu"
            ariaLabel="Playback speed"
            align="end"
            prefer="top"
          >
            {VIDEO_SPEEDS.map(s => (
              <button
                key={s}
                type="button"
                role="menuitemradio"
                aria-checked={s === rate}
                className={'ch-menu-item' + (s === rate ? ' on' : '')}
                onClick={() => { setMediaPref({ videoRate: s }); setSpeedOpen(false) }}
              >
                <Icon name="check" className="sm"/>
                <span>{s === 1 ? 'Normal' : speedLabel(s)}</span>
              </button>
            ))}
          </Popover>

          {document.pictureInPictureEnabled && (
            <button type="button" className={'vp-btn dim' + (pip ? ' on' : '')} onClick={togglePip}
              aria-label="Picture in picture" title="Picture in picture (p)">
              <Icon name="pip"/>
            </button>
          )}
          <button type="button" className="vp-btn dim" onClick={toggleFull}
            aria-label={full ? 'Exit fullscreen' : 'Fullscreen'} title={full ? 'Exit fullscreen (f)' : 'Fullscreen (f)'}>
            <Icon name={full ? 'collapse' : 'expand'}/>
          </button>
        </div>
      </div>
    </div>
  )
}

export default VideoPlayer
