/* =========================================================
   Settings v2 — quiet controls: muted accounts and hidden
   keywords (privacy resolver, SETTINGS docs §privacy/muted
   + §privacy/keywords). Muting is silent and idempotent —
   the target is never notified; keywords are normalised
   server-side (Arabic/Kurdish variants + diacritics) and a
   duplicate add returns the EXISTING row.

   HONESTY TRAP, checked in the Java: both stores are WRITE-ONLY
   today. MuteService.mutedIds and HiddenKeywordService
   .normalizedFor are documented as feed-assembly inputs but have
   no callers — nothing outside ak.dev.irc.app.settings.privacy
   even imports the package — so neither list filters a feed or a
   notification yet. The copy below says so; do not put the old
   "hides them from your feeds" wording back until a read path
   actually consumes these.
   ========================================================= */
import React from 'react'
import { Icon, Avatar, showToast } from '../ui.jsx'
import { EmptyState, Loader, ErrorState } from '../states.jsx'
import { api } from '../../api/index.js'
import { SetCard, fmtWhen } from './shared.jsx'

const KEYWORD_LIMIT = 200   // server 400s past it

/* Put one optimistically-removed row back roughly where it was, and never
   twice. Keywords come back createdAt DESC, so a revert that prepends would
   silently reorder them; the mute list has no ORDER BY server-side, so keeping
   the index is simply what stops the screen jumping under the pointer.
   Same helper as AudiencePanel's — kept local rather than shared because it is
   four lines and shared.jsx is the design vocabulary, not a utility bag. */
function putBack(arr, item, at, isSame) {
  if (arr.some(isSame)) return arr
  const i = at < 0 ? arr.length : Math.min(at, arr.length)
  return [...arr.slice(0, i), item, ...arr.slice(i)]
}

export function MutedPanel() {
  const [list, setList] = React.useState(null)
  const [error, setError] = React.useState(false)
  const [tick, setTick] = React.useState(0)
  const [q, setQ] = React.useState('')
  const [results, setResults] = React.useState([])
  const searchSeq = React.useRef(0)              // typing races: only the newest reply may land
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
    const mine = ++searchSeq.current
    if (term.trim()) {
      api.users.searchList(term, { size: 6 })
        .then(r => { if (searchSeq.current === mine) setResults(r) })
        .catch(() => {})
    } else setResults([])
  }

  const mute = (u) => {
    setList(l => [u, ...l])
    setQ(''); setResults([])
    api.settings.privacy.muted.mute(u.id)
      .then(() => showToast(`Muted @${u.handle}`))
      .catch(() => { setList(l => l.filter(x => x.id !== u.id)); showToast('Could not mute — reverted', 'err') })
  }

  const unmute = (u) => {
    const at = (list || []).findIndex(x => x.id === u.id)
    setList(l => l.filter(x => x.id !== u.id))
    api.settings.privacy.muted.unmute(u.id)
      .then(() => showToast(`Unmuted @${u.handle}`))
      .catch(() => {
        setList(l => putBack(l, u, at, x => x.id === u.id))
        showToast('Could not unmute — reverted', 'err')
      })
  }

  if (error && list === null) {
    return (
      <SetCard id="muted" icon="mute" title="Muted accounts">
        <ErrorState message="Could not load muted accounts" onRetry={() => setTick(t => t + 1)}/>
      </SetCard>
    )
  }
  if (list === null) {
    return (
      <SetCard id="muted" icon="mute" title="Muted accounts">
        <Loader label="Loading muted accounts…"/>
      </SetCard>
    )
  }

  return (
    <SetCard id="muted" icon="mute" title="Muted accounts"
      sub="Muting is silent and one-sided — the person is never told, and they can still message you. Your mute list is saved to your account, but feeds don’t filter against it yet, so this records who you want out of your feeds rather than hiding them today.">
      {/* `.stx-search`, not the chat `.cmt-box`: at ≤720px the responsive sheet
          pins a `.card-pad > .cmt-box` to the bottom of the viewport as a composer
          bar, which detached this field from its card. */}
      <div className="stx-search">
        <input className="field" type="search" aria-label="Search people to mute"
          placeholder="Search people to mute…" value={q} onChange={e => searchUsers(e.target.value)}/>
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
      ) : <EmptyState icon="mute" title="No muted accounts" sub="Muting is private — the person is never told you muted them."/>}
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
    if (rows.length >= KEYWORD_LIMIT) { showToast(`You can hide up to ${KEYWORD_LIMIT} keywords`, 'warn'); return }
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
      showToast('Could not add that keyword', 'err')
    } finally {
      setBusy(false)
    }
  }

  const remove = (row) => {
    const at = rows.findIndex(r => r.id === row.id)
    setRows(cur => cur.filter(r => r.id !== row.id))
    api.settings.privacy.keywords.remove(row.id)
      .then(() => showToast('Keyword removed'))
      .catch(() => {
        setRows(cur => putBack(cur, row, at, r => r.id === row.id))
        showToast('Could not remove — reverted', 'err')
      })
  }

  if (error && rows === null) {
    return (
      <SetCard id="keywords" icon="eyeoff" title="Hidden keywords">
        <ErrorState message="Could not load hidden keywords" onRetry={() => setTick(t => t + 1)}/>
      </SetCard>
    )
  }
  if (rows === null) {
    return (
      <SetCard id="keywords" icon="eyeoff" title="Hidden keywords">
        <Loader label="Loading hidden keywords…"/>
      </SetCard>
    )
  }

  return (
    <SetCard id="keywords" icon="eyeoff" title="Hidden keywords"
      sub="Words you would rather not read. Each one is stored normalised, so Arabic and Kurdish letter variants and diacritics all count as the same word — but feeds and notifications don’t filter against this list yet.">
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
      ) : <EmptyState icon="eyeoff" title="No hidden keywords" sub="Add words you would rather not read."/>}
    </SetCard>
  )
}
