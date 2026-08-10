/* =========================================================
   ConversationInfo — the details panel.
   ---------------------------------------------------------
   A DM shows the person, the shared media and the personal
   toggles. A group additionally shows its settings, its roster
   with role controls, and the invite link.

   The permission gates here MIRROR the backend's
   `GroupPermissions.can(actor, action, target, settings)`. They
   are a UX affordance only — the server re-checks every call —
   but keeping the same shape means a button never appears that
   would only bounce with 403 ADMINS_ONLY.

   Roster rules the matrix encodes and this file honours:
     · an admin may act on plain MEMBERS only; the owner on anyone
     · demote / transfer / delete-group are owner-only
     · the owner can never be removed, restricted or demoted
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../api/index.js'
import { Icon, Avatar, Verify, showToast } from '../ui.jsx'
import { Loader } from '../states.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { ModerationAlert } from '../Moderation.jsx'
import { isModerationError } from '../../lib/moderation.js'
import { openReport } from '../ReportDialog.jsx'
import { useImageViewer } from '../ImageLightbox.jsx'
import { useChat } from '../../context/ChatContext.jsx'
import { Popover } from './Popover.jsx'
import { Switch } from './Switch.jsx'
import { chatError } from './chatErrors.js'
import {
  useCallStats, useConversationCalls, clearCallsFor, describeCall, talkTime,
} from './callLog.js'
import { deleteIntentOf, leaveIntentOf } from './conversationActions.js'

/* ---------- the permission matrix, client side ---------- */

const SCOPE_ALL = 'ALL_MEMBERS'

function can(action, myRole, settings, targetRole) {
  const s = settings || {}
  const owner = myRole === 'OWNER'
  const staff = owner || myRole === 'ADMIN'
  const plain = targetRole === 'MEMBER'
  switch (action) {
    case 'ADD_MEMBERS':      return staff || s.whoCanAddMembers === SCOPE_ALL
    case 'EDIT_INFO':        return staff || s.whoCanEditInfo === SCOPE_ALL
    case 'PIN_MESSAGE':      return staff || s.whoCanPin === SCOPE_ALL
    case 'REMOVE_MEMBER':
    case 'RESTRICT_MEMBER':  return owner || (myRole === 'ADMIN' && plain)
    case 'PROMOTE_ADMIN':    return owner || (myRole === 'ADMIN' && !!s.adminsCanPromote && plain)
    case 'CHANGE_SETTINGS':
    case 'CREATE_INVITE':    return staff
    case 'DEMOTE_ADMIN':
    case 'TRANSFER_OWNERSHIP':
    case 'DELETE_GROUP':     return owner
    default:                 return false
  }
}

/* ---------- small atoms ---------- */

/* The presets the API documents, plus "off". Anything positive is legal, but
   a free-form seconds box invites 7-second timers nobody meant to set. */
const TTL_OPTIONS = [
  { value: 0,       label: 'Off' },
  { value: 3600,    label: 'After 1 hour' },
  { value: 86400,   label: 'After 24 hours' },
  { value: 604800,  label: 'After 7 days' },
  { value: 2592000, label: 'After 30 days' },
  { value: 7776000, label: 'After 90 days' },
]

function ScopeSelect({ value, onChange, label, disabled }) {
  return (
    <select
      className="ci-select"
      value={value || SCOPE_ALL}
      aria-label={label}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="ALL_MEMBERS">Everyone</option>
      <option value="ADMINS_ONLY">Admins only</option>
    </select>
  )
}

/* ---------- the two moderated fields, edited in place ----------
   A group's name and description are the only text this panel writes, and both
   are scored by automated moderation before anyone else can read them (as
   `ModeratedEntityType.CHANNEL` — there is no GROUP type). That rules out
   uiPrompt, which is what these used to be:

     · uiPrompt RESOLVES AND UNMOUNTS the instant Save is pressed, so a refusal
       arrives with the typed text already gone and nowhere on screen to put the
       server's answer. For a rename that costs a sentence; for a description it
       can cost several paragraphs.
     · `PATCH /conversations/{id}` answers a HOLD with 400 CONTENT_UNDER_REVIEW,
       not a 200 — the change did not land, the previously approved value keeps
       serving, and the case usually settles within seconds. That is the one
       moderation state where "Try again" is the honest control, and a dialog
       that has already closed cannot offer it.

   So the field edits where it sits: the box stays, the text stays in it, and
   the refusal renders underneath. <ModerationAlert/> decides for itself whether
   a retry is honest — it draws one only for CONTENT_UNDER_REVIEW — so `onRetry`
   is passed unconditionally and a hard block still gets no retry button. */
function InfoEdit({ label, initial, multiline, maxLength, placeholder, onSave, onCancel }) {
  const [value, setValue] = React.useState(initial ?? '')
  const [busy, setBusy] = React.useState(false)
  const [refused, setRefused] = React.useState(null)
  const fieldRef = React.useRef(null)

  React.useEffect(() => { fieldRef.current?.focus() }, [])

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setRefused(null)
    try { await onSave(value) }
    catch (e) {
      /* Moderation keeps the editor open with the text intact. Anything else
         has already been toasted by the caller — but the editor still stays
         open, because a failed save is not a reason to throw the writing away. */
      if (isModerationError(e)) setRefused(e)
    } finally { setBusy(false) }
  }

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); onCancel?.(); return }
    // Enter commits a one-line name; a description needs Enter for paragraphs,
    // so it takes the ⌘/Ctrl form the prompt dialog used.
    if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() }
  }

  return (
    /* `.cn-field` carries the whole label+field layout already; the two inline
       properties only undo `.ci-hero`'s centring for a form, which is not worth
       a rule in a shared stylesheet. */
    <div className="cn-field ci-hero-edit" style={{ textAlign: 'start', marginTop: 12 }}>
      <span>{label}</span>
      {multiline ? (
        <textarea ref={fieldRef} className="field" rows={3} dir="auto" value={value}
          maxLength={maxLength} placeholder={placeholder} disabled={busy}
          onChange={e => setValue(e.target.value)} onKeyDown={onKeyDown}/>
      ) : (
        <input ref={fieldRef} className="field" dir="auto" value={value}
          maxLength={maxLength} placeholder={placeholder} disabled={busy}
          onChange={e => setValue(e.target.value)} onKeyDown={onKeyDown}/>
      )}
      <ModerationAlert error={refused} onRetry={submit} onDismiss={() => setRefused(null)}/>
      <div className="ci-hero-actions">
        <button type="button" className="rq-btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="rq-btn primary" onClick={submit}
          disabled={busy || (!multiline && !value.trim())}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

/* ---------- member row ---------- */

function MemberRow({ member, convo, myId, onChanged }) {
  const navigate = useNavigate()
  const { openDirect, enrichAuthor } = useChat()
  // MemberResponse is id/username/fullName/role/status — no avatar.
  const who = enrichAuthor(member._author, member.userId)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const wrapRef = React.useRef(null)
  const menuBtnRef = React.useRef(null)
  // Dismissal is Popover's: this menu portals out of `.ci-body`
  // (overflow-y:auto), which would otherwise crop it near the panel edges.

  const myRole = convo.myRole
  const settings = convo.settings
  const isMe = String(member.userId) === String(myId)
  const target = member.role

  const run = async (fn, okMsg) => {
    if (busy) return
    setBusy(true)
    try { await fn(); if (okMsg) showToast(okMsg); onChanged?.() }
    catch (e) { showToast(chatError(e, 'Could not update this member')) }
    finally { setBusy(false) }
  }

  const items = []
  if (!isMe) {
    items.push({ key: 'view', label: 'View profile', icon: 'user', run: () => navigate(`/u/${member.userId}`) })
    items.push({
      key: 'msg',
      label: 'Send a message',
      icon: 'message',
      // get-or-create on the backend, so this opens the existing DM if there is one
      run: () => run(async () => {
        const convo = await openDirect(member.userId)
        if (convo?.id) navigate(`/chat/${convo.id}`)
      }),
    })

    if (target !== 'OWNER') {
      if (target === 'MEMBER' && can('PROMOTE_ADMIN', myRole, settings, target)) {
        items.push({
          key: 'promote', label: 'Make admin', icon: 'crown',
          run: () => run(() => api.chat.members.setRole(convo.id, member.userId, 'ADMIN'), 'Promoted to admin'),
        })
      }
      if (target === 'ADMIN' && can('DEMOTE_ADMIN', myRole, settings, target)) {
        items.push({
          key: 'demote', label: 'Remove as admin', icon: 'userminus',
          run: () => run(() => api.chat.members.setRole(convo.id, member.userId, 'MEMBER'), 'Admin removed'),
        })
      }
      if (can('RESTRICT_MEMBER', myRole, settings, target)) {
        items.push(member.status === 'RESTRICTED'
          ? {
              key: 'unrestrict', label: 'Allow posting', icon: 'check',
              run: () => run(() => api.chat.members.restrict(convo.id, member.userId, false), 'Member can post again'),
            }
          : {
              key: 'restrict', label: 'Restrict posting', icon: 'mute',
              run: () => run(() => api.chat.members.restrict(convo.id, member.userId, true), 'Member restricted'),
            })
      }
      if (can('TRANSFER_OWNERSHIP', myRole, settings, target) && member.status === 'ACTIVE') {
        items.push({
          key: 'transfer', label: 'Transfer ownership', icon: 'crown',
          run: () => run(async () => {
            const ok = await uiConfirm({
              title: 'Transfer ownership',
              message: `Make ${member.fullName || '@' + member.username} the owner? You will become an admin.`,
              danger: true,
              confirmLabel: 'Transfer',
            })
            if (!ok) return
            await api.chat.members.transferOwner(convo.id, member.userId)
          }, 'Ownership transferred'),
        })
      }
      if (can('REMOVE_MEMBER', myRole, settings, target)) {
        items.push({
          key: 'remove', label: 'Remove from group', icon: 'userminus', danger: true,
          run: () => run(async () => {
            const ok = await uiConfirm({
              title: 'Remove member',
              message: `Remove ${member.fullName || '@' + member.username} from the group?`,
              danger: true,
              confirmLabel: 'Remove',
            })
            if (!ok) return
            await api.chat.members.remove(convo.id, member.userId)
          }, 'Member removed'),
        })
      }
    }
  }

  return (
    <div className="ci-member" ref={wrapRef} style={{ position: 'relative' }}>
      <Avatar
        size={36}
        src={who?.profileImage || null}
        initials={who?.initials || '·'}
        color={who?.avc}
      />
      <div className="ci-member-body">
        <div className="ci-member-name">
          <span dir="auto">{member.fullName || member.username}</span>
          {who?.verified && <Verify scholar={who.role === 'SCHOLAR'}/>}
          {isMe && <span className="ci-member-sub">(you)</span>}
        </div>
        <div className="ci-member-sub">@{member.username}</div>
      </div>

      {member.role === 'OWNER' && <span className="ci-tag owner">Owner</span>}
      {member.role === 'ADMIN' && <span className="ci-tag admin">Admin</span>}
      {member.status === 'RESTRICTED' && <span className="ci-tag restricted">Muted</span>}

      {!!items.length && (
        <>
          <button
            type="button"
            ref={menuBtnRef}
            className="cv-menu-btn"
            style={{ position: 'static', display: 'inline-flex' }}
            onClick={() => setMenuOpen(v => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Actions for ${member.username}`}
            disabled={busy}
          >
            <Icon name="more"/>
          </button>
          <Popover
            anchorRef={menuBtnRef}
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            className="ch-hd-menu"
            ariaLabel={`Actions for ${member.username}`}
            align="end"
          >
            {items.map(it => (
              <button
                key={it.key}
                type="button"
                role="menuitem"
                className={'ch-menu-item' + (it.danger ? ' danger' : '')}
                onClick={() => { setMenuOpen(false); it.run() }}
              >
                <Icon name={it.icon} className="sm"/>
                <span>{it.label}</span>
              </button>
            ))}
          </Popover>
        </>
      )}
    </div>
  )
}

/* ---------- the panel ---------- */

export function ConversationInfo({
  convo,
  myId,
  pinned,
  onClose,
  onJumpTo,
  onAddMembers,
  onOpenMedia,
  onLeave,
}) {
  const navigate = useNavigate()
  const {
    setMuted, setPinned, setArchived, setDisappearing, patchConvo, watchUsers, enrichAuthor,
  } = useChat()

  const [members, setMembers] = React.useState([])
  const [loadingMembers, setLoadingMembers] = React.useState(false)
  const [membersHidden, setMembersHidden] = React.useState(false)
  const [invite, setInvite] = React.useState(null)
  const [media, setMedia] = React.useState([])
  const [savingSettings, setSavingSettings] = React.useState(false)
  const [savingTtl, setSavingTtl] = React.useState(false)
  const [showAllMembers, setShowAllMembers] = React.useState(false)
  /* null | 'title' | 'description' — which moderated field is open for editing
     in the hero. One at a time, and never both, because they are two separate
     PATCHes (see saveTitle/saveDescription) and a single "editing" flag makes
     that structural rather than something each handler has to remember. */
  const [editingField, setEditingField] = React.useState(null)
  const { openable, viewer } = useImageViewer()   // the hero photo opens full-screen

  /* Call history for this thread. `useCallStats` re-reads on every write to
     the log, so ending a call updates the panel behind the overlay. */
  const callStats = useCallStats(convo?.id || null)
  const allCallsHere = useConversationCalls(convo?.id || null)
  // Newest first, and only the last handful: this is a summary, and the
  // timeline already carries every call in its own place.
  const recentCalls = React.useMemo(() => allCallsHere.slice(-6).reverse(), [allCallsHere])
  const clearCalls = React.useCallback(async () => {
    const ok = await uiConfirm({
      title: 'Clear call history?',
      message: 'This removes the call cards from this conversation on this device. Nobody else is affected.',
      danger: true,
      confirmLabel: 'Clear',
    })
    if (ok) clearCallsFor(convo?.id)
  }, [convo])

  /* Every other chat panel closes on Escape (search, modals, the lightbox);
     this one is a full-screen sheet below 900px, so without it a keyboard or
     screen-reader user had no way out at all. */
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.() } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const isGroup = !!convo?.isGroup
  const settings = convo?.settings || {}
  const myRole = convo?.myRole || 'MEMBER'
  /* Either party may set the timer in a DM; a group needs CHANGE_SETTINGS,
     which is admins-only by default. Same rule the server enforces. */
  const canSetTimer = !!convo && (!isGroup || can('CHANGE_SETTINGS', myRole, settings))

  /* The panel's single danger row, decided where every other surface decides
     it. `leaveIntentOf.allowed` is the whole rule; whoever it refuses falls to
     DELETE, which for an owner destroys the room and for a DM just clears it.
     ChatPage's `onLeave` asks the same pair, so the button and the call it
     makes can never drift apart. */
  const dangerIntent = React.useMemo(() => {
    const leave = leaveIntentOf(convo)
    return leave.allowed
      ? { ...leave, icon: 'logout' }
      : { ...deleteIntentOf(convo), icon: 'trash' }
  }, [convo])

  /* ----- roster ----- */
  // Both inputs are hoisted to primitives so the declared deps and the ones the
  // compiler infers agree — a bare `convo` dep would refetch on every inbox tick.
  const convoId = convo?.id
  const isChannel = !!convo?.isChannel
  const loadMembers = React.useCallback(async () => {
    if (!isGroup || !convoId) return
    setLoadingMembers(true)
    setMembersHidden(false)
    try {
      // A group may hold up to 256 members (the eager-fan-out cutoff), so the
      // page size has to cover the whole roster or an admin silently loses
      // the tail of their own group.
      const res = await api.chat.members.list(convoId, { page: 0, size: 256 })
      // owner → admins → members, each alphabetical; departed members drop out
      const rank = { OWNER: 0, ADMIN: 1, MEMBER: 2 }
      setMembers(res.items
        .filter(m => m.status === 'ACTIVE' || m.status === 'RESTRICTED')
        .sort((a, b) => (rank[a.role] - rank[b.role]) || a.username.localeCompare(b.username)))
    } catch (e) {
      /* A channel with `hiddenSubscribers` answers 403 SUBSCRIBERS_HIDDEN for
         everyone below admin — that is the setting doing its job, not a
         failure, so the panel says so instead of raising an error toast. */
      if (isChannel && e?.status === 403) { setMembers([]); setMembersHidden(true) }
      else showToast(chatError(e, 'Could not load members'))
    } finally {
      setLoadingMembers(false)
    }
  }, [isGroup, isChannel, convoId])

  React.useEffect(() => { loadMembers() }, [loadMembers])

  // Resolve every visible roster avatar in one coalesced burst, plus the DM peer.
  React.useEffect(() => {
    const ids = members.map(m => m.userId).filter(Boolean)
    if (convo?.peer?.id) ids.push(convo.peer.id)
    if (ids.length) watchUsers(ids)
  }, [members, convo?.peer?.id, watchUsers])

  /* ----- shared media -----
     The dedicated `media_by_conversation` index (`GET /conversations/{id}/media`)
     — one row per attachment, newest first, no timeline scan, so the strip is
     right even when the last 60 messages were all text. One request per kind;
     an album arrives once, as its message. Falls back to scanning the recent
     page on a deploy without the endpoint. */
  React.useEffect(() => {
    let alive = true
    if (!convo?.id) return undefined
    const flat = (msgs) => {
      const assets = []
      for (const m of msgs) {
        for (const md of m.media || []) {
          if (md.kind === 'IMAGE' || md.kind === 'VIDEO') assets.push({ ...md, _at: m.createdAt || '' })
        }
      }
      return assets
    }
    Promise.all([
      api.chat.messages.media(convo.id, { kind: 'IMAGE', limit: 12 }),
      api.chat.messages.media(convo.id, { kind: 'VIDEO', limit: 12 }),
    ])
      .then(([imgs, vids]) => {
        if (!alive) return
        setMedia(flat([...imgs, ...vids])
          .sort((a, b) => (a._at < b._at ? 1 : a._at > b._at ? -1 : 0))
          .slice(0, 12))
      })
      .catch(() => {
        if (!alive) return
        api.chat.messages.page(convo.id, { limit: 60 })
          .then(res => { if (alive) setMedia(flat(res.items).slice(0, 12)) })
          .catch(() => {})
      })
    return () => { alive = false }
  }, [convo?.id])

  const saveSettings = async (patch) => {
    if (savingSettings) return
    setSavingSettings(true)
    const before = convo.settings
    patchConvo(convo.id, { settings: { ...settings, ...patch } })
    try {
      const updated = await api.chat.conversations.update(convo.id, { settings: { ...settings, ...patch } })
      if (updated) patchConvo(convo.id, { settings: updated.settings })
    } catch (e) {
      patchConvo(convo.id, { settings: before })
      showToast(chatError(e, 'Could not update group settings'))
    } finally {
      setSavingSettings(false)
    }
  }

  /* Both savers THROW on failure — that is how <InfoEdit/> knows to keep the
     box open with the text still in it. Both also send their field ON ITS OWN,
     never bundled with anything else: `PATCH /conversations/{id}` is
     @Transactional and screens the text before applying anything, so a title
     that is refused OR merely held rolls back the whole request. A rename sent
     together with, say, an `avatarKey` would lose the avatar to a verdict that
     had nothing to do with it. */
  const saveTitle = async (raw) => {
    const title = (raw || '').trim()
    if (!title || title === convo.title) { setEditingField(null); return }
    try {
      const updated = await api.chat.conversations.update(convo.id, { title })
      if (updated) patchConvo(convo.id, { title: updated.title, displayTitle: updated.displayTitle })
      setEditingField(null)
      showToast('Group renamed')
    } catch (e) {
      if (!isModerationError(e)) showToast(chatError(e, 'Could not rename the group'))
      throw e
    }
  }

  const saveDescription = async (raw) => {
    // An empty STRING is a deliberate clear, which the API accepts as "";
    // only "unchanged" is a no-op, or the field could never be emptied.
    const value = (raw || '').trim().slice(0, 500)
    if (value === (convo.description || '')) { setEditingField(null); return }
    try {
      const updated = await api.chat.conversations.update(convo.id, { description: value })
      patchConvo(convo.id, { description: updated?.description ?? value })
      setEditingField(null)
      showToast(value ? 'Description updated' : 'Description cleared')
    } catch (e) {
      if (!isModerationError(e)) showToast(chatError(e, 'Could not update the description'))
      throw e
    }
  }

  const makeInvite = async () => {
    try {
      const res = await api.chat.members.createInvite(convo.id, { expiresInHours: 168 })
      setInvite(res)
      showToast('Invite link created')
    } catch (e) {
      showToast(chatError(e, 'Could not create an invite link'))
    }
  }

  const revokeInvite = async () => {
    try {
      await api.chat.members.revokeInvite(convo.id)
      setInvite(null)
      showToast('Invite link revoked')
    } catch (e) {
      showToast(chatError(e, 'Could not revoke the link'))
    }
  }

  const copyInvite = async () => {
    if (!invite?.token) return
    // The server now mints a ready-to-share {base-url}/join/{token} — prefer
    // it (it survives base-url changes); fall back to the local route.
    const url = invite.shareUrl || `${window.location.origin}/join/${invite.token}`
    try { await navigator.clipboard.writeText(url); showToast('Invite link copied') }
    catch { showToast('Could not copy the link') }
  }

  if (!convo) return null

  const peer = isGroup ? null : enrichAuthor(convo.peer, convo.peer?.id)
  const visibleMembers = showAllMembers ? members : members.slice(0, 8)

  return (
    <aside className="chat-info" aria-label="Conversation details">
      <div className="ci-head">
        <h2>{isGroup ? 'Group info' : 'Details'}</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close details">
          <Icon name="close"/>
        </button>
      </div>

      <div className="ci-body">
        {/* ----- hero ----- */}
        <div className="ci-hero">
          <div {...openable(isGroup ? convo.avatarUrl : peer?.profileImage, {
            className: 'ci-hero-av',
            label: isGroup ? 'View the group photo' : `Profile photo of ${convo.displayTitle}`,
          })}>
            {isGroup ? (
              <span className="ci-medallion">
                {convo.avatarUrl ? <img src={convo.avatarUrl} alt=""/> : <Icon name="users"/>}
              </span>
            ) : (
              <Avatar size={84} src={peer?.profileImage || null} initials={peer?.initials || '·'} color={peer?.avc}/>
            )}
          </div>
          <div className="ci-hero-name">
            <span dir="auto">{convo.displayTitle}</span>
            {!isGroup && peer?.verified && <Verify scholar={peer.role === 'SCHOLAR'}/>}
          </div>
          <div className="ci-hero-sub">
            {isGroup
              ? `${convo.memberCount || members.length} ${convo.isChannel ? 'subscriber' : 'member'}${(convo.memberCount || members.length) === 1 ? '' : 's'}`
              : (peer?.handle ? `@${peer.handle}` : '')}
          </div>

          {isGroup && !!convo.description && !editingField && (
            <p className="ci-hero-desc" dir="auto">{convo.description}</p>
          )}

          {/* Keyed on the field so switching from Rename to Edit description
              remounts the editor with the right seed instead of keeping the
              previous value in a box that now claims to hold the other one. */}
          {editingField === 'title' && (
            <InfoEdit
              key="title"
              label="Group name"
              initial={convo.title || ''}
              maxLength={120}
              onSave={saveTitle}
              onCancel={() => setEditingField(null)}
            />
          )}
          {editingField === 'description' && (
            <InfoEdit
              key="description"
              label={convo.isChannel ? 'Channel description' : 'Group description'}
              initial={convo.description || ''}
              multiline
              maxLength={500}
              placeholder="What this conversation is for…"
              onSave={saveDescription}
              onCancel={() => setEditingField(null)}
            />
          )}

          <div className="ci-hero-actions">
            {!isGroup && peer?.id && (
              <button type="button" className="rq-btn" onClick={() => navigate(`/u/${peer.id}`)}>
                View profile
              </button>
            )}
            {isGroup && !editingField && can('EDIT_INFO', myRole, settings) && (
              <button type="button" className="rq-btn" onClick={() => setEditingField('title')}>Rename</button>
            )}
            {isGroup && !editingField && can('EDIT_INFO', myRole, settings) && (
              <button type="button" className="rq-btn" onClick={() => setEditingField('description')}>
                {convo.description ? 'Edit description' : 'Add description'}
              </button>
            )}
            {isGroup && !convo.isChannel && can('ADD_MEMBERS', myRole, settings) && (
              <button type="button" className="rq-btn primary" onClick={onAddMembers}>Add people</button>
            )}
          </div>
        </div>

        {/* ----- personal toggles ----- */}
        <div className="ci-section">
          <div className="ci-label">Notifications</div>
          <div className="ci-row">
            <Icon name={convo.muted ? 'bell_off' : 'bell'}/>
            <div className="ci-row-body">
              <div className="ci-row-title">Mute this conversation</div>
              <div className="ci-row-sub">Unread counts still update; the bell stays quiet.</div>
            </div>
            <Switch
              on={convo.muted}
              label="Mute this conversation"
              onChange={(v) => setMuted(convo.id, v ? new Date(Date.now() + 365 * 86400000).toISOString() : null)}
            />
          </div>
          <div className="ci-row">
            <Icon name="pin"/>
            <div className="ci-row-body">
              <div className="ci-row-title">Pin to the top</div>
            </div>
            <Switch on={convo.pinned} label="Pin to the top" onChange={(v) => setPinned(convo.id, v)}/>
          </div>
          <div className="ci-row">
            <Icon name="archive"/>
            <div className="ci-row-body">
              <div className="ci-row-title">Archive</div>
            </div>
            <Switch on={convo.archived} label="Archive" onChange={(v) => setArchived(convo.id, v)}/>
          </div>
        </div>

        {/* ----- disappearing messages ----- */}
        {canSetTimer && (
          <div className="ci-section">
            <div className="ci-label">Disappearing messages</div>
            <div className="ci-row">
              <Icon name="hourglass"/>
              <div className="ci-row-body">
                <div className="ci-row-title">Auto-delete new messages</div>
                {/* The rule that surprises people: this is NOT retroactive and
                    it is NOT per-user. Say both, right where they choose. */}
                <div className="ci-row-sub">
                  Applies to everyone in this {convo.isGroup ? 'group' : 'chat'} and only to
                  messages sent from now on. Existing messages stay.
                </div>
              </div>
              <select
                className="ci-select"
                aria-label="Disappearing messages timer"
                value={String(convo.disappearingSeconds || 0)}
                disabled={savingTtl}
                onChange={async (e) => {
                  setSavingTtl(true)
                  try { await setDisappearing(convo.id, Number(e.target.value)) }
                  catch { /* the context rolls back and toasts */ }
                  finally { setSavingTtl(false) }
                }}
              >
                {TTL_OPTIONS.map(o => (
                  <option key={o.value} value={String(o.value)}>{o.label}</option>
                ))}
              </select>
            </div>
            {convo.disappearingSeconds > 0 && (
              <p className="ci-note">
                <Icon name="info" className="xs"/>
                Disappearing messages are not indexed for search, and the inbox
                preview and push notification show a neutral placeholder rather
                than the text.
              </p>
            )}
          </div>
        )}

        {/* ----- pinned messages ----- */}
        {!!(pinned || []).length && (
          <div className="ci-section">
            <div className="ci-label">Pinned <span className="ci-label-n">· {pinned.length}</span></div>
            {pinned.map(p => (
              <button key={p.id} type="button" className="ci-pin" onClick={() => onJumpTo?.(p.id)}>
                <div className="ci-pin-who">{p.sender?.full || p.sender?.handle || 'Message'}</div>
                <div className="ci-pin-txt" dir="auto">
                  {p.body || (p.media?.[0]
                    ? { IMAGE: 'Photo', VIDEO: 'Video', VOICE: 'Voice message', FILE: 'File' }[p.media[0].kind]
                    : 'Message')}
                </div>
              </button>
            ))}
          </div>
        )}

        {/* ----- call history -----
            Counts and talk time for this thread, from the local log (see
            callLog.js): the API has no call-history endpoint, so this is the
            only record that exists — and the copy says "on this device"
            rather than implying it is the account's full history. */}
        {callStats.total > 0 && (
          <div className="ci-section">
            <div className="ci-label">
              Calls <span className="ci-label-n">· {callStats.total}</span>
            </div>
            <div className="ci-callstats">
              <div className="ci-stat">
                <b>{callStats.total}</b>
                <span>{callStats.total === 1 ? 'call' : 'calls'}</span>
              </div>
              <div className="ci-stat">
                <b>{talkTime(callStats.talkMs)}</b>
                <span>on the line</span>
              </div>
              <div className={'ci-stat' + (callStats.missed ? ' warn' : '')}>
                <b>{callStats.missed}</b>
                <span>missed</span>
              </div>
            </div>
            <div className="ci-callsplit">
              <Icon name="phoneout" className="xs"/>{callStats.outgoing} outgoing
              <span className="ci-dot">·</span>
              <Icon name="phonein" className="xs"/>{callStats.incoming} incoming
            </div>
            <div className="ci-calllist">
              {recentCalls.map(e => {
                const d = describeCall(e)
                return (
                  <div key={e.id} className={'ci-callrow tone-' + d.tone}>
                    <Icon name={d.icon} className="sm"/>
                    <span className="ci-callrow-t">{d.title}</span>
                    <span className="ci-callrow-w">
                      {new Date(e.endedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                      {d.detail && <> · {d.detail}</>}
                    </span>
                  </div>
                )
              })}
            </div>
            <div className="ci-note">
              <Icon name="info" className="xs"/>
              <span>Call history is kept on this device only — the server does not store one.</span>
            </div>
            <button type="button" className="ci-row click" onClick={clearCalls}>
              <Icon name="eyeoff"/>
              <div className="ci-row-body"><div className="ci-row-title">Clear call history</div></div>
            </button>
          </div>
        )}

        {/* ----- shared media ----- */}
        {!!media.length && (
          <div className="ci-section">
            <div className="ci-label">Shared media</div>
            <div className="ci-grid">
              {media.map((m, i) => (
                <button
                  key={m.storageKey || i}
                  type="button"
                  className="ci-grid-item"
                  onClick={() => onOpenMedia?.(media, i)}
                  aria-label={m.kind === 'VIDEO' ? 'Open video' : 'Open image'}
                >
                  {m.kind === 'VIDEO'
                    ? <video src={m.url || undefined} poster={m.thumbnailUrl || undefined} muted preload="metadata"/>
                    : <img src={m.thumbnailUrl || m.url || undefined} alt="" loading="lazy"/>}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ----- group settings ----- */}
        {isGroup && can('CHANGE_SETTINGS', myRole, settings) && (
          <div className="ci-section">
            <div className="ci-label">{convo.isChannel ? 'Channel permissions' : 'Group permissions'}</div>
            {convo.isChannel && (
              <p className="ci-note">
                <Icon name="info" className="xs"/>
                A channel broadcasts: only owners and admins post. Promote a
                subscriber to admin below to let them publish too.
              </p>
            )}

            <div className="ci-row">
              <Icon name="send"/>
              <div className="ci-row-body">
                <div className="ci-row-title">Who can send messages</div>
              </div>
              <ScopeSelect
                value={settings.sendMode}
                label="Who can send messages"
                disabled={savingSettings}
                onChange={(v) => saveSettings({ sendMode: v })}
              />
            </div>

            <div className="ci-row">
              <Icon name="follow"/>
              <div className="ci-row-body">
                <div className="ci-row-title">Who can add members</div>
              </div>
              <ScopeSelect
                value={settings.whoCanAddMembers}
                label="Who can add members"
                disabled={savingSettings}
                onChange={(v) => saveSettings({ whoCanAddMembers: v })}
              />
            </div>

            <div className="ci-row">
              <Icon name="edit"/>
              <div className="ci-row-body">
                <div className="ci-row-title">Who can edit the group</div>
              </div>
              <ScopeSelect
                value={settings.whoCanEditInfo}
                label="Who can edit group info"
                disabled={savingSettings}
                onChange={(v) => saveSettings({ whoCanEditInfo: v })}
              />
            </div>

            <div className="ci-row">
              <Icon name="pin"/>
              <div className="ci-row-body">
                <div className="ci-row-title">Who can pin messages</div>
              </div>
              <ScopeSelect
                value={settings.whoCanPin}
                label="Who can pin messages"
                disabled={savingSettings}
                onChange={(v) => saveSettings({ whoCanPin: v })}
              />
            </div>

            {myRole === 'OWNER' && (
              <div className="ci-row">
                <Icon name="crown"/>
                <div className="ci-row-body">
                  <div className="ci-row-title">Admins can promote</div>
                  <div className="ci-row-sub">Let admins make other members admins.</div>
                </div>
                <Switch
                  on={settings.adminsCanPromote}
                  label="Admins can promote"
                  onChange={(v) => saveSettings({ adminsCanPromote: v })}
                />
              </div>
            )}

            <div className="ci-row">
              <Icon name="clock"/>
              <div className="ci-row-body">
                <div className="ci-row-title">New members see history</div>
                <div className="ci-row-sub">Off hides everything sent before someone joined.</div>
              </div>
              <Switch
                on={settings.historyVisibleToNewMembers !== false}
                label="New members see history"
                onChange={(v) => saveSettings({ historyVisibleToNewMembers: v })}
              />
            </div>
          </div>
        )}

        {/* ----- invite link -----
            Groups AND channels: a PRIVATE channel has no public @handle URL,
            so an invite link is the only way to share it (the backend now
            accepts CHANNEL-typed conversations on the invite endpoints). */}
        {(isGroup || convo.isChannel) && can('CREATE_INVITE', myRole, settings) && (
          <div className="ci-section">
            <div className="ci-label">Invite link</div>
            <div className="ci-invite">
              {invite?.token ? (
                <>
                  <div className="ci-invite-token">{invite.shareUrl || `${window.location.origin}/join/${invite.token}`}</div>
                  <div className="ci-row-sub" style={{ marginBottom: 8 }}>
                    Shown once — copy it now. Creating a new link revokes this one.
                  </div>
                  <div className="ci-invite-actions">
                    <button type="button" className="rq-btn primary" onClick={copyInvite}>Copy link</button>
                    <button type="button" className="rq-btn" onClick={makeInvite}>Regenerate</button>
                    <button type="button" className="rq-btn danger" onClick={revokeInvite}>Revoke</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="ci-row-sub" style={{ marginBottom: 9 }}>
                    Create a link anyone can use to join this {convo.isChannel ? 'channel' : 'group'}. It expires in 7 days.
                  </div>
                  <div className="ci-invite-actions">
                    <button type="button" className="rq-btn primary" onClick={makeInvite}>Create link</button>
                    <button type="button" className="rq-btn" onClick={revokeInvite}>Revoke existing</button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* ----- roster ----- */}
        {isGroup && (
          <div className="ci-section">
            <div className="ci-label">
              {convo.isChannel ? 'Subscribers' : 'Members'}
              <span className="ci-label-n">· {convo.memberCount || members.length}</span>
            </div>
            {loadingMembers && !members.length && !membersHidden && <Loader label="Loading members…"/>}
            {membersHidden && (
              <p className="ci-note">
                <Icon name="eyeoff" className="xs"/>
                This channel keeps its subscriber list private — only its admins
                can see who is here. The count above stays public.
              </p>
            )}
            {visibleMembers.map(m => (
              <MemberRow
                key={m.userId}
                member={m}
                convo={convo}
                myId={myId}
                onChanged={loadMembers}
              />
            ))}
            {members.length > 8 && (
              <button
                type="button"
                className="ci-row click"
                onClick={() => setShowAllMembers(v => !v)}
              >
                <Icon name={showAllMembers ? 'chevup' : 'chevdown'}/>
                <div className="ci-row-body">
                  <div className="ci-row-title">
                    {showAllMembers ? 'Show fewer' : `Show all ${members.length} members`}
                  </div>
                </div>
              </button>
            )}
          </div>
        )}

        {/* ----- danger zone ----- */}
        <div className="ci-section">
          {/* A single message is reported from its own menu; this reports the
              PERSON, which is what someone being harassed across a whole thread
              actually needs. Groups have no reportable target type, so the row
              is DM-only. */}
          {!isGroup && peer?.id && (
            <button type="button" className="ci-row click"
              onClick={() => openReport({
                targetType: 'USER', targetId: peer.id,
                targetLabel: peer.handle ? '@' + peer.handle : 'this account',
              })}>
              <Icon name="flag"/>
              <div className="ci-row-body">
                <div className="ci-row-title">Report {peer.handle ? '@' + peer.handle : 'this account'}</div>
                {/* Same promise the dialog makes, worded the same way: the
                    REPORTED person never learns who filed it. Moderators do —
                    ReportService stores reporterId — so "nobody is told" would
                    be a claim the server does not keep. */}
                <div className="ci-row-sub">Moderators review it. Your name is never shown to the person you report.</div>
              </div>
            </button>
          )}
          {/* ONE row, and it never names its own verb. Leave vs delete, group
              vs channel, "for me" vs "for everyone" — all four turn on rules
              that live in conversationActions (a channel owner may never
              leave; a group owner may only when alone), and `onLeave` in
              ChatPage re-asks the same helper for the endpoint. Hard-coding
              "Leave group" here is how a channel owner used to be shown a
              button that could only 403. */}
          <button type="button" className="ci-row click danger" onClick={onLeave}>
            <Icon name={dangerIntent.icon}/>
            <div className="ci-row-body">
              <div className="ci-row-title">{dangerIntent.label}</div>
              <div className="ci-row-sub">{dangerIntent.sub}</div>
            </div>
          </button>
        </div>
      </div>
      {viewer}
    </aside>
  )
}

export default ConversationInfo
