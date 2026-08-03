/* =========================================================
   QrResolvePage — /qr/:opaque
   ---------------------------------------------------------
   Where a scanned IKA QR code lands (SETTINGS §6). The code
   itself carries only an opaque token (32 URL-safe base64
   chars); GET /discovery/qr/resolve/{opaque} trades it for the
   person it points at. The token is NOT an id — the owner can
   rotate it from Settings → Discovery, and every earlier code
   then resolves 404. That is the whole point of the
   indirection, so the failure copy says so rather than
   blaming the scan.

   The path segment is run through extractQrToken because this
   route is reached by more than a camera: someone pastes a
   whole `irc://u/<token>` uri, or a link with a tracker
   suffix, or types the token off a printed card. A dead token
   and a dead network are DIFFERENT failures — only the first
   may claim the code is invalid.

   Deliberately no "Message" action: /chat/:id takes a
   CONVERSATION id, not a user id (see App.jsx routes and
   UserProfilePage, which opens a DM through the API first),
   so a button built on the user id here would be a dead link.
   The profile it sends you to carries the real message entry.
   ========================================================= */
import React from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Icon, Avatar } from '../components/ui.jsx'
import { EmptyState, ErrorState, Loader } from '../components/states.jsx'
import { extractQrToken } from '../lib/qrToken.js'
import { api } from '../api/index.js'

export function QrResolvePage() {
  const navigate = useNavigate()
  const { opaque } = useParams()

  const [user, setUser] = React.useState(null)
  const [state, setState] = React.useState('loading')   // loading | ready | invalid | error
  const [tick, setTick] = React.useState(0)

  /* Accept every shape the token can arrive in; a bare token that our parser
     is too strict for still gets one server try (only the server knows what
     it minted), anything with a scheme or a path does not. */
  const token = React.useMemo(() => {
    const raw = String(opaque || '').trim()
    return extractQrToken(raw) || (/^[A-Za-z0-9_-]+$/.test(raw) ? raw : null)
  }, [opaque])

  React.useEffect(() => {
    let alive = true
    setState('loading')
    setUser(null)
    if (!token) { setState('invalid'); return () => { alive = false } }
    api.settings.discovery.resolveQr(token)
      /* userFrom answers null for an empty body — treat that as a dead token
         rather than rendering a card with no one in it. */
      .then(u => { if (!alive) return; if (u?.id) { setUser(u); setState('ready') } else setState('invalid') })
      /* Only a 404 means "this code is dead". A timeout or a 500 is our
         problem, and telling the user their friend's code is invalid would
         send them off to ask for a new one for nothing. */
      .catch(e => { if (alive) setState(e?.status === 404 ? 'invalid' : 'error') })
    return () => { alive = false }
  }, [token, tick])

  const rotationNote = (
    <p className="stx-sub" style={{ marginTop: 14 }}>
      A QR code can be rotated at any time. That is what makes a printed or
      forwarded code stop working — the old token stops resolving the moment a
      new one is minted.
    </p>
  )

  return (
    <div className="main center">
      <div className="col-main">
        <div className="phead">
          <div>
            <h1>Scanned <em>code</em> <span className="phead-ar" lang="ar" dir="rtl">رمز</span></h1>
            <p className="sub">The account this IKA code points at.</p>
          </div>
        </div>

        {state === 'loading' && <Loader label="Looking up this code…"/>}

        {state === 'error' && (
          <>
            <ErrorState message="Could not look this code up" onRetry={() => setTick(t => t + 1)}/>
            <TryAnother/>
          </>
        )}

        {state === 'invalid' && (
          <>
            <EmptyState
              icon="alert"
              title="This code is no longer valid"
              sub="The person may have rotated their QR code. Ask them for a fresh one."
            />
            <div className="flex gap-8" style={{ marginTop: 14, justifyContent: 'center' }}>
              <button className="btn btn-secondary" onClick={() => navigate('/')}>
                <Icon name="home" className="sm"/>Go home
              </button>
            </div>
            <TryAnother/>
            {rotationNote}
          </>
        )}

        {state === 'ready' && user && (
          <>
            <div className="card card-pad">
              <div className="flex gap-8" style={{ alignItems: 'center' }}>
                <Avatar size={72} initials={user.initials} color={user.avc} src={user.profileImage}/>
                <div style={{ minWidth: 0 }}>
                  <h3 className="title" style={{ margin: 0 }} dir="auto">{user.full}</h3>
                  <div className="muted text-sm">@{user.handle}</div>
                </div>
              </div>
              <div className="set-actions" style={{ marginTop: 16 }}>
                <button className="btn btn-primary" onClick={() => navigate(`/u/${user.id}`)}>
                  <Icon name="user" className="sm"/>View profile
                </button>
              </div>
            </div>
            {rotationNote}
          </>
        )}
      </div>
    </div>
  )
}

/** Second chance without going back to Settings: paste another code — the
 *  same four shapes the route itself accepts. */
function TryAnother() {
  const navigate = useNavigate()
  const [value, setValue] = React.useState('')
  const [bad, setBad] = React.useState(false)

  const submit = (e) => {
    e.preventDefault()
    const t = extractQrToken(value)
    if (!t) { setBad(true); return }
    setValue('')
    navigate(`/qr/${t}`)
  }

  return (
    <form className="card card-pad" style={{ marginTop: 14 }} onSubmit={submit}>
      <label className="field-label" htmlFor="qr-another">Try another code</label>
      <div className="flex gap-8" style={{ marginTop: 6, flexWrap: 'wrap' }}>
        <input id="qr-another" className="field" style={{ flex: '1 1 220px', minWidth: 0 }}
          value={value} placeholder="Paste a code or link…"
          aria-invalid={bad || undefined}
          aria-describedby={bad ? 'qr-another-e' : undefined}
          onChange={e => { setValue(e.target.value); setBad(false) }}/>
        <button type="submit" className="btn btn-secondary" disabled={!value.trim()}>
          <Icon name="search" className="sm"/>Open
        </button>
      </div>
      {bad && <p className="stx-hint" id="qr-another-e" role="alert" style={{ marginTop: 6 }}>That doesn’t look like an IKA code.</p>}
    </form>
  )
}
