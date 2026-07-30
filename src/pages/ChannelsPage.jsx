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
   double-fire. The backend floors every conversation read at
   MEMBERSHIP — a public channel 403s (NOT_A_MEMBER) until you
   subscribe — so "Open" on a channel you're not in silently
   subscribes first (idempotent) and then navigates; the full
   history is visible from the moment you're a subscriber.

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
import { Icon, showToast, Verify } from '../components/ui.jsx'
import { EmptyState, ErrorState } from '../components/states.jsx'
import { openShare } from '../components/ShareSheet.jsx'
import { useChat } from '../context/ChatContext.jsx'
import { api } from '../api/index.js'
import { chatError } from '../components/chat/chatErrors.js'
import { tintOf, crestOf, nfmt } from '../components/channels/channelArt.js'

const HANDLE_RE = /^[a-z0-9_]{3,32}$/

const FILTERS = [
  ['all', 'All'],
  ['subscribed', 'Subscribed'],
  ['mine', 'Yours'],
]

/* The directory slugs the backend's `category=` filter understands. They are
   free-form on the wire (any ≤48-char slug), so this list is a set of
   SHORTCUTS, not a closed vocabulary — a channel in an unlisted category is
   still found by the text query. */
const CATEGORIES = ['science', 'history', 'language', 'law', 'literature', 'technology']

/* ---------------------------------------------------------
   Create — with a live preview of the card it will become.
   The preview is not decoration: a channel's identity is its
   handle and its crest, and both are decided in this form with
   no other chance to see them together before it exists.
   --------------------------------------------------------- */
function CreateChannel({ onClose, onCreated, cats = [] }) {
  const [title, setTitle] = React.useState('')
  const [handle, setHandle] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [category, setCategory] = React.useState('')
  const [isPublic, setIsPublic] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [taken, setTaken] = React.useState(null)     // null | 'checking' | true | false

  /* Art picked BEFORE the channel exists. The create endpoint is JSON-only, so
     the files are held locally (object-URL previews) and uploaded through the
     ordinary photo/cover endpoints right after create — one flow to the user. */
  const [photoFile, setPhotoFile] = React.useState(null)
  const [coverFile, setCoverFile] = React.useState(null)
  const photoUrl = React.useMemo(() => (photoFile ? URL.createObjectURL(photoFile) : null), [photoFile])
  const coverUrl = React.useMemo(() => (coverFile ? URL.createObjectURL(coverFile) : null), [coverFile])
  React.useEffect(() => () => { if (photoUrl) URL.revokeObjectURL(photoUrl) }, [photoUrl])
  React.useEffect(() => () => { if (coverUrl) URL.revokeObjectURL(coverUrl) }, [coverUrl])
  const pickFile = (set) => (e) => { set(e.target.files?.[0] || null); e.target.value = '' }

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
      const found = await api.channels.byHandle(cleanHandle).catch(() => null)
      if (alive) setTaken(!!found)
    }, 420)
    return () => { alive = false; clearTimeout(t) }
  }, [cleanHandle, isPublic])

  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    try {
      const ch = await api.channels.create({
        title: title.trim(),
        description: description.trim() || undefined,
        handle: isPublic ? cleanHandle : undefined,
        publicChannel: isPublic,
        category: category.trim() || undefined,
      })
      /* Art is best-effort: the channel exists either way, and a failed image
         is re-uploadable from Manage — never roll a created channel back. */
      let final = ch
      if (photoFile) {
        try { final = await api.channels.photo(ch.id, photoFile) }
        catch { showToast('The photo could not be uploaded — add it later from Manage') }
      }
      if (coverFile) {
        try { final = await api.channels.cover(ch.id, coverFile) }
        catch { showToast('The cover could not be uploaded — add it later from Manage') }
      }
      showToast('Channel created')
      onCreated?.(final)
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
    coverUrl,
    avatarUrl: photoUrl,
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
            {/* Identity banner — cover and photo are pickable from the start,
                previewed live with the same art the card will wear. */}
            <div className={'cm-art cn-create-art tint-' + tintOf(cleanHandle || title)}>
              <div className={'cm-art-cover' + (coverUrl ? ' has-img' : '')}
                style={coverUrl ? { '--cover': `url("${coverUrl}")` } : undefined}>
                <div className="cm-art-acts">
                  <label className="cm-art-btn">
                    <Icon name="image" className="xs"/>
                    {coverUrl ? 'Replace cover' : 'Add cover'}
                    <input type="file" accept="image/*" hidden onChange={pickFile(setCoverFile)}/>
                  </label>
                  {coverUrl && (
                    <button type="button" className="cm-art-btn" onClick={() => setCoverFile(null)}
                      aria-label="Remove the cover" title="Remove the cover">
                      <Icon name="trash" className="xs"/>
                    </button>
                  )}
                </div>
              </div>
              <div className="cm-art-id">
                <div className="cm-art-photo">
                  {photoUrl
                    ? <img src={photoUrl} alt=""/>
                    : <span className="cm-art-crest" aria-hidden="true">{crestOf({ title })}</span>}
                  <label className="cm-art-cam" title={photoUrl ? 'Replace the photo' : 'Add a photo'}>
                    <Icon name="image" className="xs"/>
                    <input type="file" accept="image/*" hidden onChange={pickFile(setPhotoFile)}/>
                  </label>
                </div>
                <div className="cm-art-meta">
                  <div className="cm-art-name" dir="auto">{title.trim() || 'Your channel'}</div>
                  <div className="cm-art-sub">
                    {isPublic ? (cleanHandle ? '@' + cleanHandle : 'public channel') : 'private channel'}
                  </div>
                </div>
                {photoUrl && (
                  <button type="button" className="cn-btn cm-art-clear" onClick={() => setPhotoFile(null)}>Remove</button>
                )}
              </div>
            </div>

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

            <label className="cn-field">
              <span>Category <small>optional — where it sits in the directory</small></span>
              <input className="field" value={category} maxLength={48} list="cn-cat-list"
                onChange={e => setCategory(e.target.value)} placeholder="science"/>
              <datalist id="cn-cat-list">
                {(cats.length ? cats : CATEGORIES).map(c => <option key={c} value={c}/>)}
              </datalist>
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
function ChannelCard({ ch, onOpen, onToggle, onProfile, busy, mine, preview }) {
  /* Two cases where there is no subscribe toggle to offer:
       · the OWNER — the API refuses to let them unsubscribe from their own
         channel, so a control that can only 403 is worse than none;
       · a PRIVATE channel — self-subscribe is rejected; you get in through a
         group invite link. Discovery only returns public channels, so this
         arm is reachable only via a direct @handle lookup.
     A third state now sits between subscribed and not: a `joinByRequest`
     channel where I am WAITING. There is nothing to toggle there either — a
     second subscribe would only re-file the request I already have. */
  const isOwner = !!mine && String(ch.ownerId) === String(mine)
  const canToggle = !isOwner && !ch.pendingJoinRequest && (ch.publicChannel || ch.subscribed)

  return (
    <article className={'cn-card tint-' + tintOf(ch.id) + (ch.subscribed ? ' on' : '') + (preview ? ' preview' : '')}>
      {/* `--cover`, not `background-image` — the sheet layers it over the
          card's tint so a broken cover falls back to the derived art. */}
      <div className={'cn-card-cover' + (ch.coverUrl ? ' has-img' : '')}
        style={ch.coverUrl ? { '--cover': `url("${encodeURI(ch.coverUrl)}")` } : undefined}
        aria-hidden="true">
        {!ch.coverUrl && <Icon name="broadcast" className="cn-card-mark"/>}
        {ch.subscribed && !preview && (
          <span className="cn-card-flag"><Icon name="check" className="xs"/>Subscribed</span>
        )}
        {ch.pendingJoinRequest && !preview && (
          <span className="cn-card-flag wait"><Icon name="hourglass" className="xs"/>Waiting</span>
        )}
      </div>

      {/* The uploaded photo when there is one; the derived crest underneath it
          always, so a channel that clears its photo does not change colour. */}
      <div className="cn-card-crest" aria-hidden="true">
        {ch.avatarUrl ? <img src={ch.avatarUrl} alt="" loading="lazy"/> : crestOf(ch)}
      </div>

      <div className="cn-card-body">
        <h3 className="cn-card-title" dir="auto">
          {ch.title}
          {ch.verified && <Verify/>}
          {!ch.publicChannel && <span className="cn-tag"><Icon name="lock" className="xs"/>Private</span>}
          {isOwner && <span className="cn-tag gold"><Icon name="crown" className="xs"/>Yours</span>}
        </h3>
        {ch.handle
          ? <div className="cn-card-handle">@{ch.handle}{ch.category && <span className="cn-card-cat">{ch.category}</span>}</div>
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
          {ch.postCount > 0 && (
            <><span className="cn-card-sep">·</span>{nfmt(ch.postCount)}<span className="cn-card-metaw">&nbsp;posts</span></>
          )}
        </span>
        {!preview && (
          <div className="cn-card-acts">
            {ch.shareUrl && (
              /* Public channels carry a ready /c/{handle} link on the wire —
                 no share-link fetch, no counter to record. */
              <button className="cn-btn" onClick={() => openShare({ kind: 'channel', url: ch.shareUrl, title: ch.title })}
                aria-label={`Share ${ch.title}`} title="Share">
                <Icon name="share" className="xs"/>
              </button>
            )}
            {/* "About" is the profile — cover, badges, admin console. "Open"
                is the posts. They are different places and the card offers
                both rather than making one of them a mystery. */}
            <button className="cn-btn" onClick={() => onProfile?.(ch)}>About</button>
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
            {ch.pendingJoinRequest && <span className="cn-card-note">Awaiting approval</span>}
            {!canToggle && !isOwner && !ch.pendingJoinRequest && <span className="cn-card-note">Invite only</span>}
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
  const { upsertConvo, conversations, myId, subscribe } = useChat()

  const [q, setQ] = React.useState(params.get('q') || '')
  const [category, setCategory] = React.useState(params.get('category') || '')
  const [filter, setFilter] = React.useState('all')
  const [rows, setRows] = React.useState([])
  const [state, setState] = React.useState('loading')     // loading | ready | error
  const [creating, setCreating] = React.useState(false)
  const [busyId, setBusyId] = React.useState(null)
  const [retry, setRetry] = React.useState(0)
  /* The category chips are the categories that actually EXIST in the
     directory, harvested from every discovery answer (union — a filtered
     answer can only add, never shrink the row). The hardcoded list is just
     the create-form's suggestion floor. */
  const [cats, setCats] = React.useState([])

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
        let res = await api.channels.discover(needle, { category }, { signal: ctl.signal })
        /* The @handle fallback is deliberately NOT applied while a category is
           selected: an exact address lookup ignores the category, so it would
           surface a channel the filter had just excluded. */
        if (!res.length && handleShaped && !category) {
          // 404 here just means "no channel at that address" — not an error.
          const exact = await api.channels.byHandle(handle).catch(() => null)
          if (exact) res = [exact]
        }
        if (!ctl.signal.aborted) {
          setRows(res)
          setState('ready')
          setCats(prev => {
            const s = new Set(prev)
            res.forEach(r => { const c = (r.category || '').trim(); if (c) s.add(c) })
            return s.size === prev.length ? prev : [...s].sort((a, b) => a.localeCompare(b))
          })
        }
      } catch (e) {
        if (!ctl.signal.aborted && e?.name !== 'AbortError') setState('error')
      }
    }, needle ? 320 : 0)
    return () => { clearTimeout(t); ctl.abort() }
  }, [q, category, retry])

  /* Realtime subscriber counts — the platform's delta model: every
     subscribe/unsubscribe fans out as member.changed SUBSCRIBED/UNSUBSCRIBED
     (no counter on the wire; apply ±1 locally). My own toggles are already
     applied optimistically in `toggle`/`openChannel`, so my own echo is
     skipped or the count would move twice. */
  React.useEffect(() => subscribe((evt) => {
    if (evt?.type !== 'member.changed') return
    if (evt.memberChange !== 'SUBSCRIBED' && evt.memberChange !== 'UNSUBSCRIBED') return
    if (String(evt.userId) === String(myId)) return
    const d = evt.memberChange === 'SUBSCRIBED' ? 1 : -1
    setRows(prev => prev.map(r => (String(r.id) === String(evt.conversationId)
      ? { ...r, subscriberCount: Math.max(0, r.subscriberCount + d) }
      : r)))
  }), [subscribe, myId])

  // Keep the query AND the category in the URL so a channel search is
  // shareable and survives a reload, matching how /explore behaves.
  React.useEffect(() => {
    const next = q.trim()
    if (next === (params.get('q') || '') && category === (params.get('category') || '')) return
    const p = new URLSearchParams(params)
    if (next) p.set('q', next); else p.delete('q')
    if (category) p.set('category', category); else p.delete('category')
    setParams(p, { replace: true })
  }, [q, category, params, setParams])

  const openChannel = React.useCallback(async (ch) => {
    /* The channel id IS the conversation id — but the backend floors ALL
       conversation reads at membership (GET /conversations/{id} and its
       /messages return 403 NOT_A_MEMBER even for a PUBLIC channel; verified
       against the live server). So "Open" on a channel I'm not in must
       join first — subscribe is idempotent and free, and a brand-new
       subscriber still sees the full history once inside. */
    const isMember = ch.subscribed || String(ch.ownerId) === String(myId)
    if (!isMember) {
      if (!ch.publicChannel) { showToast('This channel is invite-only'); return }
      if (ch.pendingJoinRequest) { showToast('Your request is still waiting for an admin'); return }
      setBusyId(ch.id)
      try {
        const next = await api.channels.subscribe(ch.id)
        setRows(prev => prev.map(r => (r.id === ch.id ? next : r)))
        /* `joinByRequest` turns subscribe into "file a request" — the caller is
           NOT a member, so navigating to the thread would land on a 403. */
        if (next.pendingJoinRequest) {
          showToast('Request sent — an admin will review it')
          return
        }
        try { const c = await api.chat.conversations.get(ch.id); if (c) upsertConvo(c) }
        catch { /* it will arrive with the next inbox load */ }
      } catch (e) {
        showToast(chatError(e, 'Could not open the channel'))
        return
      } finally {
        setBusyId(null)
      }
    }
    navigate(`/chat/${ch.id}`)
  }, [navigate, myId, upsertConvo])

  const toggle = React.useCallback(async (ch) => {
    setBusyId(ch.id)
    const before = ch.subscribed
    setRows(prev => prev.map(r => (r.id === ch.id
      ? { ...r, subscribed: !before, subscriberCount: Math.max(0, r.subscriberCount + (before ? -1 : 1)) }
      : r)))
    try {
      if (before) {
        await api.channels.unsubscribe(ch.id)
        showToast('Unsubscribed')
      } else {
        const next = await api.channels.subscribe(ch.id)
        // Three outcomes, not two: a `joinByRequest` channel answers with
        // `pendingJoinRequest` and NO membership, so the optimistic
        // "subscribed" above has to be corrected rather than confirmed.
        setRows(prev => prev.map(r => (r.id === ch.id ? next : r)))
        if (next.pendingJoinRequest) {
          showToast('Request sent — an admin will review it')
        } else {
          // Subscribing makes it a conversation in my inbox; pull the row so
          // the rail shows it immediately instead of after the next refresh.
          try { const c = await api.chat.conversations.get(ch.id); if (c) upsertConvo(c) }
          catch { /* it will arrive with the next inbox load */ }
          showToast('Subscribed')
        }
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

  /* Hero stats — the truth is split across two sources: the inbox knows
     PRIVATE channels (and unread), while discovery already sits on this page
     and knows public subscribed/owner state. Union them by id so the numbers
     are right even while the inbox fetch is still in flight — with inbox-only
     counts, "0 joined · 0 yours" flashed at the owner of a channel. */
  const joinedCount = React.useMemo(() => {
    const ids = new Set(mine.map(c => String(c.id)))
    for (const r of rows) {
      if (r.subscribed || String(r.ownerId) === String(myId)) ids.add(String(r.id))
    }
    return ids.size
  }, [mine, rows, myId])
  const ownedCount = React.useMemo(() => {
    const ids = new Set(
      mine.filter(c => String(c.ownerId) === String(myId)).map(c => String(c.id)),
    )
    for (const r of rows) {
      if (String(r.ownerId) === String(myId)) ids.add(String(r.id))
    }
    return ids.size
  }, [mine, rows, myId])

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
              <span><b>{joinedCount}</b> joined</span>
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
        <div className="cn-section-head">
          <h2 className="cn-section-t">Discover</h2>
          {state === 'ready' && <span className="cn-section-n">{shown.length}</span>}
        </div>

        {/* One browse container: search + audience filters, and beneath them
            the categories that actually exist in the directory. */}
        <div className="cn-browse">
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

          {/* Real directory categories (harvested from discovery), never an
              invented vocabulary — the row only exists once the DB has one. */}
          {(cats.length > 0 || category) && (
            <div className="cn-cats" role="group" aria-label="Browse by category">
              <span className="cn-cats-label" aria-hidden="true"><Icon name="hash" className="xs"/>Category</span>
              <button className={'cn-chip sm' + (category ? '' : ' on')} aria-pressed={!category}
                onClick={() => setCategory('')}>Everything</button>
              {(cats.includes(category) || !category ? cats : [category, ...cats]).map(c => (
                <button key={c} className={'cn-chip sm' + (category === c ? ' on' : '')} dir="auto"
                  aria-pressed={category === c} onClick={() => setCategory(category === c ? '' : c)}>
                  {c}
                </button>
              ))}
            </div>
          )}
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
                onOpen={openChannel} onToggle={toggle}
                onProfile={(c) => navigate(`/channels/${c.id}`)}/>
            ))}
          </div>
        )}
      </div>

      {creating && (
        <CreateChannel
          cats={cats}
          onClose={() => setCreating(false)}
          onCreated={(ch) => { setCreating(false); if (ch?.id) navigate(`/chat/${ch.id}`) }}
        />
      )}
    </div>
  )
}

export default ChannelsPage
