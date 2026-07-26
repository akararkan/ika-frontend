/* =========================================================
   Channel statistics
   ---------------------------------------------------------
   Two kinds of number arrive from `GET /channels/{id}/stats`
   and the panel is built around telling them apart, because
   presenting them with equal authority would be a lie:

     · EXACT (Postgres)      — every member-derived figure:
       subscribers, joins/leaves, mutes, post count.
     · BEST-EFFORT (Redis)   — postsByType, totalViews,
       totalForwards, topPosts. Maintained on the hot paths and
       rebuilt on restart; the per-post counters remain the
       durable truth.
   The second group is grouped under its own heading with a
   footnote rather than mixed into the tiles.

   Charts follow the house rules: single-series data gets ONE
   hue (identity is carried by the axis label, not by colour, so
   a per-category palette would burn the free channel on
   information the bar length already shows), marks are thin
   with a rounded data-end and a surface gap, gridlines are
   solid hairlines one shade off the surface, and the only
   direct label is the extreme. Everything else is on hover.
   ========================================================= */
import React from 'react'
import { Icon } from '../ui.jsx'
import { Loader, ErrorState } from '../states.jsx'
import { api } from '../../api/index.js'
import { nfmt } from './channelArt.js'
import { JOIN_SOURCE_LABELS } from '../../api/channels.js'

const TYPE_LABELS = {
  TEXT: 'Text', IMAGE: 'Photo', VIDEO: 'Video', VOICE: 'Voice', AUDIO: 'Audio',
  GIF: 'GIF', STICKER: 'Sticker', FILE: 'File', POLL: 'Poll', LOCATION: 'Location',
  CONTACT: 'Contact', VIDEO_NOTE: 'Video note',
}

/** A single fact. The number IS the chart — no plot, no sparkline. */
function Tile({ label, value, sub, tone }) {
  return (
    <div className={'cst-tile' + (tone ? ' ' + tone : '')}>
      <div className="cst-tile-v">{nfmt(value)}</div>
      <div className="cst-tile-l">{label}</div>
      {sub && <div className="cst-tile-s">{sub}</div>}
    </div>
  )
}

/* Joins per day over the reporting window. A column chart: magnitude over
   ordered time, one series, so one hue. Only the peak is direct-labelled —
   a number over all thirty columns is noise nobody reads. */
function JoinsChart({ rows }) {
  if (!rows.length) return null
  const max = Math.max(...rows.map(r => r.value), 1)
  const peak = rows.reduce((a, b) => (b.value > a.value ? b : a), rows[0])
  const total = rows.reduce((a, r) => a + r.value, 0)

  const dayLabel = (iso) => {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  }

  return (
    <figure className="cst-fig">
      <figcaption className="cst-fig-cap">
        <span className="cst-fig-t">New subscribers per day</span>
        <span className="cst-fig-s">{nfmt(total)} over {rows.length} days · peak {nfmt(peak.value)} on {dayLabel(peak.date)}</span>
      </figcaption>

      <div className="cst-cols" role="img"
        aria-label={`New subscribers per day. ${rows.map(r => `${dayLabel(r.date)}: ${r.value}`).join(', ')}.`}>
        {/* three hairline gridlines, solid, one shade off the surface */}
        <span className="cst-grid" style={{ '--at': '100%' }} aria-hidden="true"/>
        <span className="cst-grid" style={{ '--at': '50%' }} aria-hidden="true"/>
        <span className="cst-grid" style={{ '--at': '0%' }} aria-hidden="true"/>

        {rows.map(r => (
          <span className={'cst-col' + (r.date === peak.date ? ' peak' : '')} key={r.date}
            style={{ '--h': `${Math.round((r.value / max) * 100)}%` }}>
            <span className="cst-col-bar"/>
            <span className="cst-col-tip">{dayLabel(r.date)}<b>{r.value}</b></span>
          </span>
        ))}
      </div>

      <div className="cst-axis">
        <span>{dayLabel(rows[0].date)}</span>
        <span>{dayLabel(rows[rows.length - 1].date)}</span>
      </div>
    </figure>
  )
}

/* A ranked breakdown. Horizontal bars, one hue; the category name sits on the
   row and the value at its end in text ink, so colour carries nothing and
   nothing is clipped by a short bar. */
function BarList({ title, rows, labels, empty }) {
  if (!rows.length) return <p className="cst-empty">{empty}</p>
  const max = Math.max(...rows.map(r => r.value), 1)
  const total = rows.reduce((a, r) => a + r.value, 0)
  return (
    <figure className="cst-fig">
      <figcaption className="cst-fig-cap">
        <span className="cst-fig-t">{title}</span>
        <span className="cst-fig-s">{nfmt(total)} total</span>
      </figcaption>
      <div className="cst-bars">
        {rows.map(r => (
          <div className="cst-bar-row" key={r.key}>
            <span className="cst-bar-k">{labels?.[r.key] || r.key}</span>
            <span className="cst-bar-track">
              <span className="cst-bar-fill" style={{ '--w': `${Math.round((r.value / max) * 100)}%` }}/>
            </span>
            <span className="cst-bar-v">{nfmt(r.value)}</span>
          </div>
        ))}
      </div>
    </figure>
  )
}

export function ChannelStats({ channel }) {
  const [s, setS] = React.useState(null)
  const [state, setState] = React.useState('loading')
  const [err, setErr] = React.useState(null)
  const [retry, setRetry] = React.useState(0)

  React.useEffect(() => {
    let alive = true
    setState('loading')
    api.channels.stats(channel.id)
      .then(res => { if (alive) { setS(res); setErr(null); setState('ready') } })
      .catch(e => { if (alive) { setErr(e); setState('error') } })
    return () => { alive = false }
  }, [channel.id, retry])

  if (state === 'loading') return <Loader label="Reading the numbers…"/>
  if (state === 'error' || !s) {
    // A rights refusal is final — offering Retry on a 403 contradicts the message.
    return err?.status === 403
      ? <ErrorState message="Statistics are only available to the channel’s owner and admins."/>
      : <ErrorState message="The statistics could not be loaded." onRetry={() => setRetry(n => n + 1)}/>
  }

  return (
    <div className="cst">
      <div className="cst-tiles">
        <Tile label="Subscribers" value={s.subscriberCount} sub={`${nfmt(s.onlineSubscribers)} online now`}/>
        <Tile label="Joined this week" value={s.joinedLast7Days}/>
        <Tile label="Net change · 30 days" value={s.net30} tone={s.net30 < 0 ? 'down' : 'up'}
          sub={`${nfmt(s.joinedLast30Days)} in · ${nfmt(s.leftLast30Days)} out`}/>
        <Tile label="Posts" value={s.postCount}/>
        <Tile label="Notifications on" value={s.notificationsEnabledCount}
          sub={`${nfmt(s.mutedCount)} muted`}/>
      </div>

      <JoinsChart rows={s.joinsByDay}/>

      <BarList title="How subscribers arrived" rows={s.joinsBySource} labels={JOIN_SOURCE_LABELS}
        empty="No join sources recorded yet."/>

      {/* ---- the best-effort group, fenced off and labelled ---- */}
      <section className="cst-soft">
        <h4 className="cst-soft-h"><Icon name="trending" className="xs"/>Reach</h4>
        <div className="cst-tiles">
          <Tile label="Total views" value={s.totalViews}/>
          <Tile label="Total forwards" value={s.totalForwards}/>
        </div>

        <BarList title="Posts by type" rows={s.postsByType} labels={TYPE_LABELS}
          empty="No posts yet."/>

        {!!s.topPosts.length && (
          <div className="cst-top">
            <h5 className="cst-top-h">Most-viewed posts</h5>
            {s.topPosts.slice(0, 5).map(p => (
              <div className="cst-top-row" key={p.id}>
                <span className="cst-top-body" title={p.body || undefined}
                  dir={/[\u0590-\u08FF]/.test(p.body || '') ? 'rtl' : 'ltr'}>
                  {p.body || `${TYPE_LABELS[p.type] || p.type} post`}
                </span>
                <span className="cst-top-v"><Icon name="eye" className="xs"/>{nfmt(p.views ?? 0)}</span>
              </div>
            ))}
          </div>
        )}

        <p className="cst-note">
          Reach figures are live approximations; every figure above the Reach
          heading is an exact count, and the per-post counters on each message
          remain the exact record.
        </p>
      </section>
    </div>
  )
}

export default ChannelStats
