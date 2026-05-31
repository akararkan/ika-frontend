/* =========================================================
   <MentionBox> — an <input>/<textarea> drop-in with @-mention
   autocomplete. Type "@" + a letter and a popup of matching
   users appears (api.users.search); pick with ↑/↓ + Enter/Tab,
   click, or Esc to dismiss. Inserts "@handle ".

   Controlled like a native field: pass value + onChange (the
   parent's `e => setX(e.target.value)` works unchanged, because
   chosen insertions call onChange with { target:{ value } }).
   ========================================================= */
import React from 'react'
import { Avatar } from './ui.jsx'
import { api } from '../api/index.js'

// The "@token" immediately before the caret (no whitespace inside it).
const MENTION_RE = /(?:^|\s)@([\w.]*)$/

export function MentionBox({ as = 'input', value = '', onChange, onKeyDown, className = '', ...rest }) {
  const Tag = as
  const ref = React.useRef(null)
  const anchor = React.useRef({ start: 0, caret: 0 })   // where the active @token sits
  const caretToSet = React.useRef(null)                 // caret to restore after an insert
  const seq = React.useRef(0)                            // drops stale search responses
  const [items, setItems] = React.useState([])
  const [active, setActive] = React.useState(0)
  const [open, setOpen] = React.useState(false)

  // Restore the caret right after a chosen insertion re-renders the field.
  React.useLayoutEffect(() => {
    if (caretToSet.current != null && ref.current) {
      try { ref.current.setSelectionRange(caretToSet.current, caretToSet.current) } catch { /* noop */ }
      caretToSet.current = null
    }
  })

  const search = (q) => {
    const mine = ++seq.current
    api.users.search(q, { size: 6 })
      .then(list => {
        if (mine !== seq.current) return
        const rows = (list || []).slice(0, 6)
        setItems(rows); setActive(0); setOpen(rows.length > 0)
      })
      .catch(() => { if (mine === seq.current) { setItems([]); setOpen(false) } })
  }

  const onType = (e) => {
    onChange?.(e)
    const el = e.target
    const caret = el.selectionStart ?? el.value.length
    const m = el.value.slice(0, caret).match(MENTION_RE)
    if (m) {
      anchor.current = { start: caret - m[1].length - 1, caret }
      if (m[1].length >= 1) search(m[1])
      else { setItems([]); setOpen(false) }   // bare "@" — wait for the first letter
    } else if (open) { setOpen(false) }
  }

  const choose = (u) => {
    const handle = u.handle || u.username || ''
    const el = ref.current
    const caret = el?.selectionStart ?? value.length
    const before = value.slice(0, anchor.current.start)
    const after = value.slice(caret)
    const insert = '@' + handle + ' '
    caretToSet.current = (before + insert).length
    onChange?.({ target: { value: before + insert + after } })
    setOpen(false); setItems([])
  }

  const onKey = (e) => {
    if (open && items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => (a + 1) % items.length); return }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(a => (a - 1 + items.length) % items.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(items[active]); return }
      if (e.key === 'Escape')    { e.preventDefault(); setOpen(false); return }
    }
    onKeyDown?.(e)
  }

  return (
    <div className="mention-wrap">
      <Tag
        ref={ref}
        className={className}
        value={value}
        onChange={onType}
        onKeyDown={onKey}
        onBlur={() => setTimeout(() => setOpen(false), 130)}
        {...rest}
      />
      {open && items.length > 0 && (
        <div className="mention-pop" role="listbox">
          {items.map((u, i) => (
            <button
              type="button"
              key={u.id || i}
              role="option"
              aria-selected={i === active}
              className={'mention-opt' + (i === active ? ' on' : '')}
              onMouseDown={(e) => { e.preventDefault(); choose(u) }}   // mousedown beats blur
              onMouseEnter={() => setActive(i)}
            >
              <Avatar initials={u.initials} color={u.avc} size={32} src={u.profileImage}/>
              <span className="mention-meta">
                <b>{u.full}</b>
                <small>@{u.handle}{u.verified ? ' ·' : ''}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
