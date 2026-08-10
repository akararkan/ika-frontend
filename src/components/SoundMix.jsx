/* =========================================================
   Sound mix — set the balance BEFORE the reel goes out.

   A reel with a sound has two things playing at once: the
   clip's own recorded audio and the chosen track. Which one
   should be louder is an authoring decision, so it is made
   here, next to the sound that was just picked, and it is made
   AUDIBLE: "Play mix" runs the attached clip and the track
   together at the exact levels set, straight off the local
   file, before anything is uploaded.

   A photo reel has only the track, so only one slider is drawn.

   HOW THE LEVELS TRAVEL. The API has no field for a per-post
   mix (BACKEND_NOTES #16), so they ride in the fragment of the
   post's own `audioTrackUrl` — `…/track.mp3#mix=0.4,0.9`. A
   fragment is never sent to the server on a media request and
   every client that does not know about it plays exactly the
   same audio, so the worst case is a client that ignores the
   author's balance rather than one that breaks on it. The
   viewer reads it back as that reel's starting levels.
   ========================================================= */
import React from 'react'
import { Icon } from './ui.jsx'
import { clamp01 } from '../lib/soundMix.js'

const pct = (n) => Math.round(clamp01(n) * 100)

/**
 * @param sound     the chosen sound (needs `audioUrl`)
 * @param mix       {orig, music}
 * @param onChange  next mix
 * @param file      the attached reel file — a video contributes the original
 *                  track; a photo has none, so its slider is not drawn
 */
export function SoundMix({ sound, mix, onChange, file }) {
  const hasOriginal = !!file && file.type?.startsWith('video')
  const [playing, setPlaying] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const audioRef = React.useRef(null)
  const videoRef = React.useRef(null)

  // The clip is previewed straight from the picked File — no upload, no wait.
  const [clipUrl, setClipUrl] = React.useState(null)
  React.useEffect(() => {
    if (!hasOriginal) { setClipUrl(null); return }
    const u = URL.createObjectURL(file)
    setClipUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file, hasOriginal])

  const stop = React.useCallback(() => {
    audioRef.current?.pause()
    const v = videoRef.current
    if (v) { v.pause(); try { v.currentTime = 0 } catch { /* not seekable */ } }
    setPlaying(false)
  }, [])
  React.useEffect(() => stop, [stop])
  React.useEffect(() => { stop(); setFailed(false) }, [sound?.id, stop])

  // Levels are live: drag a slider while the preview runs and it changes now.
  React.useEffect(() => {
    if (audioRef.current) audioRef.current.volume = clamp01(mix.music)
    if (videoRef.current) videoRef.current.volume = clamp01(mix.orig)
  }, [mix])

  const play = () => {
    if (playing) { stop(); return }
    if (!audioRef.current) audioRef.current = new Audio()
    const a = audioRef.current
    a.loop = true
    a.volume = clamp01(mix.music)
    a.onerror = () => { setFailed(true); setPlaying(false) }
    if (a.src !== sound.audioUrl) a.src = sound.audioUrl || ''
    const v = videoRef.current
    if (v) { v.volume = clamp01(mix.orig); v.currentTime = 0; v.play().catch(() => {}) }
    const p = a.play()
    if (p && p.then) p.then(() => { setPlaying(true); setFailed(false) }).catch(() => { setFailed(true); setPlaying(false) })
  }

  const rows = []
  if (hasOriginal) rows.push({ key: 'orig', label: 'Your video’s sound', value: mix.orig })
  rows.push({ key: 'music', label: sound.title || 'Added sound', value: mix.music })

  return (
    <div className="snd-mix">
      <div className="snd-mix-head">
        <b>{hasOriginal ? 'Balance the sound' : 'Sound level'}</b>
        <button className={'snd-mix-play' + (playing ? ' on' : '')} onClick={play}>
          <Icon name={playing ? 'pause' : 'play'} className="xs"/>{playing ? 'Stop' : 'Play mix'}
        </button>
      </div>

      {/* Muted and off-screen: this element exists to be HEARD at the level the
          slider says, not watched — the preview gallery above already shows the
          clip. `playsInline` keeps iOS from taking over the screen for it. */}
      {clipUrl && <video ref={videoRef} src={clipUrl} className="snd-mix-clip" playsInline preload="auto" loop/>}

      {rows.map(row => (
        <label key={row.key} className="snd-mix-row">
          <span className="snd-mix-name">{row.label}</span>
          <span className="snd-mix-pct">{pct(row.value)}%</span>
          <input type="range" min="0" max="100" step="1" value={pct(row.value)}
            aria-label={`${row.label} level`}
            onChange={e => onChange({ ...mix, [row.key]: Number(e.target.value) / 100 })}/>
        </label>
      ))}

      <p className="snd-mix-note">
        {failed
          ? 'The preview couldn’t play here — the levels are still saved with your reel.'
          : hasOriginal
            ? 'This is how your reel starts for everyone. They can still adjust it while watching.'
            : 'A photo reel has no sound of its own, so this track is all anyone hears.'}
      </p>
    </div>
  )
}
