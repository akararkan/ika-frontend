import React from 'react'
import { api } from '../../api/index.js'
import { session } from '../../api/config.js'
import { Avatar, Icon } from '../ui.jsx'

/* =========================================================
   New followers — a small rail section above the inbox.

   Data: the notifications feed (type NEW_FOLLOWER, category
   SOCIAL — probed against the live backend; the DTO carries the
   full actor card). "New" is decided by a CLIENT watermark, not
   the notification's isRead flag: reading the notifications
   inbox marks everything read there, and that must not silently
   empty this section before the user has seen it HERE. The
   watermark (latest createdAt acknowledged) lives in
   localStorage, scoped per signed-in user.

   Clicking a row hands the actor to the parent (ChatPage opens
   the get-or-create DM) and marks that one notification read,
   best-effort. Dismissing advances the watermark over everything
   currently shown and bulk-marks those notifications read.
   ========================================================= */

const CAP = 3
const seenKey = (uid) => `ika_flwseen_${uid || 'anon'}`

export default function NewFollowers({ onMessage }) {
  const [rows, setRows] = React.useState([])
  const uid = session.getUser()?.id || null

  const load = React.useCallback(async () => {
    try {
      // Server-side type filter — NEW_FOLLOWER never aggregates, so 30 rows
      // of the right kind beat 30 mixed rows filtered down to a handful.
      const { items } = await api.notifications.list({ type: 'NEW_FOLLOWER', page: 0, size: 30 })
      const seen = localStorage.getItem(seenKey(uid)) || ''
      // One row per follower — the same person re-following must not stack.
      const byActor = new Map()
      for (const n of items) {
        if (n.type !== 'NEW_FOLLOWER' || !n._actor?.id) continue
        if (seen && n.createdAt && n.createdAt <= seen) continue
        const prev = byActor.get(n._actor.id)
        if (!prev || (n.createdAt || '') > (prev.createdAt || '')) byActor.set(n._actor.id, n)
      }
      setRows([...byActor.values()]
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
        .slice(0, CAP))
    } catch {
      /* quiet — the inbox rail must not break on a notifications hiccup */
    }
  }, [uid])

  React.useEffect(() => { load() }, [load])
  // Catch follows that landed while the tab was in the background.
  React.useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [load])

  const dismiss = () => {
    const newest = rows.reduce((m, n) => ((n.createdAt || '') > m ? n.createdAt : m), '')
    if (newest) localStorage.setItem(seenKey(uid), newest)
    api.notifications.markReadBulk(rows.map(n => n.id)).catch(() => {})
    setRows([])
  }

  const open = (n) => {
    api.notifications.markRead(n.id).catch(() => {})
    onMessage?.(n._actor)
  }

  if (!rows.length) return null
  return (
    <section className="cv-flw" aria-label="New followers">
      <div className="cv-flw-head">
        <Icon name="users" className="sm" aria-hidden="true"/>
        <span className="cv-flw-eyebrow">New followers</span>
        <span className="cv-flw-n">{rows.length}</span>
        <button type="button" className="cv-flw-x" onClick={dismiss} aria-label="Dismiss new followers">
          <Icon name="close" className="sm"/>
        </button>
      </div>
      {rows.map(n => (
        <button type="button" className="cv-flw-row" key={n.id} onClick={() => open(n)}>
          <Avatar size={38} initials={n._actor.initials} color={n._actor.avc} src={n._actor.profileImage}/>
          <span className="cv-flw-body">
            <b className="cv-flw-name" dir="auto">{n._actor.full}</b>
            <span className="cv-flw-sub" dir="auto">@{n._actor.handle} · followed you {n.time}</span>
          </span>
          <span className="cv-flw-cta"><Icon name="chat" className="xs" aria-hidden="true"/>Message</span>
        </button>
      ))}
    </section>
  )
}
