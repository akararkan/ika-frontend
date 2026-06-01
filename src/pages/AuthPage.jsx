/* =========================================================
   Auth page — sign in / create account (live).
   ========================================================= */
import React from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Icon, BrandMark } from '../components/ui.jsx'
import { useAuth } from '../context/AuthContext.jsx'

// Map the API's errorCode (§4) to a friendly message — never branch on message text (§18.1 #5).
function authError(e, mode) {
  switch (e?.code) {
    case 'INVALID_CREDENTIALS':     return 'Wrong email/username or password.'
    case 'ACCOUNT_DISABLED':        return 'Your email isn’t verified yet — check your inbox to activate your account.'
    case 'EMAIL_ALREADY_EXISTS':    return 'That email is already registered — try signing in instead.'
    case 'USERNAME_ALREADY_EXISTS': return 'That handle is already taken — please choose another.'
    case 'VALIDATION_ERROR':        return e.message || 'Please check your details and try again.'
    default: return e?.message || (mode === 'SIGN_IN' ? 'Sign-in failed. Please try again.' : 'Could not create your account.')
  }
}

export function AuthPage({ mode: initialMode = 'SIGN_IN' }) {
  const { login, register } = useAuth()
  const navigate = useNavigate()
  const loc = useLocation()
  const [mode, setMode] = React.useState(initialMode)
  // identifier = the sign-in login id (username OR email); handle = public username, email = private address — kept separate (§8.2)
  const [fields, setFields] = React.useState({ full:'', handle:'', identifier:'', email:'', password:'' })
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const set = k => e => setFields(f => ({ ...f, [k]: e.target.value }))

  const submit = async () => {
    setBusy(true); setError('')
    try {
      if (mode === 'SIGN_IN') {
        if (!fields.identifier.trim() || !fields.password) throw new Error('Enter your email or username and your password.')
        await login(fields)
      } else {
        if (!fields.full.trim() || !fields.handle.trim() || !fields.email.trim() || !fields.password) throw new Error('Please fill in every field.')
        await register(fields)
      }
      navigate(loc.state?.from?.pathname || '/', { replace: true })
    } catch (e) {
      setError(authError(e, mode))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-left">
        <div className="auth-brand">
          <div className="auth-mark"><BrandMark/></div>
          <div>
            <div className="auth-name">IKA<b>.</b></div>
            <div className="auth-tag">Islamic Knowledge Archive</div>
          </div>
        </div>
        <h1 className="auth-hero">A scholarly community,<br/>built on <em>trust</em> and <em>isnad</em>.</h1>
        <p className="auth-sub">Share posts, publish peer-reviewed research with minted IRC identifiers, ask and answer questions, and learn from verified scholars across the world.</p>
        <ul className="auth-bullets">
          <li><span><Icon name="award" className="sm"/></span> Verified scholar program with a profile badge</li>
          <li><span><Icon name="research" className="sm"/></span> Publish research with a minted IRC identifier</li>
          <li><span><Icon name="users" className="sm"/></span> Follow, learn, and collaborate with colleagues</li>
          <li><span><Icon name="shield" className="sm"/></span> Moderation & dispute resolution by elected scholars</li>
        </ul>
        <div className="auth-foot"><small className="muted">© 2026 Islamic Knowledge Archive · Erbil, Iraq</small></div>
      </div>

      <div className="auth-right">
        <div className="auth-card">
          <div className="auth-tabs">
            <button className={'auth-tab ' + (mode==='SIGN_IN'?'on':'')} onClick={() => setMode('SIGN_IN')}>Sign in</button>
            <button className={'auth-tab ' + (mode==='SIGN_UP'?'on':'')} onClick={() => setMode('SIGN_UP')}>Create account</button>
          </div>

          {mode==='SIGN_UP' && (
            <>
              <label className="field-label">Full name</label>
              <input className="field lg" placeholder="Akar Arkan" value={fields.full} onChange={set('full')} autoComplete="name"/>
              <label className="field-label" style={{marginTop:14}}>Handle</label>
              <input className="field lg" placeholder="akar.arkan" value={fields.handle} onChange={set('handle')} autoComplete="username"/>
              <small className="muted text-xs" style={{display:'block', marginTop:6}}>Your public @handle — shown on posts &amp; mentions. Separate from your private email.</small>
            </>
          )}

          {mode==='SIGN_IN' ? (
            <>
              <label className="field-label">Email or username</label>
              <input className="field lg" placeholder="you@university.edu  ·  or  your.handle" value={fields.identifier} onChange={set('identifier')} autoComplete="username"
                onKeyDown={e => { if (e.key === 'Enter') submit() }}/>
            </>
          ) : (
            <>
              <label className="field-label" style={{marginTop:14}}>Email</label>
              <input className="field lg" type="email" placeholder="you@university.edu" value={fields.email} onChange={set('email')} autoComplete="email"
                onKeyDown={e => { if (e.key === 'Enter') submit() }}/>
            </>
          )}

          <label className="field-label" style={{marginTop:14}}>Password</label>
          <input className="field lg" type="password" placeholder="••••••••" value={fields.password} onChange={set('password')}
            autoComplete={mode==='SIGN_IN' ? 'current-password' : 'new-password'}
            onKeyDown={e => { if (e.key === 'Enter') submit() }}/>

          {mode==='SIGN_IN' && (
            <div className="flex-c" style={{justifyContent:'space-between', marginTop:10}}>
              <label className="flex-c gap-8 text-sm muted"><input type="checkbox" defaultChecked/>Remember me</label>
              {/* No forgot-password flow by design (§8.6): a password is only rotated from an active session via change-password. */}
            </div>
          )}
          {mode==='SIGN_UP' && (
            <label className="flex-c gap-8 text-xs muted mt-12">
              <input type="checkbox"/>I agree to the <a style={{color:'var(--emerald)',fontWeight:600}}>Code of Conduct</a> and <a style={{color:'var(--emerald)',fontWeight:600}}>Terms of Service</a>.
            </label>
          )}

          {error && <div className="text-sm" style={{color:'var(--rose)',fontWeight:600,marginTop:12}}>{error}</div>}

          <button className="btn btn-primary btn-lg btn-block mt-16" onClick={submit} disabled={busy}>
            {busy ? 'Please wait…' : (mode==='SIGN_IN' ? 'Sign in' : 'Create account')}
          </button>

          <div className="auth-or"><span>or continue with</span></div>
          <div className="auth-social">
            <button className="btn btn-secondary btn-block"><Icon name="google" className="sm"/>Continue with Google</button>
            <button className="btn btn-secondary btn-block" style={{marginTop:8}}><Icon name="award" className="sm"/>Institutional SSO (SAML)</button>
          </div>
          <div className="auth-switch">
            {mode==='SIGN_IN' ? <>New here? <a onClick={() => setMode('SIGN_UP')}>Create an account</a></> : <>Already have an account? <a onClick={() => setMode('SIGN_IN')}>Sign in</a></>}
          </div>
        </div>
      </div>
    </div>
  )
}
