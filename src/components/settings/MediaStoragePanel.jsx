/* =========================================================
   Settings v2 — media pipeline preferences + server storage.
   MediaPanel edits the `media` cosmetic block (uploadQuality
   is the only enum-typed field — invalid values 400); the
   tier is a request, the server enforces the real ceiling.
   StoragePanel renders /storage/usage as a stacked bar —
   the figure is cached ~1h server-side, deletions lag.
   ========================================================= */
import React from 'react'
import { Icon, showToast } from '../ui.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { EmptyState, Loader, ErrorState } from '../states.jsx'
import { api, MEDIA_TIERS } from '../../api/index.js'
import { SetCard, ControlRow, Seg, useSection, fmtBytes } from './shared.jsx'

/* ---------- media ---------- */

const CELLULAR_OPTS = [['DATA_SAVER_ONLY', 'Data saver'], ['SAME_AS_WIFI', 'Same as Wi-Fi']]
const AUTO_DL_OPTS = [['NEVER', 'Never'], ['WIFI', 'Wi-Fi'], ['WIFI_AND_CELLULAR', 'Always']]
const PLAYBACK_OPTS = [['AUTO', 'Auto'], ['P360', '360p'], ['P480', '480p'], ['P720', '720p'], ['P1080', '1080p']]

/* The exact entity defaults. Every edit in the panel is a partial PATCH; this
   complete block is the only thing PUT is ever handed, because PUT nulls
   whatever it does not receive. */
const MEDIA_DEFAULTS = {
  uploadQuality: 'HIGH', uploadOverCellular: 'SAME_AS_WIFI',
  autoDownloadPhotos: 'WIFI', autoDownloadVideos: 'WIFI', playbackQuality: 'AUTO',
}

/** Whole-block reset. The panel remounts its card on success, so useSection
 *  re-reads the section and every control shows the reset value. */
function ResetToDefaults({ onDone }) {
  const [busy, setBusy] = React.useState(false)
  const alive = React.useRef(true)
  React.useEffect(() => () => { alive.current = false }, [])

  const run = async () => {
    const ok = await uiConfirm({
      title: 'Reset media settings?',
      message: 'Every option in this section goes back to its default. Other settings are untouched.',
      confirmLabel: 'Reset',
      icon: 'refresh',
    })
    if (!ok) return
    setBusy(true)
    try {
      await api.settings.replaceSection('media', MEDIA_DEFAULTS)
      showToast('Settings reset')
      onDone()
    } catch (e) {
      if (e?.status !== 429) showToast('Could not reset')       // 429 toasts globally
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  return (
    <div className="set-actions">
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={run}>
        <Icon name="refresh" className="xs"/>{busy ? 'Resetting…' : 'Reset to defaults'}
      </button>
    </div>
  )
}

export function MediaPanel() {
  const [gen, setGen] = React.useState(0)
  return <MediaCard key={gen} onReset={() => setGen(g => g + 1)}/>
}

function MediaCard({ onReset }) {
  const { block, setField, loading, error, retry } = useSection('media')
  if (loading) {
    return (
      <SetCard icon="image" title="Media & uploads">
        <p className="muted text-sm">Loading…</p>
      </SetCard>
    )
  }
  /* Defaults must not impersonate saved values — the upload tier in particular
     decides what the server keeps, so a wrong reading here is expensive. */
  if (error) {
    return (
      <SetCard icon="image" title="Media & uploads">
        <ErrorState message="Could not load your media settings" onRetry={retry}/>
      </SetCard>
    )
  }
  const quality = block.uploadQuality ?? 'HIGH'
  const tierDesc = (MEDIA_TIERS.find(([v]) => v === quality) || [])[2]
  return (
    <SetCard icon="image" title="Media & uploads"
      sub="Your preferred tier is a request — the server enforces the ceiling and re-encodes everything (video is hard-capped at 1080p).">
      <ControlRow title="Upload quality" desc={tierDesc}>
        <Seg ariaLabel="Upload quality"
          options={MEDIA_TIERS.map(([v, label]) => [v, label])}
          value={quality}
          onChange={v => setField('uploadQuality', v)}/>
      </ControlRow>
      <ControlRow title="Uploads over cellular" desc="Data saver shrinks uploads when you are not on Wi-Fi.">
        <Seg ariaLabel="Uploads over cellular" options={CELLULAR_OPTS}
          value={block.uploadOverCellular ?? 'SAME_AS_WIFI'}
          onChange={v => setField('uploadOverCellular', v)}/>
      </ControlRow>
      <ControlRow title="Auto-download photos" desc="When photos in chats and feeds are fetched automatically.">
        <Seg ariaLabel="Auto-download photos" options={AUTO_DL_OPTS}
          value={block.autoDownloadPhotos ?? 'WIFI'}
          onChange={v => setField('autoDownloadPhotos', v)}/>
      </ControlRow>
      <ControlRow title="Auto-download videos" desc="Videos are heavier — Always can use a lot of cellular data.">
        <Seg ariaLabel="Auto-download videos" options={AUTO_DL_OPTS}
          value={block.autoDownloadVideos ?? 'WIFI'}
          onChange={v => setField('autoDownloadVideos', v)}/>
      </ControlRow>
      <ControlRow title="Playback quality" desc="Auto adapts to your connection; a fixed step pins the stream.">
        <Seg ariaLabel="Playback quality" options={PLAYBACK_OPTS}
          value={block.playbackQuality ?? 'AUTO'}
          onChange={v => setField('playbackQuality', v)}/>
      </ControlRow>
      <ResetToDefaults onDone={onReset}/>
    </SetCard>
  )
}

/* ---------- storage ---------- */

/* Stable order + color: canonical types keep their stx-c index whatever
   subset the server returns; unexpected types trail on the last color. */
const KNOWN_TYPES = ['IMAGE', 'VIDEO', 'AUDIO', 'FILM', 'VIDEO_CLIP']
const TYPE_LABELS = { IMAGE: 'Images', VIDEO: 'Videos', AUDIO: 'Audio', FILM: 'Films', VIDEO_CLIP: 'Clips' }
const typeLabel = (t) => TYPE_LABELS[t] || (t.charAt(0) + t.slice(1).toLowerCase()).replace(/_/g, ' ')

export function StoragePanel() {
  const [usage, setUsage] = React.useState(null)
  const [error, setError] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [nonce, setNonce] = React.useState(0)
  /* Whether figures are actually on screen — the only thing that decides
     toast-vs-ErrorState. The nonce cannot: retrying out of the first error
     bumps it too, which used to strand the panel on a retry-less loader. */
  const hasData = React.useRef(false)

  React.useEffect(() => {
    let alive = true
    setError(false)
    api.settings.storage.usage()
      .then(u => {
        if (!alive) return
        hasData.current = true
        setUsage(u || { totalBytes: 0, byType: {} })
        setBusy(false)
      })
      .catch(() => {
        if (!alive) return
        setBusy(false)
        if (hasData.current) showToast('Could not refresh')   // refresh failed — keep the last figures
        else setError(true)
      })
    return () => { alive = false }
  }, [nonce])

  const refresh = () => { setBusy(true); setNonce(n => n + 1) }

  if (error && usage === null) {
    return (
      <SetCard icon="archive" title="Storage">
        <ErrorState message="Could not load your storage usage" onRetry={refresh}/>
      </SetCard>
    )
  }
  if (usage === null) {
    return (
      <SetCard icon="archive" title="Storage">
        <Loader label="Measuring your storage…"/>
      </SetCard>
    )
  }

  const total = +usage.totalBytes || 0
  const byType = usage.byType || {}
  const rest = Object.keys(byType).filter(t => !KNOWN_TYPES.includes(t)).sort()
  const segs = [...KNOWN_TYPES, ...rest]
    .map((t, i) => ({ type: t, bytes: +byType[t] || 0, cls: 'stx-c' + Math.min(i, 5) }))
    .filter(s => s.bytes > 0)

  return (
    <SetCard icon="archive" title="Storage"
      sub="What your uploads occupy on the server. The figure is cached for about an hour, so recent deletions can take a while to show.">
      {total === 0 ? (
        <EmptyState icon="archive" title="Nothing stored yet"/>
      ) : (
        <>
          <div className="flex" style={{ alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ fontSize: 30, fontWeight: 700, color: 'var(--navy)', lineHeight: 1.1 }}>{fmtBytes(total)}</div>
            <span className="muted text-sm">total</span>
          </div>
          <div className="stx-bar" role="img" aria-label={`Storage used: ${fmtBytes(total)}`}>
            {segs.map(s => (
              <i key={s.type} className={s.cls} style={{ width: `${(s.bytes / total * 100).toFixed(2)}%` }}
                title={`${typeLabel(s.type)} · ${fmtBytes(s.bytes)}`}/>
            ))}
          </div>
          <div className="stx-legend">
            {segs.map(s => (
              <span key={s.type}><i className={s.cls}/>{typeLabel(s.type)} · {fmtBytes(s.bytes)}</span>
            ))}
          </div>
        </>
      )}
      <div className="set-actions" style={{ marginTop: 12 }}>
        <button className="btn btn-ghost btn-sm" onClick={refresh} disabled={busy}>
          <Icon name="refresh" className="xs"/>{busy ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </SetCard>
  )
}
