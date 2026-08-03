/* =========================================================
   Settings v2 — your data & the danger zone.
   DataExportPanel: request/track/download the account export
   (1 per 30 days, download lives 48 h; no job-list endpoint,
   so the last jobId is kept in localStorage — keyed per account,
   because a shared browser must not hand one member's job to
   the next one who signs in) + search/watch history clearing —
   which HistoryService only validates and logs, so the copy on
   those two rows must not claim a deletion that never happens.
   DangerZonePanel: account deletion. The request soft-deletes
   the account NOW and revokes every refresh token, so success
   IS a logout — and because CustomUserDetailsService only loads
   users with deletedAt == null, the account cannot sign in again
   during the 30-day grace window. There is therefore no in-app
   "change your mind" path and no deletion-status endpoint
   (AccountLifecycleService.currentPending is wired to nothing):
   cancel is only reachable in the one state where a live session
   still exists — a request that came back DELETION_PENDING.
   ========================================================= */
import React from 'react'
import { Icon, showToast } from '../ui.jsx'
import { uiConfirm, uiPrompt } from '../Dialog.jsx'
import { Loader } from '../states.jsx'
import { api, session } from '../../api/index.js'
import { saveBlob } from '../../api/http.js'
import { useAuth } from '../../context/AuthContext.jsx'
import { SetCard, SubHead, ControlRow, fmtBytes, fmtWhen, parseServerDate, requireStepUp } from './shared.jsx'

const JOB_KEY_PREFIX = 'ika_export_job_'
const DAY_MS = 86_400_000

export function DataExportPanel() {
  const { user } = useAuth()
  const [job, setJob] = React.useState(undefined)          // undefined = checking, null = no job
  const [busy, setBusy] = React.useState(false)            // requesting
  const [downloading, setDownloading] = React.useState(false)
  const [lapsed, setLapsed] = React.useState(false)        // READY whose 48 h window has just run out
  const [clearing, setClearing] = React.useState(null)     // 'search' | 'watch' while the DELETE is in flight

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
  const expiresAt = job?.expiresAt
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

  /* READY → EXPIRED is flipped LAZILY, only when someone reads the job
     (DataExportService.getJob), so a card left open past the 48 h window keeps
     offering a download that answers 404. Mark the lapse locally the moment the
     clock passes it, and re-read so the server agrees. */
  React.useEffect(() => {
    setLapsed(false)
    if (!jobId || status !== 'READY') return undefined
    const d = parseServerDate(expiresAt)
    if (!d) return undefined
    const ms = d.getTime() - Date.now()
    if (ms > DAY_MS) return undefined                 // too far out to be worth a timer; a remount re-reads
    let alive = true
    const t = setTimeout(() => {
      if (!alive) return
      setLapsed(true)
      api.settings.data.exportStatus(jobId).then(j => { if (alive) setJob(j) }).catch(() => {})
    }, Math.max(0, ms) + 1000)                        // +1 s so the server's clock is past it too
    return () => { alive = false; clearTimeout(t) }
  }, [jobId, status, expiresAt])

  const view = status === 'READY' && lapsed ? 'EXPIRED' : status

  const request = () => {
    if (busy) return
    setBusy(true)
    api.settings.data.requestExport()
      .then(j => {
        if (jobKey && j?.jobId) localStorage.setItem(jobKey, j.jobId)   // never store "undefined" as a pointer
        setJob(j)
        showToast('Export requested — we are preparing your archive')
      })
      .catch(e => { if (e?.status !== 429) showToast('Could not request an export', 'err') })   // 429 already toasts globally
      .finally(() => setBusy(false))
  }

  const download = () => {
    if (downloading || !jobId) return
    setDownloading(true)
    api.settings.data.downloadExport(jobId)
      .then(r => saveBlob(r, 'irc-export.zip'))
      .catch(() => {
        showToast('That download is no longer available', 'err')
        // The read is what flips a lapsed job to EXPIRED, so re-reading turns the
        // card into the honest state instead of leaving a button that keeps failing.
        api.settings.data.exportStatus(jobId).then(j => setJob(j)).catch(() => setLapsed(true))
      })
      .finally(() => setDownloading(false))
  }

  /* HONESTY: HistoryService validates the type, logs, and returns 204 — this
     platform has no search/watch history stores yet, so the call deletes
     nothing. The control stays (it is the real endpoint, and it starts working
     the day those stores land) but nothing here may claim a deletion. */
  const clear = async (type, label) => {
    if (clearing) return
    const ok = await uiConfirm({
      title: `Clear ${label}?`,
      message: `This asks the server to delete your ${label}. Nothing is stored separately for it yet, so today the request is accepted without removing anything.`,
      confirmLabel: 'Send request',
      icon: 'trash',
    })
    if (!ok) return
    setClearing(type)
    api.settings.data.clearHistory(type)
      .then(() => showToast(`Request accepted — no ${label} is stored yet, so nothing was removed`))
      .catch(() => showToast(`Could not clear your ${label}`, 'err'))
      .finally(() => setClearing(null))
  }

  const sub = 'A ZIP of your profile and account data. One export per 30 days; the download stays available for 48 hours after it is ready.'
  const requestBtn = (
    <button type="button" className="btn btn-primary" disabled={busy} onClick={request}>
      <Icon name="download" className="xs"/>{busy ? 'Requesting…' : 'Request export'}
    </button>
  )
  /* The 30-day limiter counts requests, not successes, so the button in a
     finished/failed state may still answer 429 — say so rather than let it look broken. */
  const limitNote = <small className="muted">Exports are limited to one every 30 days, so a new request may not be available yet.</small>

  /* One return, so the history rows below do not disappear and re-appear while
     the last export is being looked up. */
  return (
    <SetCard id="export" icon="download" title="Export your data" sub={sub}>
      {job === undefined && <Loader label="Checking your last export…"/>}
      {job === null && <div className="set-actions">{requestBtn}</div>}

      {(view === 'PENDING' || view === 'RUNNING') && (
        <>
          <div className="flex gap-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="stx-chip info"><Icon name="hourglass"/>{view === 'PENDING' ? 'Queued' : 'Preparing'}</span>
            {job.createdAt && <span className="muted text-xs">requested {fmtWhen(job.createdAt)}</span>}
          </div>
          <Loader label="Preparing your archive…"/>
        </>
      )}

      {view === 'READY' && (
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

      {view === 'FAILED' && (
        <>
          <div className="flex gap-8" style={{ alignItems: 'center' }}>
            <span className="stx-chip err"><Icon name="alert"/>Export failed</span>
          </div>
          <div className="set-actions" style={{ marginTop: 10 }}>{requestBtn}</div>
          {limitNote}
        </>
      )}

      {view === 'EXPIRED' && (
        <>
          <div className="flex gap-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="stx-chip plain"><Icon name="clock"/>Expired</span>
            <span className="muted text-sm">The 48-hour download window closed{job.expiresAt ? ` ${fmtWhen(job.expiresAt)}` : ''}.</span>
          </div>
          <div className="set-actions" style={{ marginTop: 10 }}>{requestBtn}</div>
          {limitNote}
        </>
      )}

      <SubHead>History</SubHead>
      <ControlRow
        title="Clear search history"
        desc="Your searches are not kept in a history you can be shown yet, so there is nothing here to remove today.">
        <button type="button" className="btn btn-secondary btn-sm" disabled={clearing === 'search'}
          onClick={() => clear('search', 'search history')}>
          {clearing === 'search' ? 'Clearing…' : 'Clear'}
        </button>
      </ControlRow>
      <ControlRow
        title="Clear watch history"
        desc="Reel and video watches are not kept in a history you can be shown yet, so there is nothing here to remove today.">
        <button type="button" className="btn btn-secondary btn-sm" disabled={clearing === 'watch'}
          onClick={() => clear('watch', 'watch history')}>
          {clearing === 'watch' ? 'Clearing…' : 'Clear'}
        </button>
      </ControlRow>
    </SetCard>
  )
}

/* Say only what AccountLifecycleService actually does: `deletedAt` is set (so
   the account is disabled and drops out of every query that filters it) and all
   refresh tokens are revoked. The nightly purge then overwrites the NAME,
   USERNAME and EMAIL — it does not delete posts, so "everything you posted
   disappears" would be a promise the server never keeps. */
const DELETE_MESSAGE =
  'Your account is disabled immediately, your profile stops appearing across the platform, and you are signed out ' +
  'on every device. You will not be able to sign in again, so this cannot be undone from the app — during the ' +
  '30-day grace window only support can restore the account. After that your name, username and email are ' +
  'permanently anonymised, and anything you published stays behind attributed to a deleted account.'

export function DangerZonePanel() {
  const { user } = useAuth()
  const [busy, setBusy] = React.useState(false)
  const [done, setDone] = React.useState(null)             // DeletionStatusResponse once requested
  const timer = React.useRef(null)

  React.useEffect(() => () => clearTimeout(timer.current), [])

  const handle = user?.handle || ''

  const requestDelete = async () => {
    if (busy || done) return

    /* Typing the handle is the only speed bump the user gets: the endpoint takes
       no body and no confirmation of any kind. */
    const typed = await uiPrompt({
      title: 'Delete your account?',
      message: DELETE_MESSAGE,
      label: handle ? `Type ${handle} to confirm` : 'Type DELETE to confirm',
      placeholder: handle || 'DELETE',
      confirmLabel: 'Delete account',
      danger: true,
      icon: 'trash',
    })
    if (typed == null) return
    const want = (handle || 'DELETE').toLowerCase()
    if (String(typed).trim().replace(/^@/, '').toLowerCase() !== want) {
      showToast('That didn’t match — nothing was deleted', 'err')
      return
    }

    /* DataPrivacyController leaves step-up as a SEAM ("a stolen open session must
       not be able to schedule account deletion"), so the client is the only place
       it can happen. A password always arms the window whether or not 2FA is on,
       so an unreadable 2FA status falls back to the password-only prompt. */
    const twoFactor = await api.security.twofa.status().then(s => !!s?.enabled).catch(() => false)
    if (!(await requireStepUp({ twoFactor }))) return

    setBusy(true)
    try {
      const res = await api.settings.data.requestDeletion()
      // The account is soft-deleted NOW and every session is revoked — the token
      // in storage is already dead, so drop it and show the purge date before
      // sending the user to the sign-in page.
      session.clear()
      setDone(res || {})
      // Also toast it: any background request that 401s can bounce this page to
      // /login before the card is read, and the toast survives that navigation.
      showToast(res?.purgeAfter
        ? `Account deleted — your details are anonymised on ${fmtWhen(res.purgeAfter)}`
        : 'Account deleted — signing you out')
      timer.current = setTimeout(() => window.location.assign('/login'), 12000)
    } catch (e) {
      if (e?.code === 'DELETION_PENDING') {
        // The only state where a deletion is pending AND a live session exists:
        // a previous request left the row behind without revoking this session.
        const cancel = await uiConfirm({
          title: 'Deletion already pending',
          message: 'This account is already scheduled for deletion. Do you want to cancel that and keep your account instead?',
          confirmLabel: 'Cancel deletion',
          icon: 'refresh',
        })
        if (cancel) {
          try { await api.settings.data.cancelDeletion(); showToast('Deletion cancelled — your account stays') }
          catch { showToast('Could not cancel the deletion', 'err') }
        }
      } else if (e?.status !== 429) {
        showToast('Could not request the deletion', 'err')
      }
    } finally { setBusy(false) }
  }

  if (done) {
    return (
      <SetCard id="danger" danger icon="trash" title="Account deleted"
        sub="You are signed out on every device. Signing in with this account is no longer possible.">
        <div className="stx-note info">
          <Icon name="clock"/>
          <span>
            {done.purgeAfter
              ? `Your name, username and email are permanently anonymised on ${fmtWhen(done.purgeAfter)}.`
              : 'Your name, username and email are permanently anonymised 30 days from now.'}
            {' '}Until then the account can only be restored by contacting support.
          </span>
        </div>
        <div className="set-actions" style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-secondary" onClick={() => window.location.assign('/login')}>
            Go to sign-in
          </button>
        </div>
      </SetCard>
    )
  }

  return (
    <SetCard id="danger" danger icon="trash" title="Delete account"
      sub="Your account is disabled immediately, your profile stops appearing anywhere, and every session is signed out.">
      <div className="stx-note warn">
        <Icon name="alert"/>
        <span>
          You cannot sign back in afterwards, so this cannot be undone from the app. For 30 days the account can
          still be restored by contacting support; after that your name, username and email are permanently
          anonymised. You will be asked for your password before the request goes through.
        </span>
      </div>
      <div className="set-actions" style={{ marginTop: 12 }}>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={requestDelete}>
          <Icon name="trash" className="xs"/>{busy ? 'Deleting…' : 'Delete my account'}
        </button>
      </div>
    </SetCard>
  )
}
