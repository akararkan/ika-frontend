/* =========================================================
   Post detail page — /posts/:id
   Subscribes to the post's SSE stream and patches counters +
   comments live (POSTS carry no counts → local +/-1 deltas).
   ========================================================= */
import React from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Icon, Avatar, Verify, linkify, showToast } from '../components/ui.jsx'
import { MentionBox } from '../components/MentionBox.jsx'
import { uiConfirm } from '../components/Dialog.jsx'
import { openReport } from '../components/ReportDialog.jsx'
import { PostCard } from '../components/PostCard.jsx'
import { Loader, EmptyState } from '../components/states.jsx'
import { authorOf } from '../lib/userView.js'
import { openComposeEdit } from '../lib/openCompose.js'
import { useRealtime } from '../hooks/useRealtime.js'
import { useAuth } from '../context/AuthContext.jsx'
import { api, applyPostDelta } from '../api/index.js'

/* ----- live reply-thread helpers ------------------------------------------
   A comment-scoped SSE event carries only a commentId, and that id can name a
   TOP-LEVEL comment or a REPLY inside any lazily-loaded thread — the wire does
   not say which. These map/drop the id across every loaded thread, and return
   the SAME map reference when nothing matched so the setState bails out (the
   handler calls them for every comment event, matched or not). Pure — safe
   under StrictMode's double-invoked updaters. */
function patchInThreads(m, cid, fn) {
  let changed = false
  const out = {}
  for (const k of Object.keys(m)) {
    const list = m[k] || []
    if (list.some(r => r.id === cid)) {
      changed = true
      out[k] = list.map(r => r.id === cid ? fn(r) : r)
    } else out[k] = list
  }
  return changed ? out : m
}
function dropFromThreads(m, cid) {
  let changed = false
  const out = {}
  for (const k of Object.keys(m)) {
    const list = m[k] || []
    const next = list.filter(r => r.id !== cid)
    if (next.length !== list.length) changed = true
    out[k] = next
  }
  return changed ? out : m
}

export function PostPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const me = user || { full:'You', initials:'Y', avc:'linear-gradient(135deg,#1f4e7e,#00172f)' }

  const [post, setPost] = React.useState(null)
  const [comments, setComments] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const [live, setLive] = React.useState(false)
  const [text, setText] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  /* The card's comment button hands off to the thread this page owns rather
     than expanding its own — scroll it into view and put the caret in the
     composer, so one tap gets you to typing. */
  const commentsBoxRef = React.useRef(null)
  const focusComments = React.useCallback(() => {
    const box = commentsBoxRef.current
    if (!box) return
    box.scrollIntoView({ behavior: 'smooth', block: 'start' })
    box.querySelector('input,textarea,[contenteditable="true"]')?.focus({ preventScroll: true })
  }, [])
  const [editingId, setEditingId] = React.useState(null)
  const [editValue, setEditValue] = React.useState('')
  const [replyTo, setReplyTo] = React.useState(null)       // comment id being replied to
  const [replyText, setReplyText] = React.useState('')
  const [replyTarget, setReplyTarget] = React.useState(null)
  const [repliesMap, setRepliesMap] = React.useState({})   // commentId → [reply views]
  const [openReplies, setOpenReplies] = React.useState({}) // commentId → shown?

  /* Exactly-once ledgers for the comment-scoped SSE events. The posts stream
     never echoes the actor's own events, but a watchdog-forced reconnect CAN
     replay recent ones — and the rows are deduped by id while the counters
     were not, so every replay used to drift post.comments/replyCount with no
     visible row evidence. `seenC` = comment/reply ids whose +1 already ran
     (seeded from every fetch and own successful posts); `delC` = ids whose
     delete already counted. Reset per post. */
  const seenC = React.useRef(new Set())
  const delC = React.useRef(new Set())
  /* Read-only mirrors so the SSE handler can DECIDE (is this id top-level?
     which loaded thread holds it? how many replies cascade away with it?)
     before dispatching pure setState updaters — side-effect-free under
     StrictMode's double invocation. */
  const commentsRef = React.useRef(comments)
  React.useEffect(() => { commentsRef.current = comments }, [comments])
  const repliesRef = React.useRef(repliesMap)
  React.useEffect(() => { repliesRef.current = repliesMap }, [repliesMap])

  const replyHandleOf = React.useCallback((reply, parentComment) => {
    if (reply?._replyToHandle) return reply._replyToHandle
    if (reply?.replyToUserId) {
      const parentAuthor = authorOf(parentComment)
      if (parentAuthor.handle && parentComment?.author === reply.replyToUserId) return parentAuthor.handle
      const targetReply = (repliesMap[parentComment?.id] || []).find((entry) => entry.id === reply.replyToCommentId)
      if (targetReply) return authorOf(targetReply).handle
    }
    return authorOf(parentComment).handle
  }, [repliesMap])

  React.useEffect(() => {
    let alive = true
    setLoading(true)
    seenC.current = new Set()
    delC.current = new Set()
    Promise.all([api.posts.get(id), api.posts.comments(id).catch(() => [])])
      .then(([p, c]) => {
        if (!alive) return
        // Fetched rows are inside the fetched counters — a replayed create
        // for any of them must not bump again.
        ;(c || []).forEach(x => seenC.current.add(x.id))
        setPost(p); setComments(c)
      })
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
      const t = evt.eventType
      /* Comment-scoped COUNTERS are handled explicitly below behind the
         exactly-once ledgers — applyPostDelta's blind ±1 would re-drift on a
         reconnect replay while the rows stay deduped. Everything else still
         rides the shared delta helper. */
      const commentScoped = t === 'COMMENT_CREATED' || t === 'REPLY_CREATED' || t === 'COMMENT_DELETED'
      if (!commentScoped) setPost(prev => applyPostDelta(prev, evt))
      // SAVE_COUNT_UPDATED carries no direction → debounce-re-read the true count (§7)
      if (t === 'SAVE_COUNT_UPDATED') refreshSaveCountSoon()
      const synthRow = () => ({
        id: evt.commentId,
        _author: { full: evt.actorUsername || 'Someone', handle: evt.actorUsername || 'member',
                   initials: (evt.actorUsername || 'M').slice(0,2).toUpperCase(), avc:'linear-gradient(135deg,#1f4e7e,#00172f)' },
        body: evt.textContent || '', time: 'now', likes: 0,
      })
      if (t === 'COMMENT_CREATED' && evt.commentId && !seenC.current.has(evt.commentId)) {
        seenC.current.add(evt.commentId)
        setPost(p => p ? { ...p, comments: (p.comments || 0) + 1 } : p)
        setComments(cs => cs.some(c => c.id === evt.commentId) ? cs : [...cs, synthRow()])
      }
      if (t === 'REPLY_CREATED' && evt.commentId && !seenC.current.has(evt.commentId)) {
        seenC.current.add(evt.commentId)
        const pid = evt.parentCommentId
        setPost(p => p ? { ...p, comments: (p.comments || 0) + 1 } : p)
        setComments(cs => cs.map(c => c.id === pid ? { ...c, replyCount: (c.replyCount || 0) + 1 } : c))
        setRepliesMap(m => m[pid]
          ? { ...m, [pid]: m[pid].some(r => r.id === evt.commentId) ? m[pid] : [...m[pid], synthRow()] }
          : m)
      }
      if (t === 'COMMENT_DELETED' && evt.commentId && !delC.current.has(evt.commentId)) {
        delC.current.add(evt.commentId)
        const cid = evt.commentId
        /* Decide from the mirrors, then dispatch pure updaters: was this a
           top-level comment (its counted replies cascade away with it — the
           thin wire sends no per-reply deletes) or a reply (find its parent
           in a loaded thread when the wire doesn't name it, so the "View N
           replies" label can follow)? */
        const topRow = commentsRef.current.find(c => c.id === cid)
        const pid = evt.parentCommentId
          || (topRow ? null : Object.keys(repliesRef.current).find(k => (repliesRef.current[k] || []).some(r => r.id === cid)) || null)
        const cascade = topRow ? 1 + (topRow.replyCount || 0) : 1
        setPost(p => p ? { ...p, comments: Math.max(0, (p.comments || 0) - cascade) } : p)
        setComments(cs => cs
          .filter(c => c.id !== cid)
          .map(c => pid && c.id === pid ? { ...c, replyCount: Math.max(0, (c.replyCount || 0) - 1) } : c))
        setRepliesMap(m => {
          const dropped = dropFromThreads(m, cid)
          if (!topRow || !(cid in dropped)) return dropped
          const rest = { ...dropped }
          delete rest[cid]   // a deleted top-level takes its loaded thread with it
          return rest
        })
      }
      if (evt.eventType === 'COMMENT_REACTION_ADDED' || evt.eventType === 'COMMENT_REACTION_REMOVED') {
        /* The other viewer's heart moves live — on top-level comments AND on
           replies (the old handler only patched top level, so reacting to a
           reply never showed for anyone else). */
        const d = evt.eventType === 'COMMENT_REACTION_ADDED' ? 1 : -1
        const bump = (c) => ({ ...c, likes: Math.max(0, (c.likes || 0) + d) })
        setComments(cs => cs.map(c => c.id === evt.commentId ? bump(c) : c))
        setRepliesMap(m => patchInThreads(m, evt.commentId, bump))
      }
      if (evt.eventType === 'COMMENT_EDITED' && evt.commentId && typeof evt.textContent === 'string') {
        // Thin payload like COMMENT_CREATED (ids + text): patch the body in
        // place wherever the row lives. Without textContent there is nothing
        // to render — skip rather than blank the comment.
        const edit = (c) => ({ ...c, body: evt.textContent, edited: true })
        setComments(cs => cs.map(c => c.id === evt.commentId ? edit(c) : c))
        setRepliesMap(m => patchInThreads(m, evt.commentId, edit))
      }
      if (evt.eventType === 'POST_UPDATED') {
        /* The author edited while we're reading — re-read the canonical post
           for its CONTENT (body/media/tags/visibility) but keep our local
           counters and viewer flags: they are delta-maintained, and a
           snapshot taken while my own like/comment is still in flight would
           clobber it — with own-event suppression, nothing would ever
           correct that. */
        api.posts.get(id).then(p => {
          if (!p) return
          setPost(prev => prev ? {
            ...p,
            likes: prev.likes, liked: prev.liked,
            saves: prev.saves, saved: prev.saved,
            comments: prev.comments, shares: prev.shares,
            views: Math.max(prev.views || 0, p.views || 0),
          } : p)
        }).catch(() => {})
      }
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
    delC.current.add(cid)
    // Deleting a top-level comment takes its counted replies with it — the
    // same cascade math the SSE handler applies for other viewers' deletes.
    const row = commentsRef.current.find(c => c.id === cid)
    const cascade = 1 + (row?.replyCount || 0)
    setComments(cs => cs.filter(c => c.id !== cid))
    setRepliesMap(m => { const { [cid]: _orphaned, ...rest } = m; return _orphaned ? rest : m })
    setPost(p => p ? { ...p, comments: Math.max(0, (p.comments || 0) - cascade) } : p)
    try { await api.posts.deleteComment(cid) } catch { showToast('Could not delete comment') }
  }

  // ---- Replies (depth-1, §14.3 add / §14.4 list) ----
  const toggleReplies = async (cid) => {
    const wasOpen = openReplies[cid]
    setOpenReplies(o => ({ ...o, [cid]: !wasOpen }))
    if (!wasOpen && !repliesMap[cid]) {
      try {
        const list = await api.posts.replies(cid)
        // Fetched replies are already inside the fetched counters — a replayed
        // REPLY_CREATED for any of them must not bump again — and the list IS
        // the whole thread (flat fetch), so the parent's label becomes exact.
        ;(list || []).forEach(r => seenC.current.add(r.id))
        setRepliesMap(m => ({ ...m, [cid]: list || [] }))
        setComments(cs => cs.map(c => c.id === cid ? { ...c, replyCount: (list || []).length } : c))
      }
      catch { setRepliesMap(m => ({ ...m, [cid]: [] })) }
    }
  }
  const submitReply = async (cid) => {
    const v = replyText.trim(); if (!v) return
    const handle = replyTarget?.handle || null
    const body = handle && !new RegExp(`^@${handle}(\\s|$)`, 'i').test(v) ? `@${handle} ${v}` : v
    setReplyText(''); setReplyTo(null); setReplyTarget(null)
    const tmp = { id: 'tmp-' + Date.now(), _author: me, author: me.id, body, time: 'now', likes: 0, _replyToHandle: handle }
    setRepliesMap(m => ({ ...m, [cid]: [...(m[cid] || []), tmp] }))
    setOpenReplies(o => ({ ...o, [cid]: true }))
    setComments(cs => cs.map(c => c.id === cid ? { ...c, replyCount: (c.replyCount || 0) + 1 } : c))
    setPost(p => p ? { ...p, comments: (p.comments || 0) + 1 } : p)
    try {
      const saved = await api.posts.addReply(cid, { text: body })
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
    delC.current.add(rid)
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
              {/* `inlineComments={false}`: this page already renders the whole
                  thread below, so the card must not expand a second copy of it.
                  Its comment button (and "View all") jumps to the real one. */}
              <PostCard post={post} onLike={like} onSave={save} onShare={share}
                inlineComments={false} onOpenComments={focusComments}
                observeView={false} owner={!!me.id && post.author === me.id} onEdit={() => openComposeEdit(post)} onDelete={delPost}/>

              <div className="card card-pad" ref={commentsBoxRef} style={{ marginTop:14 }}>
                <h3 className="title">
                  <Icon name="comment" className="sm"/>Comments
                  {live && <span className="pill role" style={{ marginLeft:8 }}><span className="ps-heart" style={{ width:8, height:8, background:'var(--emerald-glow)' }}/>Live</span>}
                </h3>

                <div className="cmt-box" style={{ marginTop:0, marginBottom:8 }}>
                  <Avatar initials={me.initials} color={me.avc} size={32} src={me.profileImage}/>
                  <MentionBox className="field" placeholder="Write a thoughtful reply…" value={text}
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
                            <input className="field" value={editValue} autoFocus
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
                          <button onClick={() => {
                            const open = replyTo === c.id
                            setReplyTo(open ? null : c.id)
                            setReplyTarget(open ? null : { handle: cu.handle, userId: c.author, commentId: c.id })
                            setReplyText(open ? '' : `@${cu.handle} `)
                          }}>Reply</button>
                          {cOwner && !editing && <button onClick={() => startEdit(c)}>Edit</button>}
                          {cOwner && <button onClick={() => delComment(c.id)} style={{ color:'var(--rose)' }}>Delete</button>}
                          {/* optimistic rows carry a tmp- id the moderators cannot resolve.
                              `subject` puts the comment's own text on the dialog's plate —
                              a thread of similar replies otherwise all read "this comment". */}
                          {!cOwner && c.id && !String(c.id).startsWith('tmp-') &&
                            <button onClick={() => openReport({ targetType:'COMMENT', targetId:c.id, targetLabel:'this comment', subject:c.body })}>Report</button>}
                          <span>{c.time}</span>
                        </div>

                        {replyTo === c.id && (
                          <div className="cmt-box" style={{ marginTop:8 }}>
                            <Avatar initials={me.initials} color={me.avc} size={28} src={me.profileImage}/>
                            <MentionBox className="field" autoFocus placeholder={replyTarget?.handle ? `Replying to @${replyTarget.handle}…` : `Reply to ${cu.full}…`} value={replyText}
                              onChange={e => setReplyText(e.target.value)}
                              onKeyDown={e => { if (e.key==='Enter') submitReply(c.id); if (e.key==='Escape') { setReplyTo(null); setReplyText(''); setReplyTarget(null) } }}/>
                            <button className="icon-btn" disabled={!replyText.trim()} onClick={() => submitReply(c.id)}><Icon name="send" className="sm"/></button>
                          </div>
                        )}

                        {(c.replyCount > 0 || repliesMap[c.id]?.length > 0) && (
                          <button className="cmt-toggle" onClick={() => toggleReplies(c.id)}>
                            <Icon name={openReplies[c.id] ? 'chevup' : 'chevdown'} className="xs"/>
                            {openReplies[c.id] ? 'Hide replies' : `View ${c.replyCount || repliesMap[c.id]?.length || 0} ${(c.replyCount || repliesMap[c.id]?.length) === 1 ? 'reply' : 'replies'}`}
                          </button>
                        )}

                        {openReplies[c.id] && (repliesMap[c.id] || []).map((r, ri) => {
                          const ru = authorOf(r)
                          const replyHandle = replyHandleOf(r, c)
                          const rOwner = !!me.id && r.author === me.id && !String(r.id).startsWith('tmp-')
                          const rEditing = editingId === r.id
                          return (
                            <div key={r.id || ri} className="cmt cmt-reply">
                              <span role="button" style={{ cursor:'pointer' }} onClick={() => goUser(r.author)}><Avatar initials={ru.initials} color={ru.avc} size={28} src={ru.profileImage}/></span>
                              <div className="cmt-col">
                                {rEditing ? (
                                  <div className="cmt-box" style={{ marginTop:0 }}>
                                    <input className="field" value={editValue} autoFocus
                                      onChange={e => setEditValue(e.target.value)}
                                      onKeyDown={e => { if (e.key==='Enter') saveEdit(r.id, c.id); if (e.key==='Escape') setEditingId(null) }}/>
                                    <button className="icon-btn" disabled={!editValue.trim()} onClick={() => saveEdit(r.id, c.id)}><Icon name="check" className="sm"/></button>
                                    <button className="icon-btn" onClick={() => setEditingId(null)}><Icon name="close" className="sm"/></button>
                                  </div>
                                ) : (
                                  <div className="cmt-bubble">
                                    <div className="cmt-name" role="button" style={{ cursor:'pointer' }} onClick={() => goUser(r.author)}><b>{ru.full}</b>{ru.verified && <Verify scholar={ru.role==='SCHOLAR'}/>}{replyHandle && <span className="muted text-xs"> · <Icon name="reply" className="xs"/>@{replyHandle}</span>}</div>
                                    <p>{linkify(r.body)}</p>
                                  </div>
                                )}
                                <div className="cmt-meta">
                                  <button onClick={() => reactReply(c.id, r.id)} style={r.liked ? { color:'var(--rose)' } : undefined}>
                                    <Icon name="heart" className="xs" style={r.liked ? { fill:'var(--rose)', stroke:'var(--rose)' } : undefined}/>{r.likes || 0}
                                  </button>
                                  <button onClick={() => { setReplyTo(c.id); setReplyTarget({ handle: ru.handle, userId: r.author, commentId: r.id }); setReplyText(`@${ru.handle} `) }}>Reply</button>
                                  {rOwner && !rEditing && <button onClick={() => startEdit(r)}>Edit</button>}
                                  {rOwner && <button onClick={() => delReply(c.id, r.id)} style={{ color:'var(--rose)' }}>Delete</button>}
                                  {!rOwner && r.id && !String(r.id).startsWith('tmp-') &&
                                    <button onClick={() => openReport({ targetType:'COMMENT', targetId:r.id, targetLabel:'this reply', subject:r.body })}>Report</button>}
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
