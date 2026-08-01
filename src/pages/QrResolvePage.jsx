/* =========================================================
   QrResolvePage — /qr/:opaque
   ---------------------------------------------------------
   Where a scanned IKA QR code lands (SETTINGS §6). The code
   itself carries only an opaque token (`irc://u/<token>`, 32
   URL-safe base64 chars); GET /discovery/qr/resolve/{opaque}
   trades it for the person it points at. The token is NOT an
   id — the owner can rotate it from Settings → Discovery, and
   every earlier code then resolves 404. That is the whole
   point of the indirection, so the failure copy says so
   rather than blaming the scan.

   Deliberately no "Message" action: /chat/:id takes a
   CONVERSATION id, not a user id (see App.jsx routes and
   UserProfilePage, which opens a DM through the API first),
   so a button built on the user id here would be a dead link.
   The profile it sends you to carries the real message entry.
   ========================================================= */
import React from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Icon, Avatar } from '../components/ui.jsx'
import { EmptyState, Loader } from '../components/states.jsx'
import { api } from '../api/index.js'

export function QrResolvePage() {
  const navigate = useNavigate()
  const { opaque } = useParams()

  const [user, setUser] = React.useState(null)
  const [state, setState] = React.useState('loading')   // loading | ready | invalid

  React.useEffect(() => {
    let alive = true
    setState('loading')
    setUser(null)
    if (!opaque) { setState('invalid'); return () => { alive = false } }
    api.settings.discovery.resolveQr(opaque)
      /* userFrom answers null for an empty body — treat that as a dead token
         rather than rendering a card with no one in it. */
      .then(u => { if (!alive) return; if (u?.id) { setUser(u); setState('ready') } else setState('invalid') })
      .catch(() => { if (alive) setState('invalid') })
    return () => { alive = false }
  }, [opaque])

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
