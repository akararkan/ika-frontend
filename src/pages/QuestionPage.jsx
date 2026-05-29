/* =========================================================
   Question detail page — /qna/:id
   Full QnA coverage: answers + reanswers (text / media / voice),
   inline sources & attachments, reactions, accept, best-vote,
   answer & question edit-delete, lock / answer-limit, share-link,
   and a live SSE stream that patches every counter and list in place.
   ========================================================= */
import React from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Icon, Verify, Avatar, fmt, linkify, showToast } from '../components/ui.jsx'
import { uiPrompt, uiConfirm } from '../components/Dialog.jsx'
import { SourceRow } from '../components/Source.jsx'
import { AddSourceForm } from '../components/SourceForm.jsx'
import { VoicePlayer } from '../components/VoicePlayer.jsx'
import { Loader, EmptyState } from '../components/states.jsx'
import { authorOf } from '../lib/userView.js'
import { answerFrom } from '../api/adapters.js'   // patch SSE-embedded answer DTOs in place (§9.1)
import { useRealtime } from '../hooks/useRealtime.js'
import { useAuth } from '../context/AuthContext.jsx'
import { api } from '../api/index.js'

const attIcon = (t) => t === 'IMAGE' ? 'image' : t === 'VIDEO' ? 'video' : t === 'AUDIO' ? 'mic' : 'doc'

function renderBody(body = '') {
  return body.split(/\*([^*]+)\*/g).map((piece, j) =>
    j % 2 === 1 ? <em key={j} className="ans-ref">{piece}</em> : <span key={j}>{linkify(piece)}</span>)
}

/* Build the multipart body for the answer / reanswer upload endpoints
   (§11.3 / §11.6): a JSON `data` part + optional `media` + `voice`. */
function buildAnswerForm(req, media, voice) {
  const fd = new FormData()
  fd.append('data', new Blob([JSON.stringify(req)], { type: 'application/json' }))
  if (media) fd.append('media', media)
  if (voice) fd.append('voice', voice)
  return fd
}
const fileForm = (file) => { const fd = new FormData(); fd.append('file', file); return fd }

/* Map the QnA error envelope (§3) to a clear, accurate toast message. */
function qnaError(e, fallback = 'Something went wrong') {
  const c = e?.code
  if (c === 'ANSWERS_LOCKED')     return 'Answers are locked for this question.'
  if (c === 'MAX_ANSWERS_REACHED' || c === 'ANSWER_LIMIT_REACHED') return 'This question has reached its answer limit.'
  if (c === 'INVALID_PARENT')     return 'That answer is no longer available to reply to.'
  if (c === 'VALIDATION_ERROR')   return e?.message || 'Please check what you entered.'
  if (e?.status === 401 || c === 'UNAUTHORIZED') return 'Please sign in to do that.'
  if (e?.status === 403 || c === 'FORBIDDEN')    return 'You do not have permission to do that.'
  if (e?.status === 404)          return 'That item was not found — it may have been deleted.'
  return e?.message || fallback
}

export function QuestionPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const isScholar = ['SCHOLAR','ADMIN'].includes(user?.role)

  const [q, setQ] = React.useState(null)
  const [answers, setAnswers] = React.useState([])
  const [loading, setLoading] = React.useState(true)

  // answer composer
  const [text, setText] = React.useState('')
  const [ansMedia, setAnsMedia] = React.useState(null)     // image / video File
  const [ansVoice, setAnsVoice] = React.useState(null)     // audio File
  const [recording, setRecording] = React.useState(false)
  const [ansSources, setAnsSources] = React.useState([])   // [{ req, file }] — file set only for MEDIA_FILE
  const [srcOpen, setSrcOpen] = React.useState(false)
  const [posting, setPosting] = React.useState(false)
  const mediaRef = React.useRef(null), voiceFileRef = React.useRef(null)
  const recRef = React.useRef(null), chunksRef = React.useRef([])

  // question inline edit
  const [editingQ, setEditingQ] = React.useState(false)
  const [qTitle, setQTitle] = React.useState(''); const [qBody, setQBody] = React.useState(''); const [qTags, setQTags] = React.useState('')
  // answer edit + replies
  const [editAid, setEditAid] = React.useState(null); const [editText, setEditText] = React.useState('')
  const [replyTo, setReplyTo] = React.useState(null); const [replyText, setReplyText] = React.useState(''); const [replyFile, setReplyFile] = React.useState(null)
  const [replyTarget, setReplyTarget] = React.useState(null)   // {id, handle, userId} when replying to a REPLY (else null → root)
  const replyFileRef = React.useRef(null); const tmpSeq = React.useRef(0)
  const [editRid, setEditRid] = React.useState(null); const [editRText, setEditRText] = React.useState('')   // reanswer edit (§11.7)
  const [repliesMap, setRepliesMap] = React.useState({}); const [openReplies, setOpenReplies] = React.useState({})
  // per-answer source/attachment management (own answers) — §15.3-4 / §16.1-4
  const [openManage, setOpenManage] = React.useState({})
  const [editSrcId, setEditSrcId] = React.useState(null); const [editSrcDraft, setEditSrcDraft] = React.useState({ title:'', citationText:'', ref:'' })
  const [editAttId, setEditAttId] = React.useState(null); const [editAttCaption, setEditAttCaption] = React.useState('')
  const attachRef = React.useRef(null); const attachForRef = React.useRef(null)

  const loadAnswers = React.useCallback(() => {
    api.qna.answers(id).then(setAnswers).catch(() => {})
  }, [id])

  React.useEffect(() => {
    let alive = true
    setLoading(true)
    api.qna.get(id).then(x => { if (alive) setQ(x) }).catch(() => { if (alive) setQ(false) }).finally(() => { if (alive) setLoading(false) })
    loadAnswers()
    return () => { alive = false }
  }, [id, loadAnswers])

  // local object URL for an attached image preview
  const ansMediaUrl = React.useMemo(() => ansMedia && ansMedia.type.startsWith('image') ? URL.createObjectURL(ansMedia) : null, [ansMedia])
  React.useEffect(() => () => { if (ansMediaUrl) URL.revokeObjectURL(ansMediaUrl) }, [ansMediaUrl])

  // SSE events are FLAT (no `data` wrapper, §9.1): every answer-scoped event
  // embeds the fresh `answer` DTO + root `parentAnswerId`, and the server never
  // echoes our own actions back — so we patch the one row in place, no refetch.
  const numFrom = (evt, key) => { const v = evt[key] ?? evt.count; return typeof v === 'number' ? v : null }
  // take counts/content from the broadcast, but keep THIS viewer's own state
  // (myReaction/votedByMe are neutral on the wire — §9.1)
  const mergeViewer = (fresh, prev) => prev ? { ...fresh, _liked: prev._liked, myReaction: prev.myReaction, votedByMe: prev.votedByMe } : fresh
  useRealtime('questions', q ? id : null, {
    onEvent: (evt) => {
      const t = evt.eventType
      const root = evt.parentAnswerId || null              // root answer id when the target is a reply
      const aid = evt.answerId
      const fresh = evt.answer ? answerFrom(evt.answer) : null

      if (t === 'ANSWER_CREATED' && fresh && !root) {
        setAnswers(arr => arr.some(x => x.id === fresh.id) ? arr : [...arr, fresh])
        setQ(p => p && ({ ...p, answers: (p.answers || 0) + 1 }))
      } else if (t === 'REANSWER_CREATED' && fresh) {
        const rid = root || fresh.parentAnswerId
        patchA(rid, x => ({ ...x, replyCount: (x.replyCount || 0) + 1 }))
        setRepliesMap(m => m[rid] ? ({ ...m, [rid]: m[rid].some(r => r.id === fresh.id) ? m[rid] : [...m[rid], fresh] }) : m)
      } else if (t === 'ANSWER_DELETED') {
        setAnswers(arr => arr.filter(x => x.id !== aid))
        if (root) { patchA(root, x => ({ ...x, replyCount: Math.max(0, (x.replyCount || 0) - 1) })); setRepliesMap(m => m[root] ? ({ ...m, [root]: m[root].filter(r => r.id !== aid) }) : m) }
        else setQ(p => p && ({ ...p, answers: Math.max(0, (p.answers || 0) - 1) }))
      } else if (fresh && ['ANSWER_EDITED','ANSWER_REACTION_ADDED','ANSWER_REACTION_REMOVED','ANSWER_REACTION_CHANGED','ANSWER_ACCEPTED','ANSWER_UNACCEPTED','BEST_ANSWER_VOTED','BEST_ANSWER_UNVOTED'].includes(t)) {
        if (root) setRepliesMap(m => m[root] ? ({ ...m, [root]: m[root].map(r => r.id === fresh.id ? mergeViewer(fresh, r) : r) }) : m)
        else patchA(fresh.id, prev => mergeViewer(fresh, prev))
        if (t === 'ANSWER_ACCEPTED' || t === 'ANSWER_UNACCEPTED') api.qna.get(id).then(setQ).catch(() => {})   // refresh status + acceptedAnswerCount
      }

      if (t === 'QUESTION_UPDATED') api.qna.get(id).then(setQ).catch(() => {})
      if (t === 'QUESTION_LOCKED' || t === 'QUESTION_UNLOCKED') api.qna.get(id).then(setQ).catch(() => {})   // refetch → accurate acceptsNewAnswers
      if (t === 'QUESTION_DELETED') { showToast('Question removed'); navigate('/qna') }
      if (t === 'VIEW_COUNT_UPDATED') setQ(p => p && ({ ...p, views: numFrom(evt, 'viewCount') ?? (p.views || 0) + 1 }))
      if (t === 'SAVE_COUNT_UPDATED') setQ(p => { if (!p) return p; const n = numFrom(evt, 'saveCount'); return n != null ? { ...p, saves: n } : p })
    },
  })

  const isAuthor = !!(q && user && q.author === user.id)
  const patchA = (aid, fn) => setAnswers(arr => arr.map(x => x.id === aid ? fn(x) : x))

  /* ---- question-level ---- */
  const save = () => { setQ(p => ({ ...p, saved:!p.saved, saves:Math.max(0,(p.saves||0)+(p.saved?-1:1)) })); showToast(q.saved ? 'Removed from saved' : 'Saved'); (q.saved ? api.qna.unsave(id) : api.qna.save(id)).catch(e => showToast(qnaError(e, 'Could not save'))) }
  const saveToCollection = async () => {                              // §17.1 (?collection) + §17.5 (existing names)
    let existing = []
    try { existing = await api.qna.savedCollections() || [] } catch { /* no collections yet */ }
    const name = await uiPrompt({
      title:'Save to collection',
      label:'Collection name',
      message: existing.length ? 'You already have: ' + existing.join(', ') : null,
      initial: existing[0] || 'Default',
      icon:'bookmark',
      confirmLabel:'Save',
    })
    if (name === null) return
    const coll = name.trim()
    setQ(p => ({ ...p, saved:true, saves: p.saved ? p.saves : (p.saves||0)+1 }))
    api.qna.save(id, coll || undefined).then(() => showToast(`Saved to ${coll || 'Default'}`)).catch(e => showToast(qnaError(e, 'Could not save')))
  }
  const share = async () => {
    let url = `${window.location.origin}/qna/${id}`
    try { const info = await api.qna.shareLink(id); if (info?.url) url = info.url } catch { /* fall back to local URL */ }
    navigator.clipboard?.writeText(url).catch(() => {}); showToast('Link copied')
    api.qna.recordShare(id).catch(() => {})
  }
  const startEditQ = () => { setQTitle(q.title); setQBody(q.body); setQTags((q.tags || []).join(', ')); setEditingQ(true) }
  const saveEditQ = async () => {
    const t = qTitle.trim(); if (!t) return
    const tags = qTags.split(',').map(s => s.trim().replace(/^#/, '').toLowerCase()).filter(Boolean)
    // Optimistic render so the form closes instantly.
    setQ(p => ({ ...p, title:t, body:qBody, tags })); setEditingQ(false)
    try {
      // §6.3 tags = full replace. Re-fetch canonical so the UI shows the
      // server-normalized form (lowercased / deduped tags, re-extracted
      // hashtags in body, edited flag, updatedAt, etc.).
      await api.qna.edit(id, { title: t, body: qBody, tags })
      try {
        const fresh = await api.qna.get(id)
        setQ(fresh)
        // Notify list pages (QnaPage, search, etc.) so they reflect the edit too.
        window.dispatchEvent(new CustomEvent('ika:question-updated', { detail: fresh }))
      } catch { /* keep optimistic */ }
    } catch (e) { showToast(qnaError(e, 'Could not save')) }
  }
  const deleteQ = async () => {
    const ok = await uiConfirm({ title:'Delete this question?', message:'This cannot be undone. All answers, replies and reactions are removed too.', confirmLabel:'Delete', danger:true, icon:'close' })
    if (!ok) return
    api.qna.remove(id).then(() => { showToast('Question deleted'); navigate('/qna') }).catch(e => showToast(qnaError(e, 'Could not delete')))
  }
  const toggleLock = () => { const lock = !q.answersLocked; setQ(p => ({ ...p, answersLocked: lock, acceptsNewAnswers: lock ? false : (p.maxAnswers ? (p.answers || 0) < p.maxAnswers : true) })); (lock ? api.qna.lockAnswers(id) : api.qna.unlockAnswers(id)).catch(() => {}) }
  const setLimit = async () => {
    const v = await uiPrompt({ title:'Limit number of answers', label:'Maximum answers (leave empty to clear)', initial:String(q.maxAnswers || ''), placeholder:'e.g. 10', icon:'list', confirmLabel:'Apply' })
    if (v === null) return
    const n = v.trim() ? parseInt(v, 10) : null
    setQ(p => ({ ...p, maxAnswers:n, acceptsNewAnswers: p.answersLocked ? false : (n ? (p.answers || 0) < n : true) }))
    api.qna.answerLimit(id, n).catch(() => {})
  }

  /* ---- answers ---- */
  const react = (a) => { patchA(a.id, x => ({ ...x, _liked:!x._liked, likes:x.likes + (x._liked?-1:1) })); (a._liked ? api.qna.unreact(id, a.id) : api.qna.react(id, a.id)).catch(() => loadAnswers()) }
  const accept = (a) => { patchA(a.id, x => ({ ...x, accepted:!x.accepted })); (a.accepted ? api.qna.unaccept(id, a.id) : api.qna.accept(id, a.id)).then(() => setQ(p => p && ({ ...p, status: a.accepted ? p.status : 'ANSWERED' }))).catch(() => loadAnswers()) }
  const best = (a) => { patchA(a.id, x => ({ ...x, votedByMe:!x.votedByMe, votes:x.votes + (x.votedByMe?-1:1), best:true })); (a.votedByMe ? api.qna.unvoteBest(id, a.id) : api.qna.markBest(id, a.id)).catch(() => loadAnswers()) }

  /* ---- answer media / voice / sources ---- */
  const onPickMedia = (e) => { const f = e.target.files?.[0]; if (f) { setAnsMedia(f); setAnsVoice(null) } e.target.value = '' }
  const onPickVoice = (e) => { const f = e.target.files?.[0]; if (f) { setAnsVoice(f); setAnsMedia(null) } e.target.value = '' }
  const startRec = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream); chunksRef.current = []
      mr.ondataavailable = (e) => chunksRef.current.push(e.data)
      mr.onstop = () => { const blob = new Blob(chunksRef.current, { type:'audio/webm' }); setAnsVoice(new File([blob], 'voice-note.webm', { type:'audio/webm' })); setAnsMedia(null); stream.getTracks().forEach(t => t.stop()) }
      mr.start(); recRef.current = mr; setRecording(true)
    } catch { showToast('Microphone unavailable — upload an audio file instead'); voiceFileRef.current?.click() }
  }
  const voiceTap = () => { if (recording) { try { recRef.current?.stop() } catch { /* ignore */ } setRecording(false) } else if (ansVoice) setAnsVoice(null); else startRec() }
  const resetComposer = () => { setText(''); setAnsMedia(null); setAnsVoice(null); setAnsSources([]); setSrcOpen(false) }
  // create each MEDIA_FILE source, then upload its file (§16.1 + sources/{id}/file)
  const flushMediaFileSources = async (answerId, items) => {
    for (const it of items) {
      try { const src = await api.qna.addSource(id, answerId, it.req); await api.qna.uploadSourceFile(id, answerId, src.id, fileForm(it.file)) } catch { /* skip a single failed file */ }
    }
  }

  const postAnswer = async () => {
    const body = text.trim()
    if (!body && !ansMedia && !ansVoice) return
    setPosting(true)
    try {
      const citations = ansSources.filter(s => !s.file).map(s => s.req)   // URL / ISBN / MANUAL go inline
      const fileSources = ansSources.filter(s => s.file)                 // MEDIA_FILE → upload after create
      const req = { body, ...(citations.length ? { sources: citations } : {}) }
      const saved = (ansMedia || ansVoice)
        ? await api.qna.postAnswerUpload(id, buildAnswerForm(req, ansMedia, ansVoice))   // §11.3
        : await api.qna.postAnswer(id, req)                                              // §11.2
      if (fileSources.length) { await flushMediaFileSources(saved.id, fileSources); try { saved.sources = await api.qna.listSources(id, saved.id) } catch { /* keep inline */ } }
      setAnswers(arr => [...arr, saved]); setQ(p => { if (!p) return p; const n = (p.answers || 0) + 1; return { ...p, answers: n, acceptsNewAnswers: p.maxAnswers ? n < p.maxAnswers : p.acceptsNewAnswers } })
      resetComposer()
    } catch (e) { showToast(qnaError(e, 'Could not post answer')) }
    finally { setPosting(false) }
  }
  const startEditA = (a) => { setEditAid(a.id); setEditText(a.body) }
  const saveEditA = (a) => { const v = editText.trim(); if (!v) return; patchA(a.id, x => ({ ...x, body:v, edited:true })); setEditAid(null); api.qna.editAnswer(id, a.id, v).catch(e => showToast(qnaError(e, 'Could not edit'))) }
  const deleteA = async (a) => {
    const ok = await uiConfirm({ title:'Delete this answer?', confirmLabel:'Delete', danger:true, icon:'close' })
    if (!ok) return
    setAnswers(arr => arr.filter(x => x.id !== a.id))
    setQ(p => p && ({ ...p, answers:Math.max(0,(p.answers||0)-1) }))
    api.qna.deleteAnswer(id, a.id).catch(() => loadAnswers())
  }

  /* ---- reanswers (depth-1) ---- */
  const toggleReplies = async (a) => {
    const open = openReplies[a.id]
    setOpenReplies(o => ({ ...o, [a.id]: !open }))
    if (!open && !repliesMap[a.id]) {
      try { const list = await api.qna.reanswers(id, a.id); setRepliesMap(m => ({ ...m, [a.id]: list || [] })) } catch { setRepliesMap(m => ({ ...m, [a.id]: [] })) }
    }
  }
  const submitReply = async (a) => {
    const v = replyText.trim(); const file = replyFile; const target = replyTarget
    if (!v && !file) return
    const targetId = target?.id || a.id                    // post to the ACTUAL answer/reply being replied to
    setReplyText(''); setReplyFile(null); setReplyTo(null); setReplyTarget(null); setOpenReplies(o => ({ ...o, [a.id]: true }))
    const tmp = { id:'tmp-'+(tmpSeq.current++), _author: authorOf({ id:user?.id, fullName:user?.full, username:user?.handle }), author:user?.id, body:v, time:'now', likes:0,
      replyToAnswerId: target?.id || null, replyToUserId: target?.userId || null, _replyToHandle: target?.handle || null }
    setRepliesMap(m => ({ ...m, [a.id]: [...(m[a.id]||[]), tmp] }))
    patchA(a.id, x => ({ ...x, replyCount:(x.replyCount||0)+1 }))
    try {
      const req = { body: v }
      const saved = file
        ? await api.qna.postReanswerUpload(id, targetId, buildAnswerForm(req, file.type.startsWith('audio') ? null : file, file.type.startsWith('audio') ? file : null))  // §11.6
        : await api.qna.postReanswer(id, targetId, req)
      setRepliesMap(m => ({ ...m, [a.id]: (m[a.id]||[]).map(r => r.id===tmp.id ? saved : r) }))
    } catch (e) {
      setRepliesMap(m => ({ ...m, [a.id]: (m[a.id]||[]).filter(r => r.id !== tmp.id) }))   // roll back the optimistic reply
      patchA(a.id, x => ({ ...x, replyCount:Math.max(0,(x.replyCount||0)-1) }))
      showToast(qnaError(e, 'Could not reply'))
    }
  }
  // reply to a REPLY → post to that reply's id; server hoists to a depth-1 sibling of the root but
  // records replyToAnswerId/replyToUserId so we can show "replying to @X" (§11.5 / E2)
  const replyToReply = (a, r) => { setReplyTo(a.id); setReplyTarget({ id:r.id, handle:authorOf(r).handle, userId:r.author }); setReplyText(''); setOpenReplies(o => ({ ...o, [a.id]: true })) }
  const reactReply = (aid, r) => {
    if (String(r.id).startsWith('tmp-')) return
    setRepliesMap(m => ({ ...m, [aid]: (m[aid]||[]).map(x => x.id===r.id ? { ...x, _liked:!x._liked, likes:Math.max(0, x.likes+(x._liked?-1:1)) } : x) }))
    ;(r._liked ? api.qna.unreact(id, r.id) : api.qna.react(id, r.id)).catch(() => { api.qna.reanswers(id, aid).then(list => setRepliesMap(m => ({ ...m, [aid]: list || [] }))).catch(() => {}) })   // §12 on the reanswer
  }
  const startEditReply = (r) => { setEditRid(r.id); setEditRText(r.body) }
  const saveEditReply = (aid, r) => { const v = editRText.trim(); if (!v) return; setRepliesMap(m => ({ ...m, [aid]: (m[aid]||[]).map(x => x.id===r.id ? { ...x, body:v, edited:true } : x) })); setEditRid(null); api.qna.editAnswer(id, r.id, v).catch(e => showToast(qnaError(e, 'Could not edit reply'))) }   // §11.7
  const deleteReply = async (aid, r) => {
    const ok = await uiConfirm({ title:'Delete this reply?', confirmLabel:'Delete', danger:true, icon:'close' })
    if (!ok) return
    setRepliesMap(m => ({ ...m, [aid]: (m[aid]||[]).filter(x => x.id!==r.id) }))
    patchA(aid, x => ({ ...x, replyCount:Math.max(0,(x.replyCount||0)-1) }))
    api.qna.deleteAnswer(id, r.id).catch(() => {})
  }

  /* ---- own-answer sources & attachments management (§15 / §16) ---- */
  const toggleManage = async (a) => {
    const open = openManage[a.id]; setOpenManage(o => ({ ...o, [a.id]: !open })); setEditSrcId(null); setEditAttId(null)
    if (!open) {                                  // load fresh lists (§16.2 / §15.2)
      try { const [srcs, atts] = await Promise.all([api.qna.listSources(id, a.id), api.qna.listAttachments(id, a.id)]); patchA(a.id, x => ({ ...x, sources: srcs || [], attachments: atts || [] })) } catch { /* keep what we have */ }
    }
  }
  const addManagedSource = (a, req, file) => {                                   // §16.1 (+ file upload for MEDIA_FILE)
    api.qna.addSource(id, a.id, req).then(async saved => {
      if (file) { try { saved = await api.qna.uploadSourceFile(id, a.id, saved.id, fileForm(file)) } catch { showToast('Source added — file upload failed') } }
      patchA(a.id, x => ({ ...x, sources:[...(x.sources||[]), saved] }))
    }).catch(e => showToast(qnaError(e, 'Could not add source')))
  }
  const startEditSrc = (s) => { setEditSrcId(s.id); setEditSrcDraft({ title:s.title||'', citationText:s.citationText||'', ref:s.url||s.isbn||'' }) }
  const saveEditSrc = (a, s) => {
    const req = { title: editSrcDraft.title.trim() || s.title, citationText: editSrcDraft.citationText.trim() }
    const r = editSrcDraft.ref.trim()
    if (r) { if (s.type === 'ISBN') req.isbn = r; else if (s.type === 'URL') req.url = r }
    api.qna.editSource(id, a.id, s.id, req).then(saved => {   // §16.3
      patchA(a.id, x => ({ ...x, sources:(x.sources||[]).map(o => o.id===s.id ? saved : o) })); setEditSrcId(null)
    }).catch(e => showToast(qnaError(e, 'Could not save source')))
  }
  const deleteSrc = (a, s) => {
    patchA(a.id, x => ({ ...x, sources:(x.sources||[]).filter(o => o.id!==s.id) }))
    api.qna.deleteSource(id, a.id, s.id).catch(e => { showToast(qnaError(e, 'Could not delete source')); loadAnswers() })   // §16.4
  }
  const pickAttach = (a) => { attachForRef.current = a.id; attachRef.current?.click() }
  const onAttachPicked = (e) => {
    const f = e.target.files?.[0]; const aid = attachForRef.current; e.target.value = ''
    if (!f || !aid) return
    const fd = new FormData(); fd.append('file', f)
    api.qna.addAttachment(id, aid, fd).then(saved => {   // §15.1
      patchA(aid, x => ({ ...x, attachments:[...(x.attachments||[]), saved] })); showToast('Attachment added')
    }).catch(e => showToast(qnaError(e, 'Could not upload attachment')))
  }
  const startEditAtt = (at) => { setEditAttId(at.id); setEditAttCaption(at.caption || '') }
  const saveEditAtt = (a, at) => {
    api.qna.editAttachment(id, a.id, at.id, { caption: editAttCaption }).then(saved => {   // §15.3
      patchA(a.id, x => ({ ...x, attachments:(x.attachments||[]).map(o => o.id===at.id ? saved : o) })); setEditAttId(null)
    }).catch(e => showToast(qnaError(e, 'Could not save attachment')))
  }
  const deleteAtt = (a, at) => {
    patchA(a.id, x => ({ ...x, attachments:(x.attachments||[]).filter(o => o.id!==at.id) }))
    api.qna.deleteAttachment(id, a.id, at.id).catch(e => { showToast(qnaError(e, 'Could not delete attachment')); loadAnswers() })   // §15.4
  }

  if (loading) return <div className="main center"><div className="col-main"><Loader label="Loading question…"/></div></div>
  if (!q) return <div className="main center"><div className="col-main"><EmptyState icon="qna" title="Question not found"/></div></div>

  const u = authorOf(q)
  return (
    <div className="main center">
      <div className="col-main">
        <button className="back-btn" onClick={() => navigate('/qna')}><Icon name="chevleft" className="sm"/>Back to questions</button>
        <input ref={attachRef} type="file" hidden onChange={onAttachPicked}/>

        <div className="card card-pad qd-head">
          <header>
            <span role="button" style={{ cursor:'pointer' }} onClick={() => navigate(`/u/${q.author}`)}><Avatar initials={u.initials} color={u.avc} size={44} src={u.profileImage}/></span>
            <div style={{flex:1}}>
              <div className="qna-name"><b>{u.full}</b> {u.verified && <Verify scholar={u.role==='SCHOLAR'}/>}</div>
              <div className="qna-sub">@{u.handle} · {q.time}{q.answersLocked && <> · <Icon name="lock" className="xs"/>answers locked</>}{q.maxAnswers ? <> · max {q.maxAnswers}</> : null}</div>
            </div>
            <div style={{ display:'flex', gap:6, alignItems:'center' }}>
              {q.hasAcceptedAnswer && <span className="pill scholar" title={`${q.acceptedAnswerCount} accepted answer${q.acceptedAnswerCount===1?'':'s'}`}><Icon name="check" className="xs"/>Resolved</span>}
              <span className={'status ' + q.status.toLowerCase()}>{q.status.toLowerCase()}</span>
            </div>
          </header>

          {editingQ ? (
            <div style={{ marginTop:12 }}>
              <input className="field lg" value={qTitle} onChange={e => setQTitle(e.target.value)} style={{ marginBottom:10 }}/>
              <textarea className="field" value={qBody} onChange={e => setQBody(e.target.value)}/>
              <input className="field" placeholder="Tags (comma-separated)" value={qTags} onChange={e => setQTags(e.target.value)} style={{ marginTop:10 }}/>
              <div className="flex gap-8 mt-12"><button className="btn btn-primary btn-sm" onClick={saveEditQ}>Save</button><button className="btn btn-secondary btn-sm" onClick={() => setEditingQ(false)}>Cancel</button></div>
            </div>
          ) : (
            <>
              <h1>{q.title}</h1>
              <p className="qd-body">{linkify(q.body)}</p>
            </>
          )}

          {!editingQ && !!q.tags?.length && (
            <div className="qna-tags">
              {q.tags.map(t => (
                <a key={t} onClick={() => navigate(`/tags/${encodeURIComponent(t)}`)} style={{ cursor:'pointer' }}>#{t}</a>
              ))}
            </div>
          )}

          <div className="qd-meta">
            <span><Icon name="eye" className="xs"/>{fmt(q.views)} views</span>
            <span><Icon name="comment" className="xs"/>{answers.length || q.answers} answers</span>
            <span><Icon name="bookmark" className="xs"/>{fmt(q.saves || 0)} saves</span>
            <button className={'btn btn-sm ' + (q.saved ? 'btn-primary' : 'btn-secondary')} onClick={save}><Icon name="bookmark" className="xs"/>{q.saved ? 'Saved' : 'Save'}</button>
            <button className="btn btn-secondary btn-sm" title="Save to a collection" onClick={saveToCollection}><Icon name="pin" className="xs"/>Collection</button>
            <button className="btn btn-secondary btn-sm" onClick={share}><Icon name="share" className="xs"/>Share</button>
            {isAuthor && !editingQ && <>
              <button className="btn btn-secondary btn-sm" onClick={startEditQ}><Icon name="compose" className="xs"/>Edit</button>
              <button className="btn btn-secondary btn-sm" onClick={toggleLock}><Icon name="lock" className="xs"/>{q.answersLocked ? 'Unlock' : 'Lock'}</button>
              <button className="btn btn-secondary btn-sm" onClick={setLimit}><Icon name="filter" className="xs"/>{q.maxAnswers ? `Limit ${q.maxAnswers}` : 'Limit'}</button>
              <button className="btn btn-secondary btn-sm" style={{ color:'var(--rose)' }} onClick={deleteQ}><Icon name="close" className="xs"/>Delete</button>
            </>}
          </div>
        </div>

        <div className="section-label"><span>Answers</span><i>{answers.length}</i></div>

        {answers.map((a) => {
          const au = authorOf(a)
          const own = !!(user && a.author === user.id)
          const editing = editAid === a.id
          return (
            <div key={a.id} className={'card card-pad answer ' + (a.accepted ? 'accepted' : a.best ? 'best' : '')}>
              {a.accepted && <div className="ans-banner accepted"><Icon name="check" className="xs"/>Accepted by the author</div>}
              {a.best && !a.accepted && <div className="ans-banner gold"><Icon name="star" className="xs"/>Best answer · {a.votes} scholar vote{a.votes===1?'':'s'}</div>}
              <header>
                <span role="button" style={{ cursor:'pointer' }} onClick={() => navigate(`/u/${a.author}`)}><Avatar initials={au.initials} color={au.avc} size={40} src={au.profileImage}/></span>
                <div style={{flex:1}}>
                  <div className="qna-name"><b>{au.full}</b> {au.verified && <Verify scholar={au.role==='SCHOLAR'}/>} {au.role==='SCHOLAR' && <span className="pill scholar">Scholar</span>}</div>
                  <div className="qna-sub">@{au.handle} · {a.time}{a.edited && <> · edited</>}</div>
                </div>
              </header>

              {editing ? (
                <div className="ans-composer" style={{ marginTop:10 }}>
                  <textarea className="field" value={editText} onChange={e => setEditText(e.target.value)}/>
                  <div className="flex gap-8 mt-12"><button className="btn btn-primary btn-sm" onClick={() => saveEditA(a)}>Save</button><button className="btn btn-secondary btn-sm" onClick={() => setEditAid(null)}>Cancel</button></div>
                </div>
              ) : (
                <>
                  <div className="ans-body">{renderBody(a.body)}</div>
                  {a.mediaUrl && (a.mediaType === 'VIDEO'
                    ? <video src={a.mediaUrl} poster={a.mediaThumbnailUrl || undefined} controls playsInline style={{ width:'100%', borderRadius:12, marginTop:12, background:'#000' }}/>
                    : <img src={a.mediaUrl} alt="" style={{ width:'100%', borderRadius:12, marginTop:12 }}/>)}
                  {a.voiceUrl && <VoicePlayer src={a.voiceUrl} duration={a.voiceDurationSeconds} className="vp-flush"/>}
                  {a.links && a.links.split(',').map(s => s.trim()).filter(Boolean).length > 0 && (
                    <div className="ans-links" style={{ marginTop:10, display:'flex', flexWrap:'wrap', gap:8 }}>
                      {a.links.split(',').map(s => s.trim()).filter(Boolean).map((url, j) => (
                        <a key={j} href={url} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm"><Icon name="link" className="xs"/>{url.replace(/^https?:\/\//, '').slice(0, 40)}</a>
                      ))}
                    </div>
                  )}
                  {!!a.sources?.length && (
                    <div className="ans-sources">
                      <h5>Sources &amp; references</h5>
                      {a.sources.map((s, j) => <SourceRow key={j} s={s}/>)}
                    </div>
                  )}
                  {!!a.attachments?.length && (
                    <div className="ans-sources">
                      <h5>Attachments</h5>
                      {a.attachments.map(at => (
                        <a key={at.id} className="src-row" href={at.url} target="_blank" rel="noreferrer" style={{ textDecoration:'none' }}>
                          <span className="src-ic" style={{ background:'#15302a' }}><Icon name={attIcon(at.mediaType)} className="sm"/></span>
                          <div className="src-info"><b>{at.name}</b><small className="muted">{at.caption || at.mediaType.toLowerCase()}</small></div>
                          <span className="src-tag">{at.mediaType}</span>
                        </a>
                      ))}
                    </div>
                  )}
                </>
              )}

              <div className="ans-actions">
                <button className={'btn btn-secondary btn-sm ' + (a._liked ? 'on-rose' : '')} onClick={() => react(a)}><Icon name="heart" className="xs"/>{a.likes}</button>
                {isScholar
                  ? <button className={'btn btn-secondary btn-sm ' + (a.votedByMe ? 'on-brass' : '')} onClick={() => best(a)}><Icon name="star" className="xs"/>Best · {a.votes}</button>
                  : <span className="btn btn-secondary btn-sm" style={{ cursor:'default' }}><Icon name="star" className="xs"/>{a.votes}</span>}
                <button className="btn btn-secondary btn-sm" onClick={() => { const open = replyTo === a.id; setReplyTo(open ? null : a.id); setReplyTarget(null) }}><Icon name="reply" className="xs"/>Reply{a.replyCount ? ` · ${a.replyCount}` : ''}</button>
                {own && !editing && <button className="btn btn-secondary btn-sm" onClick={() => startEditA(a)}><Icon name="compose" className="xs"/>Edit</button>}
                {own && <button className={'btn btn-secondary btn-sm ' + (openManage[a.id] ? 'on-brass' : '')} onClick={() => toggleManage(a)}><Icon name="book" className="xs"/>Sources &amp; files</button>}
                {own && <button className="btn btn-secondary btn-sm" style={{ color:'var(--rose)' }} onClick={() => deleteA(a)}><Icon name="close" className="xs"/>Delete</button>}
                {isAuthor && (
                  <button className={'btn btn-sm ' + (a.accepted ? 'btn-secondary' : 'btn-primary')} style={{marginLeft:'auto'}} onClick={() => accept(a)}>
                    <Icon name="check" className="xs"/>{a.accepted ? 'Accepted' : 'Accept'}
                  </button>
                )}
              </div>

              {/* own-answer sources & attachments management (§15 / §16) */}
              {own && openManage[a.id] && (
                <div className="ans-sources" style={{ marginTop:10 }}>
                  <h5>Sources &amp; references</h5>
                  {(a.sources||[]).map(s => (
                    editSrcId === s.id ? (
                      <div key={s.id} style={{ display:'grid', gap:6, marginBottom:8 }}>
                        <input className="field" placeholder="Title" value={editSrcDraft.title} onChange={e => setEditSrcDraft(d => ({ ...d, title:e.target.value }))}/>
                        <input className="field" placeholder="Citation text" value={editSrcDraft.citationText} onChange={e => setEditSrcDraft(d => ({ ...d, citationText:e.target.value }))}/>
                        <input className="field" placeholder="URL or ISBN" value={editSrcDraft.ref} onChange={e => setEditSrcDraft(d => ({ ...d, ref:e.target.value }))}/>
                        <div className="flex gap-8"><button className="btn btn-primary btn-sm" onClick={() => saveEditSrc(a, s)}>Save</button><button className="btn btn-ghost btn-sm" onClick={() => setEditSrcId(null)}>Cancel</button></div>
                      </div>
                    ) : (
                      <div key={s.id} style={{ display:'flex', alignItems:'center', gap:6 }}>
                        <div style={{ flex:1 }}><SourceRow s={s}/></div>
                        <button className="icon-btn" title="Edit source" onClick={() => startEditSrc(s)}><Icon name="compose" className="xs"/></button>
                        <button className="icon-btn" title="Delete source" style={{ color:'var(--rose)' }} onClick={() => deleteSrc(a, s)}><Icon name="close" className="xs"/></button>
                      </div>
                    )
                  ))}
                  <div style={{ marginTop:8 }}>
                    <AddSourceForm onAdd={(req, file) => addManagedSource(a, req, file)}/>
                  </div>

                  <h5 style={{ marginTop:14 }}>Attachments</h5>
                  {(a.attachments||[]).map(at => (
                    editAttId === at.id ? (
                      <div key={at.id} className="flex gap-8" style={{ marginBottom:8 }}>
                        <input className="field" placeholder="Caption" value={editAttCaption} onChange={e => setEditAttCaption(e.target.value)}/>
                        <button className="btn btn-primary btn-sm" onClick={() => saveEditAtt(a, at)}>Save</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditAttId(null)}>Cancel</button>
                      </div>
                    ) : (
                      <div key={at.id} style={{ display:'flex', alignItems:'center', gap:6 }}>
                        <a className="src-row" href={at.url} target="_blank" rel="noreferrer" style={{ textDecoration:'none', flex:1 }}>
                          <span className="src-ic" style={{ background:'#15302a' }}><Icon name={attIcon(at.mediaType)} className="sm"/></span>
                          <div className="src-info"><b>{at.name}</b><small className="muted">{at.caption || at.mediaType.toLowerCase()}</small></div>
                          <span className="src-tag">{at.mediaType}</span>
                        </a>
                        <button className="icon-btn" title="Edit caption" onClick={() => startEditAtt(at)}><Icon name="compose" className="xs"/></button>
                        <button className="icon-btn" title="Delete attachment" style={{ color:'var(--rose)' }} onClick={() => deleteAtt(a, at)}><Icon name="close" className="xs"/></button>
                      </div>
                    )
                  ))}
                  <button className="btn btn-secondary btn-sm mt-12" onClick={() => pickAttach(a)}><Icon name="upload" className="xs"/>Upload attachment</button>
                </div>
              )}

              {/* reply composer + thread */}
              {replyTo === a.id && (
                <div className="cmt-box" style={{ marginTop:10 }}>
                  <Avatar initials={(user?.full||'Y').slice(0,1)} color="linear-gradient(135deg,#159a76,#0a4a3c)" size={28} src={user?.profileImage}/>
                  <input className="field" autoFocus placeholder={replyTarget ? `Replying to @${replyTarget.handle}…` : `Reply to ${au.full}…`} value={replyText}
                    onChange={e => setReplyText(e.target.value)} onKeyDown={e => { if (e.key==='Enter') submitReply(a); if (e.key==='Escape') { setReplyTo(null); setReplyText(''); setReplyFile(null); setReplyTarget(null) } }}/>
                  <input ref={replyFileRef} type="file" hidden accept="image/*,video/*,audio/*" onChange={e => { const f = e.target.files?.[0]; if (f) setReplyFile(f); e.target.value='' }}/>
                  <button className="icon-btn" title={replyFile ? replyFile.name : 'Attach media'} onClick={() => replyFileRef.current?.click()} style={replyFile ? { color:'var(--emerald)' } : undefined}><Icon name="paperclip" className="sm"/></button>
                  <button className="icon-btn" disabled={!replyText.trim() && !replyFile} onClick={() => submitReply(a)}><Icon name="send" className="sm"/></button>
                </div>
              )}
              {(a.replyCount > 0 || repliesMap[a.id]?.length > 0) && (
                <button onClick={() => toggleReplies(a)} style={{ marginTop:8, fontSize:'12.5px', color:'var(--emerald)', fontWeight:600, display:'inline-flex', alignItems:'center', gap:4 }}>
                  <Icon name={openReplies[a.id] ? 'chevup' : 'chevdown'} className="xs"/>
                  {openReplies[a.id] ? 'Hide replies' : `View ${a.replyCount || repliesMap[a.id]?.length || 0} repl${(a.replyCount||repliesMap[a.id]?.length)===1?'y':'ies'}`}
                </button>
              )}
              {openReplies[a.id] && (repliesMap[a.id] || []).map((r) => {
                const ru = authorOf(r); const isTmp = String(r.id).startsWith('tmp-'); const rOwn = !!(user && r.author === user.id && !isTmp)
                const rEditing = editRid === r.id
                // "replying to @X" — only when this reply targeted ANOTHER reply (not the root answer)
                let replyingTo = r._replyToHandle || null
                if (!replyingTo && r.replyToAnswerId && r.replyToAnswerId !== a.id) {
                  const tgt = (repliesMap[a.id] || []).find(x => x.id === r.replyToAnswerId)
                  if (tgt) replyingTo = authorOf(tgt).handle
                }
                return (
                  <div key={r.id} className="cmt" style={{ marginLeft:34, marginTop:10 }}>
                    <Avatar initials={ru.initials} color={ru.avc} size={28} src={ru.profileImage}/>
                    <div className="cmt-col">
                      <div className="cmt-bubble">
                        <div className="cmt-name"><b>{ru.full}</b>{ru.verified && <Verify scholar={ru.role==='SCHOLAR'}/>}{replyingTo && <span className="muted text-xs"> · <Icon name="reply" className="xs"/>@{replyingTo}</span>}{r.edited && <span className="muted text-xs"> · edited</span>}</div>
                        {rEditing ? (
                          <div className="flex gap-8" style={{ marginTop:6 }}>
                            <input className="field" autoFocus value={editRText} onChange={e => setEditRText(e.target.value)} onKeyDown={e => { if (e.key==='Enter') saveEditReply(a.id, r); if (e.key==='Escape') setEditRid(null) }}/>
                            <button className="icon-btn" onClick={() => saveEditReply(a.id, r)}><Icon name="check" className="sm"/></button>
                          </div>
                        ) : <p>{linkify(r.body)}</p>}
                        {!rEditing && r.mediaUrl && (r.mediaType === 'VIDEO'
                          ? <video src={r.mediaUrl} controls playsInline style={{ width:'100%', borderRadius:10, marginTop:8, background:'#000' }}/>
                          : <img src={r.mediaUrl} alt="" style={{ width:'100%', borderRadius:10, marginTop:8 }}/>)}
                        {!rEditing && r.voiceUrl && <VoicePlayer src={r.voiceUrl} duration={r.voiceDurationSeconds} className="vp-flush"/>}
                      </div>
                      <div className="cmt-meta">
                        <button onClick={() => reactReply(a.id, r)} disabled={isTmp} style={r._liked ? { color:'var(--rose)' } : undefined}><Icon name="heart" className="xs"/>{r.likes || 0}</button>
                        {!isTmp && <button onClick={() => replyToReply(a, r)}><Icon name="reply" className="xs"/>Reply</button>}
                        {rOwn && !rEditing && <button onClick={() => startEditReply(r)}>Edit</button>}
                        {rOwn && <button onClick={() => deleteReply(a.id, r)} style={{ color:'var(--rose)' }}>Delete</button>}
                        <span>{r.time}</span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })}

        {/* §5/§11.2 — gate on the server's acceptsNewAnswers flag, OR'd with local signals so a stale flag can't wrongly show the composer */}
        {(q.acceptsNewAnswers === false || q.answersLocked || (q.maxAnswers && Math.max(q.answers || 0, answers.length) >= q.maxAnswers)) ? (
          q.answersLocked
            ? <div className="card card-pad muted text-sm" style={{ textAlign:'center' }}><Icon name="lock" className="sm"/> Answers are locked for this question.</div>
            : <div className="card card-pad muted text-sm" style={{ textAlign:'center' }}><Icon name="check" className="sm"/> This question has reached its {q.maxAnswers ? `${q.maxAnswers}-answer ` : ''}limit.</div>
        ) : (
          <div className="card card-pad ans-composer">
            <h3 className="title"><Icon name="compose" className="sm"/>Contribute an answer</h3>
            <textarea className="field" placeholder="Write a clear, sourced answer…" value={text} onChange={e => setText(e.target.value)}/>

            {/* attached media / voice preview */}
            {(ansMedia || ansVoice) && (
              <div style={{ marginTop:12 }}>
                {ansMediaUrl && <img src={ansMediaUrl} alt="" style={{ maxWidth:'100%', borderRadius:12 }}/>}
                {ansMedia && !ansMediaUrl && <div className="src-row"><span className="src-ic" style={{ background:'#15302a' }}><Icon name="video" className="sm"/></span><div className="src-info"><b>{ansMedia.name}</b><small className="muted">video</small></div></div>}
                {ansVoice && <div className="src-row"><span className="src-ic" style={{ background:'#15302a' }}><Icon name="mic" className="sm"/></span><div className="src-info"><b>{ansVoice.name}</b><small className="muted">voice note</small></div></div>}
                <button className="btn btn-ghost btn-sm mt-12" style={{ color:'var(--rose)' }} onClick={() => { setAnsMedia(null); setAnsVoice(null) }}><Icon name="close" className="xs"/>Remove attachment</button>
              </div>
            )}

            {/* added sources */}
            {!!ansSources.length && (
              <div className="ans-sources">
                <h5>Sources &amp; references</h5>
                {ansSources.map((s, j) => (
                  <div key={j} style={{ display:'flex', alignItems:'center', gap:6 }}>
                    <div style={{ flex:1 }}><SourceRow s={{ type:s.req.sourceType, title:s.req.title, sub: s.file ? s.file.name : (s.req.citationText || s.req.url || s.req.isbn || '') }}/></div>
                    <button className="icon-btn" onClick={() => setAnsSources(arr => arr.filter((_, i) => i !== j))}><Icon name="close" className="xs"/></button>
                  </div>
                ))}
              </div>
            )}

            {/* source mini-form */}
            {srcOpen && (
              <div style={{ marginTop:12 }}>
                <AddSourceForm onAdd={(req, file) => setAnsSources(arr => [...arr, { req, file }])}/>
                <button className="btn btn-ghost btn-sm mt-12" onClick={() => setSrcOpen(false)}>Done adding sources</button>
              </div>
            )}

            <input ref={mediaRef} type="file" hidden accept="image/*,video/*" onChange={onPickMedia}/>
            <input ref={voiceFileRef} type="file" hidden accept="audio/*" onChange={onPickVoice}/>
            <div className="flex gap-8 mt-12" style={{ alignItems:'center' }}>
              <button className="icon-btn" title="Attach image or video" onClick={() => mediaRef.current?.click()}><Icon name="image" className="sm"/></button>
              <button className={'icon-btn ' + (recording ? 'on-rose' : '')} title={recording ? 'Stop recording' : ansVoice ? 'Remove voice' : 'Record a voice note'} onClick={voiceTap}><Icon name={recording ? 'pause' : 'mic'} className="sm"/></button>
              <button className="icon-btn" title="Add a source / reference" onClick={() => setSrcOpen(v => !v)}><Icon name="book" className="sm"/></button>
              {recording && <span className="muted text-xs">Recording… tap ❚❚ to stop</span>}
              <button className="btn btn-primary" style={{marginLeft:'auto'}} disabled={posting || (!text.trim() && !ansMedia && !ansVoice)} onClick={postAnswer}>{posting ? 'Posting…' : 'Post answer'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
