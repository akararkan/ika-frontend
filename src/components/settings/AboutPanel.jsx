/* =========================================================
   Settings v2 — about & policies.
   AboutPanel: app version block (permitAll config endpoint)
   plus one card per policy document (privacy / terms /
   guidelines) with acceptance state and an optimistic
   accept action. effectiveDate mirrors version on the wire,
   so only the version is ever rendered.
   ========================================================= */
import React from 'react'
import { Icon, showToast } from '../ui.jsx'
import { EmptyState } from '../states.jsx'
import { api, POLICY_KEYS } from '../../api/index.js'
import { SetCard, fmtWhen } from './shared.jsx'

const POLICY_ICONS = { privacy: 'lock', terms: 'doc', guidelines: 'users' }

function PolicyCard({ doc, acceptance, onAccept }) {
  const current = acceptance != null && acceptance.version === doc.version
  const paragraphs = String(doc.body || '').split(/\n{2,}/).map(s => s.trim()).filter(Boolean)
  return (
    <SetCard icon={POLICY_ICONS[doc.key] || 'doc'} title={doc.title} sub={'Version ' + doc.version}>
      <div>
        {current ? (
          <span className="stx-chip ok"><Icon name="check"/>Accepted · v{doc.version}</span>
        ) : acceptance ? (
          <span className="stx-chip warn"><Icon name="alert"/>Updated since you accepted</span>
        ) : (
          <span className="stx-chip plain">Not accepted</span>
        )}
      </div>
      {paragraphs.length > 0 && (
        <div className="stx-policy-body">
          {paragraphs.map((p, i) => (
            <p key={i} className="text-sm" style={{ margin: i ? '10px 0 0' : 0 }}>{p}</p>
          ))}
        </div>
      )}
      <div className="set-actions" style={{ marginTop: 12, alignItems: 'center' }}>
        {current ? (
          <small className="muted">Accepted {fmtWhen(acceptance.acceptedAt)}</small>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onAccept(doc)}>
            Accept {doc.version}
          </button>
        )}
      </div>
    </SetCard>
  )
}

export function AboutPanel() {
  const [config, setConfig] = React.useState(null)          // {} once loaded (or failed)
  const [docs, setDocs] = React.useState(null)              // policy documents that resolved
  const [accepted, setAccepted] = React.useState({})        // key → {policyKey,version,acceptedAt}

  React.useEffect(() => {
    let alive = true
    api.settings.app.config()
      .then(c => { if (alive) setConfig(c || {}) })
      .catch(() => { if (alive) setConfig({}) })
    Promise.all([
      /* Tag each document with the key we ASKED for. The response echoes a
         `key` too, but the request is the authoritative one: it decides which
         acceptance row this card matches and which key the accept POST hits,
         and it is guaranteed unique (so it is also the safe React key). */
      Promise.all(POLICY_KEYS.map(([key]) =>
        api.settings.app.policy(key).then(d => (d ? { ...d, key } : null)).catch(() => null))),
      api.settings.app.accepted().catch(() => []),
    ]).then(([docList, acc]) => {
      if (!alive) return
      const map = {}
      for (const a of acc || []) { if (a?.policyKey) map[a.policyKey] = a }
      setAccepted(map)
      setDocs(docList.filter(Boolean))                      // a missing document is simply skipped
    })
    return () => { alive = false }
  }, [])

  const accept = (doc) => {
    const prev = accepted[doc.key]
    setAccepted(m => ({ ...m, [doc.key]: { policyKey: doc.key, version: doc.version, acceptedAt: new Date().toISOString() } }))
    api.settings.app.acceptPolicy(doc.key)
      .then(r => {
        setAccepted(m => ({ ...m, [doc.key]: r || m[doc.key] }))
        showToast(`Accepted ${doc.title}`)
      })
      .catch(() => {
        setAccepted(m => {
          const next = { ...m }
          if (prev) next[doc.key] = prev; else delete next[doc.key]
          return next
        })
        showToast('Could not record your acceptance')
      })
  }

  return (
    <div className="set-stack">
      <SetCard icon="info" title="About IKA" sub="Version information for this app.">
        {config === null ? (
          <p className="muted text-sm">Loading…</p>
        ) : (
          <>
            <dl className="stx-kv">
              <dt>App version</dt><dd>{config.latestVersion || '—'}</dd>
              <dt>Minimum supported version</dt><dd>{config.minSupportedVersion || '—'}</dd>
            </dl>
            {config.forceUpdate && (
              <div className="stx-note warn"><Icon name="alert"/><span>Older clients must update to continue.</span></div>
            )}
          </>
        )}
      </SetCard>

      {docs === null ? (
        <SetCard icon="doc" title="Policies">
          <p className="muted text-sm">Loading…</p>
        </SetCard>
      ) : docs.length === 0 ? (
        <SetCard icon="doc" title="Policies">
          <EmptyState icon="doc" title="No policies to show" sub="Policy documents will appear here once published."/>
        </SetCard>
      ) : docs.map(doc => (
        <PolicyCard key={doc.key} doc={doc} acceptance={accepted[doc.key]} onAccept={accept}/>
      ))}
    </div>
  )
}
