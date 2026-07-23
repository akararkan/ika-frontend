/* =========================================================
   ScheduledPanel — this conversation's send-later queue.
   ---------------------------------------------------------
   The rows are Postgres, not the message log: a scheduled message
   does not exist in the timeline until a poller fires it (~15s
   granularity) through the NORMAL send path, so it gets the same
   permission checks, idempotency, fan-out and realtime as a live
   send. Two consequences the copy has to carry:

   · the fire time is approximate (the poll interval), and
   · permission is re-checked AT FIRE TIME — a message queued
     before you were blocked, removed or restricted lands FAILED
     rather than sneaking through a closed door. Only permission
     and validation failures are terminal; a rate limit or a
     datastore blip leaves the row PENDING for the next poll.
   ========================================================= */
import React from 'react'
import { Icon } from '../ui.jsx'
import { EmptyState } from '../states.jsx'
import { uiConfirm } from '../Dialog.jsx'

/** ISO → "Tomorrow 09:00" / "Thu 14:30" / "3 Sep 14:30". */
function whenLabel(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return `Today ${time}`
  const t = new Date(now); t.setDate(t.getDate() + 1)
  if (d.toDateString() === t.toDateString()) return `Tomorrow ${time}`
  if (d - now < 7 * 86400000 && d > now) {
    return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
  }
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`
}

const STATUS_COPY = {
  PENDING:   { label: 'Queued',   tone: '' },
  SENT:      { label: 'Sent',     tone: 'ok' },
  CANCELLED: { label: 'Cancelled', tone: '' },
  FAILED:    { label: 'Failed',   tone: 'bad' },
}

export function ScheduledPanel({ rows = [], onClose, onCancel }) {
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const drop = async (row) => {
    const ok = await uiConfirm({
      title: 'Cancel this scheduled message?',
      message: 'It will not be sent. You can always write it again.',
      danger: true,
      confirmLabel: 'Cancel it',
    })
    if (ok) onCancel?.(row.id)
  }

  return (
    <div className="ch-search ch-sched" role="region" aria-label="Scheduled messages">
      <div className="ch-search-head">
        <h3><Icon name="calendar" className="sm"/>Scheduled</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Close scheduled messages" title="Close">
          <Icon name="close" className="sm"/>
        </button>
      </div>

      <div className="ch-search-body">
        {rows.length === 0 ? (
          <EmptyState
            icon="calendar"
            title="Nothing scheduled"
            sub="Hold the send button — or use the clock in the composer — to pick a time."
          />
        ) : (
          <>
            <p className="ch-search-hint">
              Queued messages are sent through the normal path, so permission is
              re-checked when they fire. Times are approximate to about 15 seconds.
            </p>
            {rows.map(row => {
              const st = STATUS_COPY[row.status] || STATUS_COPY.PENDING
              return (
                <div key={row.id} className="ch-schedrow">
                  <div className="ch-schedrow-main">
                    <div className="ch-schedrow-when">
                      <Icon name="clock" className="xs"/>
                      {whenLabel(row.scheduledAt)}
                      {/* PENDING is the norm and the time already says it —
                          only the outcomes get a tag. */}
                      {row.status !== 'PENDING' && (
                        <span className={'ch-schedrow-tag ' + st.tone}>{st.label}</span>
                      )}
                    </div>
                    <div className="ch-schedrow-body" dir="auto">
                      {row.body || { IMAGE: 'Photo', VIDEO: 'Video', VOICE: 'Voice message', FILE: 'File' }[row.type] || 'Message'}
                    </div>
                  </div>
                  {row.pending && (
                    <button type="button" className="ch-schedrow-x" onClick={() => drop(row)}
                      aria-label="Cancel this scheduled message" title="Cancel">
                      <Icon name="trash" className="sm"/>
                    </button>
                  )}
                </div>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}

export default ScheduledPanel
