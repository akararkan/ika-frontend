/* =========================================================
   Settings v2 — security extras: the security checkup score,
   TOTP two-factor enrolment (QR + one-time recovery codes),
   and phone binding. Step-up-guarded calls go through
   runStepUp; everything renders on the stx-* vocabulary.
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import QRCode from 'qrcode'
import { Icon, showToast } from '../ui.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { Loader, ErrorState } from '../states.jsx'
import { api } from '../../api/index.js'
import { saveBlob } from '../../api/http.js'
import { SetCard, ControlRow, runStepUp, copyText, humanEnum } from './shared.jsx'

/* ---------- security checkup ---------- */

const LEVEL_COPY = {
  LOW: 'Your account is at risk — work through the items below.',
  MEDIUM: 'Some protections are missing — see the items below.',
  HIGH: 'Your account is well protected.',
  EXCELLENT: 'Everything checks out — nothing to do here.',
}

/* The ring prints the level, and LOW/HIGH read as a measurement rather than a
   verdict — the user is being told how they are doing, not shown an enum. */
const LEVEL_LABEL = { LOW: 'At risk', MEDIUM: 'Fair', HIGH: 'Strong', EXCELLENT: 'Excellent' }

/* SecurityScoreService emits stable per-check keys precisely so a client can
   route the user to the fix (SecurityScoreService.java: two_factor / recovery /
   email_verified / recent_review). Only two have a destination in this app —
   there is no email-verification endpoint on the backend at all, and `recovery`
   is scored off the same isEmailVerified() flag — so those two stay inert text. */
const SCORE_ACTION = {
  two_factor: { label: 'Set up 2FA', to: '/settings/security#two-factor' },
  recent_review: { label: 'Review sessions', to: '/settings/sessions#sessions' },
}

export function SecurityScorePanel() {
  const navigate = useNavigate()
  const [data, setData] = React.useState(null)
  const [error, setError] = React.useState(false)
  const [tick, setTick] = React.useState(0)

  React.useEffect(() => {
    let alive = true
    setError(false)
    api.settings.safety.score()
      .then(d => { if (alive) setData(d || { score: 0, level: 'LOW', items: [] }) })
      .catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [tick])

  /* Two-factor is a card on THIS tab, so a plain navigate() would leave the
     #hash unchanged and the page's anchor effect would never re-fire. Scroll
     whatever is already mounted; only navigate when the target is elsewhere. */
  const goFix = (to) => {
    const el = document.getElementById(to.split('#')[1] || '')
    if (!el) { navigate(to); return }
    el.scrollIntoView({ block: 'start', behavior: 'smooth' })
    el.focus({ preventScroll: true })
  }

  return (
    <SetCard id="security-score" icon="award" title="Security checkup"
      sub="A quick read on how well this account is protected, with what to fix next.">
      {error ? (
        <ErrorState message="Could not load your security checkup" onRetry={() => { setData(null); setTick(t => t + 1) }}/>
      ) : data === null ? (
        <Loader/>
      ) : (
        <>
          <div className="stx-score">
            <div className="stx-score-num" data-level={data.level} style={{ '--pct': data.score }}>
              <i><b>{data.score}</b><small>{LEVEL_LABEL[data.level] || humanEnum(data.level)}</small></i>
            </div>
            <div className="muted text-sm" style={{ flex: 1, minWidth: 200 }}>
              {LEVEL_COPY[data.level] || 'Review the items below.'}
            </div>
          </div>
          {(data.items || []).map(it => {
            const act = !it.passed ? SCORE_ACTION[it.key] : null
            return (
              <div key={it.key} className={'stx-check ' + (it.passed ? 'pass' : 'fail')}>
                <span className="stx-check-ic"><Icon name={it.passed ? 'check' : 'alert'}/></span>
                <div className="stx-check-body">
                  <b>{it.label}</b>
                  {it.recommendation && <small>{it.recommendation}</small>}
                </div>
                {act && (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => goFix(act.to)}>
                    {act.label}
                  </button>
                )}
              </div>
            )
          })}
        </>
      )}
    </SetCard>
  )
}

/* ---------- recovery codes (shown once) ---------- */

function CodesReveal({ codes, onDone }) {
  /* saveBlob keeps the object URL alive past the click — Safari processes it
     asynchronously, and a revoked blob means these one-time codes never save. */
  const download = () => saveBlob({
    blob: new Blob([codes.join('\n') + '\n'], { type: 'text/plain' }),
    filename: 'ika-recovery-codes.txt',
  }, 'ika-recovery-codes.txt')
  return (
    <div style={{ marginTop: 12 }}>
      <div className="stx-codes">
        {codes.map(c => <span key={c} className="stx-code">{c}</span>)}
      </div>
      <div className="stx-note warn">
        <Icon name="alert"/>
        {/* No endpoint redeems a recovery code today (RecoveryCodeService.consume
            has no caller, and step-up accepts only a password or a live TOTP),
            so the copy must not promise a way back in. */}
        <span>These codes are shown only once. Save them somewhere safe — they are your backup if you lose access to your authenticator app.</span>
      </div>
      <div className="set-actions">
        <button className="btn btn-secondary btn-sm" onClick={() => copyText(codes.join('\n'), 'Recovery codes copied')}><Icon name="copy" className="xs"/>Copy all</button>
        <button className="btn btn-secondary btn-sm" onClick={download}><Icon name="download" className="xs"/>Download .txt</button>
        <button className="btn btn-ghost btn-sm" onClick={onDone}>Done</button>
      </div>
    </div>
  )
}

/* ---------- two-factor authentication ----------
   Wire truth the copy in here has to respect: the LOGIN path never reads the
   2FA flag (AuthServiceImpl.login goes authenticate → issueTokenPair), so a
   password alone still yields a token pair. What the enrolment does buy today
   is the step-up factor: POST /security/step-up accepts a TOTP `code`, and it
   is what guards disable-2FA and regenerate-recovery-codes. The enrolment
   itself is real — the secret and the recovery codes are stored properly — so
   we keep the control and describe what it actually protects. */

export function TwoFactorPanel() {
  /* Hand-rolled label association rather than <Field>: the label sits above a
     row that also holds a button, so Field's label+control div can't wrap it
     without moving the button. Same id/htmlFor contract Field emits. */
  const totpId = React.useId()
  const [status, setStatus] = React.useState(null)       // {enabled, recoveryCodesRemaining}
  const [error, setError] = React.useState(false)
  const [tick, setTick] = React.useState(0)
  const [enrol, setEnrol] = React.useState(null)         // {provisioningUri, secret}
  const [code, setCode] = React.useState('')
  const [codes, setCodes] = React.useState(null)         // freshly issued recovery codes
  const [busy, setBusy] = React.useState(false)
  const canvasRef = React.useRef(null)

  React.useEffect(() => {
    let alive = true
    setError(false)
    api.security.twofa.status()
      .then(s => { if (alive) setStatus(s || { enabled: false, recoveryCodesRemaining: 0 }) })
      .catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [tick])

  React.useEffect(() => {
    if (!enrol?.provisioningUri || !canvasRef.current) return
    QRCode.toCanvas(canvasRef.current, enrol.provisioningUri, {
      width: 296, margin: 1, color: { dark: '#002147', light: '#FFFFFF' },
    }).catch(() => showToast('Could not draw the QR code', 'err'))
  }, [enrol])

  const begin = async () => {
    setBusy(true)
    try {
      const res = await api.security.twofa.setup()
      setCode('')
      setEnrol(res)
    } catch (e) {
      if (e?.code === 'TWO_FA_ALREADY_ON') { showToast('Two-factor authentication is already on', 'warn'); setTick(t => t + 1) }
      else if (e?.status !== 429) showToast('Could not start setup', 'err')
    } finally { setBusy(false) }
  }

  const verify = async () => {
    if (busy) return   // Enter bypasses the disabled button; a double-press would submit twice
    const c = code.trim()
    if (!/^\d{6}$/.test(c)) { showToast('Enter the 6-digit code from your app', 'err'); return }
    setBusy(true)
    try {
      const res = await api.security.twofa.verify(c)
      const fresh = res?.codes || []
      setEnrol(null)
      setCode('')
      setStatus(s => ({ enabled: true, recoveryCodesRemaining: fresh.length || s?.recoveryCodesRemaining || 0 }))
      if (fresh.length) setCodes(fresh)
      showToast('Two-factor authentication is on')
    } catch (e) {
      if (e?.code === 'TWO_FA_INVALID') showToast('That code didn’t match — try again', 'err')
      else if (e?.code === 'TWO_FA_NOT_STARTED') { showToast('Setup expired — start again', 'warn'); setEnrol(null); setCode('') }
      else if (e?.status !== 429) showToast('Could not verify the code', 'err')
    } finally { setBusy(false) }
  }

  const regenerate = async () => {
    const yes = await uiConfirm({
      title: 'Regenerate recovery codes?',
      message: 'A new set of 10 codes will be issued. Your old codes stop working immediately.',
      confirmLabel: 'Regenerate',
      icon: 'refresh',
    })
    if (!yes) return
    try {
      /* The prompt only offers the "or a 6-digit code" route when 2FA is on —
         with it off, a six-digit password would be misrouted to the TOTP branch
         and rejected. */
      const res = await runStepUp(() => api.security.twofa.regenerateRecovery(), { twoFactor: !!status?.enabled })
      if (!res) return
      const fresh = res.codes || []
      setCodes(fresh)
      setStatus(s => ({ ...s, recoveryCodesRemaining: fresh.length }))
      showToast('New recovery codes issued')
    } catch { showToast('Could not regenerate the codes', 'err') }
  }

  const turnOff = async () => {
    const yes = await uiConfirm({
      title: 'Turn off two-factor authentication?',
      message: 'Sensitive changes will be confirmed by your password alone, and your recovery codes stop working.',
      confirmLabel: 'Turn off',
      danger: true,
      icon: 'lock',
    })
    if (!yes) return
    try {
      const ok = await runStepUp(async () => { await api.security.twofa.disable(); return true }, { twoFactor: true })
      if (!ok) return
      setStatus({ enabled: false, recoveryCodesRemaining: 0 })
      setCodes(null)
      showToast('Two-factor authentication is off')
    } catch { showToast('Could not turn off 2FA', 'err') }
  }

  return (
    <SetCard id="two-factor" icon="lock" title="Two-factor authentication"
      sub="A rotating 6-digit code from an authenticator app, used to confirm sensitive account changes.">
      {error ? (
        <ErrorState message="Could not load your 2FA status" onRetry={() => { setStatus(null); setTick(t => t + 1) }}/>
      ) : status === null ? (
        <Loader/>
      ) : enrol ? (
        <div className="stx-qr">
          <div className="stx-qr-box"><canvas ref={canvasRef}/></div>
          <div className="stx-qr-side">
            <p className="muted text-sm">Scan the code with your authenticator app (Google Authenticator, Aegis, 1Password), or type the secret in manually.</p>
            <div className="stx-plate">
              <code>{enrol.secret}</code>
              <button className="btn btn-ghost btn-sm" onClick={() => copyText(enrol.secret, 'Secret copied')}><Icon name="copy" className="xs"/>Copy</button>
            </div>
            <label className="field-label" htmlFor={totpId} style={{ marginTop: 12 }}>6-digit code</label>
            <input className="field" id={totpId} inputMode="numeric" maxLength={6} autoComplete="one-time-code"
              placeholder="000000" value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
              onKeyDown={e => { if (e.key === 'Enter') verify() }}/>
            <div className="set-actions">
              <button className="btn btn-primary btn-sm" disabled={busy || code.trim().length !== 6} onClick={verify}><Icon name="check" className="xs"/>Verify</button>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setEnrol(null); setCode('') }}>Cancel</button>
            </div>
          </div>
        </div>
      ) : status.enabled ? (
        <>
          <ControlRow title="Status" desc="Your authenticator code confirms sensitive actions, such as turning 2FA off or regenerating recovery codes.">
            <span className="stx-chip ok"><Icon name="check"/>On</span>
          </ControlRow>
          <ControlRow title="Recovery codes"
            desc={`${status.recoveryCodesRemaining ?? 0} unused ${(status.recoveryCodesRemaining ?? 0) === 1 ? 'code' : 'codes'} left. Keep them somewhere safe as your account backup.`}>
            <button className="btn btn-secondary btn-sm" onClick={regenerate}><Icon name="refresh" className="xs"/>Regenerate recovery codes</button>
          </ControlRow>
          {codes && <CodesReveal codes={codes} onDone={() => setCodes(null)}/>}
          <div className="set-actions">
            <button className="btn btn-danger btn-sm" onClick={turnOff}>Turn off</button>
          </div>
        </>
      ) : (
        <>
          <p className="muted text-sm">Adds a second factor that guards changes to your security settings. Setup takes about a minute.</p>
          {codes && <CodesReveal codes={codes} onDone={() => setCodes(null)}/>}
          <div className="set-actions">
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={begin}><Icon name="shield" className="xs"/>Turn on 2FA</button>
          </div>
        </>
      )}
    </SetCard>
  )
}

/* ---------- phone binding ---------- */

export function PhonePanel() {
  const uid = React.useId()                              // label/control pairs — see the note in TwoFactorPanel
  const [phone, setPhone] = React.useState('')
  const [code, setCode] = React.useState('')
  const [sent, setSent] = React.useState(false)
  const [bound, setBound] = React.useState(null)     // E.164 confirmed this session
  const [busy, setBusy] = React.useState(false)
  /* Session-scoped ON PURPOSE. PhoneService writes phoneE164/phoneVerifiedAt on
     the User, but no response DTO exposes them (UserResponse has no phone key)
     and there is no GET on /security/phone — so a bound number is unreadable
     after a reload, and stashing a synthetic key on the cached /users/me
     payload would be wiped by the next me() refresh. */
  const current = bound

  const send = async () => {
    if (busy) return   // Enter bypasses the disabled button; resends are rate-limited
    const p = phone.trim()
    if (!p) return
    setBusy(true)
    try {
      await api.security.phone.request(p)
      setSent(true)
      setCode('')
      showToast('Code sent if the number is valid')
    } catch (e) {
      if (e?.code === 'PHONE_INVALID') showToast('That doesn’t look like a valid phone number', 'err')
      else if (e?.status !== 429) showToast('Could not send the code', 'err')
    } finally { setBusy(false) }
  }

  const verify = async () => {
    if (busy) return   // Enter bypasses the disabled button; each submit burns one of 5 OTP attempts
    const c = code.trim()
    if (!/^\d{6}$/.test(c)) { showToast('Enter the 6-digit code from the SMS', 'err'); return }
    setBusy(true)
    try {
      const res = await api.security.phone.verify(phone.trim(), c)
      setBound(res?.phone || phone.trim())
      setSent(false)
      setPhone('')
      setCode('')
      showToast('Phone number verified')
    } catch (e) {
      if (e?.code === 'OTP_INVALID') showToast('That code is wrong or has expired', 'err')
      else if (e?.status !== 429) showToast('Could not verify the code', 'err')
    } finally { setBusy(false) }
  }

  /* The card sub used to sell two uses the backend does not have:
     OtpAuthController verifies a LOGIN code but mints no tokens (no account is
     phone-primary), and contact matching joins on an IDENTITY hash of the EMAIL
     only — ContactMatchService never touches phoneHmac, and
     isDiscoverableBy(PHONE) has no caller. Verifying really does put the E.164
     (and its keyed HMAC) on the User, so the control stays. */
  return (
    <SetCard id="phone" icon="phone" title="Phone number"
      sub="Confirm a number and we keep it on file for your account. Signing in by phone, and being found by your number, aren’t available yet.">
      {current ? (
        <ControlRow title={current} desc="Verified phone on this account.">
          <span className="stx-chip ok"><Icon name="check"/>Verified</span>
        </ControlRow>
      ) : (
        <p className="muted text-sm">We can’t show a previously verified number here — verifying again simply replaces whatever is on file.</p>
      )}
      <label className="field-label" htmlFor={`${uid}-phone`} style={{ marginTop: 12 }}>{current ? 'New phone number' : 'Phone number'}</label>
      <div className="flex gap-8">
        <input className="field" id={`${uid}-phone`} style={{ flex: 1 }} type="tel" inputMode="tel" autoComplete="tel"
          placeholder="+964 750 123 4567" value={phone}
          onChange={e => setPhone(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send() }}/>
        <button className="btn btn-secondary btn-sm" disabled={busy || !phone.trim()} onClick={send}>
          <Icon name="send" className="xs"/>{sent ? 'Resend code' : 'Send code'}
        </button>
      </div>
      {sent && (
        <>
          <label className="field-label" htmlFor={`${uid}-otp`} style={{ marginTop: 12 }}>Verification code</label>
          <div className="flex gap-8">
            <input className="field" id={`${uid}-otp`} style={{ flex: 1 }} inputMode="numeric" maxLength={6} autoComplete="one-time-code"
              placeholder="000000" value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
              onKeyDown={e => { if (e.key === 'Enter') verify() }}/>
            <button className="btn btn-primary btn-sm" disabled={busy || code.trim().length !== 6} onClick={verify}>
              <Icon name="check" className="xs"/>Verify
            </button>
          </div>
          <p className="muted text-xs" style={{ marginTop: 6 }}>The code expires in 5 minutes and allows 5 attempts.</p>
        </>
      )}
      {bound && (
        <div className="stx-note ok">
          <Icon name="check"/>
          <span>{bound} is now linked to your account.</span>
        </div>
      )}
    </SetCard>
  )
}
