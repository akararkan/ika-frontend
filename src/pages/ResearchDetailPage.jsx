/* =========================================================
   Research detail page — /research/:id
   Live full research + realtime counter stream.
   ========================================================= */
import React from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Icon, Verify, Avatar, fmt, linkify, showToast } from '../components/ui.jsx'
import { MentionBox } from '../components/MentionBox.jsx'
import { openShare } from '../components/ShareSheet.jsx'
import { uiPrompt, uiConfirm } from '../components/Dialog.jsx'
import { SourceRow } from '../components/Source.jsx'
import { ResearchComposeModal } from '../components/ResearchComposeModal.jsx'
import { RichText } from '../components/RichText.jsx'
import { VoicePlayer } from '../components/VoicePlayer.jsx'
import { Loader, EmptyState } from '../components/states.jsx'
import { authorOf } from '../lib/userView.js'
import { useRealtime } from '../hooks/useRealtime.js'
import { useAuth } from '../context/AuthContext.jsx'
import { api, adapters, applyResearchDelta } from '../api/index.js'

/* tiny formatters used by the media gallery (file size + audio/video duration) */
const fmtBytes = (n) => {
  if (n == null || n < 0) return ''
  if (n < 1024) return `${n} B`
  const u = ['KB','MB','GB','TB']; let i = -1; let v = n
  do { v /= 1024; i++ } while (v >= 1024 && i < u.length - 1)
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}
const fmtDuration = (s) => {
  if (s == null || s < 0) return ''
  const m = Math.floor(s / 60), r = Math.round(s % 60)
  return `${m}:${String(r).padStart(2, '0')}`
}
/* File-type badge: short uppercase extension + a colour class, so each
   downloadable file reads like a real document chip (PDF, DOCX, XLSX…). */
const EXT_CLASS = {
  PDF:'ext-pdf', DOC:'ext-doc', DOCX:'ext-doc', RTF:'ext-doc',
  PPT:'ext-ppt', PPTX:'ext-ppt', KEY:'ext-ppt',
  XLS:'ext-xls', XLSX:'ext-xls', CSV:'ext-xls', NUMBERS:'ext-xls',
  ZIP:'ext-zip', RAR:'ext-zip', '7Z':'ext-zip', TAR:'ext-zip', GZ:'ext-zip',
  TXT:'ext-txt', MD:'ext-txt', JSON:'ext-txt',
}
const fileExt = (m) => {
  const name = m.name || m.caption || ''
  const dot = name.lastIndexOf('.')
  if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toUpperCase().slice(0, 4)
  if (m.mimeType?.includes('/')) return m.mimeType.split('/')[1].replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 4)
  return m.type === 'DOCUMENT' ? 'DOC' : 'FILE'
}

/* Promo-video player. The FE just points <video> at r.videoPromoUrl (a direct
   URL per RESEARCH_API §5). It explicitly calls play() (the open was a user
   gesture, though autoplay-with-sound can still be refused — we swallow that and
   leave native controls). When the source itself can't be played, we surface the
   EXACT MediaError reason + the attempted URL, so a backend/CDN problem (private/
   unsigned URL, wrong content-type, expired link, or a relative path the SPA host
   answers with HTML) is diagnosable instead of a silent black box. */
const MEDIA_ERR_REASON = {
  1: 'Playback was aborted.',
  2: 'The video couldn’t be reached — a network error, 404, CORS block, or the server refused it.',
  3: 'The video is corrupt or uses a codec this browser can’t decode.',
  4: 'The link isn’t a playable video — wrong file type/content-type, an expired/unsigned URL, or the server returned a web page (index.html).',
}
function PromoVideo({ src, poster, onClose }) {
  const ref = React.useRef(null)
  const [err, setErr] = React.useState(null)
  const [blobSrc, setBlobSrc] = React.useState('')
  const [mutedHint, setMutedHint] = React.useState(false)
  const triedBlob = React.useRef(false)
  const playSrc = blobSrc || src

  React.useEffect(() => { setErr(null); setBlobSrc(''); triedBlob.current = false }, [src])
  React.useEffect(() => {
    const v = ref.current
    if (!v) return
    // MUTED autoplay is allowed in every browser → the promo ALWAYS plays the
    // instant it opens. (The earlier "click ▶ → nothing" was Firefox blocking
    // autoplay WITH sound — the file/URL is fine, served as video/mp4.) We show a
    // "Tap for sound" pill to unmute.
    v.muted = true
    setMutedHint(true)
    const p = v.play()
    if (p && p.catch) p.catch(() => { /* extremely rare — native controls remain */ })
  }, [playSrc])
  React.useEffect(() => () => { if (blobSrc) URL.revokeObjectURL(blobSrc) }, [blobSrc])

  const onVideoError = async (e) => {
    const me = e.currentTarget?.error
    const code = me?.code || 0
    // One-shot recovery: refetch and replay as a correctly-typed blob. Fixes a
    // server that sends the mp4 with a wrong Content-Type (octet-stream / HTML)
    // when it allows cross-origin fetches. Harmless if it can't (→ diagnostic).
    if (!triedBlob.current && src && /^https?:/i.test(src)) {
      triedBlob.current = true
      try {
        const res = await fetch(src)
        if (res.ok) {
          const raw = await res.blob()
          const typed = raw.type.startsWith('video') ? raw : new Blob([raw], { type: 'video/mp4' })
          setBlobSrc(URL.createObjectURL(typed))
          return
        }
      } catch { /* CORS / network — fall through to the diagnostic */ }
    }
    console.warn('[research] promo video failed', { code, message: me?.message, src })
    setErr({ code })
  }

  if (err) {
    return (
      <div className="rd-vp-fail">
        <Icon name="video"/>
        <p className="rd-vp-fail-t">This promo video couldn’t be played.</p>
        <p className="rd-vp-reason">{MEDIA_ERR_REASON[err.code] || 'The video couldn’t be loaded.'}</p>
        {src && <a className="btn btn-primary btn-sm" href={src} target="_blank" rel="noreferrer"><Icon name="share" className="xs"/>Open the video in a new tab</a>}
        {src && <code className="rd-vp-url" title={src}>{src}</code>}
      </div>
    )
  }
  return (
    <>
      <video ref={ref} className="rd-vp-video" src={playSrc} poster={poster || undefined}
        controls playsInline preload="metadata"
        onError={onVideoError} onEnded={onClose}/>
      {mutedHint && (
        <button className="rd-vp-unmute" onClick={() => { const v = ref.current; if (v) { v.muted = false; v.play?.() } setMutedHint(false) }}>
          <Icon name="volume" className="xs"/>Tap for sound
        </button>
      )}
    </>
  )
}

export function ResearchDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const meId = user?.id
  const [r, setR] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [me, setMe] = React.useState({ liked:false, saved:false })
  const [comments, setComments] = React.useState([])
  const [cText, setCText] = React.useState('')
  const [cFile, setCFile] = React.useState(null); const cFileRef = React.useRef(null)
  const [replyTo, setReplyTo] = React.useState(null)
  const [replyText, setReplyText] = React.useState('')
  const [editing, setEditing] = React.useState(false)
  const [showVideo, setShowVideo] = React.useState(false)
  const [lightbox, setLightbox] = React.useState(-1)         // index into image-only media (-1 = closed)
  const [sources, setSources] = React.useState([])           // authoritative, ordered list (§ /sources endpoint)
  // Reading chrome: TOC scrollspy, top progress bar, back-to-top FAB
  const pageRef = React.useRef(null)
  const [activeSec, setActiveSec] = React.useState('')
  const [progress, setProgress] = React.useState(0)
  const [showFab, setShowFab] = React.useState(false)

  const loadComments = React.useCallback(() => {
    api.research.comments(id).then(res => setComments((res?.content || res || []).map(adapters.researchCommentFrom))).catch(() => {})
  }, [id])
  const loadResearch = React.useCallback((recordView = false) => {
    return api.research.get(id).then(full => {
      const mapped = adapters.researchDetailFrom(full)
      setR(mapped); setMe({ liked: mapped.liked, saved: mapped.saved })
      if (recordView) api.research.recordView(id).catch(() => {})
      return mapped
    })
  }, [id])

  React.useEffect(() => {
    let alive = true
    setLoading(true)
    loadResearch(true).then(() => { if (alive) loadComments() }).catch(() => { if (alive) setR(false) }).finally(() => { if (alive) setLoading(false) })
    // Authoritative, displayOrder-sorted source list (public, block-aware).
    api.research.sources(id).then(s => { if (alive && s?.length) setSources(s) }).catch(() => {})
    return () => { alive = false }
  }, [id, loadResearch, loadComments])

  // SSE delta model (REALTIME_FRONTEND_GUIDE §4): events carry NO counter values —
  // apply +1/-1 locally by type. Own actions are skipped (actorId === me) because the
  // optimistic handlers (react/save/cite/download/comment) already applied them; the
  // comment list also dedups by id, so an echoed own comment can never double.
  useRealtime('researches', r ? id : null, {
    onEvent: (evt) => {
      const t = evt.eventType

      // lifecycle — no optimistic counterpart, handle regardless of actor.
      if (t === 'RESEARCH_UPDATED' || t === 'RESEARCH_PUBLISHED') { loadResearch().catch(() => {}); return }
      if (t === 'RESEARCH_DELETED') { showToast('Research removed'); navigate('/research'); return }

      // own action echo → fully applied optimistically already, ignore it.
      if (evt.actorId && meId && evt.actorId === meId) return

      // counter deltas
      setR(prev => prev ? { ...prev, metrics: applyResearchDelta(prev.metrics, evt) } : prev)

      // comment stream (others only)
      const parent = evt.parentCommentId || null
      const c = evt.comment ? adapters.researchCommentFrom(evt.comment) : null
      const mergeC = (fresh, prevC) => prevC ? { ...fresh, liked: prevC.liked } : fresh   // keep this viewer's like state
      if (c && (t === 'COMMENT_CREATED' || t === 'REPLY_CREATED')) {
        if (parent) setComments(cs => cs.map(x => x.id === parent ? { ...x, replyCount: (x.replyCount || 0) + 1, replies: [...(x.replies || []).filter(rr => rr.id !== c.id), c] } : x))
        else setComments(cs => cs.some(x => x.id === c.id) ? cs : [c, ...cs])
      } else if (c && t === 'COMMENT_EDITED') {
        setComments(cs => cs.map(x => x.id === c.id ? mergeC(c, x) : { ...x, replies: (x.replies || []).map(rr => rr.id === c.id ? mergeC(c, rr) : rr) }))
      } else if (t === 'COMMENT_DELETED') {
        const cid = evt.commentId
        setComments(cs => parent ? cs.map(x => x.id === parent ? { ...x, replies: (x.replies || []).filter(rr => rr.id !== cid), replyCount: Math.max(0, (x.replyCount || 0) - 1) } : x) : cs.filter(x => x.id !== cid))
      } else if (t === 'COMMENT_REACTION_ADDED' || t === 'COMMENT_REACTION_REMOVED') {
        const cid = evt.commentId
        if (cid) {
          const d = t === 'COMMENT_REACTION_ADDED' ? 1 : -1
          setComments(cs => cs.map(x => x.id === cid
            ? { ...x, likes: Math.max(0, (x.likes || 0) + d) }
            : { ...x, replies: (x.replies || []).map(rr => rr.id === cid ? { ...rr, likes: Math.max(0, (rr.likes || 0) + d) } : rr) }))
        }
      }
    },
  })

  // Esc closes the inline video promo OR the image lightbox; arrows page the lightbox
  React.useEffect(() => {
    if (!showVideo && lightbox < 0) return
    const onKey = (e) => {
      if (e.key === 'Escape') { setShowVideo(false); setLightbox(-1) }
      if (lightbox >= 0 && e.key === 'ArrowRight') setLightbox(i => (i + 1) % (r?.mediaFiles?.filter(m => m.type === 'IMAGE').length || 1))
      if (lightbox >= 0 && e.key === 'ArrowLeft')  setLightbox(i => {
        const n = r?.mediaFiles?.filter(m => m.type === 'IMAGE').length || 1
        return (i - 1 + n) % n
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showVideo, lightbox, r])

  // Reading chrome — top progress bar + back-to-top FAB on window scroll, a
  // scrollspy that lights the active TOC entry, and reveal-on-scroll for the
  // section cards. Re-runs when the set of sections changes (content loaded).
  const hasDesc = !!(r && (r.descriptionHtml || r.description))
  React.useEffect(() => {
    const root = pageRef.current
    if (loading || !r || !root) return
    const onScroll = () => {
      const d = document.documentElement
      const top = d.scrollTop || document.body.scrollTop
      const max = d.scrollHeight - d.clientHeight
      setProgress(max > 0 ? Math.min(1, Math.max(0, top / max)) : 0)
      setShowFab(top > 600)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    // Arm reveal-on-scroll only once JS is running, so cards are never left
    // invisible if the observer can't run (the hiding lives behind this class).
    root.classList.add('rd-reveal-on')
    const reveal = new IntersectionObserver(
      (es) => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); reveal.unobserve(e.target) } }),
      { threshold: 0.1 })
    root.querySelectorAll('.reveal').forEach(el => reveal.observe(el))
    const spy = new IntersectionObserver(
      (es) => es.forEach(e => { if (e.isIntersecting) setActiveSec(e.target.getAttribute('data-sec')) }),
      { rootMargin: '-22% 0px -68% 0px', threshold: 0 })
    root.querySelectorAll('[data-sec]').forEach(el => spy.observe(el))
    return () => { window.removeEventListener('scroll', onScroll); reveal.disconnect(); spy.disconnect() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, r?.id, hasDesc, r?.mediaFiles?.length, r?.contributors?.length, comments.length, sources.length])

  const scrollToSec = (secId) => {
    const el = pageRef.current?.querySelector(`#${secId}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const isAuthor = !!(meId && r && r.author === meId)
  // lifecycle endpoints (§6.3-6.7) return the updated ResearchResponse → patch
  // the header (status pill, minted ircId) in place; keep live SSE counters.
  const lifecycle = (fn, label) => fn(id).then(updated => {
    showToast(label)
    if (updated && updated.id) {
      const mapped = adapters.researchDetailFrom(updated)
      setR(prev => prev ? { ...mapped, metrics: prev.metrics } : mapped)
    } else loadResearch()
  }).catch(e => showToast(e?.message || 'Action failed'))
  const publish   = () => lifecycle(api.research.publish, 'Published')
  const unpublish = () => lifecycle(api.research.unpublish, 'Moved back to draft')
  const archive   = () => lifecycle(api.research.archive, 'Archived')
  const retract = async () => {
    const ok = await uiConfirm({ title:'Retract this research?', message:'It stays publicly readable with a retraction banner — citations to it remain valid.', confirmLabel:'Retract', danger:true, icon:'flag' })
    if (ok) lifecycle(api.research.retract, 'Retracted')
  }
  const unretract = async () => {
    const ok = await uiConfirm({ title:'Lift the retraction?', message:'The retraction banner will be removed and the paper returns to its published state. Use this only if the retraction was made in error.', confirmLabel:'Unretract', icon:'flag' })
    if (ok) lifecycle(api.research.unretract, 'Retraction lifted')
  }
  const removeResearch = async () => {
    const ok = await uiConfirm({ title:'Delete this research permanently?', message:'This cannot be undone. Sources, contributors, media, comments and all engagement are removed too.', confirmLabel:'Delete forever', danger:true, icon:'close' })
    if (!ok) return
    api.research.remove(id).then(() => { showToast('Research deleted'); navigate('/research') }).catch(e => showToast(e?.message || 'Could not delete'))
  }

  // own actions aren't echoed back on the stream (§20.1 actor-suppression) → bump the count optimistically
  const react = () => { const liked = me.liked; setMe(s => ({ ...s, liked:!liked })); setR(p => p && ({ ...p, metrics:{ ...p.metrics, reactions: Math.max(0, p.metrics.reactions + (liked?-1:1)) } })); (liked ? api.research.unreact(id) : api.research.react(id)).catch(() => {}) }
  const save = () => { const saved = me.saved; setMe(s => ({ ...s, saved:!saved })); setR(p => p && ({ ...p, metrics:{ ...p.metrics, saves: Math.max(0, p.metrics.saves + (saved?-1:1)) } })); showToast(saved ? 'Removed from saved' : 'Saved'); (saved ? api.research.unsave(id) : api.research.save(id)).catch(() => {}) }
  const downloadMedia = async (mediaId) => {
    try {
      const res = await api.research.download(id, mediaId)   // §18.2 → { url } (url null when no mediaId)
      setR(p => p && ({ ...p, metrics:{ ...p.metrics, downloads:(p.metrics.downloads||0)+1 } }))   // own action isn't echoed (§20.1) → reflect it now
      const url = typeof res === 'string' ? res : res?.url
      if (url && url.startsWith('http')) { showToast('Download ready'); window.open(url, '_blank') }
      else showToast('Download recorded')
    } catch (e) { showToast(e?.code === 'DOWNLOADS_DISABLED' ? 'Downloads are turned off' : 'Download unavailable') }
  }
  // main "Download PDF" → first DOCUMENT media (the server needs a mediaId to return a URL, §18.2)
  const download = () => { const doc = r?.mediaFiles?.find(m => m.type === 'DOCUMENT') || r?.mediaFiles?.[0]; downloadMedia(doc?.id) }
  // render a comment's attached media / voice (§5 CommentResponse)
  const commentMedia = (c) => (<>
    {c.mediaUrl && (c.mediaType === 'VIDEO'
      ? <video src={c.mediaUrl} poster={c.mediaThumbnailUrl || undefined} controls playsInline style={{ width:'100%', borderRadius:10, marginTop:8, background:'#000' }}/>
      : <img src={c.mediaUrl} alt="" style={{ width:'100%', borderRadius:10, marginTop:8 }}/>)}
    {c.voiceUrl && <VoicePlayer src={c.voiceUrl} duration={c.voiceDurationSeconds} className="vp-flush"/>}
  </>)
  const copyCite = () => { navigator.clipboard?.writeText(r.citation); showToast('Citation copied') }
  const cite = () => { setR(p => p && ({ ...p, metrics:{ ...p.metrics, citations:p.metrics.citations + 1 } })); api.research.cite(id).then(() => showToast('Recorded — thank you for citing')).catch(() => {}) }

  /* ---- comments (§17) ---- */
  const bumpC = (d) => setR(p => p && ({ ...p, metrics:{ ...p.metrics, comments: Math.max(0, p.metrics.comments + d) } }))
  const addComment = async () => {
    const v = cText.trim(); const file = cFile
    if (!v && !file) return
    setCText(''); setCFile(null)
    try {
      let raw
      if (file) {   // §17.3 multipart: data JSON + media (image/video) or voice (audio)
        const fd = new FormData()
        fd.append('data', new Blob([JSON.stringify({ content: v, parentId: null })], { type: 'application/json' }))
        fd.append(file.type.startsWith('audio') ? 'voice' : 'media', file)
        raw = await api.research.addCommentUpload(id, fd)
      } else {
        raw = await api.research.addComment(id, v)
      }
      setComments(cs => [adapters.researchCommentFrom(raw), ...cs]); bumpC(1)
    } catch (e) { showToast(e?.code === 'COMMENTS_DISABLED' ? 'Comments are turned off' : 'Could not comment') }
  }
  const submitReply = async (c) => {
    const v = replyText.trim(); if (!v) return
    setReplyText(''); setReplyTo(null)
    try { const rep = adapters.researchCommentFrom(await api.research.addComment(id, v, c.id)); setComments(cs => cs.map(x => x.id===c.id ? { ...x, replyCount:(x.replyCount||0)+1, replies:[...(x.replies||[]), rep] } : x)); bumpC(1) }
    catch { showToast('Could not reply') }
  }
  const reactComment = (c, parentId = null) => {
    const flip = (x) => ({ ...x, liked:!x.liked, likes:x.likes + (x.liked?-1:1) })
    setComments(cs => cs.map(x => parentId ? (x.id===parentId ? { ...x, replies:x.replies.map(rr => rr.id===c.id ? flip(rr) : rr) } : x) : (x.id===c.id ? flip(x) : x)))
    ;(c.liked ? api.research.unreactComment(id, c.id) : api.research.reactComment(id, c.id)).catch(() => {})
  }
  const editComment = async (c, parentId = null) => {
    const v = await uiPrompt({ title:'Edit comment', label:'Comment text', initial:c.body, multiline:true, icon:'compose', confirmLabel:'Save' })
    if (v === null) return; const nv = v.trim(); if (!nv) return
    setComments(cs => cs.map(x => parentId ? (x.id===parentId ? { ...x, replies:x.replies.map(rr => rr.id===c.id ? { ...rr, body:nv, edited:true } : rr) } : x) : (x.id===c.id ? { ...x, body:nv, edited:true } : x)))
    api.research.editComment(id, c.id, nv).catch(() => showToast('Could not edit'))
  }
  const deleteComment = async (c, parentId = null) => {
    const ok = await uiConfirm({ title:'Delete this comment?', confirmLabel:'Delete', danger:true, icon:'close' })
    if (!ok) return
    setComments(cs => parentId ? cs.map(x => x.id===parentId ? { ...x, replies:x.replies.filter(rr => rr.id!==c.id), replyCount:Math.max(0,(x.replyCount||0)-1) } : x) : cs.filter(x => x.id!==c.id))
    bumpC(-1); api.research.deleteComment(id, c.id).catch(() => {})
  }

  if (loading) return <div className="main center"><div className="col-main"><Loader label="Loading research…"/></div></div>
  if (!r) return <div className="main center"><div className="col-main"><EmptyState icon="research" title="Research not found"/></div></div>

  const u = authorOf(r)
  const sLower = r.status.toLowerCase()

  // Media grouped once — drives both the table of contents and the section cards.
  const media  = (r.mediaFiles || []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const images = media.filter(m => m.type === 'IMAGE')
  const videos = media.filter(m => m.type === 'VIDEO')
  const audios = media.filter(m => m.type === 'AUDIO')
  const files  = media.filter(m => m.type === 'DOCUMENT' || m.type === 'OTHER')
  const srcList = sources.length ? sources : (r.sources || [])

  // Table of contents — only the sections that actually render, in reading order.
  const toc = [
    hasDesc                && { id:'rd-description',  label:'Description',  icon:'book' },
    { id:'rd-abstract', label:'Abstract', icon:'doc' },
    images.length          && { id:'rd-figures',      label:'Figures',      icon:'image', n:images.length },
    videos.length          && { id:'rd-videomat',     label:'Video',        icon:'video', n:videos.length },
    audios.length          && { id:'rd-audiomat',     label:'Audio',        icon:'audio', n:audios.length },
    files.length           && { id:'rd-files',        label:'Files',        icon:'doc',   n:files.length },
    r.contributors?.length && { id:'rd-contributors', label:'Contributors', icon:'users', n:r.contributors.length },
    srcList.length         && { id:'rd-sources',      label:'Sources',      icon:'cite',  n:srcList.length },
    { id:'rd-comments', label:'Comments', icon:'comment', n:r.metrics.comments },
  ].filter(Boolean)

  return (
    <div className="rd-page" ref={pageRef}>
      <div className="rd-progress" style={{ width: `${progress * 100}%` }} aria-hidden="true"/>
      <div className="rd-shell">

        <div className="rd-toolbar">
          <button className="rd-back" onClick={() => navigate('/research')}><Icon name="chevleft" className="sm"/>Back to research</button>
          {isAuthor && (
            <div className="rd-owner">
              <div className="rd-owner-seg">
                <button onClick={() => setEditing(true)}><Icon name="compose" className="xs"/>Edit</button>
                {r.status === 'DRAFT'     && <button onClick={publish}><Icon name="upload" className="xs"/>Publish</button>}
                {r.status === 'PUBLISHED' && <button onClick={unpublish}><Icon name="download" className="xs"/>Unpublish</button>}
                {r.status !== 'ARCHIVED'  && <button onClick={archive}><Icon name="bookmark" className="xs"/>Archive</button>}
                {r.status !== 'RETRACTED' && <button onClick={retract}><Icon name="flag" className="xs"/>Retract</button>}
                {r.status === 'RETRACTED' && <button onClick={unretract}><Icon name="check" className="xs"/>Unretract</button>}
              </div>
              <button className="rd-del" onClick={removeResearch}><Icon name="close" className="xs"/>Delete</button>
            </div>
          )}
        </div>

        {r.status === 'RETRACTED' && (
          <div className="rd-banner retracted">
            <div className="rd-banner-ico"><Icon name="flag"/></div>
            <div><b>Retracted</b><p>This work has been retracted by its author and is kept publicly readable for citation integrity.</p></div>
          </div>
        )}
        {r.status === 'ARCHIVED' && (
          <div className="rd-banner archived">
            <div className="rd-banner-ico"><Icon name="lock"/></div>
            <div><b>Archived</b><p>Hidden from public feeds but still readable by direct link — for superseded papers that should remain citable.</p></div>
          </div>
        )}
        {r.status === 'DRAFT' && isAuthor && (
          <div className="rd-banner draft">
            <div className="rd-banner-ico"><Icon name="doc"/></div>
            <div><b>Draft</b><p>Only you can see this. Publish when ready to mint an IRC ID — the official paper identifier that stays stable through later unpublish/republish.</p></div>
          </div>
        )}

        {/* Masthead hero — cover wash + Islamic geometric pattern + scrim, eyebrow, title, author & key facts. */}
        <header className="rd-hero2" style={{ background: r.cover }}>
          <span className="rd-hero2-pattern" aria-hidden="true"/>
          <span className="rd-hero2-scrim" aria-hidden="true"/>
          <div className="rd-hero2-top">
            {r.irc && <span className="rd-chip-id font-mono">{r.irc}</span>}
            <span className={'rd-chip-status ' + sLower}><span className="dot"/>{r.status}</span>
          </div>
          {r.hasVideo && <button className="rd-hero2-play" onClick={() => setShowVideo(true)} aria-label="Play promo video"><Icon name="play"/></button>}
          <div className="rd-hero2-content">
            <span className="rd-eyebrow">{r.tags?.[0] || 'Research'}</span>
            <h1 className="rd-hero2-title">{r.title}</h1>
            <div className="rd-hero2-by">
              <Avatar initials={u.initials} color={u.avc} size={46} src={u.profileImage}/>
              <div>
                <div className="nm">{u.full}{u.verified && <Verify scholar/>}</div>
                <div className="tm">@{u.handle} · {r.time}</div>
              </div>
            </div>
            <div className="rd-facts">
              <span className="rd-fact"><Icon name="cite" className="xs"/><b>{fmt(r.metrics.citations)}</b> cited</span>
              <span className="rd-fact"><Icon name="download" className="xs"/><b>{fmt(r.metrics.downloads)}</b> downloads</span>
              <span className="rd-fact"><Icon name="eye" className="xs"/><b>{fmt(r.metrics.views)}</b> views</span>
            </div>
          </div>
        </header>

        <div className="rd-layout">
          <nav className="rd-toc">
            <h4>Contents</h4>
            {toc.map(t => (
              <button key={t.id} type="button" className={'rd-toc-a' + (activeSec === t.id ? ' active' : '')} onClick={() => scrollToSec(t.id)}>
                <span className="rd-toc-dot"/>
                <span className="rd-toc-eng">{t.label}</span>
                {t.n != null && <span className="rd-toc-n">{fmt(t.n)}</span>}
              </button>
            ))}
          </nav>

          <main className="rd-main">
            {hasDesc && (
              <section className="card rd-card2 reveal" id="rd-description" data-sec="rd-description">
                <div className="rd-sec-head"><span className="rd-sec-ic"><Icon name="book" className="sm"/></span><h2>Description</h2></div>
                <RichText html={r.descriptionHtml} source={r.description} format={r.bodyFormat} className="rd-text"/>
              </section>
            )}
            <section className="card rd-card2 reveal" id="rd-abstract" data-sec="rd-abstract">
              <div className="rd-sec-head"><span className="rd-sec-ic"><Icon name="doc" className="sm"/></span><h2>Abstract</h2></div>
              <RichText html={r.abstractHtml} source={r.abstractSource} format={r.bodyFormat} className="rd-abstract"/>
            </section>
            {!!images.length && (
              <section className="card rd-card2 reveal" id="rd-figures" data-sec="rd-figures">
                <div className="rd-sec-head"><span className="rd-sec-ic"><Icon name="image" className="sm"/></span><h2>Figures</h2><span className="rd-sec-n">{images.length}</span></div>
                <div className="rd-gallery">
                  {images.map((m, i) => (
                    <figure key={m.id || i} className="rd-figure" onClick={() => setLightbox(i)}>
                      <div className="rd-figure-img">
                        {m.url ? <img src={m.url} alt={m.altText || m.caption || ''} loading="lazy"/> : <div className="rd-figure-fallback"/>}
                        <span className="rd-figure-num">Fig. {i + 1}</span>
                      </div>
                      {(m.caption || m.altText) && <figcaption><b>Fig. {i + 1}.</b> {m.caption || m.altText}</figcaption>}
                    </figure>
                  ))}
                </div>
              </section>
            )}
            {!!videos.length && (
              <section className="card rd-card2 reveal" id="rd-videomat" data-sec="rd-videomat">
                <div className="rd-sec-head"><span className="rd-sec-ic"><Icon name="video" className="sm"/></span><h2>Video materials</h2><span className="rd-sec-n">{videos.length}</span></div>
                {videos.map((m) => (
                  <div key={m.id} className="rd-media-block">
                    <video src={m.url} poster={m.thumbnailUrl || undefined} controls playsInline preload="metadata"/>
                    {(m.caption || m.name) && (
                      <div className="rd-media-meta"><b>{m.caption || m.name}</b><small className="muted">{[m.mimeType, fmtBytes(m.fileSize), fmtDuration(m.duration)].filter(Boolean).join(' · ')}</small></div>
                    )}
                  </div>
                ))}
              </section>
            )}
            {!!audios.length && (
              <section className="card rd-card2 reveal" id="rd-audiomat" data-sec="rd-audiomat">
                <div className="rd-sec-head"><span className="rd-sec-ic"><Icon name="audio" className="sm"/></span><h2>Audio materials</h2><span className="rd-sec-n">{audios.length}</span></div>
                {audios.map((m) => (
                  <div key={m.id} className="rd-media-block">
                    <audio src={m.url} controls preload="metadata" style={{ width:'100%' }}/>
                    {(m.caption || m.name) && (
                      <div className="rd-media-meta"><b>{m.caption || m.name}</b><small className="muted">{[m.mimeType, fmtBytes(m.fileSize), fmtDuration(m.duration)].filter(Boolean).join(' · ')}</small></div>
                    )}
                  </div>
                ))}
              </section>
            )}
            {!!files.length && (
              <section className="card rd-card2 reveal" id="rd-files" data-sec="rd-files">
                <div className="rd-sec-head"><span className="rd-sec-ic"><Icon name="doc" className="sm"/></span><h2>Files &amp; materials</h2><span className="rd-sec-n">{files.length}</span>{!r.downloadsEnabled && <small className="muted text-xs" style={{ marginLeft:8, fontWeight:500 }}>· downloads off</small>}</div>
                <div className="rd-files">
                  {files.map((m) => {
                    const ext = fileExt(m)
                    return (
                      <button key={m.id} className="rd-file" onClick={() => downloadMedia(m.id)} disabled={!r.downloadsEnabled}
                        title={r.downloadsEnabled ? `Download ${m.name || 'file'}` : 'Downloads are turned off'}>
                        <span className={'rd-file-ic ' + (EXT_CLASS[ext] || 'ext-default')}><span className="rd-file-ext">{ext}</span></span>
                        <div className="rd-file-info">
                          <b>{m.name || m.caption || 'file'}</b>
                          <small>{[m.mimeType || m.type?.toLowerCase(), fmtBytes(m.fileSize)].filter(Boolean).join(' · ')}</small>
                          {m.caption && m.name && <p>{m.caption}</p>}
                        </div>
                        <span className="rd-file-action"><Icon name="download" className="sm"/><span className="rd-file-action-tx">Download</span></span>
                      </button>
                    )
                  })}
                </div>
              </section>
            )}
            {!!r.contributors?.length && (
              <section className="card rd-card2 reveal" id="rd-contributors" data-sec="rd-contributors">
                <div className="rd-sec-head"><span className="rd-sec-ic"><Icon name="users" className="sm"/></span><h2>Contributors</h2><span className="rd-sec-n">{r.contributors.length}</span></div>
                {r.contributors.map((c, i) => {
                  const cu = c._user || authorOf(c)
                  return (
                    <div key={i} className="rd-contrib">
                      <Avatar initials={cu.initials} color={cu.avc} size={42} src={cu.profileImage}/>
                      <div style={{flex:1}}>
                        <div className="rail-name"><b>{cu.full}</b> {cu.verified && <Verify scholar/>}</div>
                        <small className="contrib-role">{(c.role||'').replace('_',' ')}</small>
                        <div className="muted text-xs">{c.note}</div>
                      </div>
                    </div>
                  )
                })}
              </section>
            )}
            {!!srcList.length && (
              <section className="card rd-card2 reveal" id="rd-sources" data-sec="rd-sources">
                <div className="rd-sec-head"><span className="rd-sec-ic"><Icon name="cite" className="sm"/></span><h2>Sources &amp; references</h2><span className="rd-sec-n">{srcList.length}</span></div>
                <ol className="rd-refs">
                  {srcList.map((s, i) => (<li key={s.id || i}><SourceRow s={s}/></li>))}
                </ol>
              </section>
            )}

            {/* comments — last section in the reading column */}
            <section className="card rd-card2 reveal" id="rd-comments" data-sec="rd-comments">
              <div className="rd-sec-head"><span className="rd-sec-ic"><Icon name="comment" className="sm"/></span><h2>Comments</h2><span className="rd-sec-n">{fmt(r.metrics.comments)}</span></div>
              {r.commentsEnabled ? (
                <div className="cmt-box" style={{ marginTop:0, marginBottom:8 }}>
                  <Avatar initials={(user?.full || 'Y').slice(0,1).toUpperCase()} color="linear-gradient(135deg,#159a76,#0a4a3c)" size={32} src={user?.profileImage}/>
                  <MentionBox className="field" placeholder={cFile ? `${cFile.name} attached…` : 'Add a comment…'} value={cText} onChange={e => setCText(e.target.value)} onKeyDown={e => { if (e.key==='Enter') addComment() }}/>
                  <input ref={cFileRef} type="file" hidden accept="image/*,video/*,audio/*" onChange={e => { const f = e.target.files?.[0]; if (f) setCFile(f); e.target.value='' }}/>
                  <button className="icon-btn" title={cFile ? cFile.name : 'Attach image / video / voice'} onClick={() => cFileRef.current?.click()} style={cFile ? { color:'var(--emerald)' } : undefined}><Icon name="paperclip" className="sm"/></button>
                  <button className="icon-btn" disabled={!cText.trim() && !cFile} onClick={addComment}><Icon name="send" className="sm"/></button>
                </div>
              ) : <p className="muted text-sm">Comments are turned off for this research.</p>}

              {comments.map(c => {
            const cu = c._author; const own = !!(meId && c.author === meId)
            return (
              <div key={c.id} className="cmt">
                <span role="button" style={{ cursor:'pointer' }} onClick={() => c.author && navigate(`/u/${c.author}`)}><Avatar initials={cu.initials} color={cu.avc} size={32} src={cu.profileImage}/></span>
                <div className="cmt-col">
                  <div className="cmt-bubble">
                    <div className="cmt-name"><b>{cu.full}</b>{cu.verified && <Verify scholar={cu.role==='SCHOLAR'}/>}</div>
                    <p>{linkify(c.body)}</p>
                    {commentMedia(c)}
                  </div>
                  <div className="cmt-meta">
                    <button onClick={() => reactComment(c)} style={c.liked ? { color:'var(--rose)' } : undefined}><Icon name="heart" className="xs"/>{c.likes || 0}</button>
                    <button onClick={() => setReplyTo(replyTo === c.id ? null : c.id)}>Reply</button>
                    {own && <button onClick={() => editComment(c)}>Edit</button>}
                    {own && <button onClick={() => deleteComment(c)} style={{ color:'var(--rose)' }}>Delete</button>}
                    <span>{c.time}</span>
                  </div>

                  {replyTo === c.id && (
                    <div className="cmt-box" style={{ marginTop:8 }}>
                      <Avatar initials={(user?.full || 'Y').slice(0,1).toUpperCase()} color="linear-gradient(135deg,#159a76,#0a4a3c)" size={28} src={user?.profileImage}/>
                      <MentionBox className="field" autoFocus placeholder={`Reply to ${cu.full}…`} value={replyText} onChange={e => setReplyText(e.target.value)} onKeyDown={e => { if (e.key==='Enter') submitReply(c); if (e.key==='Escape') { setReplyTo(null); setReplyText('') } }}/>
                      <button className="icon-btn" disabled={!replyText.trim()} onClick={() => submitReply(c)}><Icon name="send" className="sm"/></button>
                    </div>
                  )}

                  {(c.replies || []).map(rr => {
                    const ru = rr._author; const rown = !!(meId && rr.author === meId)
                    return (
                      <div key={rr.id} className="cmt" style={{ marginTop:10 }}>
                        <span role="button" style={{ cursor:'pointer' }} onClick={() => rr.author && navigate(`/u/${rr.author}`)}><Avatar initials={ru.initials} color={ru.avc} size={28} src={ru.profileImage}/></span>
                        <div className="cmt-col">
                          <div className="cmt-bubble">
                            <div className="cmt-name"><b>{ru.full}</b>{ru.verified && <Verify scholar={ru.role==='SCHOLAR'}/>}</div>
                            <p>{linkify(rr.body)}</p>
                            {commentMedia(rr)}
                          </div>
                          <div className="cmt-meta">
                            <button onClick={() => reactComment(rr, c.id)} style={rr.liked ? { color:'var(--rose)' } : undefined}><Icon name="heart" className="xs"/>{rr.likes || 0}</button>
                            {rown && <button onClick={() => editComment(rr, c.id)}>Edit</button>}
                            {rown && <button onClick={() => deleteComment(rr, c.id)} style={{ color:'var(--rose)' }}>Delete</button>}
                            <span>{rr.time}</span>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
              {!comments.length && r.commentsEnabled && <p className="muted text-sm" style={{ padding:'8px 2px' }}>Be the first to comment.</p>}
            </section>
          </main>

          <aside className="rd-rail2">
            <div className="card rd-panel">
              <button className="rd-dlpdf" onClick={download} disabled={!r.downloadsEnabled}
                title={r.downloadsEnabled ? 'Download the main paper' : 'Downloads are turned off'}>
                <Icon name="download" className="sm"/>{r.downloadsEnabled ? 'Download PDF' : 'Downloads off'}</button>
              <div className="rd-act-row">
                <button className={'btn btn-secondary btn-sm rd-act ' + (me.liked ? 'on-rose' : '')} onClick={react}><Icon name="heart" className="xs"/>{me.liked ? 'Reacted' : 'React'}</button>
                <button className={'btn btn-secondary btn-sm rd-act ' + (me.saved ? 'on-brass' : '')} onClick={save}><Icon name="bookmark" className="xs"/>{me.saved ? 'Saved' : 'Save'}</button>
                <button className="btn btn-secondary btn-sm rd-act rd-act-ic" title="Share" onClick={() => openShare({ kind:'research', id, title: r.title })}><Icon name="share" className="xs"/></button>
              </div>
            </div>

            <div className="card rd-panel">
              <h5 className="rd-panel-h">Engagement</h5>
              <div className="rd-metrics">
                <div className="rdm"><b>{fmt(r.metrics.views)}</b><small>VIEWS</small></div>
                <div className="rdm"><b>{fmt(r.metrics.reactions)}</b><small>REACTIONS</small></div>
                <div className="rdm"><b>{fmt(r.metrics.comments)}</b><small>COMMENTS</small></div>
                <div className="rdm"><b>{fmt(r.metrics.saves)}</b><small>SAVES</small></div>
                <div className="rdm"><b>{fmt(r.metrics.downloads)}</b><small>DOWNLOADS</small></div>
                <div className="rdm"><b>{fmt(r.metrics.citations)}</b><small>CITATIONS</small></div>
              </div>
            </div>

            {r.citation && (
              <div className="card rd-panel">
                <h5 className="rd-panel-h">Cite this work</h5>
                <div className="cite-box font-serif">{r.citation}</div>
                <div className="rd-cite-actions">
                  <button onClick={copyCite}><Icon name="cite" className="xs"/>Copy citation</button>
                  <button onClick={cite}><Icon name="check" className="xs"/>I cited this</button>
                </div>
              </div>
            )}

            {!!r.tags?.length && (
              <div className="card rd-panel">
                <div className="rd-topics-head"><span className="hash">#</span>Topics</div>
                <div className="qna-tags">
                  {r.tags.map(t => (<a key={t} onClick={() => navigate(`/tags/${encodeURIComponent(t)}`)} style={{ cursor:'pointer' }}>#{t}</a>))}
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>

      {/* back-to-top */}
      <button className={'rd-fab' + (showFab ? ' show' : '')} onClick={() => window.scrollTo({ top:0, behavior:'smooth' })} aria-label="Back to top"><Icon name="chevup"/></button>

      {/* Enhanced video player — full-screen cinematic theater: blurred cover backdrop,
          framed promo with native controls, glass close (Esc / click-outside also close). */}
      {showVideo && r.videoPromoUrl && (
        <div className="rd-vplayer" onClick={(e) => { if (e.target === e.currentTarget) setShowVideo(false) }}>
          <div className="rd-vp-bg" style={{ background: r.cover }} aria-hidden="true"/>
          <div className="rd-vp-veil" aria-hidden="true"/>
          <div className="rd-vp-stage">
            <PromoVideo src={r.videoPromoUrl} poster={r.videoPromoThumb} onClose={() => setShowVideo(false)}/>
          </div>
          <button className="rd-vp-close" onClick={() => setShowVideo(false)} aria-label="Close (Esc)"><Icon name="close"/></button>
        </div>
      )}

      {/* Figure lightbox — fades in a centred image with prev/next + close affordances */}
      {lightbox >= 0 && (() => {
        const imgs = (r.mediaFiles || []).filter(m => m.type === 'IMAGE')
        const m = imgs[lightbox]; if (!m) return null
        const next = () => setLightbox((lightbox + 1) % imgs.length)
        const prev = () => setLightbox((lightbox - 1 + imgs.length) % imgs.length)
        return (
          <div className="lightbox" onClick={(e) => { if (e.target === e.currentTarget) setLightbox(-1) }}>
            <button className="lb-close" onClick={() => setLightbox(-1)} aria-label="Close (Esc)"><Icon name="close"/></button>
            {imgs.length > 1 && <button className="lb-nav lb-prev" onClick={prev} aria-label="Previous"><Icon name="chevleft"/></button>}
            {imgs.length > 1 && <button className="lb-nav lb-next" onClick={next} aria-label="Next"><Icon name="chevright"/></button>}
            <img className="lb-img" src={m.url} alt={m.altText || m.caption || ''}/>
            {(m.caption || m.altText) && (
              <div className="lb-count"><b>Fig. {lightbox + 1}.</b> {m.caption || m.altText}</div>
            )}
          </div>
        )
      })()}

      {editing && <ResearchComposeModal editResearch={r} onClose={() => setEditing(false)} onEdited={async () => {
        setEditing(false)
        await loadResearch()
        // Notify list pages (ResearchPage, search) so they pick up the new title/abstract/tags.
        try {
          const fresh = await api.research.get(id)
          window.dispatchEvent(new CustomEvent('ika:research-updated', { detail: fresh }))
        } catch { /* detail page already refreshed; lists will re-load on next visit */ }
      }}/>}
    </div>
  )
}
