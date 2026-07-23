/* =========================================================
   ChannelsPage — /channels
   ---------------------------------------------------------
   Telegram-style broadcast channels: admins publish, everyone
   else subscribes and reads.

   The single fact that shapes this whole page: a channel IS a
   conversation. `ChannelResponse.id` is the conversationId, so
   reading and posting go through the ordinary thread at
   /chat/<id> with the ordinary message endpoints — there is no
   channel timeline, no channel composer, no second message
   model. This page therefore only does the three things the
   conversation surface cannot: create, discover, subscribe.

   Subscription state comes back on every ChannelResponse, and
   both writes are idempotent, so the toggle is safe to
   double-fire. A public channel's full history is visible to a
   brand-new subscriber, which is why "Open" is offered before
   "Subscribe" rather than after.

   Two sources, one page — and they are not interchangeable:
     · DISCOVERY (`/channels/discover`) returns PUBLIC channels
       only, subscribed or not. It is the grid.
     · MY channels come from the inbox (`conversations`, where
       `isChannel` is true). That is the only place a PRIVATE
       channel I belong to appears at all, and the only place
       unread state exists. It is the rail at the top.
   Merging them into one list would either hide private channels
   or invent an unread count for a channel nobody has joined.
   ========================================================= */
import React from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Icon, showToast } from '../components/ui.jsx'
import { EmptyState, ErrorState } from '../components/states.jsx'
import { useChat } from '../context/ChatContext.jsx'
import { api } from '../api/index.js'
import { chatError } from '../components/chat/chatErrors.js'

const HANDLE_RE = /^[a-z0-9_]{3,32}$/

const FILTERS = [
  ['all', 'All'],
  ['subscribed', 'Subscribed'],
  ['mine', 'Yours'],
]

/* A channel has no avatar on the wire, so its art is DERIVED — deterministic
   from the id, which means the same channel wears the same colour on every
   device and every reload. The six tints are the discipline spine colours
   already in the token layer, so nothing new enters the palette. */
function tintOf(id) {
  const s = String(id || '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 997
  return h % 6
}

/** First letter of the title, for the crest. Falls back to the handle. */
function crestOf(ch) {
  const src = (ch.title || ch.handle || '#').trim()
  return [...src][0]?.toUpperCase() || '#'
}

function nfmt(n) {
  const v = Number(n) || 0
  if (v < 1000) return String(v)
  if (v < 1000000) return `${(v / 1000).toFixed(v < 10000 ? 1 : 0).replace('.0', '')}k`
  return `${(v / 1000000).toFixed(1).replace('.0', '')}M`
}

/* ---------------------------------------------------------
   Create — with a live preview of the card it will become.
   The preview is not decoration: a channel's identity is its
   handle and its crest, and both are decided in this form with
   no other chance to see them together before it exists.
   --------------------------------------------------------- */
function CreateChannel({ onClose, onCreated }) {
  const [title, setTitle] = React.useState('')
  const [handle, setHandle] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [isPublic, setIsPublic] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [taken, setTaken] = React.useState(null)     // null | 'checking' | true | false

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // The handle is required and unique for PUBLIC channels only — a private one
  // is joined through a group invite link, so it needs no address at all.
  const cleanHandle = handle.trim().replace(/^@/, '').toLowerCase()
  const handleBad = isPublic && !!cleanHandle && !HANDLE_RE.test(cleanHandle)
  const canSubmit = !!title.trim() && (!isPublic || HANDLE_RE.test(cleanHandle)) && taken !== true && !busy

  /* Availability, checked while typing rather than on submit. `byHandle` 404s
     for a free address — that is the ANSWER, not an error, so it resolves to
     "available" instead of surfacing anything. Debounced, and aborted on the
     next keystroke so a slow lookup can never overwrite a newer one. */
  React.useEffect(() => {
    if (!isPublic || !HANDLE_RE.test(cleanHandle)) { setTaken(null); return undefined }
    let alive = true
    setTaken('checking')
    const t = setTimeout(async () => {
      const found = await api.chat.channels.byHandle(cleanHandle).catch(() => null)
      if (alive) setTaken(!!found)
    }, 420)
    return () => { alive = false; clearTimeout(t) }
  }, [cleanHandle, isPublic])

  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    try {
      const ch = await api.chat.channels.create({
        title: title.trim(),
        description: description.trim() || undefined,
        handle: isPublic ? cleanHandle : undefined,
        publicChannel: isPublic,
      })
      showToast('Channel created')
      onCreated?.(ch)
    } catch (e) {
      showToast(chatError(e, 'Could not create the channel'))
    } finally {
      setBusy(false)
    }
  }

  const preview = {
    id: cleanHandle || title,
    title: title.trim() || 'Your channel',
    handle: isPublic ? cleanHandle : '',
    description: description.trim(),
    publicChannel: isPublic,
    subscriberCount: 1,
  }

  return (
    <div className="ch-modal-overlay" role="dialog" aria-modal="true" aria-label="Create a channel"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="ch-modal cn-modal">
        <div className="ch-modal-head">
          <h3><Icon name="broadcast" className="sm"/>New channel</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close">
            <Icon name="close" className="sm"/>
          </button>
        </div>

        <div className="ch-modal-body cn-modal-body">
          <div className="cn-form">
            <label className="cn-field">
              <span>Name</span>
              <input className="field" value={title} autoFocus maxLength={120}
                onChange={e => setTitle(e.target.value)} placeholder="AI Research Digest"/>
            </label>

            <label className="cn-field">
              <span>Description <small>optional</small></span>
              <textarea className="field" rows={3} maxLength={500} value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="What this channel publishes…"/>
            </label>

            <div className="ci-row cn-visrow">
              <Icon name={isPublic ? 'globe' : 'lock'}/>
              <div className="ci-row-body">
                <div className="ci-row-title">{isPublic ? 'Public channel' : 'Private channel'}</div>
                <div className="ci-row-sub">
                  {isPublic
                    ? 'Discoverable by anyone, joined at its @handle.'
                    : 'Not discoverable and not self-joinable — add people with an invite link.'}
                </div>
              </div>
              <button type="button" className={'ci-switch' + (isPublic ? ' on' : '')}
                role="switch" aria-checked={isPublic} aria-label="Public channel"
                onClick={() => setIsPublic(v => !v)}/>
            </div>

            {isPublic && (
              <label className="cn-field">
                <span>Handle</span>
                <div className={'cn-handle' + (handleBad || taken === true ? ' bad' : '') + (taken === false ? ' ok' : '')}>
                  <span aria-hidden="true">@</span>
                  <input className="field" value={handle} maxLength={32}
                    onChange={e => setHandle(e.target.value)} placeholder="ai_research"/>
                  {taken === 'checking' && <span className="cn-handle-spin" aria-hidden="true"/>}
                  {taken === false && <Icon name="check" className="xs cn-handle-ok"/>}
                </div>
                <small className={'cn-hint' + (handleBad || taken === true ? ' bad' : '') + (taken === false ? ' ok' : '')}>
                  {handleBad
                    ? '3–32 characters — lowercase letters, numbers and underscores only.'
                    : taken === true
                      ? 'That handle is already taken.'
                      : taken === false
                        ? '@' + cleanHandle + ' is available.'
                        : 'People find your channel at this address. It must be unique.'}
                </small>
              </label>
            )}
          </div>

          <aside className="cn-preview" aria-hidden="true">
            <div className="cn-preview-label">Preview</div>
            <ChannelCard ch={preview} preview/>
          </aside>
        </div>

        <div className="ch-modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!canSubmit} onClick={submit}>
            {busy ? 'Creating…' : 'Create channel'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------
   One discovery card.
   --------------------------------------------------------- */
function ChannelCard({ ch, onOpen, onToggle, busy, mine, preview }) {
  /* Two cases where there is no subscribe toggle to offer:
       · the OWNER — the API refuses to let them unsubscribe from their own
         channel, so a control that can only 403 is worse than none;
       · a PRIVATE channel — self-subscribe is rejected; you get in through a
         group invite link. Discovery only returns public channels, so this
         arm is reachable only via a direct @handle lookup. */
  const isOwner = !!mine && String(ch.ownerId) === String(mine)
  const canToggle = !isOwner && (ch.publicChannel || ch.subscribed)

  return (
    <article className={'cn-card tint-' + tintOf(ch.id) + (ch.subscribed ? ' on' : '') + (preview ? ' preview' : '')}>
      <div className="cn-card-cover" aria-hidden="true">
        <Icon name="broadcast" className="cn-card-mark"/>
        {ch.subscribed && !preview && (
          <span className="cn-card-flag"><Icon name="check" className="xs"/>Subscribed</span>
        )}
      </div>

      <div className="cn-card-crest" aria-hidden="true">{crestOf(ch)}</div>

      <div className="cn-card-body">
        <h3 className="cn-card-title" dir="auto">
          {ch.title}
          {!ch.publicChannel && <span className="cn-tag"><Icon name="lock" className="xs"/>Private</span>}
          {isOwner && <span className="cn-tag gold"><Icon name="crown" className="xs"/>Yours</span>}
        </h3>
        {ch.handle
          ? <div className="cn-card-handle">@{ch.handle}</div>
          : <div className="cn-card-handle muted">invite only</div>}
        {ch.description
          ? <p className="cn-card-desc" dir="auto">{ch.description}</p>
          : <p className="cn-card-desc empty">No description yet.</p>}
      </div>

      <footer className="cn-card-foot">
        <span className="cn-card-meta">
          <Icon name="users" className="xs"/>
          {nfmt(ch.subscriberCount)}<span className="cn-card-metaw">
            &nbsp;subscriber{ch.subscriberCount === 1 ? '' : 's'}
          </span>
        </span>
        {!preview && (
          <div className="cn-card-acts">
            <button className="cn-btn" onClick={() => onOpen?.(ch)}>Open</button>
            {canToggle && (
              /* The subscribed state deliberately swaps its label on hover:
                 a button that still says "Subscribed" when clicking it will
                 unsubscribe you is the oldest trap in this pattern. */
              <button
                className={'cn-btn' + (ch.subscribed ? ' on' : ' primary')}
                disabled={busy}
                onClick={() => onToggle?.(ch)}
                aria-label={ch.subscribed ? `Unsubscribe from ${ch.title}` : `Subscribe to ${ch.title}`}
              >
                {ch.subscribed
                  ? <><span className="cn-btn-a"><Icon name="check" className="xs"/>Subscribed</span>
                      <span className="cn-btn-b">Unsubscribe</span></>
                  : 'Subscribe'}
              </button>
            )}
            {!canToggle && !isOwner && <span className="cn-card-note">Invite only</span>}
          </div>
        )}
      </footer>
    </article>
  )
}

/** The loading grid. Skeletons carry the card's real geometry, so the page
 *  does not resettle when the answer lands. */
function CardSkeleton() {
  return (
    <div className="cn-card cn-skel" aria-hidden="true">
      <div className="cn-card-cover"/>
      <div className="cn-card-crest"/>
      <div className="cn-card-body">
        <div className="cn-skel-line w60"/>
        <div className="cn-skel-line w30"/>
        <div className="cn-skel-line w90"/>
        <div className="cn-skel-line w75"/>
      </div>
      <div className="cn-card-foot">
        <div className="cn-skel-line w40"/>
      </div>
    </div>
  )
}

export function ChannelsPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { upsertConvo, conversations, myId } = useChat()

  const [q, setQ] = React.useState(params.get('q') || '')
  const [filter, setFilter] = React.useState('all')
  const [rows, setRows] = React.useState([])
  const [state, setState] = React.useState('loading')     // loading | ready | error
  const [creating, setCreating] = React.useState(false)
  const [busyId, setBusyId] = React.useState(null)
  const [retry, setRetry] = React.useState(0)

  /* Debounced discovery. The AbortController is what stops a slow earlier
     query from landing after a newer one and repainting stale results.

     `discover` is a text search over titles; `by-handle` is an EXACT address
     lookup. They are different questions, and a pasted "@ai_research" is
     asking the second one — so when the query is handle-shaped and discovery
     comes back empty, fall through to the exact lookup rather than telling
     someone their own channel doesn't exist. Only on empty: a handle that
     also matches titles should still show the whole list. */
  React.useEffect(() => {
    const ctl = new AbortController()
    const needle = q.trim()
    const handle = needle.replace(/^@/, '').toLowerCase()
    const handleShaped = HANDLE_RE.test(handle)

    setState(s => (s === 'ready' ? s : 'loading'))
    const t = setTimeout(async () => {
      try {
        let res = await api.chat.channels.discover(needle, { signal: ctl.signal })
        if (!res.length && handleShaped) {
          // 404 here just means "no channel at that address" — not an error.
          const exact = await api.chat.channels.byHandle(handle).catch(() => null)
          if (exact) res = [exact]
        }
        if (!ctl.signal.aborted) { setRows(res); setState('ready') }
      } catch (e) {
        if (!ctl.signal.aborted && e?.name !== 'AbortError') setState('error')
      }
    }, needle ? 320 : 0)
    return () => { clearTimeout(t); ctl.abort() }
  }, [q, retry])

  // Keep the query in the URL so a channel search is shareable and survives a
  // reload, matching how /explore behaves.
  React.useEffect(() => {
    const next = q.trim()
    const cur = params.get('q') || ''
    if (next === cur) return
    const p = new URLSearchParams(params)
    if (next) p.set('q', next); else p.delete('q')
    setParams(p, { replace: true })
  }, [q, params, setParams])

  const openChannel = React.useCallback((ch) => {
    // The channel id IS the conversation id — no lookup, no second fetch.
    navigate(`/chat/${ch.id}`)
  }, [navigate])

  const toggle = React.useCallback(async (ch) => {
    setBusyId(ch.id)
    const before = ch.subscribed
    setRows(prev => prev.map(r => (r.id === ch.id
      ? { ...r, subscribed: !before, subscriberCount: Math.max(0, r.subscriberCount + (before ? -1 : 1)) }
      : r)))
    try {
      if (before) {
        await api.chat.channels.unsubscribe(ch.id)
        showToast('Unsubscribed')
      } else {
        await api.chat.channels.subscribe(ch.id)
        // Subscribing makes it a conversation in my inbox; pull the row so the
        // rail shows it immediately instead of after the next refresh.
        try { const c = await api.chat.conversations.get(ch.id); if (c) upsertConvo(c) }
        catch { /* it will arrive with the next inbox load */ }
        showToast('Subscribed')
      }
    } catch (e) {
      setRows(prev => prev.map(r => (r.id === ch.id
        ? { ...r, subscribed: before, subscriberCount: Math.max(0, r.subscriberCount + (before ? 1 : -1)) }
        : r)))
      showToast(chatError(e, 'Could not update the subscription'))
    } finally {
      setBusyId(null)
    }
  }, [upsertConvo])

  /* My channels — from the inbox, not from discovery (see the file header).
     This is the only view that knows about private channels and unread state. */
  const mine = React.useMemo(
    () => conversations.filter(c => c.isChannel),
    [conversations],
  )
  const ownedCount = React.useMemo(
    () => mine.filter(c => String(c.ownerId) === String(myId)).length,
    [mine, myId],
  )

  const shown = React.useMemo(() => {
    if (filter === 'subscribed') return rows.filter(r => r.subscribed)
    if (filter === 'mine') return rows.filter(r => String(r.ownerId) === String(myId))
    return rows
  }, [rows, filter, myId])

  const emptyCopy = {
    subscribed: {
      title: 'You have not subscribed to any of these',
      sub: 'Subscribe to a channel and it appears here — and in your inbox.',
    },
    mine: {
      title: 'You do not own a public channel yet',
      sub: 'Create one: it takes a name and a handle, and you can publish immediately.',
    },
    all: q
      ? { title: 'No channels match', sub: 'Try a different word, or paste an exact @handle.' }
      : { title: 'No public channels yet', sub: 'Create the first one — it takes a name and a handle.' },
  }[filter]

  return (
    <div className="main wide cn-page">
      <div className="col-main">
        {/* ---- masthead ---- */}
        <header className="cn-hero">
          <div className="cn-hero-art" aria-hidden="true"><Icon name="broadcast"/></div>
          <div className="cn-hero-main">
            <span className="cn-eyebrow">Broadcast</span>
            <h1 className="cn-title">Chan<em>nels</em></h1>
            <p className="cn-sub">
              One voice, many readers. Admins publish; everyone else subscribes and reads.
              A channel is an ordinary conversation underneath, so posting, search and
              media all work exactly as they do in a chat.
            </p>
            <div className="cn-hero-stats">
              <span><b>{mine.length}</b> joined</span>
              <span className="cn-hero-sep">·</span>
              <span><b>{ownedCount}</b> yours</span>
            </div>
          </div>
          <div className="cn-hero-cta">
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Icon name="compose" className="xs"/>New channel
            </button>
          </div>
        </header>

        {/* ---- my channels: the only place a private one shows up ---- */}
        {!!mine.length && (
          <section className="cn-section">
            <div className="cn-section-head">
              <h2 className="cn-section-t">Your channels</h2>
              <span className="cn-section-n">{mine.length}</span>
            </div>
            {/* A rail, not a grid: this list is for RETURNING to a channel, and
                a horizontal strip keeps the discovery grid above the fold. */}
            <div className="cn-rail">
              {mine.map(c => (
                <button key={c.id} className={'cn-mine tint-' + tintOf(c.id)}
                  onClick={() => navigate(`/chat/${c.id}`)}>
                  <span className="cn-mine-crest" aria-hidden="true">
                    {crestOf({ title: c.displayTitle })}
                  </span>
                  <span className="cn-mine-body">
                    <span className="cn-mine-nm" dir="auto">{c.displayTitle}</span>
                    <span className="cn-mine-sub" dir="auto">
                      {c.lastMessagePreview || `${c.memberCount || 0} subscribers`}
                    </span>
                  </span>
                  {c.hasUnread && (
                    <span className="cn-mine-dot" aria-label="Unread">
                      {c.unreadCount > 0 ? Math.min(99, c.unreadCount) : ''}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>
        )}

        {/* ---- discovery ---- */}
        <div className="cn-toolbar">
          <div className="ch-list-search cn-search">
            <Icon name="search" className="sm"/>
            <input className="field" value={q} onChange={e => setQ(e.target.value)}
              placeholder="Search channels, or paste an @handle…" aria-label="Search channels"/>
            {q && (
              <button className="icon-btn" onClick={() => setQ('')} aria-label="Clear" title="Clear">
                <Icon name="close" className="xs"/>
              </button>
            )}
          </div>
          <div className="cn-filters" role="group" aria-label="Filter channels">
            {FILTERS.map(([key, label]) => (
              <button key={key} className={'cn-chip' + (filter === key ? ' on' : '')}
                aria-pressed={filter === key} onClick={() => setFilter(key)}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {state === 'error' && (
          <ErrorState message="Channel discovery is unavailable right now."
            onRetry={() => { setState('loading'); setRetry(n => n + 1) }}/>
        )}

        {state === 'loading' && (
          <div className="cn-grid">
            {[0, 1, 2, 3, 4, 5].map(i => <CardSkeleton key={i}/>)}
          </div>
        )}

        {state === 'ready' && shown.length === 0 && (
          <EmptyState icon="broadcast" title={emptyCopy.title} sub={emptyCopy.sub}/>
        )}

        {state === 'ready' && shown.length > 0 && (
          <div className="cn-grid">
            {shown.map(ch => (
              <ChannelCard key={ch.id} ch={ch} busy={busyId === ch.id} mine={myId}
                onOpen={openChannel} onToggle={toggle}/>
            ))}
          </div>
        )}
      </div>

      {creating && (
        <CreateChannel
          onClose={() => setCreating(false)}
          onCreated={(ch) => { setCreating(false); if (ch?.id) navigate(`/chat/${ch.id}`) }}
        />
      )}
    </div>
  )
}

export default ChannelsPage
