/* =========================================================
   Reel audio — TWO tracks, one transport (Facebook-style).

   A reel that was posted with a Sound (§19 `soundId`) has two
   pieces of audio, and the backend keeps them apart:

     · the ORIGINAL sound, recorded inside the video file — it
       plays through the <video> element itself;
     · the ADDED sound, the track picked from the library —
       served separately as `audioTrackUrl` on GET /posts/{id}.

   Nothing is mixed server-side, so the viewer plays both at
   once and lets the listener balance them: each track has its
   own level and its own mute, on top of the reel's master
   mute button. Levels are remembered across reels and across
   sessions (localStorage) — the same way a volume control is
   expected to behave everywhere else.

   THE ADDED TRACK FOLLOWS THE VIDEO — never the other way
   round. The video is the clock: every play/pause/seek/loop it
   performs is mirrored onto the music element, and `timeupdate`
   re-aligns it whenever the two drift apart (a buffering stall
   moves one and not the other). Position is taken MODULO the
   track's own duration, which is what makes a short track loop
   under a long clip and a long track restart when the clip
   loops, without either case needing its own branch.
   ========================================================= */
import React from 'react'

const KEY = 'ika_reels_mix'
/* Original at full, added track a shade under it: the added sound is a bed,
   and speech in the clip has to stay intelligible over it. Both are the
   listener's to change from the first reel onwards. */
const DEFAULTS = { orig: 1, music: .7, origOff: false, musicOff: false }
/* Below this the two are audibly out of step; above it, correcting every
   timeupdate (~4×/s) would be audible as a stutter of its own. */
const DRIFT = .3

const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0))

function readOwnLevels() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (!raw || typeof raw !== 'object') return { ...DEFAULTS }
    return {
      orig: clamp01(raw.orig ?? DEFAULTS.orig),
      music: clamp01(raw.music ?? DEFAULTS.music),
      origOff: !!raw.origOff,
      musicOff: !!raw.musicOff,
    }
  } catch { return { ...DEFAULTS } }
}
function writeOwnLevels(m) { try { localStorage.setItem(KEY, JSON.stringify(m)) } catch { /* private mode */ } }

/**
 * @param videoRef  ref to the reel's <video> — the transport master
 * @param trackUrl  the ADDED sound's audio url (null when the reel has none)
 * @param srcKey    changes whenever the <video> element is replaced (reel id)
 * @param muted     the reel's master mute
 * @param onBlocked called when the browser refuses to start the added track
 *                  unmuted — the caller raises its "tap for sound" nudge
 * @param authored  {orig, music} the reel's AUTHOR set in the composer, or
 *                  null — it seeds this reel's levels until the listener
 *                  moves a slider (see lib/soundMix.js for how it travels)
 */
export function useReelAudio({ videoRef, trackUrl, srcKey, muted, onBlocked, authored = null }) {
  const [own, setOwn] = React.useState(readOwnLevels)       // the listener's own levels, remembered
  const [failed, setFailed] = React.useState(false)   // the track itself 404s / won't decode
  /* The AUTHOR's balance, when the reel carries one (`#mix=` on the track url).
     It seeds THIS reel and nothing else: the moment the listener moves a
     slider, `taken` flips and their levels win again — for this reel and for
     every reel after it. Creator's intent by default, listener's control on
     demand, and neither one quietly overwrites the other's stored value. */
  const [taken, setTaken] = React.useState(false)
  React.useEffect(() => { setTaken(false) }, [srcKey])
  const seeded = !!authored && !taken
  const mix = React.useMemo(
    () => (seeded ? { ...own, orig: authored.orig, music: authored.music } : own),
    [seeded, own, authored],
  )
  const musicRef = React.useRef(null)

  /* Refs, not deps: the transport listeners below are attached once per clip
     and must read the CURRENT levels when they fire, without being torn down
     and rebuilt (and restarting playback) on every slider move. Mirrored in an
     effect declared FIRST, so every effect after it already sees this render's
     values (effects run in declaration order). */
  const mixRef = React.useRef(mix)
  const mutedRef = React.useRef(muted)
  const blockedRef = React.useRef(onBlocked)
  React.useEffect(() => { mixRef.current = mix; mutedRef.current = muted; blockedRef.current = onBlocked })

  const hasMusic = !!trackUrl && !failed

  /* One element per track url. Deliberately NOT in the DOM and deliberately
     NOT crossOrigin: media elements need neither to play or to have their
     volume set, and asking for CORS would make the load fail outright on an
     API that does not answer with the header. */
  React.useEffect(() => {
    setFailed(false)
    if (!trackUrl) return
    const a = new Audio()
    a.loop = true                      // a short track beds under a long clip
    a.preload = 'auto'
    a.onerror = () => setFailed(true)  // → the mixer drops the row, video plays on
    a.src = trackUrl
    musicRef.current = a
    return () => {
      a.onerror = null
      a.pause()
      a.removeAttribute('src')         // stops the download; `src=''` re-fires onerror
      try { a.load() } catch { /* detached */ }
      musicRef.current = null
    }
  }, [trackUrl])

  /* Levels are written straight onto the elements rather than rendered as
     props: React owns neither element's volume, and the <video>'s `muted`
     attribute is famously unreliable as a controlled prop. */
  const apply = React.useCallback(() => {
    const m = mixRef.current, off = mutedRef.current
    const v = videoRef.current
    if (v) { v.volume = m.orig; v.muted = off || m.origOff }
    const a = musicRef.current
    if (a) { a.volume = m.music; a.muted = off || m.musicOff }
  }, [videoRef])

  React.useEffect(() => { apply() }, [apply, mix, muted, trackUrl, srcKey])

  /* The mirror. Re-attached whenever the clip or the track changes, because
     both elements are replaced under it. */
  React.useEffect(() => {
    const v = videoRef.current
    const a = musicRef.current
    if (!v || !a) return

    const align = () => {
      const d = a.duration
      const t = (isFinite(d) && d > 0) ? v.currentTime % d : v.currentTime
      if (Math.abs(a.currentTime - t) > DRIFT) { try { a.currentTime = t } catch { /* not seekable yet */ } }
    }
    const start = () => {
      if (v.paused) return
      apply(); align()
      a.playbackRate = v.playbackRate
      const p = a.play()
      /* Only worth a nudge when the track was MEANT to be heard: a muted
         start is never refused, so a rejection there would be something else. */
      if (p && p.catch) p.catch(() => { if (!a.muted) blockedRef.current?.() })
    }
    const stop = () => a.pause()
    const rate = () => { a.playbackRate = v.playbackRate }

    v.addEventListener('play', start)
    v.addEventListener('playing', start)   // also covers "resumed after buffering"
    v.addEventListener('pause', stop)
    v.addEventListener('waiting', stop)    // clip stalls → the bed stops with it
    v.addEventListener('seeked', align)
    v.addEventListener('timeupdate', align)
    v.addEventListener('ratechange', rate)
    /* The track is fetched a moment AFTER the clip starts (the reel row does
       not carry it), so the `play` event has already been and gone. */
    start()

    return () => {
      v.removeEventListener('play', start)
      v.removeEventListener('playing', start)
      v.removeEventListener('pause', stop)
      v.removeEventListener('waiting', stop)
      v.removeEventListener('seeked', align)
      v.removeEventListener('timeupdate', align)
      v.removeEventListener('ratechange', rate)
      a.pause()
    }
  }, [videoRef, trackUrl, srcKey, apply])

  /** Start the track from a user gesture (the "tap for sound" path). */
  const resume = React.useCallback(() => {
    const a = musicRef.current, v = videoRef.current
    if (!a || !v || v.paused) return
    apply()
    const p = a.play()
    if (p && p.catch) p.catch(() => {})
  }, [apply, videoRef])

  /* A slider move is the listener taking over from the author's balance, so it
     writes THEIR levels — seeded from whatever is currently audible, or the
     author's number would jump back the instant the other slider moved. */
  const update = React.useCallback((patch) => {
    const base = mixRef.current
    setTaken(true)
    setOwn(() => { const next = { ...base, ...patch }; writeOwnLevels(next); return next })
  }, [])

  /* Dragging a slider off zero un-mutes that track — the slider IS the mute
     control as far as the hand is concerned. Dragging it TO zero leaves the
     flag alone, so the icon does not start lying about which one silenced it. */
  const setLevel = React.useCallback((which, val) => {
    const v = clamp01(val)
    if (which === 'music') update({ music: v, ...(v > 0 ? { musicOff: false } : null) })
    else update({ orig: v, ...(v > 0 ? { origOff: false } : null) })
  }, [update])

  const toggleOff = React.useCallback((which) => {
    const m = mixRef.current
    update(which === 'music' ? { musicOff: !m.musicOff } : { origOff: !m.origOff })
  }, [update])

  return { mix, hasMusic, failed, seeded, apply, resume, setLevel, toggleOff }
}
