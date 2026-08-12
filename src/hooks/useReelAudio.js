/* =========================================================
   Reel audio — up to THREE tracks, one transport.

   A reel can carry three pieces of audio, and the backend keeps
   them all apart:

     · the ORIGINAL sound, recorded inside the video file — it
       plays through the <video> element itself;
     · the ADDED sound, the track picked from the library —
       served separately as `audioTrackUrl`;
     · a VOICEOVER the author recorded over the reel — uploaded
       as an AUDIO media part, surfaced as `post.voiceoverUrl`.

   Nothing is mixed server-side, so the viewer plays them
   together, at the levels THE AUTHOR SET before posting (they
   ride in on `#mix=` — see lib/soundMix.js). Watching a reel is
   not the place to re-mix somebody's work: the only audio
   control here is the master mute. A reel that carries no
   authored balance plays at DEFAULT_MIX.

   EVERYTHING FOLLOWS THE VIDEO — never the other way round.
   The video is the clock: every play/pause/seek/loop it
   performs is mirrored onto the audio elements, and
   `timeupdate` re-aligns them whenever they drift (a buffering
   stall moves one and not the others). The MUSIC aligns modulo
   its own duration — a short track loops under a long clip and
   restarts when the clip loops. The VOICEOVER aligns
   ABSOLUTELY: it was spoken against the timeline, so it plays
   once per pass, falls silent past its end, and starts again
   when the clip loops back to the words.
   ========================================================= */
import React from 'react'
/* ONE definition of the default balance, shared with the composer that writes
   it and the mix sheet that previews it. Two copies would let a reel whose
   author never touched a slider preview at one balance and play at another. */
import { DEFAULT_MIX, clamp01 } from '../lib/soundMix.js'

/* Below this the tracks are audibly out of step; above it, correcting every
   timeupdate (~4×/s) would be audible as a stutter of its own. */
const DRIFT = .3

/**
 * @param videoRef  ref to the reel's <video> — the transport master
 * @param trackUrl  the ADDED sound's audio url (null when the reel has none)
 * @param voiceUrl  the author's VOICEOVER url (null when the reel has none)
 * @param srcKey    changes whenever the <video> element is replaced (reel id)
 * @param muted     the reel's master mute — the viewer's ONLY audio control
 * @param onBlocked called when the browser refuses to start the added track
 *                  unmuted — the caller raises its "tap for sound" nudge
 * @param authored  {orig, music, voice} — the balance the reel's author set
 *                  in the composer, or null for a reel that carries none
 */
export function useReelAudio({ videoRef, trackUrl, voiceUrl = null, srcKey, muted, onBlocked, authored = null }) {
  const [failed, setFailed] = React.useState(false)   // the ADDED track 404s / won't decode
  /* Fixed for the life of the reel. `authored` arrives with the reel's own
     read, one beat after playback starts, so a ducked original is briefly
     loud — the fix for that is the feed row carrying the audio in the first
     place (BACKEND_NOTES #13), not a control the listener has to reach for. */
  const mix = React.useMemo(
    () => (authored
      ? { orig: clamp01(authored.orig), music: clamp01(authored.music), voice: clamp01(authored.voice ?? 1) }
      : { ...DEFAULT_MIX }),
    [authored],
  )
  const musicRef = React.useRef(null)
  const voiceRef = React.useRef(null)

  /* Refs, not deps: the transport listeners below are attached once per clip
     and must read the CURRENT levels when they fire — `authored` lands after
     they are attached — without being torn down and rebuilt (which would
     restart playback). Mirrored in an effect declared FIRST, so every effect
     after it already sees this render's values (effects run in order). */
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
    a.onerror = () => setFailed(true)  // → the reel says "Sound unavailable"; the clip plays on
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

  React.useEffect(() => {
    if (!voiceUrl) return
    const b = new Audio()
    b.loop = false                     // spoken against the timeline — it does NOT bed
    b.preload = 'auto'
    b.src = voiceUrl                   // a dead voiceover simply stays silent; the clip plays on
    voiceRef.current = b
    return () => {
      b.pause()
      b.removeAttribute('src')
      try { b.load() } catch { /* detached */ }
      voiceRef.current = null
    }
  }, [voiceUrl])

  /* Levels are written straight onto the elements rather than rendered as
     props: React owns neither element's volume, and the <video>'s `muted`
     attribute is famously unreliable as a controlled prop. */
  const apply = React.useCallback(() => {
    const m = mixRef.current, off = mutedRef.current
    const v = videoRef.current
    /* An author who dropped a level to zero wanted exactly that — a level of
       0, not a mute — so master mute stays the one thing the button owns. */
    if (v) { v.volume = m.orig; v.muted = off }
    const a = musicRef.current
    if (a) { a.volume = m.music; a.muted = off }
    const b = voiceRef.current
    if (b) { b.volume = m.voice ?? 1; b.muted = off }
  }, [videoRef])

  React.useEffect(() => { apply() }, [apply, mix, muted, trackUrl, voiceUrl, srcKey])

  /* The mirror. Re-attached whenever the clip or a track changes, because
     the elements are replaced under it. */
  React.useEffect(() => {
    const v = videoRef.current
    const a = musicRef.current
    const b = voiceRef.current
    if (!v || (!a && !b)) return

    const align = () => {
      const t = v.currentTime
      if (a) {
        const d = a.duration
        const at = (isFinite(d) && d > 0) ? t % d : t
        if (Math.abs(a.currentTime - at) > DRIFT) { try { a.currentTime = at } catch { /* not seekable yet */ } }
      }
      if (b) {
        const d = b.duration
        if (isFinite(d) && d > 0 && t >= d) {
          // past the last word — silence until the clip loops back
          if (!b.paused) b.pause()
        } else {
          if (Math.abs(b.currentTime - t) > DRIFT) { try { b.currentTime = t } catch { /* not seekable yet */ } }
          if (!v.paused && b.paused) b.play().catch(() => { /* gesture-gated; resume() covers it */ })
        }
      }
    }
    const start = () => {
      if (v.paused) return
      apply(); align()
      if (a) {
        a.playbackRate = v.playbackRate
        const p = a.play()
        /* Only worth a nudge when the track was MEANT to be heard: a muted
           start is never refused, so a rejection there would be something else. */
        if (p && p.catch) p.catch(() => { if (!a.muted) blockedRef.current?.() })
      }
      if (b) {
        b.playbackRate = v.playbackRate
        const p = b.play()
        if (p && p.catch) p.catch(() => { if (!b.muted && !a) blockedRef.current?.() })
      }
    }
    const stop = () => { a?.pause(); b?.pause() }
    const rate = () => { if (a) a.playbackRate = v.playbackRate; if (b) b.playbackRate = v.playbackRate }

    v.addEventListener('play', start)
    v.addEventListener('playing', start)   // also covers "resumed after buffering"
    v.addEventListener('pause', stop)
    v.addEventListener('waiting', stop)    // clip stalls → the tracks stop with it
    v.addEventListener('seeked', align)
    v.addEventListener('timeupdate', align)
    v.addEventListener('ratechange', rate)
    /* The tracks are fetched a moment AFTER the clip starts (the reel row does
       not carry them), so the `play` event has already been and gone. */
    start()

    return () => {
      v.removeEventListener('play', start)
      v.removeEventListener('playing', start)
      v.removeEventListener('pause', stop)
      v.removeEventListener('waiting', stop)
      v.removeEventListener('seeked', align)
      v.removeEventListener('timeupdate', align)
      v.removeEventListener('ratechange', rate)
      a?.pause()
      b?.pause()
    }
  }, [videoRef, trackUrl, voiceUrl, srcKey, apply])

  /** Start the tracks from a user gesture (the "tap for sound" path). */
  const resume = React.useCallback(() => {
    const v = videoRef.current
    if (!v || v.paused) return
    apply()
    musicRef.current?.play()?.catch?.(() => {})
    voiceRef.current?.play()?.catch?.(() => {})
  }, [apply, videoRef])

  return { hasMusic, failed, apply, resume }
}
