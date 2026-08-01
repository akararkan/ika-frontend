/* =========================================================
   New conversation — direct message or group.
   ---------------------------------------------------------
   Direct picks a user and calls openDirect(), which is a
   get-or-create on the backend (deterministic direct_key), so
   picking someone you already have a thread with just opens it.

   There is deliberately NO group-avatar control: the backend
   takes an `avatarKey` from the media pipeline and chat has no
   upload endpoint of its own, so a picker here would be a dead
   button. The group can be renamed/re-imaged from its info panel.
   ========================================================= */
import React from 'react'
import { Icon, Avatar, Verify, showToast } from '../ui.jsx'
import { Loader, EmptyState } from '../states.jsx'
import { useChat } from '../../context/ChatContext.jsx'
import { chatError } from './chatErrors.js'
import { api } from '../../api/index.js'

/* Two different caps, because they are two different endpoints:
     · creating a group seeds `memberIds`, capped at 256 (the conversation's
       own member ceiling — the creator is excluded automatically);
     · adding to an existing group is `AddMembersRequest.userIds`, capped at
       **100 per call**.
   The picker is shared between both modes, so using one number silently let
   an admin select 150 people and then eat a BAD_REQUEST on submit. */
const MAX_SEED_MEMBERS = 256
const MAX_ADD_PER_CALL = 100

/* The shared catalog owns every documented `errorCode`; this only supplies the
   fallback for an undocumented one. BAD_REQUEST deliberately falls through to
   the server's own message — "title must not be blank" is more useful than
   anything generic this file could write. */
const humanError = (e) => chatError(e, 'Check the group name and members.')

function UserRow({ u, selected, onPick }) {
  return (
    <button type="button" className={'ch-urow' + (selected ? ' on' : '')} onClick={() => onPick(u)}>
      <Avatar initials={u.initials} color={u.avc} size={36} src={u.profileImage}/>
      <span className="ch-urow-main">
        <span className="ch-urow-nm" dir="auto">
          {u.full}{u.verified && <Verify scholar={u.role === 'SCHOLAR'}/>}
        </span>
        <small dir="auto">@{u.handle}</small>
      </span>
      {selected && <Icon name="check" className="sm"/>}
    </button>
  )
}

export function NewChatModal({ onClose, onCreated, mode = 'new', conversation }) {
  const { openDirect, createGroup } = useChat()
  // 'add' reuses the whole picker but commits to an existing group instead of
  // creating one, so the tab strip and the direct branch are suppressed.
  const isAdd = mode === 'add'
  const [tab, setTab] = React.useState(isAdd ? 'group' : 'direct')
  const [q, setQ] = React.useState('')
  const [results, setResults] = React.useState([])
  const [searching, setSearching] = React.useState(false)
  const [picked, setPicked] = React.useState([])          // group members
  const [title, setTitle] = React.useState('')
  const [desc, setDesc] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const boxRef = React.useRef(null)
  const firstRef = React.useRef(null)

  React.useEffect(() => { firstRef.current?.focus() }, [tab])

  // Escape closes; body scroll is locked while the sheet is up.
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose?.() }
      if (e.key !== 'Tab') return
      // Focus trap — keep tabbing inside the dialog.
      const nodes = boxRef.current?.querySelectorAll(
        'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')
      if (!nodes?.length) return
      const list = [...nodes].filter(n => !n.disabled && n.offsetParent !== null)
      const first = list[0], last = list[list.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey, true)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  // Debounced people search; empty query falls back to the suggestion feed.
  React.useEffect(() => {
    const needle = q.trim()
    let alive = true
    setSearching(true)
    const t = setTimeout(() => {
      const run = needle ? api.users.searchList(needle, { size: 20 }) : api.users.suggestions({ limit: 20 })
      Promise.resolve(run)
        .then(rows => { if (alive) setResults(rows || []) })
        .catch(() => { if (alive) setResults([]) })
        .finally(() => { if (alive) setSearching(false) })
    }, 300)
    return () => { alive = false; clearTimeout(t) }
  }, [q])

  const startDirect = async (u) => {
    if (busy) return
    setBusy(true)
    try { onCreated?.(await openDirect(u.id)) }
    catch (e) { showToast(humanError(e)) }
    finally { setBusy(false) }
  }

  const maxPick = isAdd ? MAX_ADD_PER_CALL : MAX_SEED_MEMBERS

  const toggleMember = (u) => {
    setPicked(prev => prev.some(p => p.id === u.id)
      ? prev.filter(p => p.id !== u.id)
      : (prev.length >= maxPick
          ? (showToast(isAdd
              ? `You can add up to ${MAX_ADD_PER_CALL} people at a time.`
              : `A group can start with at most ${MAX_SEED_MEMBERS} members.`), prev)
          : [...prev, u]))
  }

  const submitGroup = async (e) => {
    e.preventDefault()
    if (busy) return
    if (isAdd) {
      if (!picked.length) { showToast('Pick at least one person.'); return }
      setBusy(true)
      try {
        await api.chat.members.add(conversation.id, picked.map(p => p.id))
        showToast(`Added ${picked.length} ${picked.length === 1 ? 'person' : 'people'}`)
        onCreated?.(conversation)
      } catch (err) { showToast(humanError(err)) }
      finally { setBusy(false) }
      return
    }
    if (!title.trim()) { showToast('Give the group a name.'); return }
    setBusy(true)
    try {
      onCreated?.(await createGroup({
        title: title.trim(),
        // Optional and ≤ 500 chars server-side; `undefined` (not '') so an
        // untouched field is absent from the body rather than clearing.
        description: desc.trim() ? desc.trim().slice(0, 500) : undefined,
        memberIds: picked.map(p => p.id),
      }))
    } catch (err) { showToast(humanError(err)) }
    finally { setBusy(false) }
  }

  return (
    <div className="ch-modal-overlay" role="dialog" aria-modal="true"
      aria-label={isAdd ? 'Add people to the group' : 'New conversation'}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="ch-modal" ref={boxRef}>
        <div className="ch-modal-head">
          <h3>
            {isAdd
              ? <>Add <em>people</em></>
              : <>New <em>conversation</em></>}
          </h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close">
            <Icon name="close" className="sm"/>
          </button>
        </div>

        {!isAdd && (
          <div className="tabs ch-modal-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'direct'} ref={tab === 'direct' ? firstRef : null}
              className={'tab' + (tab === 'direct' ? ' on' : '')}
              onClick={() => setTab('direct')}>Direct message</button>
            <button role="tab" aria-selected={tab === 'group'}
              className={'tab' + (tab === 'group' ? ' on' : '')}
              onClick={() => setTab('group')}>New group</button>
          </div>
        )}

        <div className="ch-modal-body">
          {tab === 'group' && (
            <>
              {!isAdd && (
                <>
                  <label className="field-label" htmlFor="ch-gname">Group name</label>
                  <input id="ch-gname" className="field" value={title} maxLength={120} dir="auto"
                    onChange={e => setTitle(e.target.value)} placeholder="e.g. Fiqh Study Circle"/>
                  <label className="field-label" htmlFor="ch-gdesc">
                    Description <small style={{ fontWeight: 400, opacity: .7 }}>optional</small>
                  </label>
                  <textarea id="ch-gdesc" className="field" rows={2} value={desc} maxLength={500} dir="auto"
                    onChange={e => setDesc(e.target.value)} placeholder="Weekly readings & discussion"/>
                </>
              )}
              {picked.length > 0 && (
                <div className="ch-chips">
                  {picked.map(p => (
                    <span key={p.id} className="chip on">
                      {p.full}
                      <button type="button" onClick={() => toggleMember(p)}
                        aria-label={`Remove ${p.full}`} className="ch-chip-x">
                        <Icon name="close" className="xs"/>
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </>
          )}

          <div className="ch-search-field">
            <Icon name="search" className="sm"/>
            <input className="field" value={q} onChange={e => setQ(e.target.value)}
              ref={tab === 'group' && !isAdd ? null : firstRef}
              placeholder={tab === 'direct' ? 'Search people…' : 'Add people…'}
              aria-label={tab === 'direct' ? 'Search people' : 'Add people'}/>
          </div>

          <div className="ch-ulist">
            {searching && <Loader label="Searching…"/>}
            {!searching && results.length === 0 && (
              <EmptyState icon="user" title="No people found" sub="Try another name or @handle."/>
            )}
            {!searching && results.map(u => (
              <UserRow key={u.id} u={u}
                selected={tab === 'group' && picked.some(p => p.id === u.id)}
                onPick={tab === 'direct' ? startDirect : toggleMember}/>
            ))}
          </div>
        </div>

        {tab === 'group' && (
          <div className="ch-modal-foot">
            <span className="ch-modal-count">
              {/* Show the ceiling once you are near it, so hitting the cap is
                  never a surprise toast on the 101st pick. */}
              {picked.length
                ? `${picked.length} selected${picked.length >= maxPick - 10 ? ` of ${maxPick}` : ''}`
                : isAdd ? 'Pick who to add.' : 'No members yet — you can add them later.'}
            </span>
            <button className="btn btn-primary" onClick={submitGroup}
              disabled={busy || (isAdd ? !picked.length : !title.trim())}>
              {busy ? (isAdd ? 'Adding…' : 'Creating…') : isAdd ? 'Add to group' : 'Create group'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default NewChatModal
