/* =========================================================
   Post detail page — /posts/:id
   Subscribes to the post's SSE stream and patches counters +
   comments live (POSTS carry no counts → local +/-1 deltas).
   ========================================================= */
import React from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Icon, Avatar, Verify, linkify, showToast } from '../components/ui.jsx'
import { uiConfirm } from '../components/Dialog.jsx'
import { PostCard } from '../components/PostCard.jsx'
import { Loader, EmptyState } from '../components/states.jsx'
import { authorOf } from '../lib/userView.js'
import { openComposeEdit } from '../lib/openCompose.js'
import { useRealtime } from '../hooks/useRealtime.js'
import { useAuth } from '../context/AuthContext.jsx'
import { api, applyPostDelta } from '../api/index.js'

export function PostPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const me = user || { full:'You', initials:'Y', avc:'linear-gradient(135deg,#159a76,#0a4a3c)' }

  const [post, setPost] = React.useState(null)
  const [comments, setComments] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const [live, setLive] = React.useState(false)
  const [text, setText] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [editingId, setEditingId] = React.useState(null)
  const [editValue, setEditValue] = React.useState('')
  const [replyTo, setReplyTo] = React.useState(null)       // comment id being replied to
  const [replyText, setReplyText] = React.useState('')
  const [repliesMap, setRepliesMap] = React.useState({})   // commentId → [reply views]
  const [openReplies, setOpenReplies] = React.useState({}) // commentId → shown?

  React.useEffect(() => {
    let alive = true
    setLoading(true)
    Promise.all([api.posts.get(id), api.posts.comments(id).catch(() => [])])
      .then(([p, c]) => { if (!alive) return; setPost(p); setComments(c) })
      .catch(() => { if (alive) setPost(false) })
      .finally(() => { if (alive) setLoading(false) })
    api.posts.recordView(id).catch(() => {})
    return () => { alive = false }
  }, [id])

  // reflect an in-place edit (PATCH §6.4 broadcasts ika:post-updated)
  React.useEffect(() => {
    const onUpdated = (e) => { if (e.detail && e.detail.id === id) setPost(e.detail) }
    window.addEventListener('ika:post-updated', onUpdated)
    return () => window.removeEventListener('ika:post-updated', onUpdated)
  }, [id])

  // realtime
  useRealtime('posts', post ? id : null, {
    onConnected: () => setLive(true),
    onError: () => setLive(false),
    onEvent: (evt) => {
      setPost(prev => applyPostDelta(prev, evt))
      // SAVE_COUNT_UPDATED carries no direction → debounce-re-read the true count (§7)
      if (evt.eventType === 'SAVE_COUNT_UPDATED') refreshSaveCountSoon()
      if (evt.eventType === 'COMMENT_CREATED') {
        setComments(cs => [...cs, {
          id: evt.commentId || Math.random().toString(36),
          _author: { full: evt.actorUsername || 'Someone', handle: evt.actorUsername || 'member',
                     initials: (evt.actorUsername || 'M').slice(0,2).toUpperCase(), avc:'linear-gradient(135deg,#159a76,#0a4a3c)' },
          body: evt.textContent || '', time: 'now', likes: 0,
        }])
      }
      if (evt.eventType === 'REPLY_CREATED') {
        const pid = evt.parentCommentId
        setComments(cs => cs.map(c => c.id === pid ? { ...c, replyCount: (c.replyCount || 0) + 1 } : c))
        setRepliesMap(m => m[pid] ? { ...m, [pid]: [...m[pid], {
          id: evt.commentId || Math.random().toString(36),
          _author: { full: evt.actorUsername || 'Someone', handle: evt.actorUsername || 'member',
                     initials: (evt.actorUsername || 'M').slice(0,2).toUpperCase(), avc:'linear-gradient(135deg,#159a76,#0a4a3c)' },
          body: evt.textContent || '', time: 'now', likes: 0,
        }] } : m)
      }
      if (evt.eventType === 'COMMENT_DELETED') setComments(cs => cs.filter(c => c.id !== evt.commentId))
      if (evt.eventType === 'COMMENT_REACTION_ADDED') setComments(cs => cs.map(c => c.id === evt.commentId ? { ...c, likes: (c.likes || 0) + 1 } : c))
      if (evt.eventType === 'COMMENT_REACTION_REMOVED') setComments(cs => cs.map(c => c.id === evt.commentId ? { ...c, likes: Math.max(0, (c.likes || 0) - 1) } : c))
      if (evt.eventType === 'POST_DELETED') { showToast('This post was removed'); navigate('/') }
    },
  })

  const goUser = (uid) => uid && navigate(`/u/${uid}`)
  const saveTimer = React.useRef(null)
  const refreshSaveCountSoon = () => {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { api.posts.get(id).then(p => setPost(prev => prev ? { ...prev, saves: p.saves } : prev)).catch(() => {}) }, 1500)
  }
  const like = () => {
    const was = post.liked
    setPost(p => ({ ...p, liked:!p.liked, likes:p.likes + (p.liked?-1:1) }))
    api.posts.toggleReaction(id).catch(() => setPost(p => ({ ...p, liked:was, likes:p.likes + (was?1:-1) })))   // roll back
  }
  const reactComment = (cid) => {
    const flip = () => setComments(cs => cs.map(c => c.id === cid ? { ...c, liked: !c.liked, likes: (c.likes || 0) + (c.liked ? -1 : 1) } : c))
    flip()                                              // optimistic
    if (String(cid).startsWith('tmp-')) return          // not persisted yet — local only
    api.posts.toggleCommentReaction(id, cid).catch(() => flip())   // revert on failure
  }
  const save = () => {
    const was = post.saved
    setPost(p => ({ ...p, saved:!p.saved, saves:p.saves + (p.saved?-1:1) }))
    showToast(was?'Removed from saved':'Saved')
    api.posts.toggleSave(id)
      .then(r => { if (r && typeof r.saved === 'boolean') setPost(p => ({ ...p, saved: r.saved })) })   // trust server state
      .catch(() => { setPost(p => ({ ...p, saved:was, saves:p.saves + (was?1:-1) })); showToast('Could not update saved') })   // roll back
  }
  const share = () => { setPost(p => ({ ...p, shares:p.shares + 1 })); showToast('Share link copied'); api.posts.share(id).catch(() => {}) }

  // DELETE /api/v1/posts/{id} (§6.5, author-only)
  const delPost = async () => {
    const ok = await uiConfirm({ title:'Delete this post?', message:'This cannot be undone. The post will be removed for everyone.', confirmLabel:'Delete', danger:true, icon:'close' })
    if (!ok) return
    api.posts.remove(id).then(() => { showToast('Post deleted'); navigate('/') }).catch(() => showToast('Could not delete post'))
  }
  // comment edit (PATCH §14.5) / delete (DELETE §14.6) — own comments only
  const startEdit = (c) => { setEditingId(c.id); setEditValue(c.body || '') }
  // edits a comment OR a reply (a reply is a comment too, §14.5). Pass the
  // parent comment id when editing a reply so the right list updates.
  const saveEdit = async (cid, parentId = null) => {
    const v = editValue.trim(); if (!v) return
    if (parentId) setRepliesMap(m => ({ ...m, [parentId]: (m[parentId] || []).map(r => r.id === cid ? { ...r, body: v } : r) }))
    else setComments(cs => cs.map(c => c.id === cid ? { ...c, body: v } : c))
    setEditingId(null)
    try { await api.posts.editComment(cid, v) } catch { showToast('Could not edit') }
  }
  const delComment = async (cid) => {
    const ok = await uiConfirm({ title:'Delete this comment?', confirmLabel:'Delete', danger:true, icon:'close' })
    if (!ok) return
    setComments(cs => cs.filter(c => c.id !== cid))
    setPost(p => p ? { ...p, comments: Math.max(0, (p.comments || 0) - 1) } : p)
    try { await api.posts.deleteComment(cid) } catch { showToast('Could not delete comment') }
  }

  // ---- Replies (depth-1, §14.3 add / §14.4 list) ----
  const toggleReplies = async (cid) => {
    const wasOpen = openReplies[cid]
    setOpenReplies(o => ({ ...o, [cid]: !wasOpen }))
    if (!wasOpen && !repliesMap[cid]) {
      try { const list = await api.posts.replies(cid); setRepliesMap(m => ({ ...m, [cid]: list || [] })) }
      catch { setRepliesMap(m => ({ ...m, [cid]: [] })) }
    }
  }
  const submitReply = async (cid) => {
    const v = replyText.trim(); if (!v) return
    setReplyText(''); setReplyTo(null)
    const tmp = { id: 'tmp-' + Date.now(), _author: me, author: me.id, body: v, time: 'now', likes: 0 }
    setRepliesMap(m => ({ ...m, [cid]: [...(m[cid] || []), tmp] }))
    setOpenReplies(o => ({ ...o, [cid]: true }))
    setComments(cs => cs.map(c => c.id === cid ? { ...c, replyCount: (c.replyCount || 0) + 1 } : c))
    setPost(p => p ? { ...p, comments: (p.comments || 0) + 1 } : p)
    try {
      const saved = await api.posts.addReply(cid, { text: v })
      setRepliesMap(m => ({ ...m, [cid]: (m[cid] || []).map(r => r.id === tmp.id ? saved : r) }))
    } catch { showToast('Could not post reply') }
  }
  const reactReply = (cid, rid) => {
    const flip = () => setRepliesMap(m => ({ ...m, [cid]: (m[cid] || []).map(r => r.id === rid ? { ...r, liked: !r.liked, likes: (r.likes || 0) + (r.liked ? -1 : 1) } : r) }))
    flip()
    if (String(rid).startsWith('tmp-')) return
    api.posts.toggleCommentReaction(id, rid).catch(() => flip())
  }
  const delReply = async (cid, rid) => {
    const ok = await uiConfirm({ title:'Delete this reply?', confirmLabel:'Delete', danger:true, icon:'close' })
    if (!ok) return
    setRepliesMap(m => ({ ...m, [cid]: (m[cid] || []).filter(r => r.id !== rid) }))
    setComments(cs => cs.map(c => c.id === cid ? { ...c, replyCount: Math.max(0, (c.replyCount || 0) - 1) } : c))
    setPost(p => p ? { ...p, comments: Math.max(0, (p.comments || 0) - 1) } : p)
    try { await api.posts.deleteComment(rid) } catch { showToast('Could not delete reply') }
  }

  const submit = async () => {
    const value = text.trim(); if (!value) return
    setText(''); setBusy(true)
    const tmp = { id:'tmp-' + Date.now(), _author: me, body:value, time:'now', likes:0 }
    setComments(cs => [...cs, tmp]); setPost(p => ({ ...p, comments:(p.comments||0)+1 }))
    try {
      const saved = await api.posts.addComment(id, { text: value })
      setComments(cs => cs.map(c => c.id === tmp.id ? saved : c))
    } catch { showToast('Could not post comment') }
    setBusy(false)
  }

  return (
    <div className="main center">
      <div className="col-main">
        <button className="back-btn" onClick={() => navigate(-1)}><Icon name="chevleft" className="sm"/>Back</button>

        {loading ? <Loader label="Loading post…"/>
          : !post ? <EmptyState icon="feed" title="Post not found" sub="It may have been removed."/>
          : (
            <>
              <PostCard post={post} onLike={like} onSave={save} onShare={share} onOpenComments={() => {}}
                observeView={false} owner={!!me.id && post.author === me.id} onEdit={() => openComposeEdit(post)} onDelete={delPost}/>

              <div className="card card-pad" style={{ marginTop:14 }}>
                <h3 className="title">
                  <Icon name="comment" className="sm"/>Comments
                  {live && <span className="pill role" style={{ marginLeft:8 }}><span className="ps-heart" style={{ width:8, height:8, background:'var(--emerald-glow)' }}/>Live</span>}
                </h3>

                <div className="cmt-box" style={{ marginTop:0, marginBottom:8 }}>
                  <Avatar initials={me.initials} color={me.avc} size={32} src={me.profileImage}/>
                  <input className="field" dir="auto" placeholder="Write a thoughtful reply…" value={text}
                    onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key==='Enter') submit() }}/>
                  <button className="icon-btn" disabled={busy || !text.trim()} onClick={submit}><Icon name="send" className="sm"/></button>
                </div>

                {comments.map((c, i) => {
                  const cu = authorOf(c)
                  const cOwner = !!me.id && c.author === me.id && !String(c.id).startsWith('tmp-')
                  const editing = editingId === c.id
                  return (
                    <div key={c.id || i} className="cmt">
                      <span role="button" style={{ cursor:'pointer' }} onClick={() => goUser(c.author)}><Avatar initials={cu.initials} color={cu.avc} size={32} src={cu.profileImage}/></span>
                      <div className="cmt-col">
                        {editing ? (
                          <div className="cmt-box" style={{ marginTop:0 }}>
                            <input className="field" dir="auto" value={editValue} autoFocus
                              onChange={e => setEditValue(e.target.value)}
                              onKeyDown={e => { if (e.key==='Enter') saveEdit(c.id); if (e.key==='Escape') setEditingId(null) }}/>
                            <button className="icon-btn" disabled={!editValue.trim()} onClick={() => saveEdit(c.id)}><Icon name="check" className="sm"/></button>
                            <button className="icon-btn" onClick={() => setEditingId(null)}><Icon name="close" className="sm"/></button>
                          </div>
                        ) : (
                          <div className="cmt-bubble">
                            <div className="cmt-name" role="button" style={{ cursor:'pointer' }} onClick={() => goUser(c.author)}><b>{cu.full}</b>{cu.verified && <Verify scholar={cu.role==='SCHOLAR'}/>}</div>
                            <p>{linkify(c.body)}</p>
                          </div>
                        )}
                        <div className="cmt-meta">
                          <button onClick={() => reactComment(c.id)} style={c.liked ? { color:'var(--rose)' } : undefined}>
                            <Icon name="heart" className="xs" style={c.liked ? { fill:'var(--rose)', stroke:'var(--rose)' } : undefined}/>{c.likes || 0}
                          </button>
                          <button onClick={() => setReplyTo(replyTo === c.id ? null : c.id)}>Reply</button>
                          {cOwner && !editing && <button onClick={() => startEdit(c)}>Edit</button>}
                          {cOwner && <button onClick={() => delComment(c.id)} style={{ color:'var(--rose)' }}>Delete</button>}
                          <span>{c.time}</span>
                        </div>

                        {replyTo === c.id && (
                          <div className="cmt-box" style={{ marginTop:8 }}>
                            <Avatar initials={me.initials} color={me.avc} size={28} src={me.profileImage}/>
                            <input className="field" dir="auto" autoFocus placeholder={`Reply to ${cu.full}…`} value={replyText}
                              onChange={e => setReplyText(e.target.value)}
                              onKeyDown={e => { if (e.key==='Enter') submitReply(c.id); if (e.key==='Escape') { setReplyTo(null); setReplyText('') } }}/>
                            <button className="icon-btn" disabled={!replyText.trim()} onClick={() => submitReply(c.id)}><Icon name="send" className="sm"/></button>
                          </div>
                        )}

                        {(c.replyCount > 0 || repliesMap[c.id]?.length > 0) && (
                          <button onClick={() => toggleReplies(c.id)}
                            style={{ marginTop:6, fontSize:'12.5px', color:'var(--ink-2)', fontWeight:600, display:'inline-flex', alignItems:'center', gap:4 }}>
                            <Icon name={openReplies[c.id] ? 'chevup' : 'chevdown'} className="xs"/>
                            {openReplies[c.id] ? 'Hide replies' : `View ${c.replyCount || repliesMap[c.id]?.length || 0} ${(c.replyCount || repliesMap[c.id]?.length) === 1 ? 'reply' : 'replies'}`}
                          </button>
                        )}

                        {openReplies[c.id] && (repliesMap[c.id] || []).map((r, ri) => {
                          const ru = authorOf(r)
                          const rOwner = !!me.id && r.author === me.id && !String(r.id).startsWith('tmp-')
                          const rEditing = editingId === r.id
                          return (
                            <div key={r.id || ri} className="cmt cmt-reply">
                              <span role="button" style={{ cursor:'pointer' }} onClick={() => goUser(r.author)}><Avatar initials={ru.initials} color={ru.avc} size={28} src={ru.profileImage}/></span>
                              <div className="cmt-col">
                                {rEditing ? (
                                  <div className="cmt-box" style={{ marginTop:0 }}>
                                    <input className="field" dir="auto" value={editValue} autoFocus
                                      onChange={e => setEditValue(e.target.value)}
                                      onKeyDown={e => { if (e.key==='Enter') saveEdit(r.id, c.id); if (e.key==='Escape') setEditingId(null) }}/>
                                    <button className="icon-btn" disabled={!editValue.trim()} onClick={() => saveEdit(r.id, c.id)}><Icon name="check" className="sm"/></button>
                                    <button className="icon-btn" onClick={() => setEditingId(null)}><Icon name="close" className="sm"/></button>
                                  </div>
                                ) : (
                                  <div className="cmt-bubble">
                                    <div className="cmt-name" role="button" style={{ cursor:'pointer' }} onClick={() => goUser(r.author)}><b>{ru.full}</b>{ru.verified && <Verify scholar={ru.role==='SCHOLAR'}/>}</div>
                                    <p>{linkify(r.body)}</p>
                                  </div>
                                )}
                                <div className="cmt-meta">
                                  <button onClick={() => reactReply(c.id, r.id)} style={r.liked ? { color:'var(--rose)' } : undefined}>
                                    <Icon name="heart" className="xs" style={r.liked ? { fill:'var(--rose)', stroke:'var(--rose)' } : undefined}/>{r.likes || 0}
                                  </button>
                                  <button onClick={() => { setReplyTo(c.id); setReplyText(`@${ru.handle} `) }}>Reply</button>
                                  {rOwner && !rEditing && <button onClick={() => startEdit(r)}>Edit</button>}
                                  {rOwner && <button onClick={() => delReply(c.id, r.id)} style={{ color:'var(--rose)' }}>Delete</button>}
                                  <span>{r.time}</span>
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
                {!comments.length && <p className="muted text-sm" style={{ padding:'8px 2px' }}>Be the first to comment.</p>}
              </div>
            </>
          )}
      </div>
    </div>
  )
}
