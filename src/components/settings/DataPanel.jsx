/* =========================================================
   Settings v2 — your data & the danger zone.
   DataExportPanel: request/track/download the account export
   (1 per 30 days, download lives 48 h; no job-list endpoint,
   so the last jobId is kept in localStorage — keyed per account,
   because a shared browser must not hand one member's job to
   the next one who signs in) + search/watch history clearing.
   DangerZonePanel: account deletion — the request instantly
   soft-deletes and revokes every session, so success IS a
   logout; a quiet row cancels a pending deletion.
   ========================================================= */
import React from 'react'
import { Icon, showToast } from '../ui.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { Loader } from '../states.jsx'
import { api, session } from '../../api/index.js'
import { saveBlob } from '../../api/http.js'
import { useAuth } from '../../context/AuthContext.jsx'
import { SetCard, fmtBytes, fmtWhen } from './shared.jsx'

const JOB_KEY_PREFIX = 'ika_export_job_'

export function DataExportPanel() {
  const { user } = useAuth()
  const [job, setJob] = React.useState(undefined)          // undefined = checking, null = no job
  const [busy, setBusy] = React.useState(false)            // requesting
  const [downloading, setDownloading] = React.useState(false)

  // Scoped per account: an unscoped key would leak (and, on 404, destroy) the
  // previous signer-in's only pointer to their export. No id ⇒ no storage at all.
  const jobKey = user?.id ? JOB_KEY_PREFIX + user.id : null

  /* Recover the last job from localStorage — there is no list endpoint. */
  React.useEffect(() => {
    let alive = true
    const jobId = jobKey ? localStorage.getItem(jobKey) : null
    if (!jobId) { setJob(null); return undefined }
    api.settings.data.exportStatus(jobId)
      .then(j => { if (alive) setJob(j) })
      .catch(e => {
        if (!alive) return
        // 403 = the job is simply not ours, so leave storage alone; only a 404
        // (our own job is gone server-side) means the pointer is worth dropping.
        if (e?.status === 404) localStorage.removeItem(jobKey)
        setJob(null)
      })
    return () => { alive = false }
  }, [jobKey])

  /* Poll while the job is still being built. */
  const jobId = job?.jobId
  const status = job?.status
  React.useEffect(() => {
    if (!jobId || (status !== 'PENDING' && status !== 'RUNNING')) return undefined
    let alive = true
    const t = setInterval(() => {
      api.settings.data.exportStatus(jobId)
        .then(j => { if (alive) setJob(j) })
        .catch(e => {
          if (!alive) return
          if (e?.status === 404) { if (jobKey) localStorage.removeItem(jobKey); setJob(null) }
          else if (e?.status === 403) setJob(null)   // not ours — forget it here, keep storage intact
        })
    }, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [jobId, status, jobKey])

  const request = () => {
    if (busy) return
    setBusy(true)
    api.settings.data.requestExport()
      .then(j => {
        if (jobKey) localStorage.setItem(jobKey, j.jobId)
        setJob(j)
        showToast('Export requested — we are preparing your archive')
      })
      .catch(e => { if (e?.status !== 429) showToast('Could not request an export') })   // 429 already toasts globally
      .finally(() => setBusy(false))
  }

  const download = () => {
    if (downloading || !jobId) return
    setDownloading(true)
    api.settings.data.downloadExport(jobId)
      .then(r => saveBlob(r, 'irc-export.zip'))
      .catch(() => showToast('Could not download — the export may have expired'))
      .finally(() => setDownloading(false))
  }

  const clear = async (type, label) => {
    const ok = await uiConfirm({
      title: `Clear ${label}?`,
      message: `Your ${label} will be removed from this account. This cannot be undone.`,
      confirmLabel: 'Clear',
      danger: true,
      icon: 'trash',
    })
    if (!ok) return
    api.settings.data.clearHistory(type)
      .then(() => showToast(type === 'search' ? 'Search history cleared' : 'Watch history cleared'))
      .catch(() => showToast(`Could not clear your ${label}`))
  }

  const sub = 'A ZIP of your profile and account data. One export per 30 days; the download stays available for 48 hours after it is ready.'
  const requestBtn = (
    <button type="button" className="btn btn-primary" disabled={busy} onClick={request}>
      <Icon name="download" className="xs"/>{busy ? 'Requesting…' : 'Request export'}
    </button>
  )

  if (job === undefined) {
    return (
      <SetCard icon="download" title="Export your data" sub={sub}>
        <p className="muted text-sm">Loading…</p>
      </SetCard>
    )
  }
  return (
    <SetCard icon="download" title="Export your data" sub={sub}>
      {job === null && <div className="set-actions">{requestBtn}</div>}

      {(status === 'PENDING' || status === 'RUNNING') && (
        <>
          <div className="flex gap-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="stx-chip info"><Icon name="hourglass"/>{status === 'PENDING' ? 'Queued' : 'Preparing'}</span>
            {job.createdAt && <span className="muted text-xs">requested {fmtWhen(job.createdAt)}</span>}
          </div>
          <Loader label="Preparing your archive…"/>
        </>
      )}

      {status === 'READY' && (
        <>
          <div className="flex gap-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="stx-chip ok"><Icon name="check"/>Ready</span>
            <span className="muted text-sm">{fmtBytes(job.sizeBytes)} · expires {fmtWhen(job.expiresAt)}</span>
          </div>
          <div className="set-actions" style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-primary" disabled={downloading} onClick={download}>
              <Icon name="download" className="xs"/>{downloading ? 'Downloading…' : 'Download ZIP'}
            </button>
          </div>
        </>
      )}

      {status === 'FAILED' && (
        <>
          <div className="flex gap-8" style={{ alignItems: 'center' }}>
            <span className="stx-chip err"><Icon name="alert"/>Export failed</span>
          </div>
          <div className="set-actions" style={{ marginTop: 10 }}>{requestBtn}</div>
        </>
      )}

      {status === 'EXPIRED' && (
        <>
          <div className="flex gap-8" style={{ alignItems: 'center' }}>
            <span className="stx-chip plain"><Icon name="clock"/>Expired</span>
          </div>
          <div className="set-actions" style={{ marginTop: 10 }}>{requestBtn}</div>
        </>
      )}

      <div className="set-toggle" style={{ marginTop: 16 }}>
        <div><b>Clear search history</b><small className="muted">Removes every search you have made here. Suggestions may become less relevant for a while.</small></div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => clear('search', 'search history')}>Clear</button>
      </div>
      <div className="set-toggle">
        <div><b>Clear watch history</b><small className="muted">Removes your reel and video watch history. Recommendations start fresh.</small></div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => clear('watch', 'watch history')}>Clear</button>
      </div>
    </SetCard>
  )
}

export function DangerZonePanel() {
  const [busy, setBusy] = React.useState(false)

  const requestDelete = async () => {
    if (busy) return
    const ok = await uiConfirm({
      title: 'Delete your account?',
      message: 'Your profile and everything you have posted disappear immediately, and you are signed out on every device. You have 30 days to change your mind by signing back in and cancelling; after that everything is permanently anonymised.',
      confirmLabel: 'Delete account',
      danger: true,
      icon: 'trash',
    })
    if (!ok) return
    setBusy(true)
    try {
      await api.settings.data.requestDeletion()
      // The account is soft-deleted NOW and every session is revoked — treat this as a logout.
      showToast('Account scheduled for deletion — signing you out')
      session.clear()
      window.location.assign('/login')
    } catch (e) {
      if (e?.code === 'DELETION_PENDING') {
        const cancel = await uiConfirm({
          title: 'Deletion already pending',
          message: 'This account is already scheduled for deletion. Do you want to cancel that and keep your account instead?',
          confirmLabel: 'Cancel deletion',
          icon: 'refresh',
        })
        if (cancel) {
          try { await api.settings.data.cancelDeletion(); showToast('Deletion cancelled') }
          catch { showToast('Could not cancel the deletion') }
        }
      } else if (e?.status !== 429) {
        showToast('Could not request the deletion')
      }
    } finally { setBusy(false) }
  }

  const cancelScheduled = async () => {
    try {
      await api.settings.data.cancelDeletion()
      showToast('Deletion cancelled — your account stays')
    } catch (e) {
      if (e?.status === 404) showToast('No deletion is scheduled')
      else if (e?.status !== 429) showToast('Could not cancel the deletion')
    }
  }

  return (
    <SetCard danger icon="trash" title="Delete account"
      sub="Your profile and content disappear immediately. You have 30 days to change your mind by signing back in and cancelling; after that everything is permanently anonymised.">
      <div className="set-actions">
        <button type="button" className="btn btn-danger" disabled={busy} onClick={requestDelete}>
          <Icon name="trash" className="xs"/>{busy ? 'Deleting…' : 'Delete my account'}
        </button>
      </div>
      <div className="set-toggle" style={{ marginTop: 12 }}>
        <div><b>Cancel a scheduled deletion</b><small className="muted">If a deletion is pending on this account, stop it and keep everything as it was.</small></div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={cancelScheduled}>Cancel deletion</button>
      </div>
    </SetCard>
  )
}
