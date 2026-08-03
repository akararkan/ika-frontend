/* =========================================================
   Settings v2 — media pipeline preferences + server storage.
   MediaPanel edits the `media` cosmetic block (uploadQuality
   is the only enum-typed field — invalid values 400); the
   tier is a request, the server enforces the real ceiling.
   StoragePanel renders /storage/usage as a stacked bar —
   the figure is cached ~1h server-side, deletions lag.

   Honesty note: of the five fields in this block only
   uploadQuality does anything in this build, and it reaches the
   wire two different ways. Multipart uploads (avatars, chat,
   posts, research — all of http.upload) are downscaled ON THIS
   DEVICE by lib/mediaTier.js; the presigned /api/v1/media
   pipeline PUTs the file byte-for-byte and only echoes the tier
   as X-Media-Tier, so there the resize is entirely the server's.
   The other four — uploadOverCellular / autoDownload* /
   playbackQuality — are documented server-side as pure client
   policy that nothing here reads yet (no connection sniffing,
   and players are handed a single URL, not a rendition ladder).
   The copy says so rather than implying a guard that does not
   exist.
   ========================================================= */
import React from 'react'
import { Icon, showToast } from '../ui.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { EmptyState, Loader, ErrorState } from '../states.jsx'
import { api, MEDIA_TIERS } from '../../api/index.js'
import { MEDIA_LIMITS } from '../../api/media.js'
import { TIER_EDGE } from '../../lib/mediaTier.js'
import { SetCard, ControlRow, Seg, SubHead, Skeleton, useSection, fmtBytes } from './shared.jsx'

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
      if (e?.status !== 429) showToast('Could not reset', 'err')   // 429 toasts globally
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
  const { block, setField, statusOf, loading, error, retry } = useSection('media')
  if (loading) {
    return (
      <SetCard id="media" icon="image" title="Media & uploads">
        <Skeleton rows={5}/>
      </SetCard>
    )
  }
  /* Defaults must not impersonate saved values — the upload tier in particular
     decides what the server keeps, so a wrong reading here is expensive. */
  if (error) {
    return (
      <SetCard id="media" icon="image" title="Media & uploads">
        <ErrorState message="Could not load your media settings" onRetry={retry}/>
      </SetCard>
    )
  }
  const quality = block.uploadQuality ?? 'HIGH'
  const tierDesc = (MEDIA_TIERS.find(([v]) => v === quality) || [])[2]
  const edge = TIER_EDGE[quality] || TIER_EDGE.HIGH
  return (
    <SetCard id="media" icon="image" title="Media & uploads"
      sub="Your preferred tier is a request, never a raise — the server keeps its own ceiling, and no video leaves it above 1080p.">
      <ControlRow title="Upload quality" desc={tierDesc} status={statusOf('uploadQuality')}>
        <Seg ariaLabel="Upload quality"
          options={MEDIA_TIERS.map(([v, label]) => [v, label])}
          value={quality}
          onChange={v => setField('uploadQuality', v)}/>
      </ControlRow>
      {/* The only line in this card describing something that actually runs:
          lib/mediaTier.js resizes images inside http.upload, so every upload
          surface in the app inherits this one choice. The byte ceilings are
          MediaProperties.Limits, which only the /api/v1/media pipeline (the
          Upload check card) enforces — do not sell them as app-wide. */}
      <p className="stx-note info">
        <Icon name="info"/>
        <span>
          Photos are resized on this device before they are sent — {edge} px on the longest side at
          this tier — so a smaller tier really does move fewer bytes wherever you post in the app.
          The Upload check below adds a ceiling of its own: {fmtBytes(MEDIA_LIMITS.IMAGE)} for a single
          image or audio file, {fmtBytes(MEDIA_LIMITS.VIDEO)} for a video.
        </span>
      </p>

      <SubHead>Connection</SubHead>
      {/* Fail-honest: these four are stored and synced, but nothing in the web
          app reads them yet. Saying so is cheaper than a user trusting a data
          cap that is not being enforced. Amber, not blue: it is a caveat about
          the controls underneath it, not a description of them. */}
      <p className="stx-note warn">
        <Icon name="info"/>
        <span>
          These are saved with your account for apps that can act on them. This one does not yet:
          browsers here cannot reliably tell Wi-Fi from cellular, and its players are handed one file
          rather than a quality ladder, so changing them will not alter what is uploaded or fetched
          on this device. Upload quality above applies everywhere, on every connection.
        </span>
      </p>
      <ControlRow title="Uploads over cellular" desc="Meant to shrink uploads when you are off Wi-Fi."
        status={statusOf('uploadOverCellular')}>
        <Seg ariaLabel="Uploads over cellular" options={CELLULAR_OPTS}
          value={block.uploadOverCellular ?? 'SAME_AS_WIFI'}
          onChange={v => setField('uploadOverCellular', v)}/>
      </ControlRow>
      <ControlRow title="Auto-download photos" desc="When photos in chats and feeds should fetch themselves."
        status={statusOf('autoDownloadPhotos')}>
        <Seg ariaLabel="Auto-download photos" options={AUTO_DL_OPTS}
          value={block.autoDownloadPhotos ?? 'WIFI'}
          onChange={v => setField('autoDownloadPhotos', v)}/>
      </ControlRow>
      <ControlRow title="Auto-download videos" desc="Videos are the heavy ones — Always would fetch them on any connection."
        status={statusOf('autoDownloadVideos')}>
        <Seg ariaLabel="Auto-download videos" options={AUTO_DL_OPTS}
          value={block.autoDownloadVideos ?? 'WIFI'}
          onChange={v => setField('autoDownloadVideos', v)}/>
      </ControlRow>
      <ControlRow title="Playback quality" desc="Auto would follow the connection; a fixed step would pin the stream."
        status={statusOf('playbackQuality')}>
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

/** Fired by MediaLabPanel after a pipeline upload or delete, with
 *  `detail: {type, bytes}` (bytes negative for a delete). The server figure is
 *  a 1 h Redis cache, so re-fetching after a change returns the SAME number —
 *  the detail is the only way the bar can react inside that hour. */
export const STORAGE_CHANGED = 'ika:storage-changed'

const NO_ADJ = { total: 0, byType: {} }

export function StoragePanel() {
  const [usage, setUsage] = React.useState(null)
  const [error, setError] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [nonce, setNonce] = React.useState(0)
  /* Local corrections layered over the cached server figure; dropped as soon
     as the server number moves, because that means the cache turned over and
     the real total already includes them. */
  const [adj, setAdj] = React.useState(NO_ADJ)
  const lastServerTotal = React.useRef(null)
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
        const next = u || { totalBytes: 0, byType: {} }
        if (lastServerTotal.current !== null && +next.totalBytes !== lastServerTotal.current) setAdj(NO_ADJ)
        lastServerTotal.current = +next.totalBytes || 0
        setUsage(next)
        setBusy(false)
      })
      .catch(() => {
        if (!alive) return
        setBusy(false)
        if (hasData.current) showToast('Could not refresh', 'err')   // refresh failed — keep the last figures
        else setError(true)
      })
    return () => { alive = false }
  }, [nonce])

  /* The sibling Upload-check card changes the same total. Ask the server again
     (in case the hour just elapsed) AND carry the delta locally, so the bar
     never sits there contradicting an upload the user just watched finish. */
  React.useEffect(() => {
    const onChanged = (e) => {
      const { type, bytes } = e?.detail || {}
      const n = +bytes || 0
      if (n) {
        setAdj(a => ({
          total: a.total + n,
          byType: type ? { ...a.byType, [type]: (a.byType[type] || 0) + n } : a.byType,
        }))
      }
      setNonce(v => v + 1)
    }
    window.addEventListener(STORAGE_CHANGED, onChanged)
    return () => window.removeEventListener(STORAGE_CHANGED, onChanged)
  }, [])

  const refresh = () => { setBusy(true); setNonce(n => n + 1) }

  if (error && usage === null) {
    return (
      <SetCard id="storage" icon="archive" title="Storage">
        <ErrorState message="Could not load your storage usage" onRetry={refresh}/>
      </SetCard>
    )
  }
  if (usage === null) {
    return (
      <SetCard id="storage" icon="archive" title="Storage">
        <Loader label="Measuring your storage…"/>
      </SetCard>
    )
  }

  const total = Math.max(0, (+usage.totalBytes || 0) + adj.total)
  const byType = { ...(usage.byType || {}) }
  for (const [t, n] of Object.entries(adj.byType)) byType[t] = Math.max(0, (+byType[t] || 0) + n)
  const rest = Object.keys(byType).filter(t => !KNOWN_TYPES.includes(t)).sort()
  const segs = [...KNOWN_TYPES, ...rest]
    .map((t, i) => ({ type: t, bytes: +byType[t] || 0, cls: 'stx-c' + Math.min(i, 5) }))
    .filter(s => s.bytes > 0)

  return (
    <SetCard id="storage" icon="archive" title="Storage"
      sub="What files processed by the media pipeline — the Upload check above — occupy on the server. Profile pictures, chat attachments and research files take a different route and are stored separately, so they are not counted here. The figure is cached for about an hour, so recent changes can take a while to show.">
      {total === 0 ? (
        <EmptyState icon="archive" title="Nothing stored yet"
          sub="Nothing has been through the media pipeline on this account. Photos, avatars and attachments you uploaded elsewhere in the app are stored outside this count."/>
      ) : (
        <>
          <div className="flex" style={{ alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
            <div className="stx-figure">{fmtBytes(total)}</div>
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
          {adj.total !== 0 && (
            <p className="muted text-xs" style={{ marginTop: 8 }}>
              Includes what you uploaded or deleted here just now — the server’s own figure catches up within the hour.
            </p>
          )}
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
