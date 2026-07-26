/* =========================================================
   Admins, rights, and join requests
   ---------------------------------------------------------
   The rights model has one trap and this file exists mostly to
   contain it: on the WIRE, every flag is nullable and **null
   means true**. A partial body can therefore only ever *remove*
   capability, and a bare `PUT` grants FULL rights. So the editor
   always transmits every flag explicitly (`rightsTo` in
   api/channels.js) — an unchecked box has to travel as `false`,
   not as an omission that the server reads back as "yes".

   Two more rules the UI has to respect rather than discover:
     · The OWNER is not editable. `ChannelRights.can` short-
       circuits to allowed for them, so an editor showing their
       toggles would be showing controls that do nothing —
       the row says "full rights, always" instead.
     · Promotion only works on an ACTIVE SUBSCRIBER. Picking
       from the roster (rather than a free-text id field) is what
       makes the 400 unreachable.
   ========================================================= */
import React from 'react'
import { Icon, Avatar, showToast } from '../ui.jsx'
import { Loader, ErrorState } from '../states.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { api } from '../../api/index.js'
import { RIGHT_KEYS, RIGHT_LABELS } from '../../api/channels.js'
import { chatError } from '../chat/chatErrors.js'

/* ---------------------------------------------------------
   The rights editor for one admin.
   --------------------------------------------------------- */
function RightsEditor({ channel, admin, onSaved, onClose }) {
  const [flags, setFlags] = React.useState(() => ({ ...admin.rights }))
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const dirty = RIGHT_KEYS.some(k => flags[k] !== admin.rights[k])
    || (flags.customTitle || '') !== (admin.customTitle || '')

  const save = async () => {
    setBusy(true)
    try {
      const next = await api.channels.admins.set(channel.id, admin.userId, flags)
      showToast(`Rights updated for ${next.fullName}`)
      onSaved?.(next)
    } catch (e) {
      showToast(chatError(e, 'Could not update the rights'))
    } finally { setBusy(false) }
  }

  const allOn = RIGHT_KEYS.every(k => flags[k] !== false)

  return (
    <div className="ch-modal-overlay" role="dialog" aria-modal="true"
      aria-label={`Rights for ${admin.fullName}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose?.() }}>
      <div className="ch-modal cn-modal">
        <div className="ch-modal-head">
          <h3><Icon name="shield" className="sm"/>{admin.fullName}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close" disabled={busy}>
            <Icon name="close" className="sm"/>
          </button>
        </div>

        <div className="ch-modal-body cn-modal-body single">
          <div className="cn-form">
            <label className="cn-field">
              <span>Rank <small>optional, shown next to their name</small></span>
              <input className="field" maxLength={32} value={flags.customTitle || ''} dir="auto"
                onChange={e => setFlags(f => ({ ...f, customTitle: e.target.value }))}
                placeholder="Editor"/>
            </label>

            <div className="ca-rights-head">
              <div className="ci-label">What they can do</div>
              <button type="button" className="cn-btn"
                onClick={() => setFlags(f => {
                  const next = { ...f }
                  for (const k of RIGHT_KEYS) next[k] = !allOn
                  return next
                })}>
                {allOn ? 'Clear all' : 'Grant all'}
              </button>
            </div>

            {RIGHT_KEYS.map(k => {
              const [label, hint] = RIGHT_LABELS[k]
              const on = flags[k] !== false
              return (
                <div className="ci-row" key={k}>
                  <div className="ci-row-body">
                    <div className="ci-row-title">{label}</div>
                    <div className="ci-row-sub">{hint}</div>
                  </div>
                  <button type="button" className={'ci-switch' + (on ? ' on' : '')}
                    role="switch" aria-checked={on} aria-label={label}
                    onClick={() => setFlags(f => ({ ...f, [k]: !on }))}/>
                </div>
              )
            })}
          </div>
        </div>

        <div className="ch-modal-foot">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" disabled={!dirty || busy} onClick={save}>
            {busy ? 'Saving…' : 'Save rights'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------
   Pick a subscriber to promote. Reads the ordinary member
   roster (a channel is a conversation), minus anyone who is
   already an admin — promoting an admin is an edit, and that
   lives on their own row.
   --------------------------------------------------------- */
function PromotePicker({ channel, existing, onPromoted, onClose }) {
  const [rows, setRows] = React.useState([])
  const [state, setState] = React.useState('loading')
  const [q, setQ] = React.useState('')
  const [busyId, setBusyId] = React.useState(null)

  React.useEffect(() => {
    let alive = true
    api.chat.members.list(channel.id, { page: 0, size: 200 })
      .then(res => {
        if (!alive) return
        const taken = new Set(existing.map(a => String(a.userId)))
        setRows(res.items.filter(m => m.status === 'ACTIVE' && !taken.has(String(m.userId))))
        setState('ready')
      })
      .catch(() => { if (alive) setState('error') })
    return () => { alive = false }
  }, [channel.id, existing])

  const shown = React.useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter(m => m.fullName.toLowerCase().includes(needle) || m.username.toLowerCase().includes(needle))
  }, [rows, q])

  const promote = async (m) => {
    setBusyId(m.userId)
    try {
      // A bare PUT is the documented "full rights" shortcut; the new admin's
      // rights are then narrowed on their own row.
      const admin = await api.channels.admins.promote(channel.id, m.userId)
      showToast(`${admin.fullName} is now an admin`)
      onPromoted?.(admin)
    } catch (e) {
      showToast(chatError(e, 'Could not promote them'))
    } finally { setBusyId(null) }
  }

  return (
    <div className="ch-modal-overlay" role="dialog" aria-modal="true" aria-label="Add an admin"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="ch-modal cn-modal">
        <div className="ch-modal-head">
          <h3><Icon name="crown" className="sm"/>Add an admin</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" className="sm"/></button>
        </div>

        <div className="ch-modal-body cn-modal-body single">
          <div className="ch-list-search cn-search">
            <Icon name="search" className="sm"/>
            <input className="field" value={q} onChange={e => setQ(e.target.value)} dir="auto"
              placeholder="Search subscribers…" aria-label="Search subscribers"/>
          </div>

          {state === 'loading' && <Loader label="Loading subscribers…"/>}
          {state === 'error' && <ErrorState message="The subscriber list could not be loaded."/>}

          {state === 'ready' && shown.length === 0 && (
            <p className="cst-empty">
              {rows.length === 0
                ? 'Every active subscriber is already an admin.'
                : 'Nobody matches that.'}
            </p>
          )}

          {state === 'ready' && shown.map(m => (
            <div className="ca-row" key={m.userId}>
              <Avatar size={34} src={m._author?.profileImage} initials={m._author?.initials} color={m._author?.avc}/>
              <div className="ca-row-body">
                <div className="ca-row-t"><bdi>{m.fullName}</bdi></div>
                <div className="ca-row-s"><bdi dir="ltr">@{m.handle}</bdi></div>
              </div>
              <button className="cn-btn primary" disabled={busyId === m.userId} onClick={() => promote(m)}>
                {busyId === m.userId ? 'Adding…' : 'Make admin'}
              </button>
            </div>
          ))}
        </div>

        <div className="ch-modal-foot">
          <button className="btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------
   The admin list.
   --------------------------------------------------------- */
export function ChannelAdmins({ channel, myId }) {
  const [rows, setRows] = React.useState([])
  const [state, setState] = React.useState('loading')
  const [editing, setEditing] = React.useState(null)
  const [adding, setAdding] = React.useState(false)

  const load = React.useCallback(async () => {
    setState('loading')
    try { setRows(await api.channels.admins.list(channel.id)); setState('ready') }
    catch { setState('error') }
  }, [channel.id])

  React.useEffect(() => { load() }, [load])

  /* Whether *I* may edit this list at all. The owner always may; an admin
     needs `canAddAdmins`. Reading the answer off my own row is what keeps this
     honest — there is no second source for it. */
  const me = rows.find(a => String(a.userId) === String(myId))
  const canEdit = !!me && (me.isOwner || me.rights.canAddAdmins !== false)

  const demote = async (a) => {
    const ok = await uiConfirm({
      title: `Remove ${a.fullName} as admin?`,
      message: 'They stay subscribed to the channel, but lose every admin right.',
      confirmLabel: 'Remove', danger: true, icon: 'userminus',
    })
    if (!ok) return
    try {
      await api.channels.admins.demote(channel.id, a.userId)
      setRows(prev => prev.filter(x => String(x.userId) !== String(a.userId)))
      showToast('Admin removed')
    } catch (e) { showToast(chatError(e, 'Could not remove them')) }
  }

  const transfer = async (a) => {
    const ok = await uiConfirm({
      title: `Make ${a.fullName} the owner?`,
      message: 'You become an ordinary admin and cannot undo this yourself. Only the new owner can hand it back.',
      confirmLabel: 'Transfer ownership', danger: true, icon: 'crown',
    })
    if (!ok) return
    try {
      await api.chat.members.transferOwner(channel.id, a.userId)
      showToast('Ownership transferred')
      load()
    } catch (e) { showToast(chatError(e, 'Could not transfer ownership')) }
  }

  if (state === 'loading') return <Loader label="Loading admins…"/>
  if (state === 'error') return <ErrorState message="The admin list could not be loaded." onRetry={load}/>

  return (
    <div className="ca">
      {/* the orienting sentence lives in the console's pane header now */}
      {canEdit && (
        <div className="ca-bar">
          <button className="cn-btn primary" onClick={() => setAdding(true)}>
            <Icon name="compose" className="xs"/>Add admin
          </button>
        </div>
      )}

      {rows.map(a => {
        const granted = RIGHT_KEYS.filter(k => a.rights[k] !== false)
        const isMe = String(a.userId) === String(myId)
        return (
          <div className={'ca-row' + (a.isOwner ? ' owner' : '')} key={a.userId}>
            <Avatar size={38} src={a._author?.profileImage} initials={a._author?.initials} color={a._author?.avc}/>
            <div className="ca-row-body">
              <div className="ca-row-t">
                <bdi>{a.fullName}</bdi>
                {a.isOwner && <span className="cn-tag gold"><Icon name="crown" className="xs"/>Owner</span>}
                {a.customTitle && <span className="cn-tag">{a.customTitle}</span>}
                {isMe && <span className="ca-you">you</span>}
              </div>
              <div className="ca-row-s">
                <bdi dir="ltr">@{a.handle}</bdi>
                {a.isOwner
                  ? ' · full rights, always'
                  : ` · ${granted.length === RIGHT_KEYS.length ? 'full rights' : `${granted.length} of ${RIGHT_KEYS.length} rights`}`}
              </div>
            </div>

            {/* The owner has nothing to edit — their rights are unconditional. */}
            {canEdit && !a.isOwner && (
              <div className="ca-row-acts">
                <button className="icon-btn" title="Edit rights" aria-label={`Edit rights for ${a.fullName}`}
                  onClick={() => setEditing(a)}>
                  <Icon name="settings" className="sm"/>
                </button>
                {me?.isOwner && (
                  <button className="icon-btn" title="Transfer ownership" aria-label={`Make ${a.fullName} the owner`}
                    onClick={() => transfer(a)}>
                    <Icon name="crown" className="sm"/>
                  </button>
                )}
                <button className="icon-btn danger" title="Remove admin" aria-label={`Remove ${a.fullName} as admin`}
                  onClick={() => demote(a)}>
                  <Icon name="userminus" className="sm"/>
                </button>
              </div>
            )}
          </div>
        )
      })}

      {editing && (
        <RightsEditor
          channel={channel} admin={editing}
          onClose={() => setEditing(null)}
          onSaved={(next) => {
            setRows(prev => prev.map(x => (String(x.userId) === String(next.userId) ? next : x)))
            setEditing(null)
          }}
        />
      )}

      {adding && (
        <PromotePicker
          channel={channel} existing={rows}
          onClose={() => setAdding(false)}
          onPromoted={(a) => { setRows(prev => [...prev, a]); setAdding(false) }}
        />
      )}
    </div>
  )
}

/* ---------------------------------------------------------
   Join requests. Filed by a `joinByRequest` subscribe or by an
   approval-gated invite link; each new one notifies every admin
   and fires `channel.join_request` on the live stream, so this
   list stays current without polling.
   --------------------------------------------------------- */
export function ChannelRequests({ channel, subscribe }) {
  const [status, setStatus] = React.useState('PENDING')
  const [rows, setRows] = React.useState([])
  const [state, setState] = React.useState('loading')
  const [busyId, setBusyId] = React.useState(null)

  const [err, setErr] = React.useState(null)
  const load = React.useCallback(async (silent) => {
    // A live re-load keeps the rows on screen: wiping the list an admin is
    // mid-click on made Approve land on the wrong person after the reflow.
    if (!silent) setState('loading')
    try {
      const res = await api.channels.requests.list(channel.id, { status })
      setRows(res.items); setErr(null); setState('ready')
    } catch (e) { setErr(e); setState('error') }
  }, [channel.id, status])

  React.useEffect(() => { load() }, [load])

  /* A request filed while this panel is open arrives on the stream. Only the
     PENDING view can gain a row that way, so the other tabs ignore it rather
     than prepending a request into a list of decided ones. */
  React.useEffect(() => {
    if (!subscribe) return undefined
    return subscribe((evt) => {
      if (evt?.type !== 'channel.join_request') return
      if (String(evt.conversationId) !== String(channel.id)) return
      if (status !== 'PENDING') return
      load(true)
    })
  }, [subscribe, channel.id, status, load])

  const decide = async (r, approve) => {
    setBusyId(r.userId)
    try {
      const next = approve
        ? await api.channels.requests.approve(channel.id, r.userId)
        : await api.channels.requests.reject(channel.id, r.userId)
      // The row leaves this list the moment it is decided — it belongs to the
      // Approved/Rejected tab now.
      setRows(prev => prev.filter(x => String(x.userId) !== String(r.userId)))
      showToast(approve ? `${next.fullName} is in` : 'Request rejected')
    } catch (e) {
      showToast(chatError(e, 'Could not record that decision'))
    } finally { setBusyId(null) }
  }

  return (
    <div className="ca">
      <div className="cn-filters" role="group" aria-label="Filter join requests">
        {[['PENDING', 'Waiting'], ['APPROVED', 'Approved'], ['REJECTED', 'Rejected']].map(([k, label]) => (
          <button key={k} className={'cn-chip' + (status === k ? ' on' : '')}
            aria-pressed={status === k} onClick={() => setStatus(k)}>{label}</button>
        ))}
      </div>

      {state === 'loading' && <Loader label="Loading requests…"/>}
      {state === 'error' && (err?.status === 403
        ? <ErrorState message="Only admins who can approve join requests may read this list."/>
        : <ErrorState message="The requests could not be loaded." onRetry={() => load()}/>
      )}

      {state === 'ready' && rows.length === 0 && (
        <p className="cst-empty">
          {status === 'PENDING'
            ? channel.settings?.joinByRequest
              ? 'Nobody is waiting. New requests appear here the moment they are filed.'
              : 'Nobody is waiting — this channel lets people subscribe directly. Turn on “Approve new subscribers” in Settings to review them first.'
            : `No ${status.toLowerCase()} requests.`}
        </p>
      )}

      {state === 'ready' && rows.map(r => (
        <div className="ca-row" key={r.id || r.userId}>
          <Avatar size={38} src={r._author?.profileImage} initials={r._author?.initials} color={r._author?.avc}/>
          <div className="ca-row-body">
            <div className="ca-row-t"><bdi>{r.fullName}</bdi></div>
            <div className="ca-row-s"><bdi dir="ltr">@{r.handle}</bdi> · requested {r.time} ago</div>
          </div>
          {r.pending ? (
            <div className="ca-row-acts">
              <button className="cn-btn primary" disabled={busyId === r.userId} onClick={() => decide(r, true)}>
                Approve
              </button>
              <button className="cn-btn" disabled={busyId === r.userId} onClick={() => decide(r, false)}>
                Reject
              </button>
            </div>
          ) : (
            <span className={'cn-tag' + (r.status === 'APPROVED' ? ' gold' : '')}>
              {r.status === 'APPROVED' ? 'Approved' : 'Rejected'}
            </span>
          )}
        </div>
      ))}

      {status === 'REJECTED' && !!rows.length && (
        <p className="cst-note">A rejected person may ask again — their request comes back here as waiting.</p>
      )}
    </div>
  )
}
