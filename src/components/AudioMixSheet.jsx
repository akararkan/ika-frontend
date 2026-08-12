/* =========================================================
   Mix your audio — the reel's sound desk (Facebook-style).

   A full-screen surface: the reel plays up top, and below it
   one row per track — the video's own sound, the added song,
   and a voiceover — each with a thick slider and a right-hand
   action (Mute / On / Edit), plus "Add voiceover". This is
   where a reel's balance is DECIDED: the viewer has no sliders,
   so what is set here is what everybody hears.

   The preview is live: tap the reel to play the whole mix off
   the local file, drag a slider and hear it change. Tracks are
   glued to the clip the same way the viewer glues them — music
   modulo its length, voiceover absolute against the timeline.

   VOICEOVER. Recorded here with the mic while the picture rolls
   SILENTLY from the top — the speaker would bleed straight back
   into the mic, so narration is recorded against the visuals,
   not the sound, and the full mix is played back afterwards.
   The recording stops by hand, at the clip's end, or at the
   photo reel's 30 seconds — whichever comes first. It uploads
   beside the clip as an ordinary audio part; a "Mute"d track is
   a level of ZERO, because that is the only thing the wire can
   carry (lib/soundMix.js).
   ========================================================= */
import React from 'react'
import { Icon, showToast } from './ui.jsx'
import { DEFAULT_MIX, clamp01 } from '../lib/soundMix.js'

const STILL_SECS = 30            // must match the viewer's photo-reel clock
const REC_CAP = 120              // hard stop even on a long clip
const UNMUTE_TO = DEFAULT_MIX    // where an un-mute lands — never surprising

function Row({ icon, art, label, value, onLevel, onAction, actionLabel }) {
  return (
    <div className="amx-row">
      <span className="amx-ic" title={label}>
        {art ? <img src={art} alt=""/> : <Icon name={icon} className="sm"/>}
      </span>
      <input className="amx-range" type="range" min="0" max="100" step="1"
        value={Math.round(clamp01(value) * 100)}
        style={{ '--v': Math.round(clamp01(value) * 100) }}
        aria-label={`${label} level`}
        onChange={e => onLevel(Number(e.target.value) / 100)}/>
      <button className="amx-act" onClick={onAction}>{actionLabel}</button>
    </div>
  )
}

/**
 * @param file       the attached reel media (image or video)
 * @param sound      the chosen library sound, or null
 * @param mix        {orig, music, voice} coming in
 * @param voiceover  the recorded voiceover File, or null
 * @param onClose    (result|null) — {mix, voiceover} on Done, null on Cancel
 */
export function AudioMixSheet({ file, sound, mix: initMix, voiceover: initVoice, onClose }) {
  const isVideo = !!file && file.type?.startsWith('video')
  const [mix, setMix] = React.useState({ ...DEFAULT_MIX, ...initMix })
  const [voice, setVoice] = React.useState(initVoice || null)
  const [voiceEdit, setVoiceEdit] = React.useState(false)
  const [playing, setPlaying] = React.useState(false)
  const [recSecs, setRecSecs] = React.useState(0)      // 0 = not recording

  const videoRef = React.useRef(null)
  const musicRef = React.useRef(null)
  const voiceRef = React.useRef(null)
  const recRef = React.useRef(null)
  const recTimer = React.useRef(0)
  const chunksRef = React.useRef([])
  const recActive = React.useRef(false)

  // the attached media, straight off the local File — nothing uploads to hear it
  const [mediaUrl, setMediaUrl] = React.useState(null)
  React.useEffect(() => {
    if (!file) return
    const u = URL.createObjectURL(file)
    setMediaUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file])
  const [voiceSrc, setVoiceSrc] = React.useState(null)
  React.useEffect(() => {
    if (!voice) { setVoiceSrc(null); return }
    const u = URL.createObjectURL(voice)
    setVoiceSrc(u)
    return () => URL.revokeObjectURL(u)
  }, [voice])

  React.useEffect(() => {
    if (!sound?.audioUrl) return
    const a = new Audio()
    a.loop = true; a.preload = 'auto'; a.src = sound.audioUrl
    musicRef.current = a
    return () => { a.pause(); a.removeAttribute('src'); try { a.load() } catch { /* detached */ } musicRef.current = null }
  }, [sound?.audioUrl])
  React.useEffect(() => {
    if (!voiceSrc) { voiceRef.current = null; return }
    const b = new Audio()
    b.loop = false; b.preload = 'auto'; b.src = voiceSrc
    voiceRef.current = b
    return () => { b.pause(); voiceRef.current = null }
  }, [voiceSrc])

  // sliders are LIVE: drag while the preview runs and hear it change now
  React.useEffect(() => {
    const v = videoRef.current
    if (v && !recActive.current) v.volume = clamp01(mix.orig)
    if (musicRef.current) musicRef.current.volume = clamp01(mix.music)
    if (voiceRef.current) voiceRef.current.volume = clamp01(mix.voice)
  }, [mix])

  // the same glue the viewer uses: music modulo, voiceover absolute
  React.useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const align = () => {
      const t = v.currentTime
      const a = musicRef.current
      if (a) {
        const d = a.duration
        const at = (isFinite(d) && d > 0) ? t % d : t
        if (Math.abs(a.currentTime - at) > .3) { try { a.currentTime = at } catch { /* not seekable */ } }
      }
      const b = voiceRef.current
      if (b && !recActive.current) {
        const d = b.duration
        if (isFinite(d) && d > 0 && t >= d) { if (!b.paused) b.pause() }
        else {
          if (Math.abs(b.currentTime - t) > .3) { try { b.currentTime = t } catch { /* not seekable */ } }
          if (!v.paused && b.paused) b.play().catch(() => {})
        }
      }
    }
    v.addEventListener('timeupdate', align)
    return () => v.removeEventListener('timeupdate', align)
  }, [mediaUrl, voiceSrc])

  const stopAll = React.useCallback(() => {
    videoRef.current?.pause()
    musicRef.current?.pause()
    voiceRef.current?.pause()
    setPlaying(false)
  }, [])
  const playAll = () => {
    const v = videoRef.current
    if (v) { v.muted = false; v.loop = true; v.volume = clamp01(mix.orig); try { v.currentTime = 0 } catch { /* ignore */ } v.play().catch(() => {}) }
    const a = musicRef.current
    if (a) { a.volume = clamp01(mix.music); try { a.currentTime = 0 } catch { /* ignore */ } a.play().catch(() => {}) }
    const b = voiceRef.current
    if (b) { b.volume = clamp01(mix.voice); try { b.currentTime = 0 } catch { /* ignore */ } b.play().catch(() => {}) }
    setPlaying(true)
  }

  /* ---- voiceover recording ---- */
  const stopRec = React.useCallback(() => {
    try { recRef.current?.stop() } catch { /* already stopped */ }
  }, [])
  const startRec = async () => {
    stopAll(); setVoiceEdit(false)
    let stream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) }
    catch { showToast('Microphone unavailable — allow it to record a voiceover'); return }
    const mr = new MediaRecorder(stream)
    chunksRef.current = []
    mr.ondataavailable = (e) => chunksRef.current.push(e.data)
    mr.onstop = () => {
      stream.getTracks().forEach(t => t.stop())
      clearInterval(recTimer.current)
      recActive.current = false
      setRecSecs(0)
      const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' })
      if (blob.size) setVoice(new File([blob], 'voiceover.webm', { type: blob.type }))
      const v = videoRef.current
      if (v) { v.pause(); v.muted = false; v.loop = true; v.onended = null }
    }
    recRef.current = mr
    recActive.current = true
    /* The picture rolls SILENTLY from the top while narrating — speaker audio
       would bleed straight back into the mic. */
    const v = videoRef.current
    if (v) { v.muted = true; v.loop = false; try { v.currentTime = 0 } catch { /* ignore */ } v.play().catch(() => {}); v.onended = stopRec }
    mr.start()
    setRecSecs(1)
    const t0 = performance.now()
    recTimer.current = setInterval(() => {
      const secs = Math.max(1, Math.round((performance.now() - t0) / 1000))
      setRecSecs(secs)
      const clip = v && isFinite(v.duration) && v.duration > 0 ? v.duration : STILL_SECS
      if (secs >= Math.min(clip, REC_CAP)) stopRec()
    }, 250)
  }
  React.useEffect(() => () => { stopRec(); clearInterval(recTimer.current); stopAll() }, [stopRec, stopAll])

  const level = (key) => (v) => setMix(m => ({ ...m, [key]: clamp01(v) }))
  const toggle = (key) => () => setMix(m => ({ ...m, [key]: m[key] > 0 ? 0 : UNMUTE_TO[key] }))
  const parts = [isVideo && 'your video', sound && (sound.title || 'the added sound'), voice && 'your voiceover'].filter(Boolean)

  return (
    <div className="amx-wrap" role="dialog" aria-modal="true" aria-label="Mix your audio">
      <header className="rs-bar">
        <button className="rs-ghost" onClick={() => { stopRec(); stopAll(); onClose(null) }}>Cancel</button>
        <span className="rs-count">{playing ? 'Playing your mix' : recSecs ? 'Recording' : 'Tap the reel to hear it'}</span>
        <button className="btn btn-primary btn-sm" onClick={() => { stopRec(); stopAll(); onClose({ mix, voiceover: voice }) }}>Done</button>
      </header>

      <div className="amx-stagewrap">
        <div className="amx-stage" onClick={recSecs ? undefined : (playing ? stopAll : playAll)}>
          {mediaUrl && (isVideo
            ? <video ref={videoRef} className="rs-media" src={mediaUrl} style={{ objectFit: 'cover' }} playsInline loop preload="auto"/>
            : <img className="rs-media" src={mediaUrl} alt="" style={{ objectFit: 'contain' }}/>)}
          {!playing && !recSecs && (
            <span className="amx-playcue" aria-hidden="true"><Icon name="play" className="lg"/></span>
          )}
          {!!recSecs && <span className="amx-reccue"><i/>{recSecs}s — speak now</span>}
        </div>
      </div>

      <section className="amx-sheet">
        <div className="amx-head"><b>Mix your audio</b></div>
        <p className="amx-sub">
          {parts.length
            ? `Balancing ${parts.join(', ')} — this is exactly what viewers hear. They can mute, nothing more.`
            : 'This photo has no sound of its own — record a voiceover, or pick a sound in the composer.'}
        </p>

        {isVideo && (
          <Row icon="volume" label="Your video’s sound" value={mix.orig}
            onLevel={level('orig')} onAction={toggle('orig')}
            actionLabel={mix.orig > 0 ? 'Mute' : 'Unmute'}/>
        )}
        {sound && (
          <Row icon="music" art={sound.cover || null} label={sound.title || 'Added sound'} value={mix.music}
            onLevel={level('music')} onAction={toggle('music')}
            actionLabel={mix.music > 0 ? 'On' : 'Off'}/>
        )}
        {voice && (
          <Row icon="mic" label="Voiceover" value={mix.voice}
            onLevel={level('voice')} onAction={() => setVoiceEdit(e => !e)}
            actionLabel="Edit"/>
        )}
        {voice && voiceEdit && (
          <div className="amx-voicemenu">
            <button className="rs-chip" onClick={startRec}><Icon name="mic" className="xs"/>Re-record</button>
            <button className="rs-chip" onClick={() => { voiceRef.current?.pause(); setVoice(null); setVoiceEdit(false) }}>
              <Icon name="trash" className="xs"/>Remove
            </button>
          </div>
        )}

        {recSecs ? (
          <button className="amx-cta is-rec" onClick={stopRec}><Icon name="pause" className="sm"/>Stop recording</button>
        ) : !voice && (
          <button className="amx-cta" onClick={startRec}><Icon name="mic" className="sm"/>Add voiceover</button>
        )}
      </section>
    </div>
  )
}
