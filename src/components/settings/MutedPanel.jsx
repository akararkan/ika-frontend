/* =========================================================
   Settings v2 — quiet controls: muted accounts and hidden
   keywords (privacy resolver, SETTINGS docs §privacy/muted
   + §privacy/keywords). Muting is silent and idempotent —
   the target is never notified; keywords are normalised
   server-side (Arabic/Kurdish variants + diacritics) and a
   duplicate add returns the EXISTING row.
   ========================================================= */
import React from 'react'
import { Icon, Avatar, showToast } from '../ui.jsx'
import { EmptyState, Loader, ErrorState } from '../states.jsx'
import { api } from '../../api/index.js'
import { SetCard, fmtWhen } from './shared.jsx'

const KEYWORD_LIMIT = 200   // server 400s past it

export function MutedPanel() {
  const [list, setList] = React.useState(null)
  const [error, setError] = React.useState(false)
  const [tick, setTick] = React.useState(0)
  const [q, setQ] = React.useState('')
  const [results, setResults] = React.useState([])
  const mutedIds = new Set((list || []).map(u => u.id))

  /* A failed load must never fall through to the empty state — "No muted
     accounts" reads as "your mutes were deleted", so the list stays null and
     the error branch offers a retry. */
  React.useEffect(() => {
    let alive = true
    setError(false)
    api.settings.mutedUsers()
      .then(r => { if (alive) setList(r || []) })
      .catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [tick])

  const searchUsers = (term) => {
    setQ(term)
    if (term.trim()) api.users.searchList(term, { size: 6 }).then(setResults).catch(() => {})
    else setResults([])
  }

  const mute = (u) => {
    setList(l => [u, ...l])
    setQ(''); setResults([])
    api.settings.privacy.muted.mute(u.id)
      .then(() => showToast(`Muted @${u.handle}`))
      .catch(() => { setList(l => l.filter(x => x.id !== u.id)); showToast('Could not mute — reverted') })
  }

  const unmute = (u) => {
    setList(l => l.filter(x => x.id !== u.id))
    api.settings.privacy.muted.unmute(u.id)
      .then(() => showToast(`Unmuted @${u.handle}`))
      .catch(() => { setList(l => [u, ...l]); showToast('Could not unmute — reverted') })
  }

  if (error && list === null) {
    return (
      <SetCard icon="mute" title="Muted accounts">
        <ErrorState message="Could not load muted accounts" onRetry={() => setTick(t => t + 1)}/>
      </SetCard>
    )
  }
  if (list === null) {
    return (
      <SetCard icon="mute" title="Muted accounts">
        <Loader/>
      </SetCard>
    )
  }

  return (
    <SetCard icon="mute" title="Muted accounts"
      sub="Muting hides someone’s posts, stories, and activity from your feeds. They can still message you, and they are never told.">
      <div className="cmt-box" style={{ marginTop: 0, marginBottom: 12 }}>
        <input className="field" placeholder="Search people to mute…" value={q} onChange={e => searchUsers(e.target.value)}/>
      </div>
      {q && results.filter(u => !mutedIds.has(u.id)).length > 0 && (
        <div className="rail-list" style={{ marginBottom: 12 }}>
          {results.filter(u => !mutedIds.has(u.id)).map(u => (
            <div key={u.id} className="rail-row">
              <Avatar initials={u.initials} color={u.avc} size={36} src={u.profileImage}/>
              <div className="rail-info">
                <div className="rail-name"><b>{u.full}</b></div>
                <div className="rail-sub">@{u.handle}</div>
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => mute(u)}><Icon name="mute" className="xs"/>Mute</button>
            </div>
          ))}
        </div>
      )}
      {list.length ? (
        <div className="rail-list">
          {list.map(u => (
            <div key={u.id} className="rail-row">
              <Avatar initials={u.initials} color={u.avc} size={40} src={u.profileImage}/>
              <div className="rail-info">
                <div className="rail-name"><b>{u.full}</b></div>
                <div className="rail-sub">@{u.handle}</div>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => unmute(u)}>Unmute</button>
            </div>
          ))}
        </div>
      ) : <EmptyState icon="mute" title="No muted accounts" sub="People you mute disappear from your feeds without knowing."/>}
    </SetCard>
  )
}

export function KeywordsPanel() {
  const [rows, setRows] = React.useState(null)
  const [error, setError] = React.useState(false)
  const [tick, setTick] = React.useState(0)
  const [q, setQ] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  /* Same rule as the mute list: a load failure is NOT an empty filter set —
     showing one would suggest the hidden keywords were dropped. */
  React.useEffect(() => {
    let alive = true
    setError(false)
    api.settings.privacy.keywords.all()
      .then(r => { if (alive) setRows(r || []) })
      .catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [tick])

  const add = async () => {
    const keyword = q.trim()
    if (!keyword || busy) return
    if (rows.length >= KEYWORD_LIMIT) { showToast(`You can hide up to ${KEYWORD_LIMIT} keywords`); return }
    setBusy(true)
    try {
      const row = await api.settings.privacy.keywords.add(keyword)
      if (row?.id && rows.some(r => r.id === row.id)) {
        showToast('Already hidden')
      } else if (row?.id) {
        setRows(cur => [row, ...cur])
        showToast('Keyword hidden')
      }
      setQ('')
    } catch {
      showToast('Could not add that keyword')
    } finally {
      setBusy(false)
    }
  }

  const remove = (row) => {
    setRows(cur => cur.filter(r => r.id !== row.id))
    api.settings.privacy.keywords.remove(row.id)
      .then(() => showToast('Keyword removed'))
      .catch(() => { setRows(cur => [row, ...cur]); showToast('Could not remove — reverted') })
  }

  if (error && rows === null) {
    return (
      <SetCard icon="eyeoff" title="Hidden keywords">
        <ErrorState message="Could not load hidden keywords" onRetry={() => setTick(t => t + 1)}/>
      </SetCard>
    )
  }
  if (rows === null) {
    return (
      <SetCard icon="eyeoff" title="Hidden keywords">
        <Loader/>
      </SetCard>
    )
  }

  return (
    <SetCard icon="eyeoff" title="Hidden keywords"
      sub="Posts and notifications containing these words are filtered before they reach you. Arabic and Kurdish letter variants and diacritics are matched too.">
      <form className="flex gap-8" style={{ marginBottom: 12 }} onSubmit={e => { e.preventDefault(); add() }}>
        <input className="field" style={{ flex: '1 1 auto', minWidth: 0 }} placeholder="Add a word or phrase…"
          value={q} onChange={e => setQ(e.target.value)} maxLength={100} aria-label="Keyword to hide"/>
        <button type="submit" className="btn btn-primary" disabled={busy || !q.trim()}>Add</button>
      </form>
      {rows.length > 0 && (
        <p className="muted text-xs" style={{ margin: '0 0 8px' }}>{rows.length} of {KEYWORD_LIMIT} keywords</p>
      )}
      {rows.length ? (
        <div className="rail-list">
          {rows.map(row => (
            <div key={row.id} className="rail-row">
              <div className="rail-info">
                <div className="rail-name"><b>{row.keyword}</b></div>
                <div className="rail-sub">Hidden {fmtWhen(row.createdAt)}</div>
              </div>
              <button className="btn btn-ghost btn-sm" aria-label={`Remove ${row.keyword}`} onClick={() => remove(row)}>
                <Icon name="trash" className="xs"/>
              </button>
            </div>
          ))}
        </div>
      ) : <EmptyState icon="eyeoff" title="No hidden keywords" sub="Add words you don’t want to see across the app."/>}
    </SetCard>
  )
}
