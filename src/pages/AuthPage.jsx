/* =========================================================
   Auth page — sign in / create account (live).
   ========================================================= */
import React from 'react'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import { Icon, BrandMark } from '../components/ui.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { api } from '../api/index.js'

/* The documents the consent line covers, named in the order it names them.
   These are PolicyService's keys verbatim — "Code of Conduct" (the old label)
   is not one of them, so it could never have been shown or recorded. */
const SIGNUP_POLICIES = ['terms', 'guidelines', 'privacy']

/* Map the API's errorCode (§4) to a friendly message — never branch on message
   text (§18.1 #5). The codes below are the SERVER's verbatim, which is not what
   this map used to guess at:
     · Spring's auth failures all come through GlobalExceptionHandler prefixed
       AUTH_* (AUTH_BAD_CREDENTIALS, not INVALID_CREDENTIALS);
     · a taken email and a taken handle share ONE code — DuplicateResourceException
       builds it as <RESOURCE>_DUPLICATE, i.e. USER_DUPLICATE for both — and are
       only told apart by details.field. Its own message interpolates the value
       ("User already exists with email: …"), so it must never be shown raw;
     · bean validation answers VALIDATION_FAILED with a placeholder message
       ("Check 'fieldErrors' for details") — the per-field message is the useful
       one, and http.js already lifts fieldErrors onto the error. */
function authError(e, mode) {
  const field = e?.payload?.details?.field
  switch (e?.code) {
    case 'AUTH_BAD_CREDENTIALS':  return 'Wrong email/username or password.'
    /* isEnabled only ever goes false when the account is closed (softDelete) —
       there is no email-verification step to point anyone at. */
    case 'AUTH_ACCOUNT_DISABLED': return 'This account is closed. Contact support if that isn’t right.'
    case 'AUTH_ACCOUNT_LOCKED':   return 'This account is locked. Please contact support.'
    case 'USER_DUPLICATE':        return field === 'username'
      ? 'That handle is already taken — please choose another.'
      : 'That email is already registered — try signing in instead.'
    case 'VALIDATION_FAILED':     return e.fieldErrors?.[0]?.message || 'Please check your details and try again.'
    default: return e?.message || (mode === 'SIGN_IN' ? 'Sign-in failed. Please try again.' : 'Could not create your account.')
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/

// Suggest a handle from the full name until the user edits the handle themselves.
function suggestHandle(name) {
  return name.trim().toLowerCase()
    .replace(/['’]/g, '')
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/\.{2,}/g, '.')
    .slice(0, 30)
}

// 0 = empty · 1 = too short · 2 = fair · 3 = good · 4 = strong
function pwScore(p) {
  if (!p) return 0
  if (p.length < 8) return 1
  let s = 1
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++
  if (/\d/.test(p)) s++
  if (/[^A-Za-z0-9]/.test(p) || p.length >= 14) s++
  return s
}
const PW_LABEL = ['', 'Too short', 'Fair', 'Good', 'Strong']

// Client-side hints only — the server stays the authority (its errors are mapped above).
function validate(mode, f, agree) {
  const e = {}
  if (mode === 'SIGN_IN') {
    if (!f.identifier.trim()) e.identifier = 'Enter your email or username.'
    if (!f.password) e.password = 'Enter your password.'
  } else {
    if (!f.full.trim()) e.full = 'Please tell us your name.'
    const h = f.handle.trim()
    if (!h) e.handle = 'Pick a handle — it’s your public @name.'
    else if (!HANDLE_RE.test(h)) e.handle = '3–30 characters: lowercase letters, numbers, dots, dashes or underscores.'
    const m = f.email.trim()
    if (!m) e.email = 'Email is required.'
    else if (!EMAIL_RE.test(m)) e.email = 'That doesn’t look like a valid email address.'
    if (!f.password) e.password = 'Choose a password.'
    else if (f.password.length < 8) e.password = 'Use at least 8 characters.'
    if (!agree) e.agree = 'Please accept the Terms, Community Guidelines and Privacy Policy to continue.'
  }
  return e
}

/* A policy link inside the consent <label>. New tab so a half-filled signup
   form survives the read. The label's activation behaviour is already spec'd
   to do nothing for clicks on an interactive descendant, so the checkbox will
   not toggle — stopPropagation only keeps that true if a handler is ever put
   on the label itself. */
function PolicyLink({ to, children }) {
  return (
    <Link to={to} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>
      {children}
    </Link>
  )
}

// Defined outside AuthPage so React keeps the same component identity across
// renders — inline definition would remount inputs and drop focus per keystroke.
function Field({ id, label, icon, error, hint, children }) {
  return (
    <div className={'af' + (error ? ' bad' : '')}>
      <label className="field-label" htmlFor={id}>{label}</label>
      <div className="af-wrap">
        <Icon name={icon} className="sm af-ico"/>
        {children}
      </div>
      {error
        ? <small className="af-err" role="alert">{error}</small>
        : hint ? <small className="af-hint">{hint}</small> : null}
    </div>
  )
}

export function AuthPage({ mode: initialMode = 'SIGN_IN' }) {
  const { login, register } = useAuth()
  const navigate = useNavigate()
  const loc = useLocation()
  const [mode, setMode] = React.useState(initialMode)
  const signIn = mode === 'SIGN_IN'
  // identifier = the sign-in login id (username OR email); handle = public username, email = private address — kept separate (§8.2)
  const [fields, setFields] = React.useState({ full:'', handle:'', identifier:'', email:'', password:'' })
  const [errs, setErrs] = React.useState({})
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [showPw, setShowPw] = React.useState(false)
  const [caps, setCaps] = React.useState(false)
  const [agree, setAgree] = React.useState(false)
  const handleTouched = React.useRef(false)
  const firstRef = React.useRef(null)
  const mounted = React.useRef(false)

  // Focus the first field when the mode flips (not on first paint — that would
  // pop the keyboard over the hero on phones).
  React.useEffect(() => {
    if (mounted.current) firstRef.current?.focus()
    else mounted.current = true
  }, [mode])

  const set = k => e => {
    const v = e.target.value
    setFields(f => {
      const next = { ...f, [k]: v }
      if (k === 'handle') {
        handleTouched.current = v !== ''         // clearing it re-enables suggestions
        next.handle = v.toLowerCase().replace(/\s+/g, '.')
      }
      if (k === 'full' && !handleTouched.current) next.handle = suggestHandle(v)
      return next
    })
    setErrs(x => (x[k] ? { ...x, [k]: undefined } : x))
  }

  // Validate only the field being left — don't flag untouched fields early.
  const blur = k => () => {
    const e = validate(mode, fields, agree)
    if (e[k]) setErrs(x => ({ ...x, [k]: e[k] }))
  }

  const switchMode = m => {
    if (m === mode || busy) return
    setMode(m); setErrs({}); setError(''); setShowPw(false); setCaps(false)
  }

  const pwKeys = e => setCaps(e.getModifierState?.('CapsLock') ?? false)
  const score = pwScore(fields.password)

  const submit = async ev => {
    ev.preventDefault()
    if (busy) return
    const e = validate(mode, fields, agree)
    setErrs(e); setError('')
    if (Object.keys(e).length) return
    setBusy(true)
    try {
      if (signIn) await login(fields)
      else {
        await register(fields)
        /* register() stores the session (api/auth.js), so the authenticated
           POST /app/policies/{key}/accept is callable from here — and only
           from here: without these rows every new account lands on the feed
           with VersionGate's re-consent banner already open, asking again for
           what was just agreed to. Fire-and-forget: a failed ledger write must
           never keep someone who just signed up out of the app, and Settings →
           About can still record it later. */
        SIGNUP_POLICIES.forEach(k => { api.settings.app.acceptPolicy(k).catch(() => {}) })
      }
      navigate(loc.state?.from?.pathname || '/', { replace: true })
    } catch (err) {
      setError(authError(err, mode))
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
        {/* mobile hides the <br> (styles-responsive §) — the explicit space keeps "community, built" intact there */}
        <h1 className="auth-hero">A scholarly community,<br/>{' '}built on <em>trust</em> and <em>isnad</em>.</h1>
        <p className="auth-sub">Share posts, publish peer-reviewed research with minted IRC identifiers, ask and answer questions, and learn from verified scholars across the world.</p>
        <ul className="auth-bullets">
          <li><span><Icon name="award" className="sm"/></span> Verified scholar program with a profile badge</li>
          <li><span><Icon name="research" className="sm"/></span> Publish research with a minted IRC identifier</li>
          <li><span><Icon name="users" className="sm"/></span> Follow, learn, and collaborate with colleagues</li>
          <li><span><Icon name="shield" className="sm"/></span> Moderation &amp; dispute resolution by elected scholars</li>
        </ul>
        <div className="auth-foot"><small className="muted">© 2026 Islamic Knowledge Archive · Erbil, Iraq</small></div>
      </div>

      <div className="auth-right">
        <div className="auth-card">
          <div className="auth-tabs" role="tablist" aria-label="Sign in or create account">
            <span className={'auth-thumb' + (signIn ? '' : ' alt')} aria-hidden="true"/>
            <button type="button" role="tab" aria-selected={signIn} className={'auth-tab ' + (signIn ? 'on' : '')} onClick={() => switchMode('SIGN_IN')}>Sign in</button>
            <button type="button" role="tab" aria-selected={!signIn} className={'auth-tab ' + (!signIn ? 'on' : '')} onClick={() => switchMode('SIGN_UP')}>Create account</button>
          </div>

          <form onSubmit={submit} noValidate>
            {/* keyed remount = soft cross-rise between the two forms */}
            <div className="af-pane" key={mode}>
              <h2 className="auth-title">{signIn ? 'Welcome back' : 'Join the archive'}</h2>
              <p className="auth-lede">{signIn ? 'Sign in to pick up where you left off.' : 'A few details and you’re in — free for scholars and students.'}</p>

              {!signIn && (
                <>
                  <Field id="f-full" label="Full name" icon="user" error={errs.full}>
                    <input ref={firstRef} id="f-full" className="field lg" placeholder="Akar Arkan" value={fields.full}
                      onChange={set('full')} onBlur={blur('full')} autoComplete="name" aria-invalid={!!errs.full}/>
                  </Field>
                  <Field id="f-handle" label="Handle" icon="at" error={errs.handle}
                    hint="Your public @name on posts & mentions — separate from your private email.">
                    <input id="f-handle" className="field lg" placeholder="akar.arkan" value={fields.handle}
                      onChange={set('handle')} onBlur={blur('handle')} autoComplete="username"
                      autoCapitalize="none" spellCheck={false} aria-invalid={!!errs.handle}/>
                  </Field>
                  <Field id="f-email" label="Email" icon="mail" error={errs.email}>
                    <input id="f-email" className="field lg" type="email" placeholder="you@university.edu" value={fields.email}
                      onChange={set('email')} onBlur={blur('email')} autoComplete="email" aria-invalid={!!errs.email}/>
                  </Field>
                </>
              )}

              {signIn && (
                <Field id="f-id" label="Email or username" icon="user" error={errs.identifier}>
                  <input ref={firstRef} id="f-id" className="field lg" placeholder="you@university.edu  ·  or  your.handle" value={fields.identifier}
                    onChange={set('identifier')} onBlur={blur('identifier')} autoComplete="username"
                    autoCapitalize="none" aria-invalid={!!errs.identifier}/>
                </Field>
              )}

              <Field id="f-pw" label="Password" icon="lock" error={errs.password}>
                <input id="f-pw" className="field lg" type={showPw ? 'text' : 'password'}
                  placeholder={signIn ? '••••••••' : 'At least 8 characters'} value={fields.password}
                  onChange={set('password')} onBlur={() => { setCaps(false); blur('password')() }}
                  onKeyDown={pwKeys} onKeyUp={pwKeys}
                  autoComplete={signIn ? 'current-password' : 'new-password'} aria-invalid={!!errs.password}/>
                <button type="button" className="af-eye" onClick={() => setShowPw(s => !s)}
                  aria-label={showPw ? 'Hide password' : 'Show password'} title={showPw ? 'Hide password' : 'Show password'}>
                  <Icon name={showPw ? 'eyeoff' : 'eye'} className="sm"/>
                </button>
              </Field>

              {caps && <small className="af-caps" role="status">⇪ Caps Lock is on</small>}

              {!signIn && fields.password && (
                <div className={'pw-meter s' + score}>
                  <div className="pw-bars" aria-hidden="true">{[1, 2, 3, 4].map(i => <i key={i} className={i <= score ? 'on' : ''}/>)}</div>
                  <small aria-live="polite">{PW_LABEL[score]}</small>
                </div>
              )}

              {signIn ? (
                /* No forgot-password flow by design (§8.6): a password is only rotated
                   from an active session via change-password. Sessions persist in
                   localStorage regardless — say so instead of a dead "Remember me". */
                <div className="auth-note"><Icon name="shield" className="sm"/><span>You’ll stay signed in on this device until you log out.</span></div>
              ) : (
                <>
                  <label className={'auth-agree' + (errs.agree ? ' bad' : '')} htmlFor="f-agree">
                    <input id="f-agree" type="checkbox" checked={agree}
                      aria-invalid={!!errs.agree} aria-describedby={errs.agree ? 'f-agree-err' : undefined}
                      onChange={e => { setAgree(e.target.checked); setErrs(x => (x.agree ? { ...x, agree: undefined } : x)) }}/>
                    <span>
                      I agree to the <PolicyLink to="/policies/terms">Terms of Service</PolicyLink> and{' '}
                      <PolicyLink to="/policies/guidelines">Community Guidelines</PolicyLink>, and to the{' '}
                      <PolicyLink to="/policies/privacy">Privacy Policy</PolicyLink>.
                    </span>
                  </label>
                  {errs.agree && <small id="f-agree-err" className="af-err" role="alert">{errs.agree}</small>}
                </>
              )}

              {error && <div className="auth-alert" role="alert"><Icon name="alert" className="sm"/><span>{error}</span></div>}

              <button type="submit" className="btn btn-primary btn-lg btn-block mt-16" disabled={busy}>
                {busy && <span className="auth-spin" aria-hidden="true"/>}
                {busy ? 'Please wait…' : signIn ? 'Sign in' : 'Create account'}
              </button>
            </div>
          </form>

          {/* No social/SSO buttons until a real OAuth/SAML flow exists on the
              backend — dead demo buttons on the front door erode trust. */}
          <div className="auth-switch">
            {signIn
              ? <>New here? <a onClick={() => switchMode('SIGN_UP')}>Create an account</a></>
              : <>Already have an account? <a onClick={() => switchMode('SIGN_IN')}>Sign in</a></>}
          </div>
        </div>
      </div>
    </div>
  )
}
