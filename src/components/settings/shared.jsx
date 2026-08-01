/* =========================================================
   Settings v2 — shared building blocks for the panel files.
   Cards, toggle/segmented rows, the step-up challenge dance,
   the optimistic cosmetic-section hook, and tiny formatters.
   Everything here renders on the `set-*` / `stx-*` vocabulary
   (styles/warm/settings.css) — panels should not invent CSS.
   ========================================================= */
/* eslint-disable react-refresh/only-export-components */
import React from 'react'
import { Icon, showToast } from '../ui.jsx'
import { uiPrompt } from '../Dialog.jsx'
import { api } from '../../api/index.js'
import { PREFS_EVENT } from '../../lib/prefs.js'

/* ---------- layout ---------- */

export function SetCard({ icon, title, sub, danger, children, className = '' }) {
  return (
    <div className={'card card-pad' + (danger ? ' stx-danger' : '') + (className ? ' ' + className : '')}>
      {title && <h3 className="title">{icon && <Icon name={icon} className="sm"/>}{title}</h3>}
      {sub && <p className="stx-sub">{sub}</p>}
      {children}
    </div>
  )
}

/** A titled switch row (the existing .set-toggle/.sw pattern). */
export function ToggleRow({ title, desc, on, onToggle, disabled }) {
  return (
    <div className="set-toggle">
      <div><b>{title}</b>{desc && <small className="muted">{desc}</small>}</div>
      <button
        type="button"
        className={'sw ' + (on ? 'on' : '')}
        role="switch" aria-checked={!!on} aria-label={title}
        disabled={disabled}
        onClick={onToggle}
      />
    </div>
  )
}

/** Segmented pill control. options: [[value, label], …] */
export function Seg({ options, value, onChange, disabled, ariaLabel }) {
  return (
    <div className="stx-seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map(([v, label]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v}
          className={'stx-seg-btn' + (value === v ? ' on' : '')}
          disabled={disabled}
          onClick={() => value !== v && onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

/** A titled row whose control (Seg / select / anything) sits at the end. */
export function ControlRow({ title, desc, children }) {
  return (
    <div className="stx-row">
      <div><b>{title}</b>{desc && <small>{desc}</small>}</div>
      {children}
    </div>
  )
}

/* ---------- step-up ---------- */

/** Collect step-up credentials: one masked prompt; a 6-digit entry is treated
 *  as an authenticator code, anything else as the password. Returns
 *  {password} | {code} | null (cancelled). */
export async function stepUpChallenge() {
  const v = await uiPrompt({
    title: 'Confirm it’s you',
    message: 'This action needs a fresh confirmation. Enter your password — or a 6-digit code from your authenticator app.',
    label: 'Password or 2FA code',
    inputType: 'password',
    confirmLabel: 'Confirm',
    icon: 'shield',
  })
  if (!v) return null
  return /^\d{6}$/.test(v.trim()) ? { code: v.trim() } : { password: v }
}

/** Run a step-up-guarded API action with the standard challenge UI.
 *  Resolves to the action's result; resolves to undefined when cancelled
 *  (already toasted). Rethrows real errors. */
export async function runStepUp(action) {
  try {
    return await api.security.withStepUp(action, stepUpChallenge)
  } catch (e) {
    if (e?.cancelled) return undefined
    if (e?.code === 'STEP_UP_BAD_PASSWORD') { showToast('That password is wrong'); return undefined }
    if (e?.status === 400 && !e?.code) { showToast('That code didn’t match'); return undefined }   // bare-400 = bad TOTP
    throw e
  }
}

/* ---------- cosmetic section hook ---------- */

/** Load one cosmetic block (`appearance` | `accessibility` | `messages` |
 *  `media`) and expose optimistic per-key edits. Every edit PATCHes just the
 *  changed key (JSON Merge Patch — the safe partial write); on failure the
 *  previous value is restored and a toast shown. */
export function useSection(section) {
  const [block, setBlock] = React.useState(null)
  const [error, setError] = React.useState(false)
  const [tick, setTick] = React.useState(0)
  /* Mirror of the latest block, so setField can read the previous value
     WITHOUT doing work inside a setState updater — updaters must stay pure
     (StrictMode double-invokes them, which would fire every PATCH twice). */
  const blockRef = React.useRef(null)

  React.useEffect(() => {
    let alive = true
    setError(false)
    api.settings.section(section)
      .then(b => { if (alive) { blockRef.current = b || {}; setBlock(b || {}) } })
      .catch(() => { if (alive) { setError(true); blockRef.current = {}; setBlock({}) } })
    return () => { alive = false }
  }, [section, tick])

  const setField = React.useCallback((key, value) => {
    const prevVal = blockRef.current?.[key]
    if (prevVal === value) return
    blockRef.current = { ...(blockRef.current || {}), [key]: value }
    setBlock(cur => ({ ...cur, [key]: value }))                 // pure updater
    api.settings.patchSection(section, { [key]: value })
      /* appearance/accessibility are applied by the client (lib/prefs.js),
         so a successful write has to tell the applier to re-read. Harmless
         for the sections nothing listens to. */
      .then(() => { window.dispatchEvent(new Event(PREFS_EVENT)) })
      .catch(() => {
        /* Revert ONLY if this write's optimistic value is still the one
           showing. Otherwise a slow failure would stomp a newer edit that
           already succeeded. */
        setBlock(cur => {
          if (!cur || cur[key] !== value) return cur
          const reverted = { ...cur, [key]: prevVal }
          blockRef.current = reverted
          return reverted
        })
        showToast('Could not save — reverted')
      })
  }, [section])

  const retry = React.useCallback(() => { setBlock(null); setTick(t => t + 1) }, [])

  return { block, setField, retry, loading: block === null, error }
}

/* ---------- formatters ---------- */

export function fmtBytes(n) {
  if (n == null || Number.isNaN(+n)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = +n, u = 0
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++ }
  return `${v >= 100 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`
}

/** Backend LocalDateTime has no zone suffix but IS UTC — append Z before
 *  parsing so it renders in the viewer's local time. */
export function parseServerDate(s) {
  if (!s) return null
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z')
  return Number.isNaN(d.getTime()) ? null : d
}

export function fmtWhen(s) {
  const d = parseServerDate(s)
  if (!d) return '—'
  const now = Date.now(), diff = now - d.getTime()
  if (diff < 60_000 && diff > -60_000) return 'just now'
  if (diff > 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff > 0 && diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
    ', ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function fmtDate(s) {
  const d = parseServerDate(s)
  return d ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'
}

/** Copy text with a toast. */
export function copyText(text, msg = 'Copied') {
  navigator.clipboard?.writeText(text).then(() => showToast(msg)).catch(() => showToast('Could not copy'))
}
