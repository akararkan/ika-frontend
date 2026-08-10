/* =========================================================
   Sound picker — the sheet you choose a reel's sound from.

   Two ways in, and they are not interchangeable (POST_API §19;
   text search is SEARCH: sounds.md):

     · Typing searches. Relevance-ranked (title over artist,
       most-used sounds winning ties), so rows render in the
       order they arrive — never re-sorted here.
     · An empty box browses ONE category of the catalogue,
       unranked. There is no endpoint that lists everything, so
       "All" is search-only.

   EVERY ROW CAN BE HEARD BEFORE IT IS CHOSEN. That is the whole
   point of the surface, so the preview is not a silent toggle:
   a row that is loading says so, a row that is playing shows
   its position, and a row whose audio will not play says THAT
   instead of just staying quiet. (Silence here is usually the
   media endpoint ignoring Range requests — BACKEND_NOTES #1 —
   which no amount of client code can fix, but which the author
   deserves to be told about rather than left guessing.)

   "Saved" is this device's own shelf: the sounds API has no
   favourites endpoint, so the row is kept in localStorage and
   the tab is labelled for what it actually is.
   ========================================================= */
import React from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './ui.jsx'
import { api } from '../api/index.js'

const CATEGORIES = [
  ['NASHEED', 'Nasheed'],
  ['QURAN_RECITATION', 'Recitation'],
  ['LECTURE_CLIP', 'Lecture'],
  ['NATURE', 'Nature'],
  ['ORIGINAL', 'Original'],
  ['PLATFORM_MUSIC', 'Platform'],
]
const labelOf = (k) => (CATEGORIES.find(c => c[0] === k) || ['', k])[1]
const SAVED_KEY = 'ika_saved_sounds'

function readSaved() {
  try { const v = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}
function writeSaved(rows) { try { localStorage.setItem(SAVED_KEY, JSON.stringify(rows.slice(0, 100))) } catch { /* private mode */ } }

/** useCount is the ranking signal, so it earns a place on the row — but only
 *  once a sound has actually been used. "0 uses" is noise on a fresh library. */
function usesLabel(n) {
  const v = Number(n) || 0
  if (!v) return ''
  return v === 1 ? '1 use' : `${v.toLocaleString()} uses`
}

const mmss = (s) => {
  const t = Math.max(0, Math.floor(Number(s) || 0))
  return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0')
}

/* ---------------------------------------------------------------
   The attach control: a chip once something is chosen, a button
   before that. Both open the sheet.
   --------------------------------------------------------------- */
export function SoundPicker({ value, onChange }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      {value ? (
        <div className="snd-chip">
          <span className="snd-chip-art" style={value.cover ? { backgroundImage: `url("${value.cover}")` } : undefined}>
            {!value.cover && <Icon name="music" className="xs"/>}
          </span>
          <span className="snd-chip-meta">
            <b>{value.title}</b>
            {value.artist && <small>{value.artist}</small>}
          </span>
          <button className="snd-chip-btn" title="Change sound" aria-label="Change sound" onClick={() => setOpen(true)}>
            <Icon name="music" className="sm"/>
          </button>
          <button className="snd-chip-btn" title="Remove sound" aria-label="Remove sound" onClick={() => onChange(null)}>
            <Icon name="close" className="sm"/>
          </button>
        </div>
      ) : (
        <button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }} onClick={() => setOpen(true)}>
          <Icon name="music" className="sm"/>Add a sound
        </button>
      )}
      {open && <SoundSheet chosen={value} onPick={(s) => { onChange(s); setOpen(false) }} onClose={() => setOpen(false)}/>}
    </>
  )
}

/* ---------------------------------------------------------------
   The sheet itself — portaled to <body> so the compose modal's
   own transform/overflow can never clip or scroll it.
   --------------------------------------------------------------- */
function SoundSheet({ chosen, onPick, onClose }) {
  const [cat, setCat] = React.useState('NASHEED')     // null === "All" (search-only)
  const [tab, setTab] = React.useState('BROWSE')      // BROWSE | SAVED
  const [q, setQ] = React.useState('')
  const [list, setList] = React.useState([])
  const [loading, setLoading] = React.useState(false)
  const [err, setErr] = React.useState(false)
  const [saved, setSaved] = React.useState(readSaved)

  const term = q.trim()
  const searching = !!term
  const browsingSaved = tab === 'SAVED' && !searching
  const stranded = !searching && !cat && tab === 'BROWSE'    // "All" with nothing typed

  React.useEffect(() => {
    if (browsingSaved) { setList(saved); setErr(false); setLoading(false); return }
    if (stranded) { setList([]); setErr(false); setLoading(false); return }
    let alive = true
    setLoading(true)
    // 250ms: about one request per word for a fast typist, still fast enough
    // that the list feels attached to the keyboard. Browsing has nothing to
    // debounce — a chip is one deliberate click — so it fires immediately.
    const t = setTimeout(() => {
      const run = searching
        ? api.sounds.search(term, { category: cat || undefined, limit: 30 })
        : api.sounds.byCategory(cat)
      // Rows arrive pre-adapted (soundFrom): absolutised urls, `id`, `artist`,
      // `useCount`. Re-mapping raw DTO fields here would silently blank them.
      run
        .then(rows => { if (alive) { setList(rows || []); setErr(false) } })
        .catch(() => { if (alive) { setList([]); setErr(true) } })
        .finally(() => { if (alive) setLoading(false) })
    }, searching ? 250 : 0)
    return () => { alive = false; clearTimeout(t) }
  }, [cat, term, searching, stranded, browsingSaved, saved])

  /* ---- preview -------------------------------------------------------
     One element for the whole sheet: two rows can never talk over each
     other, and the sheet closing can never leave a sound playing. */
  const audioRef = React.useRef(null)
  const [cue, setCue] = React.useState({ id: null, state: 'idle', at: 0, dur: 0 })  // state: loading|playing|error
  const stop = React.useCallback(() => {
    const a = audioRef.current
    if (a) { a.pause() }
    setCue({ id: null, state: 'idle', at: 0, dur: 0 })
  }, [])
  React.useEffect(() => () => { audioRef.current?.pause() }, [])
  // A preview whose row just dropped out of the results would otherwise keep
  // playing with no visible control left to stop it.
  React.useEffect(() => {
    if (cue.id && !list.some(s => s.id === cue.id)) stop()
  }, [list, cue.id, stop])

  const preview = (s) => {
    if (cue.id === s.id && cue.state !== 'error') { stop(); return }
    if (!audioRef.current) audioRef.current = new Audio()
    const a = audioRef.current
    a.pause()
    a.onerror = () => setCue(c => (c.id === s.id ? { ...c, state: 'error' } : c))
    a.onloadedmetadata = () => setCue(c => (c.id === s.id ? { ...c, dur: isFinite(a.duration) ? a.duration : 0 } : c))
    a.ontimeupdate = () => setCue(c => (c.id === s.id ? { ...c, at: a.currentTime } : c))
    a.onended = () => stop()
    a.src = s.audioUrl || ''
    setCue({ id: s.id, state: 'loading', at: 0, dur: 0 })
    if (!s.audioUrl) { setCue({ id: s.id, state: 'error', at: 0, dur: 0 }); return }
    const p = a.play()
    if (p && p.then) p.then(() => setCue(c => (c.id === s.id ? { ...c, state: 'playing' } : c)))
      /* A rejected play() is the honest failure case: autoplay policy (never,
         here — this IS a click), a decode error, or a media endpoint that will
         not stream. Whatever it is, say it rather than sit there mute. */
      .catch(() => setCue(c => (c.id === s.id ? { ...c, state: 'error' } : c)))
  }

  const isSaved = (id) => saved.some(s => s.id === id)
  const toggleSave = (s) => {
    setSaved(prev => {
      const next = prev.some(x => x.id === s.id) ? prev.filter(x => x.id !== s.id) : [{ ...s }, ...prev]
      writeSaved(next)
      return next
    })
  }
  const choose = (s) => { stop(); onPick(s) }

  const heading = browsingSaved ? 'Saved on this device'
    : searching ? `Best matches · ${cat ? labelOf(cat) : 'every category'}`
    : cat ? labelOf(cat) : ''

  return createPortal(
    <div className="snd-scrim" onClick={e => { if (e.target === e.currentTarget) { stop(); onClose() } }}>
      <aside className="snd-sheet" role="dialog" aria-modal="true" aria-label="Choose a sound">
        <div className="snd-grab" aria-hidden="true"/>
        <div className="snd-top">
          <b>Choose a sound</b>
          <button className="icon-btn" onClick={() => { stop(); onClose() }} aria-label="Close"><Icon name="close" className="sm"/></button>
        </div>

        <div className="snd-search">
          <Icon name="search" className="sm"/>
          <input value={q} onChange={e => setQ(e.target.value)} dir="auto" autoFocus
            placeholder="Search music" aria-label="Search sounds by title or artist"/>
          {!!q && <button className="icon-btn" onClick={() => setQ('')} aria-label="Clear search"><Icon name="close" className="xs"/></button>}
        </div>

        <div className="snd-chips">
          <button className={'snd-tab' + (tab === 'BROWSE' && !searching ? ' on' : '')}
            onClick={() => { setTab('BROWSE'); if (!cat) setCat('NASHEED') }}>
            <Icon name="list" className="xs"/>Browse
          </button>
          <button className={'snd-tab' + (browsingSaved ? ' on' : '')} onClick={() => setTab('SAVED')}>
            <Icon name="bookmark" className="xs"/>Saved{saved.length ? ` · ${saved.length}` : ''}
          </button>
          <span className="snd-chip-sep" aria-hidden="true"/>
          <button className={'snd-tab' + (cat === null && tab === 'BROWSE' ? ' on' : '')}
            title="Search every category" onClick={() => { setTab('BROWSE'); setCat(null) }}>All</button>
          {CATEGORIES.map(([k, label]) => (
            <button key={k} className={'snd-tab' + (cat === k && tab === 'BROWSE' ? ' on' : '')}
              onClick={() => { setTab('BROWSE'); setCat(k) }}>{label}</button>
          ))}
        </div>

        <div className="snd-scroll">
          {!!heading && <div className="snd-sec"><h4>{heading}</h4>{!browsingSaved && !!list.length && <span className="muted text-xs">{list.length === 1 ? '1 sound' : `${list.length} sounds`}</span>}</div>}

          {stranded ? <p className="snd-note">Type to search every category, or pick one above to browse it.</p>
            : loading ? <p className="snd-note">{searching ? 'Searching…' : 'Loading sounds…'}</p>
            : err ? <p className="snd-note">{searching ? 'Search didn’t run. Try again, or browse a category above.' : 'Couldn’t load this category.'}</p>
            : !list.length ? (
              browsingSaved ? <p className="snd-note">Nothing saved yet — tap the bookmark on a sound to keep it here.</p>
                /* An empty search is genuinely ambiguous: when Elasticsearch is
                   down the endpoint answers `[]` rather than a 5xx, so "no
                   matches" and "search is offline" are indistinguishable from
                   here. Hence the fallback is named every time — browsing never
                   touches the index. */
                : searching ? (
                  <>
                    <p className="snd-note">Nothing matched “{term}”{cat ? ` in ${labelOf(cat)}` : ''}.</p>
                    <p className="snd-note">Try a shorter word{cat ? ', search every category,' : ''} or browse a category above.</p>
                  </>
                ) : <p className="snd-note">No sounds in this category yet.</p>
            ) : list.map(s => {
              const on = cue.id === s.id
              const sub = [s.artist, usesLabel(s.useCount)].filter(Boolean).join(' · ')
              const pos = on && cue.dur ? `${mmss(cue.at)} / ${mmss(cue.dur)}` : ''
              return (
                <div key={s.id} className={'snd-row' + (chosen?.id === s.id ? ' picked' : '') + (on && cue.state === 'error' ? ' bad' : '')}>
                  <button className="snd-row-main" onClick={() => choose(s)}>
                    <span className="snd-art" style={s.cover ? { backgroundImage: `url("${s.cover}")` } : undefined}>
                      {!s.cover && <Icon name="music" className="sm"/>}
                      {on && cue.state === 'playing' && <i className="snd-eq" aria-hidden="true"><em/><em/><em/></i>}
                    </span>
                    <span className="snd-meta">
                      <b>{s.title}</b>
                      <small>
                        {on && cue.state === 'error' ? 'Couldn’t play this sound — it may still work in the reel'
                          : on && cue.state === 'loading' ? 'Loading…'
                          : pos || sub}
                      </small>
                    </span>
                  </button>
                  <button className={'snd-save' + (isSaved(s.id) ? ' on' : '')} onClick={() => toggleSave(s)}
                    aria-pressed={isSaved(s.id)} aria-label={isSaved(s.id) ? 'Remove from saved' : 'Save sound'}
                    title={isSaved(s.id) ? 'Remove from saved' : 'Save sound'}>
                    <Icon name="bookmark" className="sm"/>
                  </button>
                  <button className={'snd-play' + (on ? ' on' : '')} onClick={() => preview(s)}
                    aria-label={on && cue.state === 'playing' ? `Stop preview of ${s.title}` : `Play preview of ${s.title}`}
                    title={on && cue.state === 'playing' ? 'Stop' : 'Play'}>
                    <Icon name={on && cue.state === 'playing' ? 'pause' : on && cue.state === 'loading' ? 'clock' : 'play'} className="sm"/>
                  </button>
                  {on && cue.dur > 0 && (
                    <span className="snd-prog" aria-hidden="true"><i style={{ width: `${Math.min(100, (cue.at / cue.dur) * 100)}%` }}/></span>
                  )}
                </div>
              )
            })}
        </div>

        <div className="snd-foot">
          <span className="muted text-xs">Tap a row to use it · tap ▶ to hear it first</span>
        </div>
      </aside>
    </div>,
    document.body,
  )
}
