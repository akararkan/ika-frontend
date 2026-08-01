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
   ========================================================= */
import React from 'react'
import { Icon, showToast } from '../ui.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { api } from '../../api/index.js'
import { SetCard, fmtBytes } from './shared.jsx'

/* The wire accepts IMAGE | VIDEO | AUDIO | FILM | VIDEO_CLIP and silently
   falls back to IMAGE for anything it doesn't know — mirror that here. */
function assetTypeOf(file) {
  const mime = (file?.type || '').toLowerCase()
  if (mime.startsWith('video/')) return 'VIDEO'
  if (mime.startsWith('audio/')) return 'AUDIO'
  return 'IMAGE'
}

const TYPE_ICONS = { IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio' }

function uploadErrorMessage(err) {
  if (err?.code === 'MEDIA_TOO_LARGE') return 'That file is over the size limit for its type'
  if (err?.code === 'STORAGE_UNAVAILABLE') return 'Uploads are unavailable right now'
  return err?.message || 'Upload failed'
}

/** The one-line summary under a finished upload. */
function metaLine(res) {
  const parts = []
  parts.push(res?.storedBytes === 0 ? 'deduplicated — no new bytes stored' : fmtBytes(res?.storedBytes))
  if (res?.width && res?.height) parts.push(`${res.width} × ${res.height}`)
  if (res?.durationMs != null) parts.push(`${(res.durationMs / 1000).toFixed(1)}s`)
  return parts.join(' · ')
}

export function MediaLabPanel() {
  const [tier, setTier] = React.useState(null)         // null = still reading the setting
  const [job, setJob] = React.useState(null)           // {name, pct, phase:'uploading'|'processing'}
  const [items, setItems] = React.useState([])         // this session's finished uploads
  const fileRef = React.useRef(null)
  const abortRef = React.useRef(null)
  const mountedRef = React.useRef(true)
  const seqRef = React.useRef(0)

  /* Read the tier once — it is edited in Media & uploads, not here. */
  React.useEffect(() => {
    let alive = true
    api.settings.section('media')
      .then(b => { if (alive) setTier(b?.uploadQuality || 'HIGH') })
      .catch(() => { if (alive) setTier('HIGH') })
    return () => { alive = false }
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

    const ctrl = new AbortController()
    abortRef.current = ctrl
    setJob({ name: file.name, pct: 0, phase: 'uploading' })

    try {
      const res = await api.media.upload(file, {
        type: assetTypeOf(file),
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
      setItems(list => [{ key: seqRef.current, id: res?.mediaId, name: file.name, res }, ...list])
      showToast(res?.storedBytes === 0
        ? 'Already on the server — nothing new was stored'
        : 'Upload complete')
    } catch (err) {
      if (!mountedRef.current || err?.name === 'AbortError' || err?.status === 429) return
      showToast(uploadErrorMessage(err))
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

  const remove = async (item) => {
    const ok = await uiConfirm({
      title: 'Delete this upload?',
      message: 'The stored file and every rendition are removed from the server straight away. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
      icon: 'trash',
    })
    if (!ok) return
    const drop = () => setItems(list => list.filter(x => x.key !== item.key))
    try {
      await api.media.remove(item.id)
      drop()
      showToast('Upload deleted')
    } catch (e) {
      if (e?.status === 404) { drop(); showToast('That upload was already gone') }   // hard delete — nothing to keep
      else if (e?.status !== 429) showToast('Could not delete that upload')
    }
  }

  return (
    <SetCard icon="upload" title="Upload check"
      sub="Upload a file to see exactly what the server keeps at your current quality — the original is re-encoded, resized and stripped of location metadata before anything is stored.">

      <div className="flex gap-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="stx-chip info"><Icon name="sparkle"/>Uploading at {tier || 'HIGH'}</span>
        <span className="muted text-xs">Change this in Media &amp; uploads above.</span>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*,audio/*"
        style={{ display: 'none' }}
        onChange={onFile}/>

      <div className="set-actions" style={{ marginTop: 12 }}>
        <button type="button" className="btn btn-primary" disabled={!!job} onClick={pick}>
          <Icon name="upload" className="xs"/>Choose a file
        </button>
      </div>

      {job && (
        <div style={{ marginTop: 12 }}>
          <div className="flex gap-8" style={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
            <b className="text-sm" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.name}</b>
            <span className="muted text-xs" style={{ flex: 'none' }}>
              {job.phase === 'processing' ? 'Processing…' : `${job.pct}%`}
            </span>
          </div>
          <div className="stx-prog"><i style={{ width: job.pct + '%' }}/></div>
          <div className="set-actions" style={{ marginTop: 8 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={cancel}>Cancel</button>
          </div>
        </div>
      )}

      {items.length > 0 && (
        <div className="rail-list" style={{ marginTop: 14 }}>
          {items.map(item => {
            const res = item.res || {}
            const failed = typeof res.status === 'string' && res.status.startsWith('FAILED')
            const rends = Array.isArray(res.renditions) ? res.renditions : []
            return (
              <div key={item.key} className="rail-row">
                <span className="stx-sess-ic"><Icon name={TYPE_ICONS[res.type] || 'doc'}/></span>
                <div className="rail-info" style={{ minWidth: 0 }}>
                  <div className="rail-name">
                    <b style={{ overflowWrap: 'anywhere' }}>{item.name}</b>
                  </div>
                  <div className="flex gap-8" style={{ alignItems: 'center', flexWrap: 'wrap', margin: '4px 0' }}>
                    <span className={'stx-chip ' + (failed ? 'err' : res.status === 'READY' ? 'ok' : 'plain')}>
                      <Icon name={failed ? 'alert' : res.status === 'READY' ? 'check' : 'clock'}/>
                      {res.status || 'Unknown'}
                    </span>
                    {rends.map((r, i) => (
                      <span key={(r.label || 'rendition') + i} className="stx-chip plain">
                        {r.label || 'rendition'}{r.bytes != null ? ` · ${fmtBytes(r.bytes)}` : ''}
                      </span>
                    ))}
                  </div>
                  <div className="rail-sub">{metaLine(res)}</div>
                  {failed && res.errorMessage && <div className="rail-sub">{res.errorMessage}</div>}
                </div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => remove(item)}>Delete</button>
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
