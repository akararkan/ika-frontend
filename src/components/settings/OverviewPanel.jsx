/* =========================================================
   Settings v2 — the Overview landing tab.
   ---------------------------------------------------------
   /settings used to land silently on the profile editor, so the
   four things a person opens Settings to check — is my account
   secure, how much have I stored, am I in trouble, is my export
   ready — were each three clicks deep in four different groups.

   Every tile is a link into the card that owns the real control,
   and every tile degrades to "unavailable" rather than a
   fabricated zero: a failed fetch that renders "0 strikes" is
   worse than no tile at all.
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../ui.jsx'
import { api } from '../../api/index.js'
import { useAuth } from '../../context/AuthContext.jsx'
import { SetCard, fmtBytes, fmtWhen, Skeleton } from './shared.jsx'

const JOB_KEY_PREFIX = 'ika_export_job_'
const LEVEL_LABELS = { LOW: 'At risk', MEDIUM: 'Fair', HIGH: 'Strong', EXCELLENT: 'Excellent' }

/** One status tile. `state` is 'loading' | 'ok' | 'unavailable'. */
function Tile({ state, icon, label, value, sub, chip, attn, onClick, actionLabel }) {
  return (
    <button type="button" className={'stx-tile' + (attn ? ' attn' : '')} onClick={onClick}
      aria-label={`${label}: ${state === 'ok' ? (typeof value === 'string' ? value : '') : 'unavailable'}. ${actionLabel || 'Open'}`}>
      <span className="stx-tile-top"><Icon name={attn ? 'alert' : icon}/>{label}</span>
      {state === 'loading' ? (
        <Skeleton rows={2}/>
      ) : state === 'unavailable' ? (
        <span className="stx-chip plain"><Icon name="info"/>Unavailable</span>
      ) : (
        <>
          {value != null && <span className="stx-tile-val">{value}</span>}
          {chip}
          {sub && <span className="stx-tile-sub">{sub}</span>}
        </>
      )}
    </button>
  )
}

/** null = still loading, false = the call failed, otherwise the payload. */
function useProbe(fn, deps = []) {
  const [state, setState] = React.useState(null)
  React.useEffect(() => {
    let alive = true
    fn().then(r => { if (alive) setState(r ?? false) }).catch(() => { if (alive) setState(false) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}

export function OverviewPanel() {
  const navigate = useNavigate()
  const { user } = useAuth()

  const score = useProbe(() => api.settings.safety.score())
  const usage = useProbe(() => api.settings.storage.usage())
  const strikes = useProbe(() => api.settings.safety.strikes())
  const dnd = useProbe(() => api.settings.notifications.dnd())
  const twofa = useProbe(() => api.security.twofa.status())

  /* There is no export-job list endpoint — DataPanel keeps the last job id in
     localStorage, keyed per account. Read the same pointer rather than
     inventing a second source of truth. */
  const jobKey = user?.id ? JOB_KEY_PREFIX + user.id : null
  const [job, setJob] = React.useState(null)
  React.useEffect(() => {
    const id = jobKey ? localStorage.getItem(jobKey) : null
    if (!id) { setJob(false); return undefined }
    let alive = true
    api.settings.data.exportStatus(id)
      .then(j => { if (alive) setJob(j || false) })
      .catch(() => { if (alive) setJob(false) })
    return () => { alive = false }
  }, [jobKey])

  const go = (tab, anchor) => navigate(`/settings/${tab}#${anchor}`)
  const st = (v) => (v === null ? 'loading' : v === false ? 'unavailable' : 'ok')

  const strikeCount = Array.isArray(strikes) ? strikes.length : null
  const quiet = dnd && dnd !== true && dnd.enabled && dnd.startTime && dnd.endTime
  const snoozed = dnd && dnd !== true && dnd.muteUntil

  return (
    <div className="set-stack">
      {/* The tab heading above already says "Overview" — this card names what
          it actually shows, so the two headings do not read as a stutter. */}
      <SetCard id="overview" icon="grid" title="At a glance"
        sub="How your account stands right now. Each card opens the setting behind it.">
        <div className="stx-overview">
          <Tile
            state={st(score)} icon="shield" label="Security"
            attn={!!score && score !== true && (score.level === 'LOW' || score.level === 'MEDIUM')}
            value={score && score !== true ? String(score.score ?? '—') : null}
            sub={score && score !== true
              ? `${LEVEL_LABELS[score.level] || score.level || ''}${twofa && twofa !== true ? (twofa.enabled ? ' · 2FA on' : ' · 2FA off') : ''}`
              : null}
            actionLabel="Open the security checkup"
            onClick={() => go('security', 'security-score')}
          />

          <Tile
            state={st(usage)} icon="image" label="Storage"
            value={usage && usage !== true ? fmtBytes(usage.totalBytes ?? 0) : null}
            sub="Processed media on the server"
            actionLabel="Open storage"
            onClick={() => go('media', 'storage')}
          />

          <Tile
            state={st(strikes)} icon="flag" label="Standing"
            attn={!!strikeCount}
            value={strikeCount == null ? null : strikeCount === 0 ? 'Good' : String(strikeCount)}
            sub={strikeCount === 0 ? 'No active strikes'
              : strikeCount === 1 ? '1 active strike'
              : strikeCount ? `${strikeCount} active strikes` : null}
            actionLabel="Open the Safety Center"
            onClick={() => go('safety', 'strikes')}
          />

          <Tile
            state={st(dnd)} icon="bell" label="Notifications"
            value={snoozed ? 'Snoozed' : quiet ? 'Quiet hours' : 'On'}
            sub={snoozed ? 'Muted until further notice'
              : quiet ? `${dnd.startTime}–${dnd.endTime}` : 'No quiet hours set'}
            actionLabel="Open notification settings"
            onClick={() => go('notifications', 'dnd')}
          />

          {job && job !== true && (
            <Tile
              state="ok" icon="download" label="Data export"
              value={job.status === 'READY' ? 'Ready' : job.status === 'FAILED' ? 'Failed' : 'Preparing'}
              sub={job.status === 'READY' && job.expiresAt ? `Expires ${fmtWhen(job.expiresAt)}` : 'Your account archive'}
              actionLabel="Open your data"
              onClick={() => go('data', 'export')}
            />
          )}
        </div>

        <div className="stx-jump">
          <button type="button" onClick={() => go('privacy', 'privacy')}><Icon name="lock"/>Who can see what</button>
          <button type="button" onClick={() => go('sessions', 'sessions')}><Icon name="clock"/>Where you’re signed in</button>
          <button type="button" onClick={() => go('muted', 'keywords')}><Icon name="mute"/>Hidden words</button>
          <button type="button" onClick={() => go('data', 'export')}><Icon name="download"/>Download your data</button>
        </div>
      </SetCard>
    </div>
  )
}
