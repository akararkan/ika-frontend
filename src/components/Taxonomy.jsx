/* =========================================================
   Knowledge-taxonomy UI — the two pickers over the fixed
   reference vocabularies (TAXONOMY_API §1-3):

     · <SpecializationPicker> — many topics, ORDERED. The list
       is saved with replace-all semantics, so what this widget
       holds IS the profile's new list, position included.
     · <MadhhabSelect>        — one school, or none.

   Both vocabularies are trilingual and read-only (operator-
   managed rows, no write API), so these pickers only ever
   choose from what the server already knows — a free-text
   "other" would have nowhere to go.

   Names render in the READER's language with the api layer's
   fallback, and every chip carries dir="auto" so an Arabic or
   Kurdish name is not laid out as though it were English.
   ========================================================= */
import React from 'react'
import { Icon } from './ui.jsx'
import { api, taxonomyName } from '../api/index.js'
import { useAuth } from '../context/AuthContext.jsx'

/* The language the vocabularies are rendered in: the signed-in reader's own
   content language (EN | AR | KU), English until they pick one. */
export function useTaxonomyLang() {
  const { user } = useAuth() || {}
  return (user?.contentLanguage || 'EN').toUpperCase()
}

/** One vocabulary, session-cached by the api layer. `state` is what the UI
 *  needs to tell "still loading" from "the operator has not added any rows
 *  yet" — an empty picker with no explanation reads as a bug. */
export function useVocabulary(kind) {
  const [rows, setRows] = React.useState([])
  const [state, setState] = React.useState('loading')   // loading | ready | empty | error
  const [nonce, setNonce] = React.useState(0)

  React.useEffect(() => {
    let alive = true
    setState('loading')
    api[kind].all()
      .then(list => { if (!alive) return; setRows(list); setState(list.length ? 'ready' : 'empty') })
      .catch(() => { if (alive) setState('error') })
    return () => { alive = false }
  }, [kind, nonce])

  // Re-read after an operator adds rows, without a page reload.
  const reload = React.useCallback(() => { api[kind].forget(); setNonce(n => n + 1) }, [kind])
  return { rows, state, reload }
}

/* =========================================================
   Specializations — search, pick, order
   ========================================================= */
export function SpecializationPicker({ value = [], onChange, lang, disabled }) {
  const uiLang = useTaxonomyLang()
  const L = lang || uiLang
  const [q, setQ] = React.useState('')
  const [hits, setHits] = React.useState([])
  const [open, setOpen] = React.useState(false)
  const [state, setState] = React.useState('idle')      // idle | loading | error
  const dragIx = React.useRef(null)

  const picked = React.useMemo(() => new Set(value.map(v => Number(v.id))), [value])

  /* Debounced lookup. A BLANK query is not a no-op here (it is for tags): the
     documented picker case is exactly "no query → the whole vocabulary", which
     is what makes this browsable rather than guess-the-word. */
  React.useEffect(() => {
    if (!open) return
    let alive = true
    setState('loading')
    const t = setTimeout(() => {
      api.topics.search(q)
        .then(rows => { if (alive) { setHits(rows); setState('idle') } })
        .catch(() => { if (alive) { setHits([]); setState('error') } })
    }, 200)
    return () => { alive = false; clearTimeout(t) }
  }, [q, open])

  const add = (row) => {
    if (disabled || picked.has(Number(row.id))) return
    onChange?.([...value, row])
    setQ('')
  }
  const remove = (id) => onChange?.(value.filter(v => Number(v.id) !== Number(id)))
  const move = (from, to) => {
    if (to < 0 || to >= value.length || from === to) return
    const next = [...value]
    const [row] = next.splice(from, 1)
    next.splice(to, 0, row)
    onChange?.(next)
  }

  const suggestions = hits.filter(r => !picked.has(Number(r.id)))

  return (
    <div className="tx-pick">
      {value.length > 0 && (
        <ul className="tx-chips" aria-label="Chosen specializations, in the order they appear on your profile">
          {value.map((row, i) => (
            <li
              key={row.id}
              className="tx-chip"
              draggable={!disabled}
              onDragStart={() => { dragIx.current = i }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { const from = dragIx.current; dragIx.current = null; if (from != null) move(from, i) }}
              /* Drag is for the mouse; Alt+arrows are the same move for
                 everyone else. Delete/Backspace removes the focused chip. */
              onKeyDown={(e) => {
                if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowUp')) { e.preventDefault(); move(i, i - 1) }
                else if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowDown')) { e.preventDefault(); move(i, i + 1) }
                else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(row.id) }
              }}
              tabIndex={0}
              title="Drag to reorder — or Alt + arrow keys"
            >
              <span className="tx-ord" aria-hidden="true">{i + 1}</span>
              <bdi dir="auto">{taxonomyName(row, L)}</bdi>
              <button type="button" className="tx-x" disabled={disabled}
                onClick={() => remove(row.id)} aria-label={`Remove ${taxonomyName(row, L)}`}>
                <Icon name="close" className="xs"/>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="tx-field">
        <Icon name="search" className="xs"/>
        <input
          className="tx-input"
          value={q}
          disabled={disabled}
          placeholder="Search topics — English, عربي or کوردی"
          onChange={e => setQ(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 140)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setOpen(false); e.currentTarget.blur() }
            else if (e.key === 'Enter') { e.preventDefault(); if (suggestions[0]) add(suggestions[0]) }
          }}
        />
      </div>

      {open && (
        <div className="tx-menu">
          {state === 'loading' && !suggestions.length && <div className="tx-note">Loading topics…</div>}
          {state === 'error' && <div className="tx-note">Could not load the topic list.</div>}
          {state === 'idle' && !suggestions.length && (
            <div className="tx-note">
              {q.trim()
                ? 'No topic matches that.'
                : (value.length ? 'Every topic is already on your profile.' : 'No topics have been added to the platform yet.')}
            </div>
          )}
          {suggestions.map(row => (
            <button
              key={row.id}
              type="button"
              className="tx-opt"
              onMouseDown={(e) => e.preventDefault()}   /* keep focus so blur doesn't close first */
              onClick={() => add(row)}
            >
              <bdi dir="auto">{taxonomyName(row, L)}</bdi>
              {/* the other two names, so a picker in one language is still
                  recognisable to someone who knows the term in another */}
              <small className="muted" dir="auto">
                {[row.nameEn, row.nameAr, row.nameCkb].filter(n => n && n !== taxonomyName(row, L)).join(' · ')}
              </small>
            </button>
          ))}
        </div>
      )}

      <p className="tx-hint muted text-xs">
        {value.length
          ? `${value.length} chosen · they appear on your profile in this order — drag a chip, or Alt + arrow keys.`
          : 'Pick the subject areas you want shown on your profile.'}
      </p>
    </div>
  )
}

/* =========================================================
   Madhhab — one, or none
   ========================================================= */
export function MadhhabSelect({ value, onChange, lang, disabled }) {
  const uiLang = useTaxonomyLang()
  const L = lang || uiLang
  const { rows, state } = useVocabulary('madhhabs')
  const id = value === null || value === undefined || value === '' ? '' : String(value)

  /* A stored id the vocabulary no longer lists must stay selected rather than
     silently becoming "not specified" — that would quietly rewrite a person's
     profile the next time they saved anything else. */
  const known = rows.some(r => String(r.id) === id)

  return (
    <>
      <select
        className="field"
        value={id}
        disabled={disabled || state === 'loading'}
        onChange={e => onChange?.(e.target.value === '' ? null : Number(e.target.value))}
      >
        <option value="">{state === 'loading' ? 'Loading…' : 'Not specified'}</option>
        {rows.map(r => <option key={r.id} value={r.id}>{taxonomyName(r, L)}</option>)}
        {id && !known && state !== 'loading' && <option value={id}>Currently set (#{id})</option>}
      </select>
      {state === 'empty' && <small className="muted text-xs">No schools have been added to the platform yet.</small>}
      {state === 'error' && <small className="muted text-xs">Could not load the list of schools.</small>}
    </>
  )
}
