/* =========================================================
   Settings v2 — about & policies.
   Two cards: `about` (what build this is, what the server
   expects) and `policies` (privacy / terms / guidelines with
   their acceptance state and an optimistic accept action).

   Wire truths worth keeping in mind:
   • AppConfigResponse is {minSupportedVersion, forceUpdate,
     latestVersion} — ALL THREE describe the server's
     expectations. None of them is the build the user is
     running; that only exists client-side (lib/version.js).
   • PolicyDocResponse.effectiveDate mirrors `version` on the
     wire (PolicyService.policyMeta passes the version string
     twice), so only the version is ever rendered.
   • accepted() is a bare array keyed `policyKey`, and rows are
     upserted per (user, key) — so a stored version different
     from the document's current version means re-consent is due.
   • TRAP: policy versions are DATE strings (AboutProperties
     defaults them to "2026-08-01"), NOT semver. compareVersions
     splits on '.', so "2026-08-01" and "2026-09-01" both parse
     as [2026] and compare EQUAL — using it here would mark a
     stale consent as current while VersionGate (string equality)
     kept prompting. Only the app version is semver.
   ========================================================= */
import React from 'react'
import { Icon, showToast } from '../ui.jsx'
import { ErrorState } from '../states.jsx'
import { api, POLICY_KEYS } from '../../api/index.js'
import { SetCard, SubHead, Skeleton, fmtDate, fmtWhen } from './shared.jsx'
import { CLIENT_VERSION, CLIENT_BUILD, compareVersions } from '../../lib/version.js'

/* A build with no injected version reports 0.0.0 — that is "unknown", not
   "ancient", so it must not be dressed up as an available update. */
const UNSTAMPED = !CLIENT_VERSION || CLIENT_VERSION === '0.0.0'

function PolicyDoc({ doc, acceptance, onAccept }) {
  /* Exact-match, like VersionGate: only ONE version of a document is ever
     offered, so a stored version that is not this one is a stale consent —
     and these version strings are dates, which do not order numerically. */
  const current = acceptance != null && String(acceptance.version) === String(doc.version)
  const behind = acceptance != null && !current
  return (
    /* A fragment, not a wrapper: .stx-subhead draws its own divider only while
       it is a direct child of the card, so a wrapping <div> would flatten the
       rhythm between the three documents. */
    <>
      <SubHead>{doc.title}</SubHead>
      <div className="flex gap-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        {current ? (
          <span className="stx-chip ok"><Icon name="check"/>Accepted</span>
        ) : behind ? (
          <span className="stx-chip warn"><Icon name="alert"/>You accepted {acceptance.version} · this version needs your consent</span>
        ) : (
          <span className="stx-chip plain">Not accepted</span>
        )}
        <span className="muted text-xs">Current version {doc.version}</span>
      </div>
      {doc.paragraphs.length > 0 && (
        <div className="stx-policy-body">
          {doc.paragraphs.map((p, i) => (
            <p key={i} className="text-sm" style={{ margin: i ? '10px 0 0' : 0 }}>{p}</p>
          ))}
        </div>
      )}
      <div className="set-actions" style={{ marginTop: 10, alignItems: 'center' }}>
        {current ? (
          <small className="muted">Accepted {fmtWhen(acceptance.acceptedAt)}</small>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onAccept(doc)}>
            Accept version {doc.version}
          </button>
        )}
      </div>
    </>
  )
}

export function AboutPanel() {
  const [config, setConfig] = React.useState(null)          // {} once loaded; null while loading
  const [configError, setConfigError] = React.useState(false)
  const [docs, setDocs] = React.useState(null)              // policy documents that resolved
  const [docsError, setDocsError] = React.useState(false)
  const [accepted, setAccepted] = React.useState({})        // key → {policyKey,version,acceptedAt}
  const [accError, setAccError] = React.useState(false)     // acceptance list unreadable
  const [tick, setTick] = React.useState(0)

  React.useEffect(() => {
    let alive = true
    setConfigError(false)
    setDocsError(false)
    setAccError(false)
    api.settings.app.config()
      .then(c => { if (alive) setConfig(c || {}) })
      .catch(() => { if (alive) { setConfig({}); setConfigError(true) } })
    Promise.all([
      /* Tag each document with the key we ASKED for. The response echoes a
         `key` too, but the request is the authoritative one: it decides which
         acceptance row this card matches and which key the accept POST hits,
         and it is guaranteed unique (so it is also the safe React key). */
      Promise.all(POLICY_KEYS.map(([key]) =>
        api.settings.app.policy(key).then(d => (d ? { ...d, key } : null)).catch(() => null))),
      api.settings.app.accepted().catch(() => null),
    ]).then(([docList, acc]) => {
      if (!alive) return
      // An unreadable acceptance list is NOT "you have accepted nothing" — say so
      // rather than let three confident "Not accepted" chips stand.
      if (!Array.isArray(acc)) setAccError(true)
      const map = {}
      for (const a of acc || []) { if (a?.policyKey) map[a.policyKey] = a }
      setAccepted(map)
      const found = docList.filter(Boolean)
      // The three keys are fixed server-side, so "none of them resolved" is an
      // outage, not an empty shelf — never render that as a confident empty state.
      if (found.length === 0) { setDocsError(true); setDocs([]); return }
      setDocs(found.map(d => ({
        ...d,
        paragraphs: String(d.body || '').split(/\n{2,}/).map(s => s.trim()).filter(Boolean),
      })))
    })
    return () => { alive = false }
  }, [tick])

  /* The chip and the "Accepted …" line flip in place (which also takes the
     button away, so there is no second click to guard against), so a success
     toast would only repeat the row. The REVERT is what needs announcing —
     without it the row would just quietly snap back. */
  const accept = (doc) => {
    const prev = accepted[doc.key]
    setAccepted(m => ({ ...m, [doc.key]: { policyKey: doc.key, version: doc.version, acceptedAt: new Date().toISOString() } }))
    api.settings.app.acceptPolicy(doc.key)
      .then(r => setAccepted(m => ({ ...m, [doc.key]: r || m[doc.key] })))
      .catch(() => {
        setAccepted(m => {
          const next = { ...m }
          if (prev) next[doc.key] = prev; else delete next[doc.key]
          return next
        })
        showToast('Could not record your acceptance', 'err')
      })
  }

  const retry = () => { setConfig(null); setDocs(null); setTick(t => t + 1) }

  const latest = config?.latestVersion || ''
  const minimum = config?.minSupportedVersion || ''
  const behind = !UNSTAMPED && latest && compareVersions(CLIENT_VERSION, latest) < 0
  const unsupported = !UNSTAMPED && minimum && compareVersions(CLIENT_VERSION, minimum) < 0

  return (
    <div className="set-stack">
      <SetCard id="about" icon="info" title="About IKA" sub="The build you are running, and what the server expects.">
        {config === null ? (
          <Skeleton rows={3}/>
        ) : (
          <>
            <dl className="stx-kv">
              <dt>You are running</dt>
              <dd className="flex gap-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                {UNSTAMPED ? 'Development build' : CLIENT_VERSION}
                {behind && <span className="stx-chip warn"><Icon name="alert"/>Update available</span>}
              </dd>
              {CLIENT_BUILD && (<><dt>Built</dt><dd>{fmtDate(CLIENT_BUILD)}</dd></>)}
              <dt>Latest available</dt><dd>{latest || '—'}</dd>
              <dt>Minimum supported</dt><dd>{minimum || '—'}</dd>
            </dl>
            {configError && (
              <div className="stx-note warn"><Icon name="alert"/>
                <span>Could not reach the server for version information — only the build you are running is shown.</span>
              </div>
            )}
            {unsupported ? (
              <div className="stx-note err"><Icon name="alert"/>
                <span>This build is older than the minimum supported version. Reload the app to pick up the newest one.</span>
              </div>
            ) : behind ? (
              <div className="stx-note warn"><Icon name="alert"/>
                <span>
                  Version {latest} is available — reload the app to update.
                  {config.forceUpdate ? ' Updates are mandatory here, so this build will stop working.' : ''}
                </span>
              </div>
            ) : null}
          </>
        )}
      </SetCard>

      <SetCard id="policies" icon="doc" title="Policies"
        sub="The documents that govern this account, and the version of each one you have accepted.">
        {docs === null ? (
          <Skeleton rows={5}/>
        ) : docsError ? (
          <ErrorState message="Could not load the policy documents." onRetry={retry}/>
        ) : (
          <>
            {accError && (
              <div className="stx-note warn"><Icon name="alert"/>
                <span>Could not read which versions you have already accepted, so the states below may be out of date. Accepting again is harmless.</span>
              </div>
            )}
            {docs.map(doc => (
              <PolicyDoc key={doc.key} doc={doc} acceptance={accepted[doc.key]} onAccept={accept}/>
            ))}
          </>
        )}
      </SetCard>
    </div>
  )
}
