/* =========================================================
   VersionGate — the client build gate and policy re-consent
   prompt (§19). Mounted at the ROUTER ROOT (App.jsx) so it also
   covers /login and /register: GET /app/config is permitAll
   precisely so a defective build is retired BEFORE anyone signs
   in. Signed out it only issues that one public call.
   Three outcomes, cheapest first:
     1. too old (below minSupportedVersion, or behind
        latestVersion while forceUpdate is on) → a blocking
        overlay whose only action is a reload;
     2. merely behind latestVersion → a dismissible bottom
        banner (dismissal lasts the tab session);
     3. a policy document published a version the account has
        not accepted → the same banner, pointing at
        /settings/about (or the public /policies/:key when the
        session has lapsed since — /settings is auth-gated).
   Outcomes 1 and 2 need a version to compare; an unstamped
   build (0.0.0) is skipped rather than treated as ancient.
   Wire: app.config()/app.policy() are permitAll; accepted() is
   a bare array keyed `policyKey` (the doc says `key`). Every
   request is individually caught — a settings outage must
   never wedge the app, so any failure renders nothing (fail
   open: a network blip must not lock anyone out).
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from './ui.jsx'
import { api, session, POLICY_KEYS } from '../api/index.js'
import { CLIENT_VERSION, compareVersions as cmp } from '../lib/version.js'

const UPDATE_KEY = 'ika_update_dismissed'
const POLICY_KEY = 'ika_policy_prompt_dismissed'

/* A build with no injected version reports 0.0.0 — that is "unknown", not
   "ancient". Comparing it would put every browser behind the server's default
   minSupportedVersion (1.0.0) and hard-block the app the moment a pipeline
   forgets to stamp package.json, so an unstamped build is never gated at all.
   AboutPanel calls the same state a "Development build". */
const UNSTAMPED = !CLIENT_VERSION || CLIENT_VERSION === '0.0.0'

/* ---------- one live gate at a time ----------
   The root mount covers the logged-out routes, but the shell (Layout) mounts
   its own copy as well, and two live gates would stack two overlays and fire
   two config calls. So instances queue: the first to mount owns the screen,
   the rest render nothing and only take over if it goes away. */
const parked = new Set()
let holder = null

function useGateLead() {
  const [lead, setLead] = React.useState(false)
  React.useEffect(() => {
    const self = { take: () => setLead(true) }
    if (holder) parked.add(self)
    else { holder = self; setLead(true) }
    return () => {
      parked.delete(self)
      if (holder !== self) return
      /* Drop our own lead BEFORE handing it on — StrictMode runs this cleanup
         between the two mount passes, and a stale `true` here would leave two
         instances rendering. */
      setLead(false)
      holder = null
      const next = parked.values().next().value
      if (next) { parked.delete(next); holder = next; next.take() }
    }
  }, [])
  return lead
}

/* ---------- session-scoped dismissal (storage can throw) ---------- */

function wasDismissed(key) {
  try { return sessionStorage.getItem(key) === '1' } catch { return false }
}
function remember(key) {
  try { sessionStorage.setItem(key, '1') } catch { /* private mode — dismiss for this render only */ }
}

/* ---------- the slim bottom banner ---------- */

/* Positioning lives in settings.css (.vg-banner) rather than inline, because it
   has to clear the mobile bottom nav — a fixed `bottom:16px` planted this
   directly on top of the tab bar, covering it. */
function Banner({ icon, text, actionLabel, onAction, onDismiss }) {
  return (
    <div className="card vg-banner" role="status">
      <Icon name={icon} className="sm"/>
      <span className="text-sm vg-banner-txt">{text}</span>
      <button type="button" className="btn btn-primary btn-sm" onClick={onAction}>{actionLabel}</button>
      <button type="button" className="icon-btn" aria-label="Dismiss" onClick={onDismiss}>
        <Icon name="close" className="sm"/>
      </button>
    </div>
  )
}

/* ---------- the gate ---------- */

export function VersionGate() {
  const navigate = useNavigate()
  const lead = useGateLead()
  const [gate, setGate] = React.useState(null)          // 'block' | 'update' | null
  const [latest, setLatest] = React.useState('')
  const [policy, setPolicy] = React.useState(null)      // {text, key} once a doc is stale
  const [updateOff, setUpdateOff] = React.useState(() => wasDismissed(UPDATE_KEY))
  const [policyOff, setPolicyOff] = React.useState(() => wasDismissed(POLICY_KEY))

  React.useEffect(() => {
    if (!lead) return undefined
    let alive = true

    const run = async () => {
      const cfg = await api.settings.app.config().catch(() => null)
      if (!alive || !cfg) return

      const min = cfg.minSupportedVersion || ''
      const newest = cfg.latestVersion || ''
      const blocking = !UNSTAMPED && ((!!min && cmp(CLIENT_VERSION, min) < 0) ||
        (!!cfg.forceUpdate && !!newest && cmp(CLIENT_VERSION, newest) < 0))
      const behind = !UNSTAMPED && !blocking && !!newest && cmp(CLIENT_VERSION, newest) < 0

      setLatest(newest)
      setGate(blocking ? 'block' : behind ? 'update' : null)

      /* The blocking gate owns the screen — nothing else is worth asking. */
      if (blocking) return
      /* The acceptance list needs a session; signed-out visitors are skipped. */
      if (!session.isAuthed()) return

      const [docs, accepted] = await Promise.all([
        Promise.all(POLICY_KEYS.map(([key]) => api.settings.app.policy(key).catch(() => null))),
        api.settings.app.accepted().catch(() => null),
      ])
      if (!alive || !Array.isArray(accepted)) return

      const isAccepted = (doc) => accepted.some(a =>
        String(a?.policyKey || '').toLowerCase() === String(doc.key || '').toLowerCase() &&
        String(a?.version || '') === String(doc.version || ''))
      const stale = docs.filter(d => d && d.version && !isAccepted(d))
      if (!stale.length) return

      const known = POLICY_KEYS.find(([k]) => k === stale[0].key)
      const title = stale[0].title || (known ? known[1] : 'policy')
      setPolicy({
        key: stale[0].key,
        text: stale.length > 1 ? 'Please review our policies' : `Our ${title} has been updated`,
      })
    }

    run().catch(() => { /* never block the app on a settings failure */ })
    return () => { alive = false }
  }, [lead])

  if (!lead) return null

  /* 1 — hard gate. No dismiss control: that is the point. */
  if (gate === 'block') {
    return (
      <div role="dialog" aria-modal="true" aria-labelledby="vg-title"
        style={{
          position: 'fixed', inset: 0, zIndex: 4000,
          background: 'rgba(11,18,32,.72)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
        <div className="dlg" style={{ maxWidth: 420, borderRadius: 'var(--r-xl)' }}>
          <div className="dlg-head">
            <div className="dlg-ic"><Icon name="download"/></div>
            <h3 id="vg-title">Update required</h3>
          </div>
          <div className="dlg-body">
            <p className="dlg-msg">
              This version of IKA is no longer supported. Reload the page to pick up the current
              build — nothing you have saved is affected.
            </p>
            <p className="muted text-xs">
              You are running {CLIENT_VERSION}{latest ? ` · current build is ${latest}` : ''}
            </p>
          </div>
          <div className="dlg-foot">
            <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
              <Icon name="refresh" className="xs"/>Reload
            </button>
          </div>
        </div>
      </div>
    )
  }

  /* 2 — soft update nudge, which outranks the policy prompt. */
  if (gate === 'update' && !updateOff) {
    return (
      <Banner
        icon="refresh"
        text={`A newer version of IKA is available${latest ? ` (${latest})` : ''}. Reload when it suits you.`}
        actionLabel="Reload"
        onAction={() => window.location.reload()}
        onDismiss={() => { remember(UPDATE_KEY); setUpdateOff(true) }}
      />
    )
  }

  /* 3 — policy re-consent. Only ever reached with a session (the acceptance
     list needs one), but /settings/about is auth-gated and a token can lapse
     between the fetch and the click — the public document is the safe landing. */
  if (policy && !policyOff) {
    return (
      <Banner
        icon="doc"
        text={policy.text}
        actionLabel="Review"
        onAction={() => {
          remember(POLICY_KEY); setPolicyOff(true)
          navigate(session.isAuthed() ? '/settings/about' : `/policies/${policy.key}`)
        }}
        onDismiss={() => { remember(POLICY_KEY); setPolicyOff(true) }}
      />
    )
  }

  return null
}
