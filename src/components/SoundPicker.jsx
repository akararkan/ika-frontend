/* =========================================================
   Sound picker — browse the library by category and choose a
   sound (POST_API §19). The chosen sound's id is sent as
   `soundId` on post/reel create.
   ========================================================= */
import React from 'react'
import { Icon } from './ui.jsx'
import { api, assetUrl } from '../api/index.js'

const CATEGORIES = [
  ['NASHEED', 'Nasheed'],
  ['QURAN_RECITATION', 'Recitation'],
  ['LECTURE_CLIP', 'Lecture'],
  ['NATURE', 'Nature'],
  ['ORIGINAL', 'Original'],
  ['PLATFORM_MUSIC', 'Platform'],
]

export function SoundPicker({ value, onChange }) {
  const [open, setOpen] = React.useState(false)
  const [cat, setCat] = React.useState('NASHEED')
  const [list, setList] = React.useState([])
  const [loading, setLoading] = React.useState(false)
  const [playing, setPlaying] = React.useState(null)
  const audioRef = React.useRef(null)

  React.useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    api.sounds.byCategory(cat)
      .then(rows => { if (alive) setList((rows || []).map(s => ({ id: s.soundId, title: s.title, artist: s.artistName, audioUrl: assetUrl(s.audioUrl), duration: s.durationSeconds, cover: assetUrl(s.coverArtUrl) }))) })
      .catch(() => { if (alive) setList([]) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open, cat])

  React.useEffect(() => () => { audioRef.current?.pause() }, [])

  const preview = (s) => {
    if (!audioRef.current) audioRef.current = new Audio()
    const a = audioRef.current
    if (playing === s.id) { a.pause(); setPlaying(null); return }
    a.src = s.audioUrl; a.play().catch(() => {}); setPlaying(s.id)
    a.onended = () => setPlaying(null)
  }
  const select = (s) => { audioRef.current?.pause(); setPlaying(null); onChange(s); setOpen(false) }
  const clear = () => { audioRef.current?.pause(); setPlaying(null); onChange(null) }

  if (value) {
    return (
      <div className="cm-attach" style={{ marginTop: 12 }}>
        <div className="flex-c gap-8" style={{ color: 'var(--emerald-deep)', fontWeight: 600, fontSize: 13, minWidth: 0 }}>
          <Icon name="music" className="sm"/>
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value.title}{value.artist ? ` · ${value.artist}` : ''}</span>
        </div>
        <div className="cm-attach-row">
          <button title="Change sound" onClick={() => setOpen(true)}><Icon name="music" className="sm"/></button>
          <button title="Remove sound" onClick={clear}><Icon name="close" className="sm"/></button>
        </div>
      </div>
    )
  }

  if (!open) {
    return (
      <button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }} onClick={() => setOpen(true)}>
        <Icon name="music" className="sm"/>Add a sound
      </button>
    )
  }

  return (
    <div className="card card-pad" style={{ marginTop: 12, background: 'var(--card-2)' }}>
      <div className="flex-c" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <b className="text-sm">Choose a sound</b>
        <button className="icon-btn" onClick={() => setOpen(false)}><Icon name="close" className="sm"/></button>
      </div>
      <div className="chips" style={{ marginBottom: 12 }}>
        {CATEGORIES.map(([k, label]) => (
          <button key={k} className={'chip ' + (cat === k ? 'on' : '')} onClick={() => setCat(k)}>{label}</button>
        ))}
      </div>
      {loading ? <p className="muted text-sm">Loading sounds…</p>
        : !list.length ? <p className="muted text-sm">No sounds in this category yet.</p>
        : (
          <div className="rail-list" style={{ maxHeight: 220, overflow: 'auto' }}>
            {list.map(s => (
              <div key={s.id} className="rail-row">
                <button className="src-ic" style={{ background: 'var(--emerald-deep)', border: 0 }} onClick={() => preview(s)}>
                  <Icon name={playing === s.id ? 'pause' : 'play'} className="sm"/>
                </button>
                <div className="rail-info"><div className="rail-name"><b>{s.title}</b></div><div className="rail-sub">{s.artist}</div></div>
                <button className="btn btn-primary btn-sm" onClick={() => select(s)}>Use</button>
              </div>
            ))}
          </div>
        )}
    </div>
  )
}
