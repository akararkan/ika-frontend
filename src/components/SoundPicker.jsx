/* =========================================================
   Sound picker — search the library by name, or browse it by
   category, and choose a sound (POST_API §19; text search is
   SEARCH: sounds.md). The chosen sound's id is sent as
   `soundId` on post/reel create.
   ---------------------------------------------------------
   Two modes feed one list, and they are not interchangeable:

     · Typing searches. Relevance-ranked (title over artist,
       most-used sounds winning ties), so the rows render in
       the order they arrive — never re-sorted here.
     · An empty box browses a single category out of the
       catalogue, unranked, exactly as this panel always has.

   The category chips stay live in BOTH modes: the search
   endpoint takes an optional category, so a chip narrows the
   query instead of being ignored. "All" exists because the
   common case is a half-remembered title whose category the
   user cannot guess — but it is search-only, since there is
   no endpoint that lists the whole catalogue.
   ========================================================= */
import React from 'react'
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

/** useCount is the ranking signal, so it earns a place on the row — but only
 *  once a sound has actually been used. "0 uses" is noise on a fresh library. */
function usesLabel(n) {
  const v = Number(n) || 0
  if (!v) return ''
  return v === 1 ? '1 use' : `${v.toLocaleString()} uses`
}

export function SoundPicker({ value, onChange }) {
  const [open, setOpen] = React.useState(false)
  const [cat, setCat] = React.useState('NASHEED')          // null === "All", search-only
  const [q, setQ] = React.useState('')
  const [list, setList] = React.useState([])
  const [loading, setLoading] = React.useState(false)
  const [err, setErr] = React.useState(false)
  const [playing, setPlaying] = React.useState(null)
  const audioRef = React.useRef(null)

  const term = q.trim()
  const searching = !!term
  const stranded = !searching && !cat                      // "All" with nothing typed

  React.useEffect(() => {
    if (!open) return
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
  }, [open, cat, term, searching, stranded])

  // A preview whose row just dropped out of the results would otherwise keep
  // playing with no visible control left to stop it.
  React.useEffect(() => {
    if (playing && !list.some(s => s.id === playing)) { audioRef.current?.pause(); setPlaying(null) }
  }, [list, playing])

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

      <div className="ch-list-search" style={{ marginBottom: 10 }}>
        <Icon name="search" className="sm"/>
        <input className="field" value={q} onChange={e => setQ(e.target.value)} dir="auto"
          placeholder="Search sounds by title or artist…" aria-label="Search sounds" autoFocus/>
        {!!q && (
          <button className="icon-btn ch-search-clear" onClick={() => setQ('')}
            aria-label="Clear search" title="Clear search">
            <Icon name="close" className="xs"/>
          </button>
        )}
      </div>

      <div className="chips" style={{ marginBottom: 8 }}>
        <button className={'chip ' + (cat === null ? 'on' : '')} title="Search every category"
          onClick={() => setCat(null)}>All</button>
        {CATEGORIES.map(([k, label]) => (
          <button key={k} className={'chip ' + (cat === k ? 'on' : '')} onClick={() => setCat(k)}>{label}</button>
        ))}
      </div>

      {/* Which mode is running is not obvious from the chips alone — both modes
          keep one lit — so the list says it in words. */}
      {!stranded && (
        <p className="muted text-sm" style={{ marginBottom: 8 }}>
          {searching
            ? `Best matches first · ${cat ? labelOf(cat) : 'every category'}`
            : `Browsing ${labelOf(cat)}`}
        </p>
      )}

      {stranded ? <p className="muted text-sm">Type to search every category, or pick one above to browse it.</p>
        : loading ? <p className="muted text-sm">{searching ? 'Searching…' : 'Loading sounds…'}</p>
        : err ? <p className="muted text-sm">{searching ? 'Search didn’t run. Try again, or browse a category above.' : 'Couldn’t load this category.'}</p>
        : !list.length ? (
          /* An empty search is genuinely ambiguous: when Elasticsearch is down
             the endpoint answers `[]` rather than a 5xx, so "no matches" and
             "search is offline" are indistinguishable from here. Hence the
             fallback is named every time — browsing never touches the index. */
          searching
            ? (
              <>
                <p className="muted text-sm">Nothing matched “{term}”{cat ? ` in ${labelOf(cat)}` : ''}.</p>
                <p className="muted text-sm">Try a shorter word{cat ? ', search every category,' : ''} or browse a category above.</p>
              </>
            )
            : <p className="muted text-sm">No sounds in this category yet.</p>
        )
        : (
          <div className="rail-list" style={{ maxHeight: 220, overflow: 'auto' }}>
            {list.map(s => {
              const sub = [s.artist, usesLabel(s.useCount)].filter(Boolean).join(' · ')
              return (
                <div key={s.id} className="rail-row">
                  <button className="src-ic" style={{ background: 'var(--emerald-deep)', border: 0 }} onClick={() => preview(s)}>
                    <Icon name={playing === s.id ? 'pause' : 'play'} className="sm"/>
                  </button>
                  <div className="rail-info"><div className="rail-name"><b>{s.title}</b></div>{sub && <div className="rail-sub">{sub}</div>}</div>
                  <button className="btn btn-primary btn-sm" onClick={() => select(s)}>Use</button>
                </div>
              )
            })}
          </div>
        )}
    </div>
  )
}
