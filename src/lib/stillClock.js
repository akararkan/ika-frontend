/* =========================================================
   StillClock — a photo reel's transport, shaped like a video.

   A reel made from a photo has no <video> to run it: there is
   no duration, no currentTime, nothing to play or pause. But
   everything around it in the reels viewer — the progress bar,
   the drag-scrub, space to pause, the arrow keys, and the
   added-sound mixer that follows the clip — is written against
   an HTMLMediaElement.

   So rather than teach each of those about stills, the still
   brings its own clock that ANSWERS LIKE one: `duration`,
   `currentTime` (settable, and it emits `seeked`), `paused`,
   `play()`/`pause()`, `buffered`/`seekable`, `volume`/`muted`
   (accepted and ignored — a photo has no audio to level), and
   the `play` / `pause` / `timeupdate` / `seeked` events. Point
   the viewer's videoRef at one of these and every control keeps
   working unchanged.

   It loops, because a reel loops. It advances off
   requestAnimationFrame and reports ~10 timeupdates a second —
   the frame budget of a still is a progress bar moving, and the
   audio mirror re-aligns on the same event.
   ========================================================= */

const TICK = 100   // ms between timeupdate events — smooth bar, cheap loop

export class StillClock extends EventTarget {
  constructor(duration = 30) {
    super()
    this._d = Math.max(1, Number(duration) || 30)
    this._t = 0
    this._paused = true
    this._raf = 0
    this._at = 0        // performance.now() of the last advance
    this._emitted = 0   // performance.now() of the last timeupdate
  }

  get duration() { return this._d }
  get paused() { return this._paused }
  get ended() { return false }              // it loops, so it never ends
  get playbackRate() { return 1 }
  set playbackRate(_v) { /* stills run at one speed */ }
  /* The mixer writes level/mute onto whatever it thinks is the clip. A photo
     has no original audio, so these are accepted and dropped — without them
     the writes would throw on a frozen object. */
  get volume() { return 1 }
  set volume(_v) { /* no original audio */ }
  get muted() { return true }
  set muted(_v) { /* no original audio */ }
  /* Nothing to buffer: the image is either on screen or it is not. Reporting a
     full range keeps the viewer's buffer bar honest instead of empty. */
  get buffered() { return { length: 1, start: () => 0, end: () => this._d } }
  get seekable() { return this.buffered }

  get currentTime() { return this._t }
  set currentTime(v) {
    const n = Number(v)
    if (!isFinite(n)) return
    this._t = Math.min(this._d, Math.max(0, n)) % this._d
    this._at = performance.now()
    this.dispatchEvent(new Event('seeked'))
    this.dispatchEvent(new Event('timeupdate'))
  }

  play() {
    if (!this._paused) return Promise.resolve()
    this._paused = false
    this._at = performance.now()
    this.dispatchEvent(new Event('play'))
    this.dispatchEvent(new Event('playing'))
    this._tick()
    return Promise.resolve()
  }

  pause() {
    if (this._paused) return
    this._advance()
    this._paused = true
    cancelAnimationFrame(this._raf)
    this._raf = 0
    this.dispatchEvent(new Event('pause'))
  }

  /** Stop for good — the reel changed or the viewer closed. */
  destroy() {
    cancelAnimationFrame(this._raf)
    this._raf = 0
    this._paused = true
  }

  _advance() {
    const now = performance.now()
    if (!this._paused) this._t = (this._t + (now - this._at) / 1000) % this._d
    this._at = now
  }

  _tick = () => {
    if (this._paused) return
    this._advance()
    const now = performance.now()
    if (now - this._emitted >= TICK) {
      this._emitted = now
      this.dispatchEvent(new Event('timeupdate'))
    }
    this._raf = requestAnimationFrame(this._tick)
  }
}
