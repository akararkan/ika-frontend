/* =========================================================
   Settings v2 — notifications: the event×channel preference
   matrix, quiet hours (DND schedule + snooze), and the list
   of registered push devices. Wire: settings.notifications.*
   (no envelopes; DND PUT is patch-style — `enabled` must be
   sent explicitly on EVERY write or the server re-derives it).
   ========================================================= */
import React from 'react'
import { Icon, showToast } from '../ui.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { EmptyState, Loader, ErrorState } from '../states.jsx'
import {
  api, session, NOTIFICATION_CHANNELS, CHANNEL_LABELS, NOTIFICATION_GROUPS,
  LOCKED_NOTIFICATION_TYPES, DND_DAYS,
} from '../../api/index.js'
import { SetCard, ToggleRow, fmtWhen } from './shared.jsx'

/* ---------- notification matrix ---------- */

export function NotificationsMatrixPanel() {
  const [matrix, setMatrix] = React.useState(null)
  const [error, setError] = React.useState(false)
  const [tick, setTick] = React.useState(0)

  React.useEffect(() => {
    let alive = true
    setError(false)
    api.settings.notifications.matrix()
      .then(m => { if (alive) setMatrix(m || {}) })
      .catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [tick])

  const toggle = (type, channel) => {
    const cur = !!matrix?.[type]?.[channel]
    const next = !cur
    setMatrix(m => ({ ...m, [type]: { ...m[type], [channel]: next } }))
    api.settings.notifications.setPref(type, channel, next).catch(() => {
      setMatrix(m => ({ ...m, [type]: { ...m[type], [channel]: cur } }))
      showToast('Could not save — reverted')
    })
  }

  return (
    <SetCard icon="bell" title="Notification matrix"
      sub="Choose where each kind of notification reaches you. Security alerts are always delivered.">
      {error && matrix === null ? (
        <ErrorState message="Could not load notification preferences" onRetry={() => setTick(t => t + 1)}/>
      ) : matrix === null ? (
        <Loader/>
      ) : (
        <div className="stx-scroll">
          <table className="stx-matrix">
            <thead>
              <tr>
                <th>Notification</th>
                {NOTIFICATION_CHANNELS.map(c => <th key={c}>{CHANNEL_LABELS[c]}</th>)}
              </tr>
            </thead>
            <tbody>
              {NOTIFICATION_GROUPS.map(group => (
                <React.Fragment key={group.label}>
                  <tr className="stx-mgroup"><td colSpan={6}>{group.label}</td></tr>
                  {group.rows.map(([type, label]) => {
                    const locked = LOCKED_NOTIFICATION_TYPES.has(type)
                    return (
                      <tr key={type}>
                        <td>{label}</td>
                        {NOTIFICATION_CHANNELS.map(channel => (
                          <td key={channel}>
                            <input type="checkbox" className="stx-tick"
                              checked={locked ? true : !!matrix[type]?.[channel]}
                              disabled={locked}
                              title={locked ? 'Always delivered' : undefined}
                              aria-label={`${label} — ${CHANNEL_LABELS[channel]}`}
                              onChange={() => toggle(type, channel)}/>
                          </td>
                        ))}
                      </tr>
                    )
                  })}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SetCard>
  )
}

/* ---------- quiet hours (DND) ---------- */

const WALL_OPTS = {
  hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
}

/** A Date instant rendered as wall-clock time in `tz`, in the EXACT shape the
 *  backend's LocalDateTime deserializer accepts.
 *
 *  The server registers one strict global formatter for every LocalDateTime,
 *  `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'` (config/JacksonConfig.java), on BOTH the
 *  read and the write side. A bare 19-character 'YYYY-MM-DDTHH:mm:ss' fails to
 *  parse and the whole request 400s — so the `.000Z` tail is mandatory. The Z
 *  there is a LITERAL in the pattern, not a zone conversion: the value stays
 *  wall-clock in the DND timezone, which is how the server evaluates it. */
function wallClock(date, tz) {
  let parts
  try { parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...WALL_OPTS }).formatToParts(date) }
  catch { parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', ...WALL_OPTS }).formatToParts(date) }
  const p = {}
  for (const { type, value } of parts) p[type] = value
  const hour = p.hour === '24' ? '00' : p.hour   // some engines emit 24 at midnight with hour12:false
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}.000Z`
}

export function DndPanel() {
  const [dnd, setDnd] = React.useState(null)
  const [error, setError] = React.useState(false)
  const [tick, setTick] = React.useState(0)
  const writeSeq = React.useRef(0)

  React.useEffect(() => {
    let alive = true
    setError(false)
    api.settings.notifications.dnd()
      .then(d => { if (alive) setDnd(d || {}) })
      .catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [tick])

  /** Apply a change optimistically, then reconcile from the server response.
   *  TRAP: omitting `enabled` makes the server re-derive it from the window,
   *  so every write carries it explicitly. */
  const apply = (patch, okMsg) => {
    const prev = dnd
    if (!prev) return
    const body = { ...patch, enabled: 'enabled' in patch ? patch.enabled : !!prev.enabled }
    /* Typing in a time field fires several writes in a row, and the responses
       can land out of order — only the newest one is allowed to publish its
       server state or roll anything back. */
    const mySeq = ++writeSeq.current
    setDnd({ ...prev, ...body })
    api.settings.notifications.updateDnd(body)
      .then(res => {
        if (writeSeq.current !== mySeq) return          // a newer write owns the state
        if (res) setDnd(res)
        if (okMsg) showToast(okMsg)
      })
      .catch(e => {
        // Roll back only the keys THIS write carried, and only if it is still the latest.
        if (writeSeq.current === mySeq) {
          setDnd(cur => {
            if (!cur) return cur
            const back = { ...cur }
            for (const k of Object.keys(body)) back[k] = prev[k]
            return back
          })
        }
        showToast(e?.code === 'BAD_TIMEZONE' ? 'That timezone isn’t recognised'
          : e?.code === 'BAD_TIME' ? 'That time isn’t valid'
          : 'Could not save — reverted')
      })
  }

  const zones = React.useMemo(() => {
    const cur = dnd?.timezone || ''
    let list
    if (typeof Intl.supportedValuesOf === 'function') list = Intl.supportedValuesOf('timeZone')
    else list = [cur, 'UTC', 'Asia/Baghdad'].filter(Boolean)
    if (cur && !list.includes(cur)) list = [cur, ...list]
    return [...new Set(list)]
  }, [dnd?.timezone])

  if (error && dnd === null) {
    return (
      <SetCard icon="clock" title="Quiet hours">
        <ErrorState message="Could not load quiet hours" onRetry={() => setTick(t => t + 1)}/>
      </SetCard>
    )
  }
  if (dnd === null) return <SetCard icon="clock" title="Quiet hours"><Loader/></SetCard>

  const mask = dnd.daysMask || 0
  const everyDay = mask === 0
  const tz = dnd.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  /* muteUntil is wall-clock in the DND timezone — compare against the current
     wall-clock in that zone. Both sides are trimmed to the same 19-character
     'YYYY-MM-DDTHH:mm:ss' prefix (the wire carries a '.000Z' tail) so the
     lexicographic comparison is between like shapes. */
  const muteUntil = (dnd.muteUntil || '').slice(0, 19)
  const snoozed = !!muteUntil && muteUntil > wallClock(new Date(), tz).slice(0, 19)

  const toggleDay = (bit) => {
    const eff = mask === 0 ? 127 : mask       // 0 means every day
    let next = eff ^ bit
    if (next === 127) next = 0                // all seven back on → every day
    apply({ daysMask: next })
  }

  const snooze = (h) => {
    const at = new Date()
    at.setTime(at.getTime() + h * 3_600_000)
    apply({ muteUntil: wallClock(at, tz) }, `Notifications muted for ${h}h`)
  }
  /* muteUntil:null would be SKIPPED by the patch semantics (only non-null
     fields apply), so clearing writes a past instant instead — the epoch is
     inert and reads as "not muted". */
  const clearSnooze = () => apply({ muteUntil: '1970-01-01T00:00:00.000Z' }, 'Mute cleared')

  return (
    <SetCard icon="clock" title="Quiet hours"
      sub="Pause deliveries on a schedule, or mute everything for a while.">
      <ToggleRow
        title="Pause notifications on a schedule"
        desc="During the window below nothing is pushed to your devices. Notifications still collect in-app."
        on={!!dnd.enabled}
        onToggle={() => apply({ enabled: !dnd.enabled })}/>
      {dnd.enabled && (
        <>
          <div className="set-grid" style={{ marginTop: 8 }}>
            <div>
              <label className="field-label">Start</label>
              <input type="time" className="field" value={(dnd.startTime || '').slice(0, 5)}
                onChange={e => e.target.value && apply({ startTime: e.target.value })}/>
            </div>
            <div>
              <label className="field-label">End</label>
              <input type="time" className="field" value={(dnd.endTime || '').slice(0, 5)}
                onChange={e => e.target.value && apply({ endTime: e.target.value })}/>
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <label className="field-label">Timezone</label>
            <select className="field" value={dnd.timezone || ''}
              onChange={e => e.target.value && apply({ timezone: e.target.value })}>
              {!dnd.timezone && <option value="">Choose a timezone…</option>}
              {zones.map(z => <option key={z} value={z}>{z}</option>)}
            </select>
          </div>
          <div style={{ marginTop: 10 }}>
            <label className="field-label">Days</label>
            <div className="stx-days">
              {DND_DAYS.map(([label, bit]) => {
                const on = everyDay || (mask & bit) !== 0
                return (
                  <button key={label} type="button" aria-pressed={on}
                    className={'stx-day' + (on ? ' on' : '')}
                    onClick={() => toggleDay(bit)}>{label}</button>
                )
              })}
            </div>
            {everyDay && <p className="muted text-xs" style={{ marginTop: 6 }}>Every day</p>}
          </div>
        </>
      )}
      <div className="set-toggle" style={{ marginTop: 8 }}>
        <div><b>Mute everything for</b><small className="muted">Silences every channel regardless of the schedule.</small></div>
        <div className="flex gap-8">
          {[1, 8, 24].map(h => (
            <button key={h} className="btn btn-secondary btn-sm" onClick={() => snooze(h)}>{h}h</button>
          ))}
        </div>
      </div>
      {snoozed && (
        <div className="stx-note info">
          <Icon name="mute"/>
          <span>
            Muted until {muteUntil.slice(0, 16).replace('T', ' ')} ({tz}).{' '}
            <button className="btn btn-ghost btn-sm" onClick={clearSnooze}>Clear</button>
          </span>
        </div>
      )}
    </SetCard>
  )
}

/* ---------- push devices ---------- */

function deviceIcon(platform) {
  const p = (platform || '').toUpperCase()
  if (p.includes('WEB')) return 'globe'
  if (p.includes('DESKTOP') || p.includes('MAC') || p.includes('WIN') || p.includes('LINUX')) return 'screen'
  return 'phone'
}

/* Web push needs a VAPID public key baked in at build time. Without one there
   is nothing honest to register — a synthetic token would poison the server's
   token table (the POST upserts by token value), so we show a note instead. */
const VAPID_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || ''

/** 'unsupported' (browser can't do web push) | 'unconfigured' (no VAPID key) | 'ready'. */
function pushSupport() {
  if (typeof window === 'undefined') return 'unsupported'
  if (!window.isSecureContext) return 'unsupported'          // push requires https / localhost
  if (!('Notification' in window)) return 'unsupported'
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return 'unsupported'
  if (!('PushManager' in window)) return 'unsupported'
  return VAPID_KEY ? 'ready' : 'unconfigured'
}

/** VAPID keys travel as base64url; `applicationServerKey` wants raw bytes. */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/** The current session id from the JWT payload, so logging out purges the
 *  token server-side. Best-effort: any malformed token yields undefined. */
function currentSid() {
  try {
    const part = (session.getToken() || '').split('.')[1]
    if (!part) return undefined
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)))
    return payload?.sid || undefined
  } catch { return undefined }
}

export function PushTokensPanel() {
  const [list, setList] = React.useState(null)
  const [error, setError] = React.useState(false)
  const [tick, setTick] = React.useState(0)
  const [busy, setBusy] = React.useState(false)
  const support = React.useMemo(() => pushSupport(), [])
  const aliveRef = React.useRef(true)
  React.useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false } }, [])

  React.useEffect(() => {
    let alive = true
    setError(false)
    api.settings.notifications.pushTokens()
      .then(r => { if (alive) setList(r || []) })
      .catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [tick])

  /* Subscribe this browser and hand the subscription to the server. We never
     register a service worker here — if the app hasn't installed one there is
     nothing to attach a subscription to, so we say so and stop. */
  const enable = async () => {
    if (busy) return
    setBusy(true)
    let timer = 0
    try {
      const perm = await Notification.requestPermission()
      if (perm === 'denied') { showToast('Notifications are blocked in your browser settings'); return }
      if (perm !== 'granted') return                          // dismissed — nothing to say
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 3000) }),
      ])
      if (!reg) { showToast('Push needs a service worker on this site'); return }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_KEY),
      })
      await api.settings.notifications.registerPushToken({
        provider: 'WEB', token: JSON.stringify(sub), platform: 'WEB', sid: currentSid(),
      })
      if (!aliveRef.current) return
      setTick(t => t + 1)
      showToast('Push enabled on this device')
    } catch {
      showToast('Could not enable push')
    } finally {
      clearTimeout(timer)
      if (aliveRef.current) setBusy(false)
    }
  }

  const remove = async (t) => {
    const ok = await uiConfirm({
      title: 'Remove this device?',
      message: 'It stops receiving push notifications until the app registers itself again.',
      confirmLabel: 'Remove', icon: 'trash',
    })
    if (!ok) return
    const prev = list
    setList(l => l.filter(x => x.id !== t.id))
    try {
      await api.settings.notifications.deletePushToken(t.id)
      showToast('Device removed')
    } catch {
      setList(prev)
      showToast('Could not remove — reverted')
    }
  }

  return (
    <SetCard icon="phone" title="Push devices"
      sub="Devices registered for push delivery. Remove any you no longer use.">
      {support === 'unsupported' ? (
        <div className="stx-note info" style={{ marginBottom: 12 }}>
          <Icon name="info"/>
          <span>This browser does not support push notifications. In-app and email notifications still work.</span>
        </div>
      ) : support === 'unconfigured' ? (
        <div className="stx-note info" style={{ marginBottom: 12 }}>
          <Icon name="info"/>
          <span>Push delivery is not configured for this deployment yet. The notification settings above still apply everywhere else.</span>
        </div>
      ) : (
        <div className="flex gap-8" style={{ marginBottom: 12 }}>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={enable}>
            <Icon name="bell" className="xs"/>{busy ? 'Enabling…' : 'Enable push on this device'}
          </button>
        </div>
      )}
      {error && list === null ? (
        <ErrorState message="Could not load push devices" onRetry={() => setTick(t => t + 1)}/>
      ) : list === null ? (
        <Loader/>
      ) : list.length ? (
        <div className="rail-list">
          {list.map(t => (
            <div key={t.id} className="rail-row">
              <span className="stx-sess-ic"><Icon name={deviceIcon(t.platform)}/></span>
              <div className="rail-info">
                <div className="rail-name"><b>{t.provider || 'Push'}</b></div>
                <div className="rail-sub">{t.platform ? `${t.platform} · ` : ''}last seen {fmtWhen(t.lastSeenAt)}</div>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => remove(t)}>Remove</button>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState icon="phone" title="No push devices"
          sub="Web and mobile apps register here when they enable push."/>
      )}
    </SetCard>
  )
}
