/* =========================================================
   Story viewer — full-screen 24h story playback (live).
   Loads an author's active stories, records views, shows the
   two-option poll if one is attached. Reuses .reels-view/.rv-*.
   ========================================================= */
import React from 'react'
import { Icon, Avatar, Verify, showToast } from './ui.jsx'
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

function PollWidget({ poll }) {
  const [s, setS] = React.useState({ a: poll.voteA || 0, b: poll.voteB || 0, mine: poll.myChoice || null })
  const total = Math.max(1, s.a + s.b)
  const pa = Math.round((s.a / total) * 100), pb = 100 - pa
  const vote = (side) => {
    if (s.mine === side) return
    setS(p => ({ a: p.a + (side==='A'?1:0) - (p.mine==='A'?1:0), b: p.b + (side==='B'?1:0) - (p.mine==='B'?1:0), mine: side }))
    api.stories.vote(poll.pollId, side).catch(() => {})
  }
  const opts = [{ side:'A', label: poll.optionA, pct: pa }, { side:'B', label: poll.optionB, pct: pb }]
  return (
    <div style={{ marginTop:14 }}>
      <div style={{ fontWeight:600, marginBottom:8, textShadow:'0 1px 6px rgba(0,0,0,.6)' }}>{poll.question}</div>
      <div style={{ display:'flex', gap:8 }}>
        {opts.map(o => (
          <button key={o.side} onClick={() => vote(o.side)} style={{
            position:'relative', flex:1, padding:'12px 14px', borderRadius:12, overflow:'hidden', color:'#fff',
            textAlign:'left', fontWeight:600, fontSize:14, background:'rgba(255,255,255,.14)', backdropFilter:'blur(6px)',
            border: s.mine === o.side ? '1.5px solid #fff' : '1.5px solid transparent',
          }}>
            <span style={{ position:'absolute', inset:0, width:`${o.pct}%`, background:'rgba(255,255,255,.22)' }}/>
            <span style={{ position:'relative', display:'flex', justifyContent:'space-between' }}>
              <span>{o.label}</span><span className="font-mono">{s.mine ? o.pct + '%' : ''}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

export function StoryViewer({ authorId, author, onClose }) {
  const [items, setItems] = React.useState([])
  const [idx, setIdx] = React.useState(0)
  const [poll, setPoll] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const u = author || { full: 'Member', handle: 'member', initials: '··', avc: gradientFor(authorId) }

  React.useEffect(() => {
    let alive = true
    api.stories.byAuthor(authorId).then(rows => {
      if (!alive) return
      setItems((rows || []).map(r => ({
        id: r.storyId, type: r.storyType, visibility: r.visibility,
        bg: r.mediaUrl ? `center/cover no-repeat url("${assetUrl(r.mediaUrl)}")` : gradientFor(r.storyId),
        text: r.textContent || '', time: adapters.timeAgo(r.createdAt),
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
        <button className="rv-close" onClick={onClose}><Icon name="close"/></button>
      </div>

      <div className="rv-progress">
        {items.map((_, i) => <i key={i} className={i < idx ? 'done' : i === idx ? 'cur' : ''}/>)}
      </div>

      <div className="rv-stage">
        <div className="rv-card">
          <div className="rv-bg" style={{ background: item.bg }}/>
          {item.text && <div className="rv-center">{item.text}</div>}
          <div className="rv-meta">
            {poll && <PollWidget poll={poll}/>}
            <div className="rvm-sound" style={{ marginTop:12 }} onClick={() => showToast('Reply sent')}>
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
