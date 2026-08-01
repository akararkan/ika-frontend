/* =========================================================
   Settings v2 — custom audiences (privacy lists). These are
   the named lists the CUSTOM visibility level resolves
   against: name a list, add people, then pick “Custom lists”
   for any field in Privacy. Members arrive as bare UUIDs and
   are hydrated client-side; failures are dropped, not errors.
   ========================================================= */
import React from 'react'
import { Icon, Avatar, showToast } from '../ui.jsx'
import { uiConfirm, uiPrompt } from '../Dialog.jsx'
import { EmptyState, ErrorState } from '../states.jsx'
import { api } from '../../api/index.js'
import { SetCard, fmtDate } from './shared.jsx'

/* Optimistic reverts here are per-row and functional rather than a restore
   of a snapshot taken before the request: two overlapping edits would make
   the older snapshot discard the newer edit. Put the one row back roughly
   where it was, and never twice. */
function putBack(arr, item, at, isSame) {
  if (arr.some(isSame)) return arr
  const i = at < 0 ? arr.length : Math.min(at, arr.length)
  return [...arr.slice(0, i), item, ...arr.slice(i)]
}

export function AudiencePanel() {
  const [lists, setLists] = React.useState(null)      // null = loading
  const [error, setError] = React.useState(false)
  const [idsMap, setIdsMap] = React.useState({})      // listId → bare UUID[]
  const [usersMap, setUsersMap] = React.useState({})  // listId → hydrated users
  const [openId, setOpenId] = React.useState(null)
  const [q, setQ] = React.useState('')
  const [results, setResults] = React.useState([])

  /* ---- load the lists, then each list's member ids for the counts ---- */
  React.useEffect(() => {
    let alive = true
    api.settings.privacy.lists.all()
      .then(rows => {
        if (!alive) return
        const custom = (rows || []).filter(r => r.type === 'CUSTOM')
        setLists(custom)
        custom.forEach(l => {
          api.settings.privacy.lists.members(l.id)
            .then(ids => { if (alive) setIdsMap(m => ({ ...m, [l.id]: ids || [] })) })
            .catch(() => {})
        })
      })
      .catch(() => { if (alive) { setError(true); setLists([]) } })
    return () => { alive = false }
  }, [])

  /* ---- hydrate the open list's members (drop deleted users) ---- */
  React.useEffect(() => {
    if (!openId || usersMap[openId] || !idsMap[openId]) return
    let alive = true
    Promise.all(idsMap[openId].map(id => api.users.get(id).catch(() => null)))
      .then(us => { if (alive) setUsersMap(m => ({ ...m, [openId]: us.filter(Boolean) })) })
    return () => { alive = false }
  }, [openId, idsMap, usersMap])

  const toggleOpen = (id) => { setOpenId(cur => (cur === id ? null : id)); setQ(''); setResults([]) }

  const searchUsers = (term) => {
    setQ(term)
    if (term.trim()) api.users.searchList(term, { size: 6 }).then(setResults).catch(() => {})
    else setResults([])
  }

  const createList = async () => {
    const name = await uiPrompt({
      title: 'New audience',
      message: 'Name the list, then add people to it. It becomes an option wherever you choose the Custom lists visibility level.',
      label: 'List name',
      placeholder: 'e.g. Study group',
      confirmLabel: 'Create',
      icon: 'users',
    })
    if (!name || !name.trim()) return
    try {
      const row = await api.settings.privacy.lists.create(name.trim())
      setLists(ls => [row, ...(ls || [])])
      setIdsMap(m => ({ ...m, [row.id]: [] }))
      setUsersMap(m => ({ ...m, [row.id]: [] }))
      setOpenId(row.id); setQ(''); setResults([])
      showToast('List created')
    } catch { showToast('Could not create the list') }
  }

  const deleteList = async (l) => {
    const ok = await uiConfirm({
      title: 'Delete this list?',
      message: `“${l.name}” and its members will be removed. Content set to this audience will no longer resolve to it.`,
      danger: true,
    })
    if (!ok) return
    const at = (lists || []).findIndex(x => x.id === l.id)
    setLists(ls => (ls || []).filter(x => x.id !== l.id))
    if (openId === l.id) { setOpenId(null); setQ(''); setResults([]) }
    api.settings.privacy.lists.remove(l.id)
      .then(() => showToast('List deleted'))
      .catch(() => {
        setLists(ls => putBack(ls || [], l, at, x => x.id === l.id))
        showToast('Could not delete — restored')
      })
  }

  /* ids drive the member counts and users drive the roster, so both move
     together on every optimistic step — otherwise they drift apart. */
  const addMember = (listId, u) => {
    setUsersMap(m => {
      const cur = m[listId] || []
      return cur.some(x => x.id === u.id) ? m : { ...m, [listId]: [...cur, u] }
    })
    setIdsMap(m => {
      const cur = m[listId] || []
      return cur.includes(u.id) ? m : { ...m, [listId]: [...cur, u.id] }
    })
    api.settings.privacy.lists.addMember(listId, u.id)
      .then(() => showToast(`Added ${u.full.split(' ')[0]}`))
      .catch(() => {
        setUsersMap(m => ({ ...m, [listId]: (m[listId] || []).filter(x => x.id !== u.id) }))
        setIdsMap(m => ({ ...m, [listId]: (m[listId] || []).filter(x => x !== u.id) }))
        showToast('Could not add — reverted')
      })
  }

  const removeMember = (listId, u) => {
    const atUsers = (usersMap[listId] || []).findIndex(x => x.id === u.id)
    const atIds = (idsMap[listId] || []).indexOf(u.id)
    setUsersMap(m => ({ ...m, [listId]: (m[listId] || []).filter(x => x.id !== u.id) }))
    setIdsMap(m => ({ ...m, [listId]: (m[listId] || []).filter(x => x !== u.id) }))
    api.settings.privacy.lists.removeMember(listId, u.id)
      .then(() => showToast('Removed'))
      .catch(() => {
        setUsersMap(m => ({ ...m, [listId]: putBack(m[listId] || [], u, atUsers, x => x.id === u.id) }))
        setIdsMap(m => ({ ...m, [listId]: putBack(m[listId] || [], u.id, atIds, x => x === u.id) }))
        showToast('Could not remove — reverted')
      })
  }

  if (lists === null) {
    return (
      <div className="card card-pad">
        <h3 className="title"><Icon name="users" className="sm"/>Custom audiences</h3>
        <p className="muted text-sm">Loading…</p>
      </div>
    )
  }

  return (
    <SetCard icon="users" title="Custom audiences"
      sub="Name a list and add people to it, then pick Custom lists as a visibility level in Privacy to share only with them.">
      {error ? <ErrorState message="Could not load your audiences"/> : (
        <>
          <div className="set-actions" style={{ marginBottom: 12 }}>
            <button className="btn btn-primary btn-sm" onClick={createList}><Icon name="users" className="xs"/>New list</button>
          </div>
          {lists.length ? (
            <div className="rail-list">
              {lists.map(l => {
                const ids = idsMap[l.id]
                const open = openId === l.id
                const members = usersMap[l.id]
                const memberIds = new Set(ids || [])
                const addable = results.filter(u => !memberIds.has(u.id))
                return (
                  <React.Fragment key={l.id}>
                    <div className="rail-row">
                      <div className="rail-info">
                        <div className="rail-name"><b>{l.name}</b></div>
                        <div className="rail-sub">
                          {ids ? `${ids.length} ${ids.length === 1 ? 'person' : 'people'}` : 'Loading…'}
                          {l.createdAt ? ` · created ${fmtDate(l.createdAt)}` : ''}
                        </div>
                      </div>
                      <button className="btn btn-ghost btn-sm" aria-label={open ? `Collapse ${l.name}` : `Expand ${l.name}`}
                        onClick={() => toggleOpen(l.id)}>
                        <Icon name={open ? 'chevup' : 'chevdown'} className="xs"/>
                      </button>
                      <button className="btn btn-ghost btn-sm" aria-label={`Delete ${l.name}`} onClick={() => deleteList(l)}>
                        <Icon name="trash" className="xs"/>
                      </button>
                    </div>
                    {open && (
                      <div style={{ padding: '4px 0 12px' }}>
                        <div className="cmt-box" style={{ marginTop: 0, marginBottom: 10 }}>
                          <input className="field" placeholder="Search people to add…" value={q} onChange={e => searchUsers(e.target.value)}/>
                        </div>
                        {q && addable.length > 0 && (
                          <div className="rail-list" style={{ marginBottom: 10 }}>
                            {addable.map(u => (
                              <div key={u.id} className="rail-row">
                                <Avatar initials={u.initials} color={u.avc} size={36} src={u.profileImage}/>
                                <div className="rail-info"><div className="rail-name"><b>{u.full}</b></div><div className="rail-sub">@{u.handle}</div></div>
                                <button className="btn btn-primary btn-sm" onClick={() => addMember(l.id, u)}><Icon name="follow" className="xs"/>Add</button>
                              </div>
                            ))}
                          </div>
                        )}
                        {!members ? <p className="muted text-sm">Loading members…</p> : members.length ? (
                          <div className="rail-list">
                            {members.map(u => (
                              <div key={u.id} className="rail-row">
                                <Avatar initials={u.initials} color={u.avc} size={40} src={u.profileImage}/>
                                <div className="rail-info"><div className="rail-name"><b>{u.full}</b></div><div className="rail-sub">@{u.handle}</div></div>
                                <button className="btn btn-secondary btn-sm" onClick={() => removeMember(l.id, u)}>Remove</button>
                              </div>
                            ))}
                          </div>
                        ) : <p className="muted text-sm">No one here yet. Search above to add people.</p>}
                      </div>
                    )}
                  </React.Fragment>
                )
              })}
            </div>
          ) : <EmptyState icon="users" title="No custom audiences yet" sub="Create a list to use the Custom lists visibility level."/>}
        </>
      )}
    </SetCard>
  )
}
