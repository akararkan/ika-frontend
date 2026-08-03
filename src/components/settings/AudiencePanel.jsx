/* =========================================================
   Settings v2 — custom audiences (privacy lists). These are
   the named lists the CUSTOM visibility level resolves
   against: name a list, add people, then pick “Custom lists”
   for any field in Privacy. Members arrive as bare UUIDs and
   are hydrated client-side; failures are dropped, not errors.

   THE TRAP THIS CARD HAS TO TELL THE TRUTH ABOUT: the lists
   are NOT picked one at a time. VisibilityResolver resolves
   CUSTOM with isInAnyCustomList(owner, viewer) — membership in
   ANY custom list allows the field — and SetVisibilityRequest
   carries only `visibility`, so no per-field binding exists.
   Every list therefore widens every CUSTOM field, which is why
   the deduplicated union is shown above the stack.
   ========================================================= */
import React from 'react'
import { Icon, Avatar, showToast } from '../ui.jsx'
import { uiConfirm, uiPrompt } from '../Dialog.jsx'
import { EmptyState, Loader, ErrorState } from '../states.jsx'
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

const LISTS_SUB = 'Name a list and add people to it, then pick Custom lists as a visibility level in Privacy. ' +
  'All of your custom lists count as one audience — anyone on any list can see a field set to Custom lists.'

export function AudiencePanel() {
  const [lists, setLists] = React.useState(null)      // null = loading
  const [error, setError] = React.useState(false)
  const [idsMap, setIdsMap] = React.useState({})      // listId → UUID[] · false = unreadable · absent = loading
  const [usersMap, setUsersMap] = React.useState({})  // listId → hydrated users
  const [openId, setOpenId] = React.useState(null)
  const [q, setQ] = React.useState('')
  const [results, setResults] = React.useState([])
  const [tick, setTick] = React.useState(0)
  const searchSeq = React.useRef(0)                   // typing races: only the newest reply may land

  /* ---- load the lists, then each list's member ids for the counts ---- */
  React.useEffect(() => {
    let alive = true
    setError(false)
    api.settings.privacy.lists.all()
      .then(rows => {
        if (!alive) return
        const custom = (rows || []).filter(r => r.type === 'CUSTOM')
        setLists(custom)
        /* A swallowed roster failure used to leave the row on "Loading…" and an
           open list on a spinner that never resolved — record it as `false`. */
        custom.forEach(l => {
          api.settings.privacy.lists.members(l.id)
            .then(ids => { if (alive) setIdsMap(m => ({ ...m, [l.id]: ids || [] })) })
            .catch(() => { if (alive) setIdsMap(m => ({ ...m, [l.id]: false })) })
        })
      })
      .catch(() => { if (alive) { setError(true); setLists([]) } })
    return () => { alive = false }
  }, [tick])

  const retry = () => { setLists(null); setIdsMap({}); setUsersMap({}); setTick(t => t + 1) }

  /* Re-read one roster. Dropping the key puts the row back on "Loading…", and
     the hydrate effect below fires again once it lands as an array. */
  const retryRoster = (id) => {
    setIdsMap(m => { const next = { ...m }; delete next[id]; return next })
    api.settings.privacy.lists.members(id)
      .then(ids => setIdsMap(m => ({ ...m, [id]: ids || [] })))
      .catch(() => setIdsMap(m => ({ ...m, [id]: false })))
  }

  /* ---- hydrate the open list's members (drop deleted users) ---- */
  React.useEffect(() => {
    if (!openId || usersMap[openId] || !Array.isArray(idsMap[openId])) return
    let alive = true
    Promise.all(idsMap[openId].map(id => api.users.get(id).catch(() => null)))
      .then(us => { if (alive) setUsersMap(m => ({ ...m, [openId]: us.filter(Boolean) })) })
    return () => { alive = false }
  }, [openId, idsMap, usersMap])

  const toggleOpen = (id) => { setOpenId(cur => (cur === id ? null : id)); setQ(''); setResults([]) }

  const searchUsers = (term) => {
    setQ(term)
    const mine = ++searchSeq.current
    if (term.trim()) {
      api.users.searchList(term, { size: 6 })
        .then(r => { if (searchSeq.current === mine) setResults(r) })
        .catch(() => {})
    } else setResults([])
  }

  const createList = async () => {
    const name = await uiPrompt({
      title: 'New audience',
      message: 'Name the list, then add people to it. Everyone on it joins one pooled audience: anyone on any of ' +
        'your custom lists can see every field you set to Custom lists.',
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
    } catch { showToast('Could not create the list', 'err') }
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
        showToast('Could not delete — restored', 'err')
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
        showToast('Could not add — reverted', 'err')
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
        showToast('Could not remove — reverted', 'err')
      })
  }

  if (lists === null) {
    return (
      <SetCard id="lists" icon="users" title="Custom audiences" sub={LISTS_SUB}>
        <Loader label="Loading your audiences…"/>
      </SetCard>
    )
  }

  /* The union is only honest once every roster has landed — a missing one would
     under-state the reach, so the note holds back until then, and says WHY when
     a roster is never coming rather than counting forever. */
  const rosters = lists.map(l => idsMap[l.id])
  const anyRosterFailed = rosters.some(r => r === false)
  const unionSize = rosters.every(Array.isArray)
    ? new Set(rosters.flat()).size
    : null

  return (
    <SetCard id="lists" icon="users" title="Custom audiences" sub={LISTS_SUB}>
      {error ? <ErrorState message="Could not load your audiences" onRetry={retry}/> : (
        <>
          <div className="set-actions" style={{ marginBottom: 12 }}>
            <button className="btn btn-primary btn-sm" onClick={createList}><Icon name="users" className="xs"/>New list</button>
          </div>
          {lists.length > 0 && (
            <p className={'stx-note ' + (unionSize === 0 ? 'warn' : 'info')} style={{ margin: '0 0 12px' }}>
              <Icon name={unionSize === 0 ? 'alert' : 'info'} className="xs"/>
              <span>
                {unionSize == null
                  ? (anyRosterFailed
                      ? `${lists.length} ${lists.length === 1 ? 'list' : 'lists'} — one of them could not be read, so the head count is unavailable.`
                      : `${lists.length} ${lists.length === 1 ? 'list' : 'lists'} — counting the people on them…`)
                  : unionSize === 0
                    ? `Your ${lists.length === 1 ? 'list is' : 'lists are'} empty, so anything set to Custom lists is visible to nobody.`
                    : `${unionSize} ${unionSize === 1 ? 'person' : 'people'} across ${lists.length} ${lists.length === 1 ? 'list' : 'lists'} can see anything you set to Custom lists — someone on two lists is counted once.`}
              </span>
            </p>
          )}
          {lists.length ? (
            <div className="rail-list">
              {lists.map(l => {
                const ids = Array.isArray(idsMap[l.id]) ? idsMap[l.id] : null
                const rosterFailed = idsMap[l.id] === false
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
                          {ids ? `${ids.length} ${ids.length === 1 ? 'person' : 'people'}`
                            : rosterFailed ? 'Members unavailable' : 'Loading…'}
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
                        {/* An unreadable roster hides the whole editor, not just the list:
                            with no member ids there is nothing to dedupe the search against,
                            and an optimistic add would print a member count ("1 person") that
                            is a guess. Retry first, then edit. */}
                        {rosterFailed ? (
                          <ErrorState message="Could not load the people on this list" onRetry={() => retryRoster(l.id)}/>
                        ) : (<>
                        {/* `.stx-search`, not the chat `.cmt-box`: at ≤720px the responsive
                            sheet pins a `.card-pad > .cmt-box` to the bottom of the viewport
                            as a composer bar, which detached this field from its list. */}
                        <div className="stx-search">
                          <input className="field" type="search" aria-label={`Search people to add to ${l.name}`}
                            placeholder="Search people to add…" value={q} onChange={e => searchUsers(e.target.value)}/>
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
                        {!members ? <Loader label="Loading members…"/> : members.length ? (
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
                        </>)}
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
