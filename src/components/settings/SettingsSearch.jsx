/* =========================================================
   Settings search — find a control by its name, not its tab.
   ---------------------------------------------------------
   Twenty tabs is more than anyone can hold in their head, and
   the things people come looking for ("dark mode", "quiet
   hours", "delete my account") sit in cards whose titles don't
   contain those words. This searches SETTINGS_INDEX (title,
   card and the words people actually type) and navigates to
   /settings/{tab}#{anchor}, which the shell then scrolls,
   focuses and flashes.

   Keyboard: ⌘K / Ctrl-K focuses it from anywhere on the page,
   ↑/↓ move, Enter opens, Escape closes then clears.
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../ui.jsx'
import { searchSettings } from './index.data.js'

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform || '')

export function SettingsSearch() {
  const navigate = useNavigate()
  const [q, setQ] = React.useState('')
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(0)
  const inputRef = React.useRef(null)
  const wrapRef = React.useRef(null)
  const listId = React.useId()

  const hits = React.useMemo(() => (q.trim() ? searchSettings(q) : []), [q])

  /* ⌘K / Ctrl-K from anywhere on the settings page. */
  React.useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* Click-away closes the popover but keeps the query, so returning to the
     field re-opens the same result list. */
  React.useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const go = (row) => {
    if (!row) return
    setOpen(false)
    setQ('')
    inputRef.current?.blur()
    navigate(`/settings/${row.tab}#${row.anchor}`)
  }

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { if (open) setOpen(false); else setQ(''); return }
    if (!hits.length) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(i => (i + 1) % hits.length) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); setActive(i => (i - 1 + hits.length) % hits.length) }
    else if (e.key === 'Enter') { e.preventDefault(); go(hits[active]) }
  }

  const showPop = open && !!q.trim()

  return (
    <div className="stx-find" ref={wrapRef}>
      <div className="stx-find-wrap">
        <Icon name="search" aria-hidden="true"/>
        <input
          ref={inputRef}
          className="stx-find-input"
          type="search"
          role="combobox"
          aria-expanded={showPop}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showPop && hits[active] ? `${listId}-${active}` : undefined}
          aria-label="Search settings"
          placeholder="Search settings…"
          value={q}
          onChange={(e) => { setQ(e.target.value); setActive(0); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {!q && <span className="stx-find-kbd" aria-hidden="true">{isMac ? '⌘K' : 'Ctrl K'}</span>}
      </div>

      {showPop && (
        <div className="stx-find-pop" id={listId} role="listbox" aria-label="Settings results">
          {hits.length ? hits.map((row, i) => (
            <button
              key={`${row.tab}-${row.anchor}-${row.title}`}
              type="button"
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={'stx-find-opt' + (i === active ? ' on' : '')}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(row)}
            >
              <Icon name="chevright" aria-hidden="true"/>
              <span className="stx-find-txt">
                <b>{row.title}</b>
                <span className="stx-find-path">{row.card}</span>
              </span>
            </button>
          )) : (
            <p className="stx-find-none">Nothing matches “{q.trim()}”.</p>
          )}
        </div>
      )}
    </div>
  )
}
