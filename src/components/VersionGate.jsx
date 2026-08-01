/* =========================================================
   VersionGate — the client build gate and policy re-consent
   prompt (§19). Mounted once inside the app shell.
   Three outcomes, cheapest first:
     1. too old (below minSupportedVersion, or behind
        latestVersion while forceUpdate is on) → a blocking
        overlay whose only action is a reload;
     2. merely behind latestVersion → a dismissible bottom
        banner (dismissal lasts the tab session);
     3. a policy document published a version the account has
        not accepted → the same banner, pointing at
        /settings/about.
   Wire: app.config()/app.policy() are permitAll; accepted() is
   a bare array keyed `policyKey` (the doc says `key`). Every
   request is individually caught — a settings outage must
   never wedge the app, so any failure renders nothing.
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from './ui.jsx'
import { api, session, POLICY_KEYS } from '../api/index.js'

const CLIENT_VERSION = import.meta.env?.VITE_APP_VERSION || '1.0.0'
const UPDATE_KEY = 'ika_update_dismissed'
const POLICY_KEY = 'ika_policy_prompt_dismissed'

/* ---------- version compare ---------- */

/** One dotted segment as a number; junk ('beta', '', undefined) counts as 0. */
function seg(part) {
  const n = parseInt(part, 10)
  return Number.isFinite(n) ? n : 0
}

/** Semver-ish compare: -1 / 0 / 1. Missing trailing parts are 0, so
 *  '1.2' === '1.2.0' and '1.2.0' < '1.2.1'. Never throws. */
function cmp(a, b) {
  const pa = String(a ?? '').split('.')
  const pb = String(b ?? '').split('.')
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = seg(pa[i]), y = seg(pb[i])
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/* ---------- session-scoped dismissal (storage can throw) ---------- */

function wasDismissed(key) {
  try { return sessionStorage.getItem(key) === '1' } catch { return false }
}
function remember(key) {
  try { sessionStorage.setItem(key, '1') } catch { /* private mode — dismiss for this render only */ }
}

/* ---------- the slim bottom banner ---------- */

function Banner({ icon, text, actionLabel, onAction, onDismiss }) {
  return (
    <div className="card" role="status"
      style={{
        position: 'fixed', left: 16, right: 16, bottom: 16,
        maxWidth: 520, margin: '0 auto', zIndex: 3000,
        padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10,
        boxShadow: '0 18px 40px -18px rgba(13,21,32,.45)',
      }}>
      <Icon name={icon} className="sm"/>
      <span className="text-sm" style={{ flex: 1, lineHeight: 1.4 }}>{text}</span>
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
  const [gate, setGate] = React.useState(null)          // 'block' | 'update' | null
  const [latest, setLatest] = React.useState('')
  const [policyText, setPolicyText] = React.useState('')
  const [updateOff, setUpdateOff] = React.useState(() => wasDismissed(UPDATE_KEY))
  const [policyOff, setPolicyOff] = React.useState(() => wasDismissed(POLICY_KEY))

  React.useEffect(() => {
    let alive = true

    const run = async () => {
      const cfg = await api.settings.app.config().catch(() => null)
      if (!alive || !cfg) return

      const min = cfg.minSupportedVersion || ''
      const newest = cfg.latestVersion || ''
      const blocking = (!!min && cmp(CLIENT_VERSION, min) < 0) ||
        (!!cfg.forceUpdate && !!newest && cmp(CLIENT_VERSION, newest) < 0)
      const behind = !blocking && !!newest && cmp(CLIENT_VERSION, newest) < 0

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
      setPolicyText(stale.length > 1 ? 'Please review our policies' : `Our ${title} has been updated`)
    }

    run().catch(() => { /* never block the app on a settings failure */ })
    return () => { alive = false }
  }, [])

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

  /* 3 — policy re-consent. */
  if (policyText && !policyOff) {
    return (
      <Banner
        icon="doc"
        text={policyText}
        actionLabel="Review"
        onAction={() => { remember(POLICY_KEY); setPolicyOff(true); navigate('/settings/about') }}
        onDismiss={() => { remember(POLICY_KEY); setPolicyOff(true) }}
      />
    )
  }

  return null
}
