/* =========================================================
   Global step-up modal — frontend-error-handling.md §2.2.

   http.js parks any request that answered 403 STEP_UP_REQUIRED
   and asks this host to arm the window; on success it replays
   the original request, so the caller's promise simply resolves
   as if the 403 never happened. No token changes hands — the
   marker is server-side (POST /api/v1/security/step-up → 204,
   ~5-minute window that covers subsequent sensitive calls too).

   Contracts honoured here:
   · single-flight — ten concurrent 403s share ONE open prompt,
     and every parked request replays off the same confirmation;
   · 400 STEP_UP_BAD_PASSWORD keeps the modal open with the error
     inline (the parked request is still waiting — nothing lost);
   · a 6-digit entry is tried as a TOTP code first, then retried
     as the password, so a six-digit password can't be eaten by
     the code branch;
   · cancel resolves false → http.js rethrows the original 403
     tagged stepUpCancelled, which withStepUp() translates to its
     cancel shape instead of prompting a second time.
   ========================================================= */
import React from 'react'
import { setStepUpPrompt } from '../api/http.js'
import { security } from '../api/security.js'
import { Icon } from './ui.jsx'

export function StepUpHost() {
  const [open, setOpen] = React.useState(false)
  const [value, setValue] = React.useState('')
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const resolver = React.useRef(null)   // resolve fn of the shared promise
  const shared = React.useRef(null)     // in-flight prompt — the single-flight latch
  const inputRef = React.useRef(null)

  React.useEffect(() => {
    setStepUpPrompt(() => {
      if (!shared.current) {
        shared.current = new Promise(resolve => { resolver.current = resolve })
          .finally(() => { shared.current = null; resolver.current = null })
        setValue(''); setError(''); setBusy(false); setOpen(true)
      }
      return shared.current
    })
    return () => setStepUpPrompt(null)
  }, [])

  React.useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  const finish = (ok) => { setOpen(false); resolver.current?.(ok) }
  const cancel = React.useCallback(() => {
    if (!busy) { setOpen(false); resolver.current?.(false) }
  }, [busy])

  React.useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); cancel() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, cancel])

  const submit = async (e) => {
    e?.preventDefault?.()
    const v = value.trim()
    if (!v || busy) return
    setBusy(true); setError('')
    const asCode = /^\d{6}$/.test(v)
    try {
      try {
        await security.stepUp(asCode ? { code: v } : { password: value })
      } catch (err) {
        // 6-digit password misread as a TOTP code → one retry as the password.
        if (!(asCode && err?.status === 400 && err?.code !== 'STEP_UP_BAD_PASSWORD')) throw err
        await security.stepUp({ password: value })
      }
      finish(true)
    } catch (err) {
      setBusy(false)
      if (err?.code === 'STEP_UP_BAD_PASSWORD') setError('That password is incorrect.')
      else if (err?.status === 400) setError('That didn’t match — check it and try again.')
      else setError(err?.message || 'Could not confirm it’s you — try again.')
    }
  }

  if (!open) return null
  return (
    <div className="dlg-overlay" onClick={(e) => { if (e.target === e.currentTarget) cancel() }}>
      <form className="dlg" role="dialog" aria-modal="true" aria-labelledby="stepup-title" onSubmit={submit}>
        <div className="dlg-head">
          <div className="dlg-ic"><Icon name="shield"/></div>
          <h3 id="stepup-title">Confirm it’s you</h3>
          <button type="button" className="dlg-x" onClick={cancel} aria-label="Close">
            <Icon name="close" className="sm"/>
          </button>
        </div>
        <div className="dlg-body">
          <p className="dlg-msg">This action needs a fresh confirmation. Enter your account password — or a 6-digit code from your authenticator app.</p>
          <label className="field-label dlg-label" htmlFor="stepup-cred">Password or 2FA code</label>
          <input
            id="stepup-cred"
            ref={inputRef}
            className="field lg"
            type="password"
            autoComplete="current-password"
            value={value}
            onChange={(e) => { setValue(e.target.value); if (error) setError('') }}
          />
          {error && <p className="dlg-msg" role="alert" style={{ color: 'var(--danger)', marginTop: 8 }}>{error}</p>}
        </div>
        <div className="dlg-foot">
          <button type="button" className="btn btn-ghost" onClick={cancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !value.trim()}>
            {busy ? 'Confirming…' : 'Confirm'}
          </button>
        </div>
      </form>
    </div>
  )
}
