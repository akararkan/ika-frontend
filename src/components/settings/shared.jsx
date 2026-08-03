/* =========================================================
   Settings v2 — shared building blocks for the panel files.
   Cards, toggle/segmented rows, the step-up challenge dance,
   the optimistic cosmetic-section hook, and tiny formatters.
   Everything here renders on the `set-*` / `stx-*` vocabulary
   (styles/warm/settings.css) — panels should not invent CSS.

   Two contracts worth knowing before editing a panel:

   1. FEEDBACK BELONGS TO THE ROW, NOT THE SCREEN. An optimistic
      write shows "Saving…" then "Saved" (or "Not saved" plus a
      one-shot revert flash) on the control itself. Use
      `useWriteStatus()` — or `useSection`'s built-in `statusOf`
      — and pass `status` to ToggleRow / ControlRow. Don't toast
      a routine save; a centre-screen pill next to a switch that
      silently snapped back tells the user nothing.

   2. EVERY CARD HAS AN ADDRESS. `<SetCard id="…">` renders a
      focusable <section id> so /settings/<tab>#<id> can scroll,
      focus and flash it, and so the search index can point at
      it. New cards must carry an id and be listed in
      index.data.js.
   ========================================================= */
/* eslint-disable react-refresh/only-export-components */
import React from 'react'
import { Link } from 'react-router-dom'
import { Icon, showToast } from '../ui.jsx'
import { uiPrompt } from '../Dialog.jsx'
import { api } from '../../api/index.js'
import { PREFS_EVENT } from '../../lib/prefs.js'

/* ---------- layout ---------- */

/** A settings card.
 *  `id` gives it a deep-link address (/settings/tab#id) and a copy-link
 *  affordance; it is required for anything the search index can reach. */
export function SetCard({ id, icon, title, sub, danger, actions, children, className = '' }) {
  const copyLink = () => {
    const base = typeof window === 'undefined' ? '' : window.location.origin + window.location.pathname
    copyText(`${base}#${id}`, 'Link to this setting copied')
  }
  return (
    <section
      id={id}
      tabIndex={id ? -1 : undefined}
      className={'card card-pad stx-card' + (danger ? ' stx-danger' : '') + (className ? ' ' + className : '')}
      aria-labelledby={id && title ? `${id}-t` : undefined}
    >
      {title && (
        <div className="stx-head">
          <h3 className="title" id={id ? `${id}-t` : undefined}>
            {icon && <Icon name={icon} className="sm"/>}{title}
          </h3>
          <div className="stx-head-act">
            {actions}
            {id && (
              <button type="button" className="stx-anchor" onClick={copyLink}
                title="Copy link to this setting" aria-label={`Copy link to ${title}`}>
                <Icon name="link" className="xs"/>
              </button>
            )}
          </div>
        </div>
      )}
      {sub && <p className="stx-sub">{sub}</p>}
      {children}
    </section>
  )
}

/** A subordinate heading inside a card — sans + ink, so it never competes
 *  with the serif Oxford-Blue card title. Draws its own divider. */
export function SubHead({ children, className = '' }) {
  return <h4 className={'stx-subhead' + (className ? ' ' + className : '')}>{children}</h4>
}

/** "This setting also lives over there" — the cross-link row for controls
 *  that are deliberately split across tabs. */
export function SeeAlso({ to, children }) {
  return (
    <p className="stx-seealso">
      <Icon name="chevright" className="xs"/>
      <Link to={to}>{children}</Link>
    </p>
  )
}

/** The one-line status marker that lives at the end of a settings row. */
function StatusMark({ status }) {
  if (!status || status === 'idle') return null
  const label = status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : 'Not saved'
  return <span className={'stx-state ' + status} aria-hidden="true">{label}</span>
}

/** A titled switch row (the existing .set-toggle/.sw pattern).
 *  `status` drives the inline saving/saved/failed marker and the revert flash. */
export function ToggleRow({ title, desc, on, onToggle, disabled, busy, status, children }) {
  return (
    <div className={'set-toggle' + (status === 'failed' ? ' is-reverted' : '')}>
      <div><b>{title}</b>{desc && <small className="muted">{desc}</small>}</div>
      {children}
      <StatusMark status={status}/>
      <button
        type="button"
        className={'sw ' + (on ? 'on' : '')}
        role="switch" aria-checked={!!on} aria-label={title}
        aria-busy={busy || status === 'saving' || undefined}
        disabled={disabled || busy}
        onClick={onToggle}
      />
    </div>
  )
}

/** Segmented pill control. options: [[value, label], …]
 *  Implements the radiogroup keyboard contract: one tab stop, arrows move
 *  and select, Home/End jump. */
export function Seg({ options, value, onChange, disabled, ariaLabel }) {
  const ref = React.useRef(null)
  const move = (e) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }
    const dir = keys[e.key]
    if (!dir && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const i = options.findIndex(([v]) => v === value)
    const next = e.key === 'Home' ? 0
      : e.key === 'End' ? options.length - 1
      : (i < 0 ? 0 : (i + dir + options.length) % options.length)
    const [nv] = options[next] || []
    if (nv !== undefined && nv !== value) onChange(nv)
    ref.current?.querySelectorAll('.stx-seg-btn')[next]?.focus()
  }
  return (
    <div className="stx-seg" role="radiogroup" aria-label={ariaLabel} ref={ref} onKeyDown={move}>
      {options.map(([v, label]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v}
          tabIndex={value === v ? 0 : -1}
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
export function ControlRow({ title, desc, status, children }) {
  return (
    <div className={'stx-row' + (status === 'failed' ? ' is-reverted' : '')}>
      <div><b>{title}</b>{desc && <small>{desc}</small>}</div>
      <StatusMark status={status}/>
      {children}
    </div>
  )
}

/** A labelled field with a real label/control association. */
export function Field({ label, hint, id, children }) {
  const auto = React.useId()
  const fid = id || auto
  const kid = React.Children.only(children)
  return (
    <div>
      <label className="field-label" htmlFor={fid}>{label}</label>
      {React.cloneElement(kid, { id: fid, 'aria-describedby': hint ? `${fid}-h` : undefined })}
      {hint && <small className="stx-hint" id={`${fid}-h`}>{hint}</small>}
    </div>
  )
}

/** Content-shaped placeholder — calmer than a spinner for a known layout. */
export function Skeleton({ rows = 3, className = '' }) {
  return (
    <div className={'stx-skel' + (className ? ' ' + className : '')} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => <span key={i} className="stx-skel-row"/>)}
    </div>
  )
}

/* ---------- write status ---------- */

const SAVED_MS = 1800

/** Track per-key save status for optimistic writes.
 *  `track(key, promise)` → 'saving' … 'saved' (auto-clears) | 'failed'. */
export function useWriteStatus() {
  const [map, setMap] = React.useState({})
  const timers = React.useRef({})
  const alive = React.useRef(true)
  React.useEffect(() => () => {
    alive.current = false
    Object.values(timers.current).forEach(clearTimeout)
  }, [])

  const set = React.useCallback((key, value) => {
    if (!alive.current) return
    setMap(m => ({ ...m, [key]: value }))
  }, [])

  const track = React.useCallback((key, promise) => {
    clearTimeout(timers.current[key])
    set(key, 'saving')
    return Promise.resolve(promise).then(
      (r) => {
        set(key, 'saved')
        timers.current[key] = setTimeout(() => set(key, 'idle'), SAVED_MS)
        return r
      },
      (e) => {
        set(key, 'failed')
        timers.current[key] = setTimeout(() => set(key, 'idle'), 4000)
        throw e
      },
    )
  }, [set])

  const statusOf = React.useCallback((key) => map[key] || 'idle', [map])
  return { statusOf, track }
}

/* ---------- step-up ---------- */

/** Collect step-up credentials: one masked prompt; a 6-digit entry is treated
 *  as an authenticator code, anything else as the password. Returns
 *  {password} | {code} | null (cancelled).
 *  `twoFactor` tells the prompt whether a code is even possible — with 2FA off
 *  a 6-digit password would otherwise be misrouted to the code branch and
 *  rejected as a bad TOTP. */
export async function stepUpChallenge({ twoFactor = true } = {}) {
  const v = await uiPrompt({
    title: 'Confirm it’s you',
    message: twoFactor
      ? 'This action needs a fresh confirmation. Enter your password — or a 6-digit code from your authenticator app.'
      : 'This action needs a fresh confirmation. Enter your account password.',
    label: twoFactor ? 'Password or 2FA code' : 'Password',
    inputType: 'password',
    confirmLabel: 'Confirm',
    icon: 'shield',
  })
  if (!v) return null
  return twoFactor && /^\d{6}$/.test(v.trim()) ? { code: v.trim() } : { password: v }
}

/** Run a step-up-guarded API action with the standard challenge UI.
 *  Resolves to the action's result; resolves to undefined when cancelled
 *  (already toasted). Rethrows real errors. */
export async function runStepUp(action, opts) {
  try {
    return await api.security.withStepUp(action, () => stepUpChallenge(opts))
  } catch (e) {
    if (e?.cancelled) return undefined
    if (e?.code === 'STEP_UP_BAD_PASSWORD') { showToast('That password is wrong', 'err'); return undefined }
    if (e?.status === 400 && !e?.code) { showToast('That code didn’t match', 'err'); return undefined }   // bare-400 = bad TOTP
    throw e
  }
}

/** Arm the step-up window up front, for actions the backend does NOT guard
 *  but that are irreversible enough to deserve a re-auth (account deletion).
 *  Returns true when armed, false when cancelled/failed (already toasted). */
export async function requireStepUp(opts) {
  const cred = await stepUpChallenge(opts)
  if (!cred) return false
  try {
    await api.security.stepUp(cred)
    return true
  } catch (e) {
    if (e?.code === 'STEP_UP_BAD_PASSWORD') showToast('That password is wrong', 'err')
    else if (e?.status === 400) showToast('That didn’t match', 'err')
    else showToast('Could not confirm it’s you', 'err')
    return false
  }
}

/* ---------- cosmetic section hook ---------- */

/** Load one cosmetic block (`appearance` | `accessibility` | `messages` |
 *  `media`) and expose optimistic per-key edits. Every edit PATCHes just the
 *  changed key (JSON Merge Patch — the safe partial write); on failure the
 *  previous value is restored and the row shows "Not saved". */
export function useSection(section) {
  const [block, setBlock] = React.useState(null)
  const [error, setError] = React.useState(false)
  const [tick, setTick] = React.useState(0)
  const { statusOf, track } = useWriteStatus()
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
    if (prevVal === value) return Promise.resolve()
    blockRef.current = { ...(blockRef.current || {}), [key]: value }
    setBlock(cur => ({ ...cur, [key]: value }))                 // pure updater
    return track(key, api.settings.patchSection(section, { [key]: value })
      /* appearance/accessibility are applied by the client (lib/prefs.js),
         so a successful write has to tell the applier to re-read. Harmless
         for the sections nothing listens to. */
      .then(() => { window.dispatchEvent(new Event(PREFS_EVENT)) })
      .catch((e) => {
        /* Revert ONLY if this write's optimistic value is still the one
           showing. Otherwise a slow failure would stomp a newer edit that
           already succeeded. */
        setBlock(cur => {
          if (!cur || cur[key] !== value) return cur
          const reverted = { ...cur, [key]: prevVal }
          blockRef.current = reverted
          return reverted
        })
        throw e
      })).catch(() => {})     // the row already says "Not saved"
  }, [section, track])

  const retry = React.useCallback(() => { setBlock(null); setTick(t => t + 1) }, [])

  return { block, setField, statusOf, retry, loading: block === null, error }
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

/** A WALL-CLOCK server string (DND muteUntil is stored in the user's DND
 *  timezone, not UTC) — read the parts literally, never shift them. */
export function fmtWall(s) {
  if (!s) return '—'
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s)
  if (!m) return s
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])
  return Number.isNaN(d.getTime()) ? s
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** SCREAMING_ENUM → Sentence case, for any value with no curated label. */
export function humanEnum(v) {
  if (!v) return ''
  const s = String(v).toLowerCase().replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Copy text with a toast. */
export function copyText(text, msg = 'Copied') {
  navigator.clipboard?.writeText(text).then(() => showToast(msg)).catch(() => showToast('Could not copy', 'err'))
}
