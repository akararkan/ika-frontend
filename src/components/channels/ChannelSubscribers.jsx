/* =========================================================
   Subscribers — the channel's member roster, managed
   ---------------------------------------------------------
   A channel is a conversation, so the roster is the ordinary
   `GET /conversations/{id}/members` Spring page and the member
   actions are the shared endpoints groups already use:

     · add      POST   /conversations/{id}/members   (canInviteUsers,
                join-source ADDED_BY_ADMIN)
     · kick     DELETE /conversations/{id}/members/{userId}
     · restrict POST   /conversations/{id}/members/{userId}/restrict

   Rules the UI respects rather than discovers:
     · The OWNER row is untouchable, and admin rows are managed
       from the Admins tab — kicking an admin answers
       CANNOT_ACT_ON_ADMIN, so the buttons simply are not there.
     · `hiddenSubscribers` never bites here: the console is
       admins-only and the 403 is for non-admins. It is still
       handled, because rights can be edited under our feet.
     · Restriction on a broadcast channel governs the SHARED
       surfaces (reactions, comments in the discussion group) —
       ordinary subscribers cannot post to the channel anyway,
       and the row copy says so instead of implying a gag.
   ========================================================= */
import React from 'react'
import { Icon, Avatar, showToast } from '../ui.jsx'
import { Loader, ErrorState } from '../states.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { api } from '../../api/index.js'
import { chatError } from '../chat/chatErrors.js'
import { dateLabel, plural } from './channelArt.js'

const PAGE_SIZE = 50
const MAX_ADD_PER_CALL = 100   // same server cap NewChatModal honours

/* ---------------------------------------------------------
   Add subscribers — search the whole directory, pick many,
   one POST. People added this way join immediately
   (join-source ADDED_BY_ADMIN), no request round.
   --------------------------------------------------------- */
function AddSubscribers({ channel, existingIds, onAdded, onClose }) {
  const [q, setQ] = React.useState('')
  const [results, setResults] = React.useState([])
  const [searching, setSearching] = React.useState(false)
  const [picked, setPicked] = React.useState([])
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  // Debounced directory search; an empty box shows nothing rather than a
  // suggestion feed — "add to my channel" starts from a name, not from browsing.
  React.useEffect(() => {
    const needle = q.trim()
    if (!needle) { setResults([]); setSearching(false); return undefined }
    let alive = true
    setSearching(true)
    const t = setTimeout(() => {
      api.users.searchList(needle, { size: 20 })
        .then(rows => { if (alive) setResults(rows || []) })
        .catch(() => { if (alive) setResults([]) })
        .finally(() => { if (alive) setSearching(false) })
    }, 300)
    return () => { alive = false; clearTimeout(t) }
  }, [q])

  const isIn = (id) => existingIds.has(String(id))
  const isPicked = (id) => picked.some(p => String(p.id) === String(id))

  const toggle = (u) => {
    if (isIn(u.id)) return
    setPicked(prev => isPicked(u.id)
      ? prev.filter(p => String(p.id) !== String(u.id))
      : (prev.length >= MAX_ADD_PER_CALL
          ? (showToast(`You can add up to ${MAX_ADD_PER_CALL} people at a time.`), prev)
          : [...prev, u]))
  }

  const submit = async () => {
    if (!picked.length || busy) return
    setBusy(true)
    try {
      await api.chat.members.add(channel.id, picked.map(p => p.id))
      showToast(`Added ${plural(picked.length, 'subscriber')}`)
      onAdded?.()
    } catch (e) {
      showToast(chatError(e, 'Could not add them'))
      setBusy(false)
    }
  }

  return (
    <div className="ch-modal-overlay" role="dialog" aria-modal="true" aria-label="Add subscribers"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose?.() }}>
      <div className="ch-modal cn-modal">
        <div className="ch-modal-head">
          <h3><Icon name="follow" className="sm"/>Add subscribers</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close" disabled={busy}>
            <Icon name="close" className="sm"/>
          </button>
        </div>

        <div className="ch-modal-body cn-modal-body single">
          <div className="ch-list-search cn-search">
            <Icon name="search" className="sm"/>
            <input className="field" value={q} onChange={e => setQ(e.target.value)} dir="auto"
              placeholder="Search people…" aria-label="Search people" autoFocus/>
          </div>

          {searching && <Loader label="Searching…"/>}

          {!searching && !!q.trim() && results.length === 0 && (
            <p className="cst-empty">Nobody matches that.</p>
          )}
          {!searching && !q.trim() && picked.length === 0 && (
            <p className="cst-empty">
              Search by name or @username. People you add are subscribed
              immediately — no request, no invite link.
            </p>
          )}

          {results.map(u => {
            const already = isIn(u.id)
            const on = isPicked(u.id)
            return (
              <button type="button" key={u.id} disabled={already}
                className={'ca-row ca-pick' + (on ? ' on' : '')}
                aria-pressed={on} onClick={() => toggle(u)}>
                <Avatar size={34} src={u.profileImage} initials={u.initials} color={u.avc}/>
                <div className="ca-row-body">
                  <div className="ca-row-t"><bdi>{u.full}</bdi></div>
                  <div className="ca-row-s"><bdi dir="ltr">@{u.handle}</bdi></div>
                </div>
                {already
                  ? <span className="cn-tag">Subscribed</span>
                  : <Icon name={on ? 'check' : 'compose'} className="sm"/>}
              </button>
            )
          })}
        </div>

        <div className="ch-modal-foot">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" disabled={!picked.length || busy} onClick={submit}>
            {busy ? 'Adding…' : picked.length ? `Add ${picked.length}` : 'Add'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------
   The roster.
   --------------------------------------------------------- */
export function ChannelSubscribers({ channel, myId, me, subscribe }) {
  const [rows, setRows] = React.useState([])
  const [total, setTotal] = React.useState(null)
  const [page, setPage] = React.useState(0)
  const [hasMore, setHasMore] = React.useState(false)
  const [state, setState] = React.useState('loading')
  const [err, setErr] = React.useState(null)
  const [more, setMore] = React.useState(false)
  const [q, setQ] = React.useState('')
  const [busyId, setBusyId] = React.useState(null)
  const [adding, setAdding] = React.useState(false)

  const canInvite = !!me && (me.isOwner || me.rights?.canInviteUsers !== false)

  const load = React.useCallback(async (silent) => {
    // Silent reloads keep the rows on screen — wiping a list an admin is
    // mid-click on makes the action land on the wrong person after the reflow.
    if (!silent) setState('loading')
    try {
      const res = await api.chat.members.list(channel.id, { page: 0, size: PAGE_SIZE })
      setRows(res.items); setTotal(res.total); setHasMore(res.hasMore); setPage(0)
      setErr(null); setState('ready')
    } catch (e) { setErr(e); setState('error') }
  }, [channel.id])

  React.useEffect(() => { load() }, [load])

  const loadMore = async () => {
    if (more || !hasMore) return
    setMore(true)
    try {
      const res = await api.chat.members.list(channel.id, { page: page + 1, size: PAGE_SIZE })
      setRows(prev => {
        const seen = new Set(prev.map(m => String(m.userId)))
        return [...prev, ...res.items.filter(m => !seen.has(String(m.userId)))]
      })
      setTotal(res.total); setHasMore(res.hasMore); setPage(p => p + 1)
    } catch (e) { showToast(chatError(e, 'Could not load more')) }
    finally { setMore(false) }
  }

  /* Membership moves under this panel all the time (subscribes, approvals,
     invite redemptions) and every one of them rides the stream as
     `member.changed` — so the roster follows along without polling. */
  React.useEffect(() => {
    if (!subscribe) return undefined
    return subscribe((evt) => {
      if (evt?.type !== 'member.changed') return
      if (String(evt.conversationId) !== String(channel.id)) return
      load(true)
    })
  }, [subscribe, channel.id, load])

  const shown = React.useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter(m => m.fullName.toLowerCase().includes(needle)
      || m.username.toLowerCase().includes(needle))
  }, [rows, q])

  const kick = async (m) => {
    const ok = await uiConfirm({
      title: `Remove ${m.fullName}?`,
      message: channel.publicChannel
        ? 'They are unsubscribed immediately. A public channel can be re-joined from discovery, so this is not a ban.'
        : 'They are unsubscribed immediately and need a new invite to come back.',
      confirmLabel: 'Remove', danger: true, icon: 'userminus',
    })
    if (!ok) return
    setBusyId(m.userId)
    try {
      await api.chat.members.remove(channel.id, m.userId)
      setRows(prev => prev.filter(x => String(x.userId) !== String(m.userId)))
      setTotal(t => (t == null ? t : Math.max(0, t - 1)))
      showToast('Subscriber removed')
    } catch (e) { showToast(chatError(e, 'Could not remove them')) }
    finally { setBusyId(null) }
  }

  const setRestricted = async (m, restricted) => {
    if (restricted) {
      const ok = await uiConfirm({
        title: `Restrict ${m.fullName}?`,
        message: 'They stay subscribed and keep reading, but lose the interactive surfaces — reactions and the comment thread.',
        confirmLabel: 'Restrict', danger: true, icon: 'block',
      })
      if (!ok) return
    }
    setBusyId(m.userId)
    try {
      await api.chat.members.restrict(channel.id, m.userId, restricted)
      setRows(prev => prev.map(x => (String(x.userId) === String(m.userId)
        ? { ...x, status: restricted ? 'RESTRICTED' : 'ACTIVE' } : x)))
      showToast(restricted ? 'Restricted' : 'Restriction lifted')
    } catch (e) { showToast(chatError(e, 'Could not change that')) }
    finally { setBusyId(null) }
  }

  if (state === 'loading') return <Loader label="Loading subscribers…"/>
  if (state === 'error') {
    return err?.status === 403
      ? <ErrorState message="This channel hides its subscriber list, and your rights no longer include seeing it."/>
      : <ErrorState message="The subscriber list could not be loaded." onRetry={() => load()}/>
  }

  const existingIds = new Set(rows.map(m => String(m.userId)))

  return (
    <div className="ca">
      <div className="ca-bar">
        <div className="ch-list-search cn-search ca-bar-search">
          <Icon name="search" className="sm"/>
          <input className="field" value={q} onChange={e => setQ(e.target.value)} dir="auto"
            placeholder={total != null ? `Search ${plural(total, 'subscriber')}…` : 'Search subscribers…'}
            aria-label="Search subscribers"/>
        </div>
        {canInvite && (
          <button className="cn-btn primary" onClick={() => setAdding(true)}>
            <Icon name="follow" className="xs"/>Add people
          </button>
        )}
      </div>

      {channel.settings?.hiddenSubscribers && (
        <p className="cst-note">
          The subscriber list is hidden — only the channel’s admins can see these
          names. The count stays public.
        </p>
      )}

      {shown.length === 0 && (
        <p className="cst-empty">
          {rows.length === 0 ? 'Nobody is subscribed yet.' : 'Nobody matches that.'}
        </p>
      )}

      {shown.map(m => {
        const isMe = String(m.userId) === String(myId)
        const staff = m.role === 'OWNER' || m.role === 'ADMIN'
        const restricted = m.status === 'RESTRICTED'
        return (
          <div className={'ca-row' + (m.role === 'OWNER' ? ' owner' : '')} key={m.userId}>
            <Avatar size={38} src={m._author?.profileImage} initials={m._author?.initials} color={m._author?.avc}/>
            <div className="ca-row-body">
              <div className="ca-row-t">
                <bdi>{m.fullName}</bdi>
                {m.role === 'OWNER' && <span className="cn-tag gold"><Icon name="crown" className="xs"/>Owner</span>}
                {m.role === 'ADMIN' && <span className="cn-tag">Admin</span>}
                {restricted && <span className="cn-tag danger">Restricted</span>}
                {isMe && <span className="ca-you">you</span>}
              </div>
              <div className="ca-row-s">
                <bdi dir="ltr">@{m.handle}</bdi>
                {m.joinedAt ? ` · joined ${dateLabel(m.joinedAt)}` : ''}
              </div>
            </div>

            {/* Admin rows are managed from the Admins tab — the endpoints refuse
                to act on them (CANNOT_ACT_ON_ADMIN), so no dead buttons here. */}
            {!staff && !isMe && (
              <div className="ca-row-acts">
                <button className={'icon-btn' + (restricted ? '' : ' danger')} disabled={busyId === m.userId}
                  title={restricted ? 'Lift the restriction' : 'Restrict'}
                  aria-label={restricted ? `Lift the restriction on ${m.fullName}` : `Restrict ${m.fullName}`}
                  onClick={() => setRestricted(m, !restricted)}>
                  <Icon name={restricted ? 'check' : 'block'} className="sm"/>
                </button>
                <button className="icon-btn danger" disabled={busyId === m.userId}
                  title="Remove subscriber" aria-label={`Remove ${m.fullName}`}
                  onClick={() => kick(m)}>
                  <Icon name="userminus" className="sm"/>
                </button>
              </div>
            )}
          </div>
        )
      })}

      {hasMore && !q.trim() && (
        <button className="cn-btn ca-more" disabled={more} onClick={loadMore}>
          {more ? 'Loading…' : `Show more (${rows.length}${total != null ? ` of ${total}` : ''})`}
        </button>
      )}
      {/* The search box only filters what is loaded; say so once paging starts. */}
      {hasMore && !!q.trim() && (
        <p className="cst-note">Searching the {rows.length} loaded so far — show more to widen it.</p>
      )}

      {adding && (
        <AddSubscribers
          channel={channel} existingIds={existingIds}
          onClose={() => setAdding(false)}
          onAdded={() => { setAdding(false); load(true) }}
        />
      )}
    </div>
  )
}

export default ChannelSubscribers
