/* =========================================================
   Settings v2 — security extras: the security checkup score,
   TOTP two-factor enrolment (QR + one-time recovery codes),
   and phone binding. Step-up-guarded calls go through
   runStepUp; everything renders on the stx-* vocabulary.
   ========================================================= */
import React from 'react'
import QRCode from 'qrcode'
import { Icon, showToast } from '../ui.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { Loader, ErrorState } from '../states.jsx'
import { api } from '../../api/index.js'
import { saveBlob } from '../../api/http.js'
import { useAuth } from '../../context/AuthContext.jsx'
import { SetCard, ControlRow, runStepUp, copyText } from './shared.jsx'

/* ---------- security checkup ---------- */

const LEVEL_COPY = {
  LOW: 'Your account is at risk — work through the items below.',
  MEDIUM: 'Some protections are missing — see the items below.',
  HIGH: 'Your account is well protected.',
  EXCELLENT: 'Everything checks out — nothing to do here.',
}

export function SecurityScorePanel() {
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

  return (
    <SetCard icon="award" title="Security checkup"
      sub="A quick read on how well this account is protected, with what to fix next.">
      {error ? (
        <ErrorState message="Could not load your security checkup" onRetry={() => { setData(null); setTick(t => t + 1) }}/>
      ) : data === null ? (
        <Loader/>
      ) : (
        <>
          <div className="stx-score">
            <div className="stx-score-num" style={{ '--pct': data.score }}>
              <i><b>{data.score}</b><small>{data.level}</small></i>
            </div>
            <div className="muted text-sm" style={{ flex: 1, minWidth: 200 }}>
              {LEVEL_COPY[data.level] || 'Review the items below.'}
            </div>
          </div>
          {(data.items || []).map(it => (
            <div key={it.key} className={'stx-check ' + (it.passed ? 'pass' : 'fail')}>
              <span className="stx-check-ic"><Icon name={it.passed ? 'check' : 'alert'}/></span>
              <div>
                <b>{it.label}</b>
                {it.recommendation && <small>{it.recommendation}</small>}
              </div>
            </div>
          ))}
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
        <span>These codes are shown only once. Save them somewhere safe — each code signs you in a single time if you lose your authenticator.</span>
      </div>
      <div className="set-actions">
        <button className="btn btn-secondary btn-sm" onClick={() => copyText(codes.join('\n'), 'Recovery codes copied')}><Icon name="copy" className="xs"/>Copy all</button>
        <button className="btn btn-secondary btn-sm" onClick={download}><Icon name="download" className="xs"/>Download .txt</button>
        <button className="btn btn-ghost btn-sm" onClick={onDone}>Done</button>
      </div>
    </div>
  )
}

/* ---------- two-factor authentication ---------- */

export function TwoFactorPanel() {
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
    }).catch(() => showToast('Could not draw the QR code'))
  }, [enrol])

  const begin = async () => {
    setBusy(true)
    try {
      const res = await api.security.twofa.setup()
      setCode('')
      setEnrol(res)
    } catch (e) {
      if (e?.code === 'TWO_FA_ALREADY_ON') { showToast('Two-factor authentication is already on'); setTick(t => t + 1) }
      else if (e?.status !== 429) showToast('Could not start setup')
    } finally { setBusy(false) }
  }

  const verify = async () => {
    if (busy) return   // Enter bypasses the disabled button; a double-press would submit twice
    const c = code.trim()
    if (!/^\d{6}$/.test(c)) { showToast('Enter the 6-digit code from your app'); return }
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
      if (e?.code === 'TWO_FA_INVALID') showToast('That code didn’t match — try again')
      else if (e?.code === 'TWO_FA_NOT_STARTED') { showToast('Setup expired — start again'); setEnrol(null); setCode('') }
      else if (e?.status !== 429) showToast('Could not verify the code')
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
      const res = await runStepUp(() => api.security.twofa.regenerateRecovery())
      if (!res) return
      const fresh = res.codes || []
      setCodes(fresh)
      setStatus(s => ({ ...s, recoveryCodesRemaining: fresh.length }))
      showToast('New recovery codes issued')
    } catch { showToast('Could not regenerate the codes') }
  }

  const turnOff = async () => {
    const yes = await uiConfirm({
      title: 'Turn off two-factor authentication?',
      message: 'Your account will rely on your password alone, and your recovery codes stop working.',
      confirmLabel: 'Turn off',
      danger: true,
      icon: 'lock',
    })
    if (!yes) return
    try {
      const ok = await runStepUp(async () => { await api.security.twofa.disable(); return true })
      if (!ok) return
      setStatus({ enabled: false, recoveryCodesRemaining: 0 })
      setCodes(null)
      showToast('Two-factor authentication is off')
    } catch { showToast('Could not turn off 2FA') }
  }

  return (
    <SetCard icon="lock" title="Two-factor authentication"
      sub="A second check at sign-in: your password plus a rotating 6-digit code from an authenticator app.">
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
            <label className="field-label" style={{ marginTop: 12 }}>6-digit code</label>
            <input className="field" inputMode="numeric" maxLength={6} autoComplete="one-time-code"
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
          <ControlRow title="Status" desc="A code from your authenticator app is required at every sign-in.">
            <span className="stx-chip ok"><Icon name="check"/>On</span>
          </ControlRow>
          <ControlRow title="Recovery codes"
            desc={`${status.recoveryCodesRemaining ?? 0} unused ${(status.recoveryCodesRemaining ?? 0) === 1 ? 'code' : 'codes'} left. Each signs you in once if you lose your authenticator.`}>
            <button className="btn btn-secondary btn-sm" onClick={regenerate}><Icon name="refresh" className="xs"/>Regenerate recovery codes</button>
          </ControlRow>
          {codes && <CodesReveal codes={codes} onDone={() => setCodes(null)}/>}
          <div className="set-actions">
            <button className="btn btn-danger btn-sm" onClick={turnOff}>Turn off</button>
          </div>
        </>
      ) : (
        <>
          <p className="muted text-sm">Even if someone learns your password, they can’t sign in without your phone. Setup takes about a minute.</p>
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
  const { user } = useAuth()
  const [phone, setPhone] = React.useState('')
  const [code, setCode] = React.useState('')
  const [sent, setSent] = React.useState(false)
  const [bound, setBound] = React.useState(null)     // E.164 confirmed this session
  const [busy, setBusy] = React.useState(false)
  const current = bound || user?.phone || null

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
      if (e?.code === 'PHONE_INVALID') showToast('That doesn’t look like a valid phone number')
      else if (e?.status !== 429) showToast('Could not send the code')
    } finally { setBusy(false) }
  }

  const verify = async () => {
    if (busy) return   // Enter bypasses the disabled button; each submit burns one of 5 OTP attempts
    const c = code.trim()
    if (!/^\d{6}$/.test(c)) { showToast('Enter the 6-digit code from the SMS'); return }
    setBusy(true)
    try {
      const res = await api.security.phone.verify(phone.trim(), c)
      setBound(res?.phone || phone.trim())
      setSent(false)
      setPhone('')
      setCode('')
      showToast('Phone number verified')
    } catch (e) {
      if (e?.code === 'OTP_INVALID') showToast('That code is wrong or has expired')
      else if (e?.status !== 429) showToast('Could not verify the code')
    } finally { setBusy(false) }
  }

  return (
    <SetCard icon="phone" title="Phone number"
      sub="Used for sign-in codes and for finding you by phone, if you allow that in Discovery.">
      {current && (
        <ControlRow title={current} desc="Verified phone on this account.">
          <span className="stx-chip ok"><Icon name="check"/>Verified</span>
        </ControlRow>
      )}
      <label className="field-label" style={{ marginTop: current ? 12 : 0 }}>{current ? 'New phone number' : 'Phone number'}</label>
      <div className="flex gap-8">
        <input className="field" style={{ flex: 1 }} type="tel" inputMode="tel" autoComplete="tel"
          placeholder="+964 750 123 4567" value={phone}
          onChange={e => setPhone(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send() }}/>
        <button className="btn btn-secondary btn-sm" disabled={busy || !phone.trim()} onClick={send}>
          <Icon name="send" className="xs"/>{sent ? 'Resend code' : 'Send code'}
        </button>
      </div>
      {sent && (
        <>
          <label className="field-label" style={{ marginTop: 12 }}>Verification code</label>
          <div className="flex gap-8">
            <input className="field" style={{ flex: 1 }} inputMode="numeric" maxLength={6} autoComplete="one-time-code"
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
