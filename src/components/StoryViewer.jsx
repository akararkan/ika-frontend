/* =========================================================
   Story viewer — full-screen 24h story playback (live).
   Loads an author's active stories, records views, shows the
   two-option poll if one is attached. Reuses .reels-view/.rv-*.
   ========================================================= */
import React from 'react'
import { Icon, Avatar, Verify, showToast } from './ui.jsx'
import { uiConfirm } from './Dialog.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { api, adapters, assetUrl } from '../api/index.js'

function gradientFor(id = '') {
  const grads = [
    'linear-gradient(160deg,#0a4a3c,#070d0b)', 'linear-gradient(160deg,#1fb98e,#0a4a3c)',
    'linear-gradient(160deg,#bd9344,#7a5a1a)', 'linear-gradient(160deg,#3f6a8a,#16302a)',
    'linear-gradient(160deg,#5a2a1a,#160a06)',
  ]
  let h = 0; for (let i = 0; i < String(id).length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return grads[h % grads.length]
}

// Voter list (author-only) — who picked each choice. Lazy-fetches both sides on open.
function VotersSheet({ poll, onClose }) {
  const [sides, setSides] = React.useState({ A: null, B: null })
  React.useEffect(() => {
    let alive = true
    const grab = (choice) => api.stories.voters(poll.pollId, choice)
      .then(r => (r?.content || r || []).map(v => adapters.authorFrom(v.user || v, v.userId || v.id)))
      .catch(() => [])
    Promise.all([grab('A'), grab('B')]).then(([A, B]) => { if (alive) setSides({ A, B }) })
    return () => { alive = false }
  }, [poll.pollId])
  const col = (label, list) => (
    <div style={{ flex:1, minWidth:0 }}>
      <div className="muted text-xs" style={{ marginBottom:6 }}>{label}{list ? ` · ${list.length}` : ''}</div>
      {list == null ? <div className="muted text-xs">Loading…</div>
        : !list.length ? <div className="muted text-xs">No votes yet</div>
        : list.map(v => (
          <div key={v.id || v.handle} className="rail-row" style={{ padding:'6px 0' }}>
            <Avatar initials={v.initials} color={v.avc} size={28} src={v.profileImage}/>
            <div className="rail-info" style={{ minWidth:0 }}><div className="rail-sub" style={{ whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>@{v.handle}</div></div>
          </div>
        ))}
    </div>
  )
  return (
    <div className="overlay open" onClick={e => { if (e.target === e.currentTarget) onClose() }} style={{ zIndex:60 }}>
      <div className="modal" style={{ maxWidth:440, width:'92%' }} onClick={e => e.stopPropagation()}>
        <div className="phead" style={{ padding:'14px 16px 0' }}><h3 style={{ margin:0 }}>Votes</h3><button className="icon-btn" onClick={onClose}><Icon name="close" className="sm"/></button></div>
        <div style={{ display:'flex', gap:16, padding:16 }}>
          {col(poll.optionA, sides.A)}
          {col(poll.optionB, sides.B)}
        </div>
      </div>
    </div>
  )
}

function PollWidget({ poll, isOwner, live }) {
  const [s, setS] = React.useState({ a: poll.voteA || 0, b: poll.voteB || 0, mine: poll.myChoice || null })
  const [showVoters, setShowVoters] = React.useState(false)
  // Live tally from the story-tray SSE (author only) — set the absolute counts, keep my own choice.
  React.useEffect(() => {
    if (live && live.pollId === poll.pollId) setS(p => ({ ...p, a: live.voteA ?? p.a, b: live.voteB ?? p.b }))
  }, [live, poll.pollId])
  // Percentages are computed off the REAL vote total — with zero votes both are
  // 0% (never the old "100% to B" artefact of dividing by a clamped total).
  const votes = s.a + s.b
  const pa = votes ? Math.round((s.a / votes) * 100) : 0
  const pb = votes ? 100 - pa : 0
  // The author can't vote on their own poll (server self-suppresses); they always see tallies.
  const reveal = isOwner || !!s.mine
  const vote = (side) => {
    if (isOwner || s.mine === side) return
    setS(p => ({ a: p.a + (side==='A'?1:0) - (p.mine==='A'?1:0), b: p.b + (side==='B'?1:0) - (p.mine==='B'?1:0), mine: side }))
    api.stories.vote(poll.pollId, side).catch(() => {})
  }
  const opts = [
    { side:'A', label: poll.optionA, pct: pa, win: votes > 0 && s.a > s.b },
    { side:'B', label: poll.optionB, pct: pb, win: votes > 0 && s.b > s.a },
  ]
  return (
    <div className="sv-poll">
      <div className="sv-poll-head"><Icon name="qna" className="xs"/><span>Poll</span></div>
      <div className="sv-poll-q">{poll.question}</div>
      <div className="sv-poll-opts">
        {opts.map(o => (
          <button
            key={o.side}
            className={'sv-poll-opt' + (s.mine === o.side ? ' mine' : '') + (reveal && o.win ? ' win' : '')}
            onClick={() => vote(o.side)}
            disabled={isOwner}
          >
            <span className="sv-poll-fill" style={{ width: reveal && votes ? `${o.pct}%` : '0%' }}/>
            <span className="sv-poll-label">
              <span className="sv-poll-txt">{s.mine === o.side && <Icon name="check" className="xs"/>}{o.label}</span>
              {reveal && <span className="sv-poll-pct">{o.pct}%</span>}
            </span>
          </button>
        ))}
      </div>
      {isOwner ? (
        <button className="sv-poll-foot" onClick={() => setShowVoters(true)}>
          <Icon name="users" className="xs"/>{votes ? `${votes} ${votes === 1 ? 'vote' : 'votes'} · view` : 'No votes yet · view'}
        </button>
      ) : s.mine ? (
        <div className="sv-poll-foot static"><Icon name="users" className="xs"/>{votes} {votes === 1 ? 'vote' : 'votes'}</div>
      ) : null}
      {showVoters && <VotersSheet poll={poll} onClose={() => setShowVoters(false)}/>}
    </div>
  )
}

export function StoryViewer({ authorId, author, onClose }) {
  const { user } = useAuth()
  const isOwner = !!user?.id && user.id === authorId
  const [items, setItems] = React.useState([])
  const [idx, setIdx] = React.useState(0)
  const [poll, setPoll] = React.useState(null)
  const [liveTally, setLiveTally] = React.useState(null)   // latest POLL_VOTE_CAST from the tray stream
  const [loading, setLoading] = React.useState(true)
  const u = author || { full: 'Member', handle: 'member', initials: '··', avc: gradientFor(authorId) }

  // Author-only: live poll tallies via the story-tray SSE (POLL_VOTE_CAST).
  React.useEffect(() => {
    if (!isOwner) return
    return api.stories.trayStream({ onPollVote: (ev) => ev?.pollId && setLiveTally(ev) })
  }, [isOwner])

  React.useEffect(() => {
    let alive = true
    api.stories.byAuthor(authorId).then(rows => {
      if (!alive) return
      setItems((rows || []).map(r => ({
        id: r.storyId, type: r.storyType, visibility: r.visibility,
        bg: r.mediaUrl ? `center/cover no-repeat url("${assetUrl(r.mediaUrl)}")` : gradientFor(r.storyId),
        text: r.textContent || '',
        // When the story has media, the StoryEditor has already baked the text
        // layers into the image. The `textContent` field is metadata for
        // search/notifications — do NOT render it as a duplicate center caption.
        hasMedia: !!r.mediaUrl,
        time: adapters.timeAgo(r.createdAt),
      })))
    }).catch(() => {}).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [authorId])

  const item = items[idx]

  React.useEffect(() => {
    if (!item) return
    api.stories.recordView(item.id).catch(() => {})
    setPoll(null)
    api.stories.getPoll(item.id).then(p => p && setPoll(p)).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id])

  if (loading) return <div className="reels-view" style={{ display:'grid', placeItems:'center', color:'#fff' }}>Loading…<button className="rv-close" onClick={onClose} style={{ position:'absolute', top:18, right:22 }}><Icon name="close"/></button></div>
  if (!item) { onClose(); return null }

  const step = (d) => { const n = idx + d; if (n < 0) return; if (n >= items.length) { onClose(); return } setIdx(n) }

  // Author-only delete (full backend cascade: story + poll tables + tray story_removed fan-out).
  const removeCurrent = async () => {
    if (!item) return
    const ok = await uiConfirm({ title:'Delete this story?', message:'This removes it for everyone, along with any poll on it. This cannot be undone.', confirmLabel:'Delete', danger:true, icon:'trash' })
    if (!ok) return
    const sid = item.id
    api.stories.remove(sid).then(() => showToast('Story deleted')).catch(() => showToast('Could not delete story'))
    window.dispatchEvent(new CustomEvent('ika:story-deleted', { detail: { storyId: sid } }))   // feed tray re-reads
    const remaining = items.filter(x => x.id !== sid)
    if (!remaining.length) { onClose(); return }
    setItems(remaining)
    setIdx(i => Math.min(i, remaining.length - 1))
  }

  return (
    <div className="reels-view">
      <div className="rv-top">
        <div className="rvm-author" style={{ margin:0 }}>
          <Avatar initials={u.initials} color={u.avc} size={36}/>
          <div>
            <div className="rvm-name"><b>{u.full}</b>{u.verified && <Verify scholar={u.role === 'SCHOLAR'}/>}</div>
            <div className="rvm-time">{item.time} ago · {item.visibility?.toLowerCase?.() || 'public'}</div>
          </div>
        </div>
        {isOwner && <button className="rv-close" style={{ marginLeft:'auto' }} onClick={removeCurrent} title="Delete story" aria-label="Delete story"><Icon name="trash"/></button>}
        <button className="rv-close" onClick={onClose}><Icon name="close"/></button>
      </div>

      <div className="rv-progress">
        {items.map((_, i) => <i key={i} className={i < idx ? 'done' : i === idx ? 'cur' : ''}/>)}
      </div>

      <div className="rv-stage">
        <div className="rv-card">
          <div className="rv-bg" style={{ background: item.bg }}/>
          {item.text && !item.hasMedia && <div className="rv-center">{item.text}</div>}
          {poll && (
            <div
              className={'sv-poll-wrap' + (poll.posX != null && poll.posY != null ? ' placed' : '')}
              style={poll.posX != null && poll.posY != null ? { left: `${poll.posX}%`, top: `${poll.posY}%` } : undefined}
            >
              <PollWidget poll={poll} isOwner={isOwner} live={liveTally}/>
            </div>
          )}
          <div className="rv-meta">
            <div className="rvm-sound" onClick={() => showToast('Reply sent')}>
              <Icon name="send" className="xs"/>Reply to {u.full.split(' ')[0]}…
            </div>
          </div>
        </div>
        <div className="rv-nav">
          <button onClick={() => step(-1)} disabled={idx === 0}><Icon name="chevup"/></button>
          <button onClick={() => step(1)}><Icon name="chevdown"/></button>
        </div>
      </div>
    </div>
  )
}
