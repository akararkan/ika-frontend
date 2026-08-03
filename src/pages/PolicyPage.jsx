/* =========================================================
   PolicyPage — /policies/:key  ·  PUBLIC (no session needed)
   ---------------------------------------------------------
   GET /api/v1/app/policies/{key} is permitAll precisely so a
   signed-out visitor — someone still filling in the signup
   form, or a build the version gate has retired — can read the
   document they are being asked to accept. Until this page
   existed the only renderer was /settings/about, behind
   RequireAuth.

   Wire truths (PolicyService):
     · keys are exactly privacy | terms | guidelines; anything
       else throws ResourceNotFoundException → 404. A wrong key
       is a wrong URL, not an outage, so it gets its own copy
       and no retry button;
     · `effectiveDate` mirrors `version` on the wire, so only
       the version is rendered (same choice as AboutPanel);
     · `body` is a short in-app SUMMARY — the authoritative
       long-form document is hosted on the web, and the copy
       below says so rather than implying this is the contract.

   Accepting is authenticated (POST …/accept), so this page
   only reads; signed-in visitors get a pointer to
   /settings/about, which owns the accept action.
   ========================================================= */
import React from 'react'
import { Link, useParams } from 'react-router-dom'
import { Icon, BrandMark } from '../components/ui.jsx'
import { RichText } from '../components/RichText.jsx'
import { EmptyState, ErrorState, Loader } from '../components/states.jsx'
import { api, session, POLICY_KEYS } from '../api/index.js'

export function PolicyPage() {
  const { key = '' } = useParams()
  const wanted = String(key).trim().toLowerCase()
  const known = POLICY_KEYS.some(([k]) => k === wanted)

  const [doc, setDoc] = React.useState(null)
  const [state, setState] = React.useState('loading')   // loading | ready | missing | error
  const [retry, setRetry] = React.useState(0)

  React.useEffect(() => {
    /* Don't spend a request on a key the backend's switch cannot serve. */
    if (!known) { setDoc(null); setState('missing'); return undefined }
    let alive = true
    setState('loading')
    /* permitAll gets you past @PreAuthorize, not past the filter chain:
       JwtAuthenticationFilter 401s an expired token BEFORE the request reaches
       the controller, so a lapsed session left in localStorage would make a
       public document look like an outage. http.js has already tried a refresh
       and cleared the dead session by the time it throws, so one retry now
       goes out unauthenticated and succeeds. */
    const read = () => api.settings.app.policy(wanted)
    read()
      .catch(e => (e?.status === 401 && !session.isAuthed() ? read() : Promise.reject(e)))
      .then(d => {
        if (!alive) return
        /* Tag with the key we ASKED for — the response echoes one, but the
           request is the authoritative key (it is what /accept would hit). */
        if (d && (d.title || d.body)) { setDoc({ ...d, key: wanted }); setState('ready') }
        else setState('missing')
      })
      .catch(e => { if (alive) setState(e?.status === 404 ? 'missing' : 'error') })
    return () => { alive = false }
  }, [wanted, known, retry])

  const others = POLICY_KEYS.filter(([k]) => k !== wanted)

  return (
    <div className="main center">
      <div className="col-main">
        <Link to="/" className="brand" style={{ width: 'auto', marginBottom: 20, textDecoration: 'none' }}>
          <div className="mark"><BrandMark/></div>
          <div className="word">IKA<b> ·</b> Archive</div>
        </Link>

        <div className="phead">
          <div>
            <h1>{state === 'ready' ? doc.title : 'Policies'} <span className="phead-ar" lang="ar" dir="rtl">سياسة</span></h1>
            <p className="sub">
              {state === 'ready'
                ? `Version ${doc.version}`
                : 'Privacy, terms and the community guidelines for the archive.'}
            </p>
          </div>
        </div>

        {state === 'loading' && <Loader label="Loading this document…"/>}

        {state === 'missing' && (
          <EmptyState
            icon="doc"
            title="We don’t publish a document at that address"
            sub="Pick one of the policies below."
          />
        )}

        {state === 'error' && (
          <ErrorState
            message="This document could not be loaded right now."
            onRetry={() => setRetry(n => n + 1)}
          />
        )}

        {state === 'ready' && (
          <div className="card card-pad">
            {/* The body carries no format flag; <RichText> escapes plain text and
                sanitises anything richer, so a summary that later ships Markdown
                or HTML renders instead of leaking its markup. */}
            <RichText source={doc.body} className="text-sm"/>
            <p className="muted text-xs" style={{ marginTop: 14 }}>
              This is the in-app summary. The full document is published on the web.
            </p>
            {session.isAuthed() && (
              <div className="set-actions" style={{ marginTop: 16 }}>
                <Link className="btn btn-secondary btn-sm" to="/settings/about">
                  <Icon name="check" className="xs"/>Review &amp; accept in Settings
                </Link>
              </div>
            )}
          </div>
        )}

        <div className="flex gap-8" style={{ marginTop: 18, flexWrap: 'wrap' }}>
          <nav className="flex gap-8" style={{ flexWrap: 'wrap' }} aria-label="Other policies">
            {others.map(([k, label]) => (
              <Link key={k} className="btn btn-secondary btn-sm" to={`/policies/${k}`}>{label}</Link>
            ))}
          </nav>
          <Link className="btn btn-secondary btn-sm" to="/login"><Icon name="user" className="xs"/>Sign in</Link>
        </div>
      </div>
    </div>
  )
}
