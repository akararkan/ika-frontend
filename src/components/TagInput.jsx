/* =========================================================
   TagInput — chip-style tag editor for Q&A + Research forms
   ---------------------------------------------------------
   Server-side normalization (SEARCH_API §7.2): lowercased,
   trimmed, leading '#' stripped, de-duplicated, capped at 30
   tags × 100 chars. We mirror it client-side to keep the UI
   tidy. Arabic ↔ Latin tags stay distinct on purpose — do
   not transliterate (§7.2 / §8.5).

   Autocomplete uses GET /api/v1/tags/search?prefix= (§7.6)
   so suggestions span the WHOLE catalogue, not just the top-N
   trending list. Debounced ~200ms; re-sorted by usageCount
   so popular tags surface first.
   ========================================================= */
import React from 'react'
import { Icon } from './ui.jsx'
import { api } from '../api/index.js'
import { normalizeTag, normalizeTags } from '../api/tags.js'

const MAX_TAGS = 30

export function TagInput({ value = [], onChange, scope = 'ALL', placeholder = 'Add tag, then Enter' }) {
  const [draft, setDraft] = React.useState('')
  const [suggestions, setSuggestions] = React.useState([])
  const [focused, setFocused] = React.useState(false)

  const tags = Array.isArray(value) ? value : []
  const canAddMore = tags.length < MAX_TAGS

  const tagsSet = React.useMemo(() => new Set(tags.map(t => t.toLowerCase())), [tags])
  const draftN = normalizeTag(draft)

  // Debounced prefix autocomplete against /tags/search (§7.6). Bails on empty
  // prefix; cancels in-flight requests when the user keeps typing.
  React.useEffect(() => {
    if (!focused || !draftN) { setSuggestions([]); return }
    let alive = true
    const t = setTimeout(async () => {
      try {
        const rows = await api.tags.search({ prefix: draftN, scope, limit: 10 })
        if (!alive) return
        // Re-sort "popular first" — the server returns them in tag-name order.
        const sorted = rows
          .filter(s => !tagsSet.has(s.tag))
          .sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0))
        setSuggestions(sorted)
      } catch { /* swallow — autocomplete is best-effort */ }
    }, 200)
    return () => { alive = false; clearTimeout(t) }
  }, [draftN, focused, scope, tagsSet])

  const commit = (raw) => {
    const t = normalizeTag(raw)
    if (!t || tagsSet.has(t) || !canAddMore) { setDraft(''); return }
    onChange?.(normalizeTags([...tags, t]))
    setDraft('')
  }
  const remove = (t) => onChange?.(tags.filter(x => x !== t))

  const onKey = (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
      if (draft.trim()) { e.preventDefault(); commit(draft) }
    } else if (e.key === 'Backspace' && !draft && tags.length) {
      e.preventDefault(); remove(tags[tags.length - 1])
    }
  }
  const onPaste = (e) => {
    const text = e.clipboardData?.getData('text') || ''
    if (text.includes(',')) {
      e.preventDefault()
      const incoming = text.split(/[,\n]+/).map(normalizeTag).filter(Boolean)
      onChange?.(normalizeTags([...tags, ...incoming]))
    }
  }

  return (
    <div className="tag-input">
      <div className="tag-chips">
        {tags.map(t => (
          <span key={t} className="chip on" style={{ paddingRight: 6 }}>
            <span style={{ opacity:.75 }}>#</span>{t}
            <button type="button" onClick={() => remove(t)} title="Remove" style={{
              background:'transparent', border:0, color:'inherit', display:'inline-flex',
              padding:0, marginLeft:4, cursor:'pointer'
            }}>
              <Icon name="close" className="xs"/>
            </button>
          </span>
        ))}
        <input
          className="field"
          style={{ flex:1, minWidth:140, border:0, padding:'6px 8px', background:'transparent' }}
          value={draft}
          placeholder={canAddMore ? placeholder : `Max ${MAX_TAGS} tags`}
          disabled={!canAddMore}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 120)}
        />
      </div>
      {focused && !!suggestions.length && (
        <div className="tag-suggest">
          {suggestions.map(s => (
            <button
              key={s.tag}
              type="button"
              className="tag-suggest-row"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commit(s.tag)}
            >
              <span><span style={{ color:'var(--brass)' }}>#</span>{s.tag}</span>
              <i className="muted text-xs" style={{ fontStyle:'normal' }}>{s.usageCount}</i>
            </button>
          ))}
        </div>
      )}
      <div className="text-xs muted" style={{ marginTop:6 }}>
        {tags.length}/{MAX_TAGS} tags · press Enter to add
      </div>
    </div>
  )
}
