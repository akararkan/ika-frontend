/* =========================================================
   Dialog — beautiful in-app replacement for window.prompt /
   window.confirm. Promise-based, so any handler can:
     const url = await uiPrompt({ title, label, initial })
     const ok  = await uiConfirm({ title, message, danger })
   The <DialogHost/> at app root listens for open requests and
   stacks dialogs (multiple can be queued; Esc dismisses the
   top one). Same look-and-feel as the rest of the modals.
   ========================================================= */
/* eslint-disable react-refresh/only-export-components */
import React from 'react'
import { Icon } from './ui.jsx'

/* Module-level "openFn" is set by the DialogHost when mounted.
   The helpers below dispatch through it. If no host is mounted
   they fall back to the native dialogs so we never wedge a flow. */
let openFn = null
let seq = 0

export function uiPrompt(opts = {}) {
  return new Promise(resolve => {
    if (openFn) openFn({ id: ++seq, type: 'prompt', resolve, ...opts })
    else resolve(window.prompt(opts.title || opts.label || '', opts.initial || ''))
  })
}

export function uiConfirm(opts = {}) {
  return new Promise(resolve => {
    if (openFn) openFn({ id: ++seq, type: 'confirm', resolve, ...opts })
    else resolve(window.confirm(opts.message || opts.title || 'Are you sure?'))
  })
}

export function DialogHost() {
  const [stack, setStack] = React.useState([])

  React.useEffect(() => {
    openFn = (dlg) => setStack(s => [...s, dlg])
    return () => { openFn = null }
  }, [])

  if (!stack.length) return null
  const top = stack[stack.length - 1]
  const close = (result) => {
    setStack(s => s.filter(d => d.id !== top.id))
    top.resolve(result)
  }
  return <DialogModal key={top.id} dlg={top} onClose={close}/>
}

function DialogModal({ dlg, onClose }) {
  const { type, title, message, label, initial, confirmLabel, cancelLabel, danger, icon, placeholder, multiline } = dlg
  const [value, setValue] = React.useState(initial != null ? String(initial) : '')
  const inputRef = React.useRef(null)

  const cancelResult = type === 'prompt' ? null : false
  const confirmResult = type === 'prompt' ? value : true

  React.useEffect(() => {
    if (type === 'prompt') {
      requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select?.() })
    }
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(cancelResult) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [type, onClose, cancelResult])

  const headIcon = icon || (danger ? 'flag' : type === 'prompt' ? 'compose' : 'check')
  const submitDisabled = type === 'prompt' && !value.trim() && initial == null

  return (
    <div className="dlg-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(cancelResult) }}>
      <div className={'dlg' + (danger ? ' dlg-danger' : '')} role="dialog" aria-modal="true" aria-labelledby="dlg-title">
        <div className="dlg-head">
          <div className={'dlg-ic ' + (danger ? 'danger' : '')}><Icon name={headIcon}/></div>
          <h3 id="dlg-title">{title || (type === 'prompt' ? 'Enter a value' : 'Confirm')}</h3>
          <button type="button" className="dlg-x" onClick={() => onClose(cancelResult)} aria-label="Close">
            <Icon name="close" className="sm"/>
          </button>
        </div>
        <div className="dlg-body">
          {message && <p className="dlg-msg">{message}</p>}
          {type === 'prompt' && (
            <>
              {label && <label className="field-label dlg-label">{label}</label>}
              {multiline ? (
                <textarea
                  ref={inputRef}
                  className="field"
                  style={{ minHeight: 110 }}
                  value={value}
                  onChange={e => setValue(e.target.value)}
                  placeholder={placeholder || ''}
                  onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onClose(value) } }}
                />
              ) : (
                <input
                  ref={inputRef}
                  className="field lg"
                  value={value}
                  onChange={e => setValue(e.target.value)}
                  placeholder={placeholder || ''}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onClose(value) } }}
                />
              )}
            </>
          )}
        </div>
        <div className="dlg-foot">
          <button type="button" className="btn btn-ghost" onClick={() => onClose(cancelResult)}>
            {cancelLabel || 'Cancel'}
          </button>
          <button type="button" className={'btn ' + (danger ? 'btn-danger' : 'btn-primary')}
            disabled={submitDisabled}
            onClick={() => onClose(confirmResult)}>
            {confirmLabel || (type === 'prompt' ? 'OK' : 'Confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
