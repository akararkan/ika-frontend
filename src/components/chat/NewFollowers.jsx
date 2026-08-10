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
   the get-or-create DM), marks that one notification read, and
   RETIRES the row — messaging someone is the whole point of this
   section, so a follower you have already written to must not be
   sitting here again after a reload. Dismissing advances the
   watermark over everything currently shown and bulk-marks those
   notifications read.
   ========================================================= */

const CAP = 3
const seenKey = (uid) => `ika_flwseen_${uid || 'anon'}`
/* Why a second key, and not just a nudge of the watermark: the watermark is a
   single timestamp, so it can only ever acknowledge a PREFIX of the list.
   Advancing it to retire the person you just messaged would take every OLDER
   follower down with them — and you message people out of order. So the
   individually-handled ones are kept as their own `{actorId: notificationId}`
   map.
   The value is the notification ID, deliberately, not its timestamp: a
   timestamp has to be compared, and `createdAt` is not stable enough to
   compare for identity (it drifts by milliseconds between fetches under the
   mock, and clock skew would do the same against a real server), so "is this
   the follow I already handled" quietly became false and the row came back.
   An id is an identity test, and it keeps the re-follow case honest for free:
   following again writes a NEW notification with a new id, so that actor
   surfaces again exactly once. */
const doneKey = (uid) => `ika_flwdone_${uid || 'anon'}`
/* One entry per person ever messaged from this rail — bounded so a decade of
   followers cannot turn a convenience into a growing localStorage blob. */
const DONE_CAP = 50

const readDone = (uid) => {
  try { return JSON.parse(localStorage.getItem(doneKey(uid)) || '{}') || {} } catch { return {} }
}
const writeDone = (uid, map) => {
  try {
    // String keys keep insertion order, so the oldest entries fall off the front.
    const kept = Object.entries(map).slice(-DONE_CAP)
    localStorage.setItem(doneKey(uid), JSON.stringify(Object.fromEntries(kept)))
  } catch { /* private mode */ }
}

export default function NewFollowers({ onMessage }) {
  const [rows, setRows] = React.useState([])
  const uid = session.getUser()?.id || null

  const load = React.useCallback(async () => {
    try {
      // Server-side type filter — NEW_FOLLOWER never aggregates, so 30 rows
      // of the right kind beat 30 mixed rows filtered down to a handful.
      const { items } = await api.notifications.list({ type: 'NEW_FOLLOWER', page: 0, size: 30 })
      const seen = localStorage.getItem(seenKey(uid)) || ''
      const done = readDone(uid)
      // One row per follower — the same person re-following must not stack.
      const byActor = new Map()
      for (const n of items) {
        if (n.type !== 'NEW_FOLLOWER' || !n._actor?.id) continue
        if (seen && n.createdAt && n.createdAt <= seen) continue
        const prev = byActor.get(n._actor.id)
        if (!prev || (n.createdAt || '') > (prev.createdAt || '')) byActor.set(n._actor.id, n)
      }
      setRows([...byActor.values()]
        /* Filtered AFTER the collapse, not during it: the map holds only each
           actor's newest follow, so an older notification from the same person
           can never slip in behind the one that was just handled. */
        .filter(n => done[n._actor.id] !== n.id)
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
    /* Retire the row: pressing Message is the acknowledgement this section
       exists to collect. Written BEFORE the reload below, which reads it. */
    const actorId = n._actor.id
    writeDone(uid, { ...readDone(uid), [actorId]: n.id })
    setRows(prev => prev.filter(r => r._actor.id !== actorId))
    /* The list is capped at three, so retiring one may reveal a fourth
       follower who was waiting behind it. Quiet and best-effort — the row is
       already gone locally whether or not this comes back. */
    load()
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
