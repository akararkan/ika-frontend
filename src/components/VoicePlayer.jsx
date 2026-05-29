/* =========================================================
   VoicePlayer — waveform voice-note player.
   Plays a REAL <audio> file: the waveform fills as it plays,
   click the wave to seek, time counts up live. Used by voice
   posts and Q&A voice answers / reanswers.
   ========================================================= */
import React from 'react'
import { Icon } from './ui.jsx'

const N = 46   // number of waveform bars

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

export function VoicePlayer({ src, duration, className = '' }) {
  const audioRef = React.useRef(null)
  const waveRef = React.useRef(null)
  const [playing, setPlaying] = React.useState(false)
  const [cur, setCur] = React.useState(0)
  const [dur, setDur] = React.useState(typeof duration === 'number' ? duration : 0)
  const bars = React.useMemo(() => waveform(src || ''), [src])

  const onLoaded = () => { const a = audioRef.current; if (a && isFinite(a.duration)) setDur(a.duration) }
  const toggle = () => { const a = audioRef.current; if (!a) return; if (a.paused) a.play().catch(() => {}); else a.pause() }
  const seek = (e) => {
    const a = audioRef.current, el = waveRef.current; if (!a || !el || !dur) return
    const rect = el.getBoundingClientRect()
    const p = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    a.currentTime = p * dur; setCur(a.currentTime)
  }

  const progress = dur ? cur / dur : 0
  const idx = progress * N
  const total = dur || (typeof duration === 'number' ? duration : 0)
  const totalLabel = total ? fmt(total) : (typeof duration === 'string' ? duration : '0:00')
  const timeLabel = (playing || cur > 0) ? fmt(cur) : totalLabel

  return (
    <div className={'vp ' + className}>
      <div className="vp-top">
        <button className={'vp-play' + (playing ? ' playing' : '')} onClick={toggle} disabled={!src}
          title={src ? (playing ? 'Pause' : 'Play') : 'Audio unavailable'} aria-label={playing ? 'Pause' : 'Play'}>
          <Icon name={playing ? 'pause' : 'play'}/>
        </button>
        <div className="vp-wave" ref={waveRef} onClick={seek}>
          {bars.map((h, i) => (
            <i key={i} style={{ height: (h * 100) + '%' }}
              className={(i < idx ? 'on' : '') + (playing && Math.abs(i - idx) < 1.5 ? ' live' : '')}/>
          ))}
        </div>
      </div>
      <div className="vp-bot">
        <span className="vp-tag"><Icon name="mic"/>Voice note</span>
        <span className="vp-time">{timeLabel}</span>
      </div>
      {src && (
        <audio ref={audioRef} src={src} preload="metadata" style={{ display: 'none' }}
          onLoadedMetadata={onLoaded}
          onTimeUpdate={() => { const a = audioRef.current; if (a) setCur(a.currentTime) }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); setCur(0) }}/>
      )}
    </div>
  )
}
