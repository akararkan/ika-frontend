/* =========================================================
   Settings v2 — notifications: the event×channel preference
   matrix, quiet hours (DND schedule + snooze), and the list
   of registered push devices. Wire: settings.notifications.*
   (no envelopes; DND PUT is patch-style — `enabled` must be
   sent explicitly on EVERY write or the server re-derives it).

   What each column of the matrix is actually worth today —
   the panel says all of this out loud rather than implying a
   delivery that never happens. NotificationPrefResolver.isEnabled
   has NO caller outside the settings package (the delivery path,
   CassandraNotificationService, never asks it), so the matrix is
   a stored intent for every channel except the one this client
   serves itself:
     DESKTOP · real, raised by THIS client (lib/desktopNotify)
     IN_APP  · stored; the inbox row is written either way
     PUSH    · the token registry works; the only PushSender bean
               is NoOpPushSender, so nothing is ever sent
     EMAIL   · stored, but the mailer reads the five coarse
               flags on /settings/emails, not this column
     SMS     · stored; no SMS notification sender exists at all
   Quiet hours are the same story: DndEvaluator has no caller
   anywhere, so the window only gates desktop alerts from here.
   ========================================================= */
import React from 'react'
import { Link } from 'react-router-dom'
import { Icon, showToast } from '../ui.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { EmptyState, Loader, ErrorState } from '../states.jsx'
import {
  api, session, NOTIFICATION_CHANNELS, CHANNEL_LABELS, NOTIFICATION_GROUPS,
  LOCKED_NOTIFICATION_TYPES, DND_DAYS,
} from '../../api/index.js'
/* Not re-exported by the barrel — imported from the module that defines it. */
import { GROUPED_NOTIFICATION_TYPES } from '../../api/settings.js'
import { useAuth } from '../../context/AuthContext.jsx'
import {
  permissionState, ensurePermission, notify,
  wallClockIn, detectedZone,
} from '../../lib/desktopNotify.js'
import {
  SetCard, SubHead, SeeAlso, ToggleRow, ControlRow, Field, useWriteStatus,
  fmtWhen, fmtWall, humanEnum,
} from './shared.jsx'

/* ---------- notification matrix ---------- */

/* Honest per-column caveats. Shown as a header tooltip and repeated as
   footnotes under the table for anyone who never hovers a header. */
const CHANNEL_NOTE = {
  DESKTOP: 'Shown by this browser while IKA is open in a tab',
  IN_APP: 'Everything reaches your inbox today — saved for when this can be split',
  PUSH: 'Saved on your account; no push service is sending on this deployment yet',
  EMAIL: 'Email delivery is currently governed by your email preferences',
  SMS: 'Needs a phone number — add one in Security',
}

/* .stx-tick styles :checked only, so a partly-on group would read as "off".
   backgroundImage — not the `background` shorthand — so the base white (and the
   dark-theme --card-2 override) survives underneath the dash. */
const MIXED_TICK = {
  backgroundImage: 'linear-gradient(var(--ink-soft),var(--ink-soft))',
  backgroundSize: '10px 2px',
  backgroundPosition: 'center',
  backgroundRepeat: 'no-repeat',
}

export function NotificationsMatrixPanel() {
  const { user } = useAuth()
  const [matrix, setMatrix] = React.useState(null)
  const [error, setError] = React.useState(false)
  const [tick, setTick] = React.useState(0)
  const [reverted, setReverted] = React.useState({})       // "TYPE:CHANNEL" → flash that cell
  const [bulking, setBulking] = React.useState('')         // one group×channel write at a time
  const [perm, setPerm] = React.useState(permissionState)
  const flashTimers = React.useRef({})

  React.useEffect(() => {
    let alive = true
    setError(false)
    api.settings.notifications.matrix()
      .then(m => { if (alive) setMatrix(m || {}) })
      .catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [tick])

  React.useEffect(() => () => Object.values(flashTimers.current).forEach(clearTimeout), [])

  /* Notification permission is revocable from the browser's own site controls,
     and the prompt itself steals focus — neither fires a React update, so the
     chip below would otherwise keep showing whatever the state was at mount. */
  React.useEffect(() => {
    const sync = () => setPerm(permissionState())
    window.addEventListener('focus', sync)
    document.addEventListener('visibilitychange', sync)
    return () => {
      window.removeEventListener('focus', sync)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [])

  /* A cell has nowhere to hang a "Not saved" marker — the row status belongs to
     a whole setting, and a toast for one tick is louder than the mistake. The
     cell flashes instead (the .is-reverted keyframe) as it snaps back. */
  const flashRevert = (key) => {
    clearTimeout(flashTimers.current[key])
    setReverted(r => ({ ...r, [key]: 1 }))
    flashTimers.current[key] = setTimeout(
      () => setReverted(r => { const n = { ...r }; delete n[key]; return n }), 1200)
  }

  /* SMS is the one channel with a prerequisite that lives in another tab: a
     phone number bound under Security.
     NOT a hard gate. Nothing in the API says whether a number is bound —
     UserResponse has no phone field, so `user.phone` is only ever set for a
     number verified in THIS session (PhonePanel does the same) — and refusing
     the write on that would make the column permanently un-tickable. The
     preference is stored either way; we just say once what it needs. */
  const smsHinted = React.useRef(false)
  const hintSms = (channel, next) => {
    if (channel !== 'SMS' || !next || user?.phone || smsHinted.current) return
    smsHinted.current = true
    showToast('SMS also needs a phone number on your account — add one in Security', 'warn')
  }

  const toggle = (type, channel) => {
    const cur = !!matrix?.[type]?.[channel]
    const next = !cur
    hintSms(channel, next)
    setMatrix(m => ({ ...m, [type]: { ...m[type], [channel]: next } }))
    api.settings.notifications.setPref(type, channel, next).catch(() => {
      setMatrix(m => ({ ...m, [type]: { ...m[type], [channel]: cur } }))
      flashRevert(`${type}:${channel}`)
    })
  }

  /* Group × channel bulk. Sequential on purpose: there is no batch endpoint, it
     is only 3–6 PUTs, and a partial failure stays in a predictable order. */
  const bulk = async (group, channel, next) => {
    if (bulking) return
    hintSms(channel, next)
    const types = group.rows.map(([t]) => t).filter(t => !LOCKED_NOTIFICATION_TYPES.has(t))
    if (!types.length) return
    const before = new Map(types.map(t => [t, !!matrix?.[t]?.[channel]]))
    setBulking(`${group.label}:${channel}`)
    setMatrix(m => {
      const n = { ...m }
      for (const t of types) n[t] = { ...n[t], [channel]: next }
      return n
    })
    const failed = []
    for (const t of types) {
      try { await api.settings.notifications.setPref(t, channel, next) } catch { failed.push(t) }
    }
    if (failed.length) {
      setMatrix(m => {
        const n = { ...m }
        for (const t of failed) n[t] = { ...n[t], [channel]: before.get(t) }
        return n
      })
      for (const t of failed) flashRevert(`${t}:${channel}`)
      showToast(`${failed.length} of ${types.length} rows could not be saved`, 'err')
    }
    setBulking('')
  }

  /* resolvedMatrix walks the WHOLE NotificationType enum, so the response
     carries every type whether or not a group claims it. Unclaimed ones get a
     toggle under "Other" — a type added server-side must never end up invisible
     (and so untoggleable) here. Today that section holds the five types nothing
     dispatches yet; the footnote under the table says so. */
  const groups = React.useMemo(() => {
    const extra = Object.keys(matrix || {}).filter(t => !GROUPED_NOTIFICATION_TYPES.has(t))
    return extra.length
      ? [...NOTIFICATION_GROUPS, { label: 'Other', rows: extra.map(t => [t, humanEnum(t)]) }]
      : NOTIFICATION_GROUPS
  }, [matrix])

  const askDesktop = async () => setPerm(await ensurePermission())
  const testDesktop = () => {
    if (!notify({ title: 'IKA', body: 'Desktop notifications are working.', tag: 'ika-test' })) {
      showToast('Your browser refused to show it', 'err')
    }
  }

  return (
    <SetCard id="notifications" icon="bell" title="Notification matrix"
      sub="Choose where each kind of notification should reach you. Account warnings are always delivered.">
      {error && matrix === null ? (
        <ErrorState message="Could not load notification preferences" onRetry={() => setTick(t => t + 1)}/>
      ) : matrix === null ? (
        <Loader/>
      ) : (
        <>
          <div className="stx-mwrap">
            <table className="stx-matrix">
              <thead>
                <tr>
                  <th>Notification</th>
                  {NOTIFICATION_CHANNELS.map(c => (
                    <th key={c} title={CHANNEL_NOTE[c] || undefined}>{CHANNEL_LABELS[c]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.map(group => {
                  /* Locked rows are excluded from the group's bulk maths — they
                     are always on and a PUT for them would be a lie. */
                  const types = group.rows.map(([t]) => t).filter(t => !LOCKED_NOTIFICATION_TYPES.has(t))
                  /* Only the group being written is frozen — greying the whole
                     matrix for a 4-PUT bulk reads as a fault. */
                  const frozen = bulking.startsWith(`${group.label}:`)
                  return (
                  <React.Fragment key={group.label}>
                    <tr className="stx-mgroup">
                      <td>{group.label}</td>
                      {NOTIFICATION_CHANNELS.map(channel => {
                        const on = types.length > 0 && types.every(t => !!matrix[t]?.[channel])
                        const mixed = !on && types.some(t => !!matrix[t]?.[channel])
                        return (
                          <td key={channel}>
                            {types.length > 0 && (
                              <label className="stx-cell">
                                <input type="checkbox" className="stx-tick"
                                  checked={on}
                                  disabled={!!bulking}
                                  /* A partly-on group must not read as "off". `indeterminate` is
                                     DOM-only state (no attribute, so it goes on the node) and the
                                     shared .stx-tick styles nothing for it — hence the drawn dash. */
                                  ref={el => { if (el) el.indeterminate = mixed }}
                                  style={mixed ? MIXED_TICK : undefined}
                                  title={`Turn ${CHANNEL_LABELS[channel]} ${on ? 'off' : 'on'} for every row in ${group.label}`}
                                  aria-label={`All of ${group.label} — ${CHANNEL_LABELS[channel]}`}
                                  onChange={() => bulk(group, channel, !on)}/>
                              </label>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                    {group.rows.map(([type, label]) => {
                      const locked = LOCKED_NOTIFICATION_TYPES.has(type)
                      return (
                        <tr key={type}>
                          <td>{label}</td>
                          {NOTIFICATION_CHANNELS.map(channel => (
                            <td key={channel}
                              className={reverted[`${type}:${channel}`] ? 'is-reverted' : undefined}>
                              <label className="stx-cell">
                                <input type="checkbox" className="stx-tick"
                                  checked={locked ? true : !!matrix[type]?.[channel]}
                                  disabled={locked || frozen}
                                  title={locked ? 'Always delivered' : undefined}
                                  aria-label={`${label} — ${CHANNEL_LABELS[channel]}`}
                                  onChange={() => toggle(type, channel)}/>
                              </label>
                            </td>
                          ))}
                        </tr>
                      )
                    })}
                  </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="stx-mnote">
            A group heading turns a whole section on or off for one channel.
          </p>
          {groups.some(g => g.label === 'Other') && (
            <p className="stx-mnote">
              <b>Other</b> collects event types your account knows about that aren’t in a section
              above. Some of them are placeholders nothing sends yet.
            </p>
          )}
          <p className="stx-mnote">
            <b>Desktop</b> is the one column acted on today — by this browser, see below.{' '}
            <b>In-app</b> and <b>Push</b> are recorded on your account, but every notification
            still lands in your inbox and no push service is sending from this deployment.
          </p>
          <p className="stx-mnote">
            <b>Email</b> is decided today by the five switches on your email preferences page,
            not by this column — these ticks are saved, but the mail sender reads those instead.
          </p>
          <p className="stx-mnote">
            <b>SMS</b> needs a phone number on your account (<Link to="/settings/security#phone">add one in Security</Link>),
            and no text messages are sent from this deployment yet.
          </p>
          <SeeAlso to="/settings/emails">Email preferences — which emails you get</SeeAlso>

          <SubHead>Desktop alerts</SubHead>
          <p className="stx-sub">
            Raised by this browser while IKA is open, for the types ticked in the Desktop column.
            They stay quiet while you are looking at the app, and during quiet hours.
          </p>
          <ControlRow
            title="Show alerts on this device"
            desc={perm === 'denied'
              ? 'Blocked for this site. Unblock notifications from your browser’s address bar, then reload.'
              : perm === 'unsupported'
                ? 'This browser cannot show desktop notifications.'
                : 'Asked once per browser. Without it the Desktop column has nothing to deliver through.'}>
            {perm === 'granted' ? (
              <div className="flex gap-8">
                <span className="stx-chip ok"><Icon name="check"/>Allowed</span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={testDesktop}>Send a test</button>
              </div>
            ) : perm === 'denied' ? (
              <span className="stx-chip err"><Icon name="mute"/>Blocked</span>
            ) : perm === 'unsupported' ? (
              <span className="stx-chip plain">Not supported</span>
            ) : (
              <button type="button" className="btn btn-secondary btn-sm" onClick={askDesktop}>
                <Icon name="screen" className="xs"/>Allow desktop notifications
              </button>
            )}
          </ControlRow>
        </>
      )}
    </SetCard>
  )
}

/* ---------- quiet hours (DND) ---------- */

export function DndPanel() {
  const [dnd, setDnd] = React.useState(null)
  const [error, setError] = React.useState(false)
  const [tick, setTick] = React.useState(0)
  const [until, setUntil] = React.useState('')      // the "mute until…" picker, device-local
  const { statusOf, track } = useWriteStatus()
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
   *  so every write carries it explicitly. `key` addresses the row whose
   *  saving/saved/failed marker reports the write. */
  const apply = (patch, key) => {
    const prev = dnd
    if (!prev) return
    const body = { ...patch, enabled: 'enabled' in patch ? patch.enabled : !!prev.enabled }
    /* Typing in a time field fires several writes in a row, and the responses
       can land out of order — only the newest one is allowed to publish its
       server state or roll anything back. */
    const mySeq = ++writeSeq.current
    setDnd({ ...prev, ...body })
    track(key, api.settings.notifications.updateDnd(body)
      .then(res => {
        if (writeSeq.current !== mySeq) return          // a newer write owns the state
        if (res) setDnd(res)
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
        /* The row marker already says "Not saved"; only the two validation
           codes carry a reason the marker cannot. */
        if (e?.code === 'BAD_TIMEZONE') showToast('That timezone isn’t recognised', 'err')
        else if (e?.code === 'BAD_TIME') showToast('That time isn’t valid', 'err')
        throw e
      })).catch(() => {})
  }

  const zones = React.useMemo(() => {
    const cur = dnd?.timezone || ''
    let list
    if (typeof Intl.supportedValuesOf === 'function') list = Intl.supportedValuesOf('timeZone')
    else list = [cur, 'UTC', detectedZone(), 'Asia/Baghdad'].filter(Boolean)
    if (cur && !list.includes(cur)) list = [cur, ...list]
    return [...new Set(list)]
  }, [dnd?.timezone])

  if (error && dnd === null) {
    return (
      <SetCard id="dnd" icon="clock" title="Quiet hours">
        <ErrorState message="Could not load quiet hours" onRetry={() => setTick(t => t + 1)}/>
      </SetCard>
    )
  }
  if (dnd === null) return <SetCard id="dnd" icon="clock" title="Quiet hours"><Loader/></SetCard>

  const mask = dnd.daysMask || 0
  const everyDay = mask === 0
  /* The server's own default is UTC (NotificationSettingsService.getDnd), so an
     unset zone is UTC — not the browser's. Say so rather than showing a zone
     the server is not using. */
  const tz = dnd.timezone || 'UTC'
  const detected = detectedZone()
  /* muteUntil is wall-clock in the DND timezone — compare against the current
     wall-clock in that zone. Both sides are trimmed to the same 19-character
     'YYYY-MM-DDTHH:mm:ss' prefix (the wire carries a '.000Z' tail) so the
     lexicographic comparison is between like shapes. */
  const muteUntil = (dnd.muteUntil || '').slice(0, 19)
  const snoozed = !!muteUntil && muteUntil > wallClockIn(new Date(), tz).slice(0, 19)
  /* DndEvaluator returns false whenever either bound is null, so an "enabled"
     schedule with a missing time pauses precisely nothing. */
  const incomplete = !!dnd.enabled && (!dnd.startTime || !dnd.endTime)

  const toggleDay = (bit) => {
    const eff = mask === 0 ? 127 : mask       // 0 means every day
    let next = eff ^ bit
    if (next === 127) next = 0                // all seven back on → every day
    apply({ daysMask: next }, 'daysMask')
  }

  const toggleSchedule = () => {
    /* First enable with no window would persist an "on" that mutes nothing, so
       seed a conventional night window in the SAME write (the server needs
       `enabled` explicitly either way). */
    if (!dnd.enabled && !dnd.startTime && !dnd.endTime) {
      apply({ enabled: true, startTime: '22:00', endTime: '07:00' }, 'enabled')
    } else {
      apply({ enabled: !dnd.enabled }, 'enabled')
    }
  }

  const snooze = (h) => {
    const at = new Date()
    at.setTime(at.getTime() + h * 3_600_000)
    setUntil('')
    apply({ muteUntil: wallClockIn(at, tz) }, 'muteUntil')
  }
  /* The picker hands back a moment on the DEVICE's clock. The server stores
     wall clock in the DND zone, so the instant is converted rather than passed
     through — otherwise a user whose zone differs mutes the wrong hour. */
  const snoozeUntil = (localValue) => {
    setUntil(localValue)
    const at = new Date(localValue)
    if (Number.isNaN(at.getTime())) return
    apply({ muteUntil: wallClockIn(at, tz) }, 'muteUntil')
  }
  /* muteUntil:null would be SKIPPED by the patch semantics (only non-null
     fields apply), so clearing writes a past instant instead — the epoch is
     inert and reads as "not muted". */
  const clearSnooze = () => { setUntil(''); apply({ muteUntil: '1970-01-01T00:00:00.000Z' }, 'muteUntil') }

  return (
    <SetCard id="dnd" icon="clock" title="Quiet hours"
      sub="Stay unbothered on a schedule, or mute everything for a while.">
      {/* HONESTY: DndEvaluator has no caller in the backend, so the window this
          card writes is only ever read by lib/desktopNotify on this device. Say
          exactly how far it reaches rather than promising a quiet phone. */}
      <div className="stx-note info" style={{ marginBottom: 12 }}>
        <Icon name="info"/>
        <span>
          Quiet hours silence the desktop alerts this browser raises. Email and your in-app
          inbox aren’t paused by them, so nothing is missed while you’re muted — and the
          window is saved on your account, ready for the rest of your devices.
        </span>
      </div>
      <ToggleRow
        title="Pause alerts on a schedule"
        desc="Inside the window below, this browser stays silent."
        on={!!dnd.enabled}
        status={statusOf('enabled')}
        onToggle={toggleSchedule}/>
      {dnd.enabled && (
        <>
          {incomplete && (
            <div className="stx-note warn">
              <Icon name="info"/>
              <span>Set a start and an end time — until both are set, nothing is paused.</span>
            </div>
          )}
          <ControlRow title="Window" desc="Crossing midnight is fine — 22:00 to 07:00 works."
            status={statusOf('window')}>
            <div className="flex gap-8">
              <Field label="Start">
                <input type="time" className="field" value={(dnd.startTime || '').slice(0, 5)}
                  onChange={e => e.target.value && apply({ startTime: e.target.value }, 'window')}/>
              </Field>
              <Field label="End">
                <input type="time" className="field" value={(dnd.endTime || '').slice(0, 5)}
                  onChange={e => e.target.value && apply({ endTime: e.target.value }, 'window')}/>
              </Field>
            </div>
          </ControlRow>
          <ControlRow title="Days" desc={everyDay ? 'Every day.' : 'Only on the days you pick.'}
            status={statusOf('daysMask')}>
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
          </ControlRow>
        </>
      )}
      {/* Outside the schedule branch on purpose: a mute is measured in this zone
          too, so someone who only ever snoozes still has to be able to fix it. */}
      <ControlRow title="Timezone" desc={`Quiet hours and mutes are measured in ${tz}.`}
        status={statusOf('timezone')}>
        <div className="flex gap-8" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          {detected && detected !== tz && (
            <button type="button" className="btn btn-secondary btn-sm"
              onClick={() => apply({ timezone: detected }, 'timezone')}>Use {detected}</button>
          )}
          <select className="field" style={{ width: 200 }} aria-label="Quiet hours timezone" value={dnd.timezone || ''}
            onChange={e => e.target.value && apply({ timezone: e.target.value }, 'timezone')}>
            {!dnd.timezone && <option value="">UTC (not set)</option>}
            {zones.map(z => <option key={z} value={z}>{z}</option>)}
          </select>
        </div>
      </ControlRow>
      <ControlRow title="Mute everything for" desc="Silences alerts straight away, schedule or not."
        status={statusOf('muteUntil')}>
        <div className="flex gap-8" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          {[1, 8, 24].map(h => (
            <button key={h} type="button" className="btn btn-secondary btn-sm" onClick={() => snooze(h)}>{h}h</button>
          ))}
          <input type="datetime-local" className="field" style={{ width: 200 }}
            aria-label="Mute until a specific time" value={until}
            min={wallClockIn(new Date(), detected).slice(0, 16)}
            onChange={e => snoozeUntil(e.target.value)}/>
        </div>
      </ControlRow>
      {snoozed && (
        <div className="stx-note info">
          <Icon name="mute"/>
          <span>
            Muted until {fmtWall(dnd.muteUntil)} ({tz}).{' '}
            <button type="button" className="btn btn-ghost btn-sm" onClick={clearSnooze}>Clear</button>
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

/* The row id of the token THIS browser registered. The server's own hygiene
   (PushTokenService.deleteForSession) has no caller, so the client is the only
   thing that can retire the token when the session ends — the sign-out path
   reads this key. */
const PUSH_TOKEN_KEY = 'ika.pushTokenId'
const rememberToken = (id) => { try { localStorage.setItem(PUSH_TOKEN_KEY, id || '') } catch { /* private mode */ } }
const forgetToken = (id) => {
  try { if (!id || localStorage.getItem(PUSH_TOKEN_KEY) === id) localStorage.removeItem(PUSH_TOKEN_KEY) }
  catch { /* private mode */ }
}

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
      if (perm === 'denied') { showToast('Notifications are blocked in your browser settings', 'err'); return }
      if (perm !== 'granted') return                          // dismissed — nothing to say
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 3000) }),
      ])
      if (!reg) { showToast('Push needs a service worker on this site', 'err'); return }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_KEY),
      })
      /* provider names the TRANSPORT, platform the device — sending 'WEB' for
         both left the two columns meaningless. The server stores provider
         verbatim (PushTokenService.register validates nothing), so 'WEBPUSH'
         is safe and finally distinguishes a browser subscription from FCM. */
      const row = await api.settings.notifications.registerPushToken({
        provider: 'WEBPUSH', token: JSON.stringify(sub), platform: 'WEB', sid: currentSid(),
      })
      rememberToken(row?.id)
      if (!aliveRef.current) return
      setTick(t => t + 1)
      showToast('Push enabled on this device')
    } catch {
      showToast('Could not enable push', 'err')
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
      forgetToken(t.id)
      showToast('Device removed')
    } catch {
      setList(prev)
      showToast('Could not remove — reverted', 'err')
    }
  }

  return (
    <SetCard id="push" icon="phone" title="Push devices"
      sub="Devices registered for push delivery. Remove any you no longer use.">
      {support === 'unsupported' ? (
        <div className="stx-note info" style={{ marginBottom: 12 }}>
          <Icon name="info"/>
          <span>This browser does not support push notifications. In-app and email notifications still work.</span>
        </div>
      ) : support === 'unconfigured' ? (
        <div className="stx-note info" style={{ marginBottom: 12 }}>
          <Icon name="info"/>
          <span>
            Push delivery is not configured for this build, so no device can register here yet.
            Desktop alerts above still work while IKA is open, and the in-app inbox is unaffected.
          </span>
        </div>
      ) : (
        <>
          {/* Reachable only once a VAPID key is baked in — and even then the only
              PushSender bean is NoOpPushSender, so a registration is a record and
              not a delivery. Don't let the button imply otherwise. */}
          <div className="stx-note info" style={{ marginBottom: 12 }}>
            <Icon name="info"/>
            <span>
              Registering records this device on your account. Nothing is sending push messages
              from this deployment yet — desktop alerts above are the working path for now.
            </span>
          </div>
          <div className="flex gap-8" style={{ marginBottom: 12 }}>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={enable}>
              <Icon name="bell" className="xs"/>{busy ? 'Enabling…' : 'Enable push on this device'}
            </button>
          </div>
        </>
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
        /* Not "apps register here when they enable push" — directly under the
           note saying nothing can register, that reads as a contradiction. */
        <EmptyState icon="phone" title="No push devices"
          sub="Nothing has registered for push on this account."/>
      )}
    </SetCard>
  )
}
