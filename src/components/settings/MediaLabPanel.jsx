/* =========================================================
   Settings v2 — the media pipeline, made visible (§20).
   The only place /api/v1/media is reachable: pick a file and
   watch the real flow — upload-intent → presigned PUT →
   complete → poll — then read back exactly what the server
   kept (status, stored bytes, dimensions, renditions).
   Wire truths: no list endpoint (this session's uploads are
   local only), a dedup hit resolves instantly with
   storedBytes 0, DELETE is a hard delete (second call 404),
   and the tier comes from the user's own media setting.
   MediaStatus.isTerminalFailure() covers all three FAILED_*
   states, but only FAILED_PROCESSING is documented as
   retryable, so the File stays in memory until the row is
   dismissed. One more: this pipeline PUTs the file untouched —
   the on-device downscale in lib/mediaTier.js hangs off
   http.upload, which the presigned path never goes through.
   ========================================================= */
import React from 'react'
import { Icon, showToast } from '../ui.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { api } from '../../api/index.js'
import { MEDIA_LIMITS } from '../../api/media.js'
import { getTier, TIER_EDGE } from '../../lib/mediaTier.js'
import { PREFS_EVENT } from '../../lib/prefs.js'
import { SetCard, Seg, fmtBytes } from './shared.jsx'
import { STORAGE_CHANGED } from './MediaStoragePanel.jsx'

/* MediaAssetType, all five members. The server parses leniently (unknown →
   IMAGE) and charges the SAME byte cap to VIDEO/FILM/VIDEO_CLIP — the enum's
   "90 s / 200 MB" javadoc for clips is documentation, not an enforced limit —
   so the choice only decides which bucket Storage counts it under. */
const ASSET_TYPES = [
  ['IMAGE', 'Image'], ['VIDEO', 'Video'], ['AUDIO', 'Audio'], ['FILM', 'Film'], ['VIDEO_CLIP', 'Clip'],
]
const TYPE_LABEL = Object.fromEntries(ASSET_TYPES)
const TYPE_ICONS = { IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio', FILM: 'video', VIDEO_CLIP: 'reels' }

/* Renditions that are actually a picture, most-decodable first — 'captions'/
   'hls' are sidecar files and 'original' may be a 40 MB raw, so neither may
   ever reach an <img>. Today ImageProcessor emits only "jpeg"; the rest are
   here so a server that starts emitting avif does not silently paint nothing. */
const THUMB_LABELS = ['jpeg', 'webp', 'poster', 'avif']

function familyOf(file) {
  const mime = (file?.type || '').toLowerCase()
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'image'
}

/** Read a video's duration locally so the type Seg opens on a sensible guess.
 *  Resolves null on anything the browser will not decode — and on a stall,
 *  because a file picker must never hang on metadata that never arrives. */
function probeDuration(file) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') { resolve(null); return }
    const url = URL.createObjectURL(file)
    const el = document.createElement('video')
    let done = false
    const finish = (secs) => {
      if (done) return
      done = true
      clearTimeout(timer)
      /* removeAttribute alone leaves the fetch running against a URL we are
         about to revoke; load() is what actually abandons it. */
      el.removeAttribute('src')
      el.load?.()
      URL.revokeObjectURL(url)
      resolve(secs)
    }
    const timer = setTimeout(() => finish(null), 4000)
    el.preload = 'metadata'
    el.onloadedmetadata = () => finish(Number.isFinite(el.duration) ? el.duration : null)
    el.onerror = () => finish(null)
    el.src = url
  })
}

/* The thresholds are the enum's own description of each member (clip ≤ 90 s,
   film = long form); nothing server-side checks them. */
function videoTypeFor(secs) {
  if (secs == null) return 'VIDEO'
  if (secs <= 90) return 'VIDEO_CLIP'
  if (secs > 300) return 'FILM'
  return 'VIDEO'
}

/* GlobalExceptionHandler puts these in `errorCode`, which http.js maps to
   ApiError.code — so they really do arrive as err.code. */
const CODE_TEXT = {
  MEDIA_TOO_LARGE: 'That file is over the size limit for its type',
  STORAGE_UNAVAILABLE: 'Storage is not accepting uploads right now',
  MEDIA_RAW_MISSING: 'The bytes never reached storage — send it again',
  NOT_MEDIA_OWNER: 'That upload belongs to another account',
}
/* A poll that ends in a failed state rejects with .status (the MediaStatus
   name), never .code — two different shapes for the same conversation.
   The give-up path is the trap: api/media.js sets `.status` to the LAST status
   it saw, so a three-minute encode surfaces as PROCESSING, not TIMEOUT. Those
   in-flight names therefore need a sentence too, or the row falls back to the
   raw "Timed out waiting for media processing". */
const STILL_WORKING = 'Still processing after a few minutes — the server may well finish on its own, but there is no endpoint that lists uploads, so this page cannot look again.'
const STATUS_TEXT = {
  FAILED_VALIDATION: 'The server could not read that file — the format or size was rejected',
  FAILED_MODERATION: 'That file was blocked by moderation',
  FAILED_PROCESSING: 'The server could not finish processing it',
  TIMEOUT: STILL_WORKING, PENDING: STILL_WORKING, UPLOADING: STILL_WORKING, PROCESSING: STILL_WORKING,
}
/* Short forms for the chip; the sentence goes underneath. Only READY can reach
   a successful row (upload() resolves on nothing else), so every other entry
   here is describing a give-up. */
const STATUS_CHIP = {
  READY: 'Ready', PENDING: 'Still working', UPLOADING: 'Still working', PROCESSING: 'Still working',
  FAILED_VALIDATION: 'Rejected', FAILED_MODERATION: 'Blocked', FAILED_PROCESSING: 'Failed',
  TIMEOUT: 'Timed out',
}

/* Nothing failed here — we stopped watching. Amber, not red, and never a
   "Try again": the asset may still be processing, and a second upload of the
   same bytes cannot dedup against it (dedup only matches READY), so retrying
   would quietly store the file twice. */
const INFLIGHT_STATUSES = new Set(['PENDING', 'UPLOADING', 'PROCESSING', 'TIMEOUT'])

const RETRY_CODES = new Set(['STORAGE_UNAVAILABLE', 'MEDIA_RAW_MISSING'])
const RETRY_STATUSES = new Set(['FAILED_PROCESSING'])

function uploadErrorMessage(err) {
  return CODE_TEXT[err?.code] || STATUS_TEXT[err?.status] || err?.message || 'Upload failed'
}

/** Offer "Try again" only where trying again can differ. */
function isRetryable(err) {
  if (typeof err?.status === 'string') return RETRY_STATUSES.has(err.status)
  if (err?.code) return RETRY_CODES.has(err.code)
  if (typeof err?.status === 'number') return err.status >= 500
  return true          // a bare network/storage-PUT failure carries neither
}

/** The one-line summary under a finished upload. */
function metaLine(res) {
  const parts = []
  parts.push(res?.storedBytes === 0 ? 'deduplicated — no new bytes stored' : fmtBytes(res?.storedBytes))
  if (res?.width && res?.height) parts.push(`${res.width} × ${res.height}`)
  if (res?.durationMs != null) parts.push(`${(res.durationMs / 1000).toFixed(1)}s`)
  return parts.join(' · ')
}

function thumbOf(res) {
  if (res?.type !== 'IMAGE') return null
  const rends = Array.isArray(res.renditions) ? res.renditions : []
  for (const label of THUMB_LABELS) {          // our preference, not the server's row order
    const hit = rends.find(r => r.url && r.label === label)
    if (hit) return hit
  }
  return null
}

/** label · W×H · bytes, opening the stored object when the server gave a URL. */
function RenditionChip({ r }) {
  const text = [
    r.label || 'rendition',
    r.width && r.height ? `${r.width} × ${r.height}` : null,
    r.bytes != null ? fmtBytes(r.bytes) : null,
  ].filter(Boolean).join(' · ')
  if (!r.url) return <span className="stx-chip plain" title={r.mime || undefined}>{text}</span>
  return (
    <a className="stx-chip plain" href={r.url} target="_blank" rel="noreferrer noopener"
      title={r.mime ? `Open this rendition (${r.mime})` : 'Open this rendition'}>
      {text}<Icon name="external"/>
    </a>
  )
}

export function MediaLabPanel() {
  const [tier, setTier] = React.useState(null)         // null = still reading the setting
  const [staged, setStaged] = React.useState(null)     // {file, type} — picked, not sent yet
  const [job, setJob] = React.useState(null)           // {name, pct, phase:'uploading'|'processing'}
  const [items, setItems] = React.useState([])         // this session's attempts (finished or failed)
  const fileRef = React.useRef(null)
  const abortRef = React.useRef(null)
  const mountedRef = React.useRef(true)
  const seqRef = React.useRef(0)

  /* Read the tier through mediaTier so this chip and the pre-compression that
     actually happens can never disagree. PREFS_EVENT is how a write in Media &
     uploads announces itself; mediaTier's own listener is registered at import
     time (i.e. before this one), so its cache is already cleared by the time
     we re-read. */
  React.useEffect(() => {
    let alive = true
    const read = () => getTier()
      .then(t => { if (alive) setTier(t) })
      .catch(() => { if (alive) setTier('HIGH') })
    read()
    window.addEventListener(PREFS_EVENT, read)
    return () => { alive = false; window.removeEventListener(PREFS_EVENT, read) }
  }, [])

  /* Nothing may outlive the panel: drop late state, abort the transfer. */
  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [])

  const pick = () => { if (!job) fileRef.current?.click() }

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''                                 // allow re-picking the same file
    if (!file || job) return
    const family = familyOf(file)
    /* Stage rather than send: the type decides the byte cap and the Storage
       bucket, and only the user knows whether a 3-minute file is a clip. */
    setStaged({ file, type: family === 'audio' ? 'AUDIO' : family === 'image' ? 'IMAGE' : 'VIDEO' })
    if (family !== 'video') return
    const secs = await probeDuration(file)
    if (!mountedRef.current) return
    setStaged(s => (s && s.file === file ? { ...s, type: videoTypeFor(secs) } : s))
  }

  /* Storage's total is a 1 h Redis cache, so the sibling card cannot discover
     this by re-fetching — hand it the delta. */
  const notifyStorage = (type, bytes) => {
    window.dispatchEvent(new CustomEvent(STORAGE_CHANGED, { detail: { type, bytes } }))
  }

  const start = async (file, type) => {
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setStaged(null)
    setJob({ name: file.name, pct: 0, phase: 'uploading' })

    try {
      const res = await api.media.upload(file, {
        type,
        tier: tier || 'HIGH',
        signal: ctrl.signal,
        onProgress: (f) => {
          if (!mountedRef.current || abortRef.current !== ctrl) return
          const pct = Math.max(0, Math.min(100, Math.round(f * 100)))
          setJob(j => (j ? { ...j, pct, phase: pct >= 100 ? 'processing' : 'uploading' } : j))
        },
      })
      if (!mountedRef.current || ctrl.signal.aborted) return
      seqRef.current += 1
      setItems(list => [{ key: seqRef.current, id: res?.mediaId, name: file.name, file, type, res }, ...list])
      notifyStorage(res?.type || type, +res?.storedBytes || 0)
      showToast(res?.storedBytes === 0
        ? 'Already on the server — nothing new was stored'
        : 'Upload complete')
    } catch (err) {
      if (!mountedRef.current || err?.name === 'AbortError' || err?.status === 429) return
      seqRef.current += 1
      const text = uploadErrorMessage(err)
      const tone = INFLIGHT_STATUSES.has(err?.status) ? 'warn' : 'err'
      /* Keep the File: a FAILED_PROCESSING or a storage hiccup is worth one
         more attempt, and re-picking the same file is a poor substitute. */
      setItems(list => [{
        key: seqRef.current, name: file.name, file, type,
        error: { text, tone, chip: STATUS_CHIP[err?.status] || 'Failed', retryable: isRetryable(err) },
      }, ...list])
      showToast(text, tone)
    } finally {
      /* Only the run that still owns the slot may clear it — a cancel or a
         newer pick has already moved on. */
      const owned = abortRef.current === ctrl
      if (owned) {
        abortRef.current = null
        if (mountedRef.current) setJob(null)
      }
    }
  }

  const cancel = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setJob(null)
  }

  const drop = (item) => setItems(list => list.filter(x => x.key !== item.key))

  const remove = async (item) => {
    /* A dedup hit (storedBytes 0) is a REFERENCE: MediaAssetService copies the
       original's renditions with the same objectKey, and delete() removes the
       objects those keys point at — so deleting the reference takes the shared
       bytes with it. Say so rather than let it look free. */
    const shared = item.res?.storedBytes === 0
    const ok = await uiConfirm({
      title: 'Delete this upload?',
      message: shared
        ? 'This one was deduplicated — it points at bytes an earlier upload already stored, and deleting it removes those shared files too. This cannot be undone.'
        : 'The stored file and every rendition are removed from the server straight away. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
      icon: 'trash',
    })
    if (!ok) return
    try {
      await api.media.remove(item.id)
      drop(item)
      notifyStorage(item.res?.type || item.type, -(+item.res?.storedBytes || 0))
      showToast('Upload deleted')
    } catch (e) {
      if (e?.status === 404) { drop(item); showToast('That upload was already gone') }   // hard delete — nothing to keep
      else if (e?.status !== 429) showToast('Could not delete that upload', 'err')
    }
  }

  const retry = (item) => {
    if (job || !item.file) return
    drop(item)
    start(item.file, item.type)
  }

  const stagedCap = staged ? MEDIA_LIMITS[staged.type] : 0
  const overCap = !!(staged && stagedCap && staged.file.size > stagedCap)

  /* The sub must not promise a video transcode: VideoProcessor falls back to
     passthrough whenever media.processing is off or ffmpeg is missing, and the
     rendition list underneath is exactly where that shows up ("original" rather
     than "1080p"). Photos are always redrawn, so EXIF/GPS really do go. */
  return (
    <SetCard id="media-lab" icon="upload" title="Upload check"
      sub="Send a file and read back exactly what the server kept. Photos are always redrawn — location and camera metadata cannot survive that. Video is re-encoded only where the server has a transcoder; a rendition labelled “original” means yours was stored as sent.">

      <div className="flex gap-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="stx-chip info"><Icon name="sparkle"/>Uploading at {tier || 'HIGH'}</span>
        {/* Do NOT claim the on-device resize here: that lives in http.upload,
            and this pipeline PUTs the file straight to storage. The tier still
            travels (X-Media-Tier), so the server caps its renditions. */}
        <span className="muted text-xs">
          Sent exactly as picked, so you can see the server&rsquo;s own re-encode — elsewhere in the app a
          photo is downscaled to {TIER_EDGE[tier] || TIER_EDGE.HIGH} px first. Change the tier in Media &amp; uploads above.
        </span>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*,audio/*"
        style={{ display: 'none' }}
        onChange={onFile}/>

      {!staged && (
        <div className="set-actions" style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-primary" disabled={!!job} onClick={pick}>
            <Icon name="upload" className="xs"/>Choose a file
          </button>
        </div>
      )}

      {staged && (
        <div style={{ marginTop: 12 }}>
          <div className="flex gap-8" style={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
            <b className="text-sm" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{staged.file.name}</b>
            <span className="muted text-xs" style={{ flex: 'none' }}>{fmtBytes(staged.file.size)}</span>
          </div>
          <div className="flex gap-8" style={{ alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
            <span className="muted text-xs">Send it as</span>
            <Seg ariaLabel="Asset type" options={ASSET_TYPES}
              value={staged.type}
              onChange={v => setStaged(s => (s ? { ...s, type: v } : s))}/>
          </div>
          {overCap && (
            <p className="stx-note err">
              <Icon name="alert"/>
              <span>
                That file is {fmtBytes(staged.file.size)} — the limit for {TYPE_LABEL[staged.type].toLowerCase()} uploads
                is {fmtBytes(stagedCap)}. Pick a smaller file, or send it as a type with a larger cap.
              </span>
            </p>
          )}
          <div className="set-actions" style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-primary" disabled={overCap || !!job}
              onClick={() => start(staged.file, staged.type)}>
              <Icon name="upload" className="xs"/>Upload
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStaged(null)}>Choose another</button>
          </div>
        </div>
      )}

      {job && (
        <div style={{ marginTop: 12 }}>
          <div className="flex gap-8" style={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
            <b className="text-sm" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.name}</b>
            <span className="muted text-xs" style={{ flex: 'none' }}>
              {job.phase === 'processing' ? 'Processing…' : `${job.pct}%`}
            </span>
          </div>
          <div className="stx-prog" role="progressbar" aria-label={`Uploading ${job.name}`}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.pct}
            aria-valuetext={job.phase === 'processing' ? 'Processing on the server' : `${job.pct}%`}>
            <i style={{ width: job.pct + '%' }}/>
          </div>
          <div className="set-actions" style={{ marginTop: 8 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={cancel}>Cancel</button>
          </div>
        </div>
      )}

      {items.length > 0 && (
        <div className="rail-list" style={{ marginTop: 14 }}>
          {items.map(item => {
            const res = item.res || null
            const err = item.error || null
            const rends = Array.isArray(res?.renditions) ? res.renditions : []
            const thumb = thumbOf(res)
            const chip = err ? err.chip : (STATUS_CHIP[res?.status] || res?.status || 'Unknown')
            const ok = !err && res?.status === 'READY'
            return (
              <div key={item.key} className="rail-row">
                <span className="stx-sess-ic">
                  {thumb
                    ? <img src={thumb.url} alt="" width={40} height={40}
                      style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 11 }}/>
                    : <Icon name={TYPE_ICONS[res?.type || item.type] || 'doc'}/>}
                </span>
                <div className="rail-info" style={{ minWidth: 0 }}>
                  <div className="rail-name">
                    <b style={{ overflowWrap: 'anywhere' }}>{item.name}</b>
                  </div>
                  <div className="flex gap-8" style={{ alignItems: 'center', flexWrap: 'wrap', margin: '4px 0' }}>
                    <span className={'stx-chip ' + (err ? err.tone : ok ? 'ok' : 'plain')}>
                      <Icon name={err ? (err.tone === 'warn' ? 'clock' : 'alert') : ok ? 'check' : 'clock'}/>{chip}
                    </span>
                    {rends.map((r, i) => <RenditionChip key={(r.label || 'rendition') + i} r={r}/>)}
                  </div>
                  {res && <div className="rail-sub">{metaLine(res)}</div>}
                  {err && <div className="rail-sub">{err.text}</div>}
                  {/* The server's own words, kept under the translation rather
                      than instead of it — they name the failing codec. */}
                  {res?.errorMessage && <div className="rail-sub">{res.errorMessage}</div>}
                </div>
                {/* Every row repeats the same two words, so the file name has to
                    ride in the accessible name — otherwise a screen reader hears
                    "Delete, Delete, Delete". */}
                <div className="flex gap-8" style={{ flex: 'none' }}>
                  {err?.retryable && item.file && (
                    <button type="button" className="btn btn-secondary btn-sm" disabled={!!job}
                      aria-label={`Try uploading ${item.name} again`}
                      onClick={() => retry(item)}>Try again</button>
                  )}
                  {item.id
                    ? <button type="button" className="btn btn-danger btn-sm"
                      aria-label={`Delete ${item.name} from the server`}
                      onClick={() => remove(item)}>Delete</button>
                    : <button type="button" className="btn btn-ghost btn-sm"
                      aria-label={`Dismiss ${item.name}`}
                      onClick={() => drop(item)}>Dismiss</button>}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <p className="muted text-xs" style={{ marginTop: 12 }}>
        There is no endpoint that lists your uploads, so this list only covers files you send from this page and it empties when you leave.
      </p>
    </SetCard>
  )
}
