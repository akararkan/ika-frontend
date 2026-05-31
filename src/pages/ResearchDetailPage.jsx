/* =========================================================
   Research detail page — /research/:id
   Live full research + realtime counter stream.
   ========================================================= */
import React from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Icon, Verify, Avatar, fmt, linkify, showToast } from '../components/ui.jsx'
import { uiPrompt, uiConfirm } from '../components/Dialog.jsx'
import { SourceRow } from '../components/Source.jsx'
import { ResearchComposeModal } from '../components/ResearchComposeModal.jsx'
import { RichText } from '../components/RichText.jsx'
import { VoicePlayer } from '../components/VoicePlayer.jsx'
import { Loader, EmptyState } from '../components/states.jsx'
import { authorOf } from '../lib/userView.js'
import { useRealtime } from '../hooks/useRealtime.js'
import { useAuth } from '../context/AuthContext.jsx'
import { api, adapters } from '../api/index.js'

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
    return () => { alive = false }
  }, [id, loadResearch, loadComments])

  // SSE is FLAT (§20.1): every event carries the post-action ABSOLUTE counters in
  // named fields, comment events embed the fresh `comment` + `parentCommentId`,
  // and the server doesn't echo our own actions → patch in place, no refetch.
  useRealtime('researches', r ? id : null, {
    onEvent: (evt) => {
      const t = evt.eventType
      const num = (k, fb) => typeof evt[k] === 'number' ? evt[k] : fb
      setR(prev => prev ? { ...prev, metrics: {
        views:     num('viewCount',     prev.metrics.views),
        downloads: num('downloadCount', prev.metrics.downloads),
        reactions: num('reactionCount', prev.metrics.reactions),
        comments:  num('commentCount',  prev.metrics.comments),
        saves:     num('saveCount',     prev.metrics.saves),
        citations: num('citationCount', prev.metrics.citations),
      } } : prev)

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
        const cid = evt.commentId, lc = num('commentReactionCount', null)
        if (cid && lc != null) setComments(cs => cs.map(x => x.id === cid ? { ...x, likes: lc } : { ...x, replies: (x.replies || []).map(rr => rr.id === cid ? { ...rr, likes: lc } : rr) }))
      }

      // lifecycle (defined but not broadcast today, §21 — harmless if they ever fire)
      if (t === 'RESEARCH_UPDATED' || t === 'RESEARCH_PUBLISHED') loadResearch().catch(() => {})
      if (t === 'RESEARCH_DELETED') { showToast('Research removed'); navigate('/research') }
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
  return (
    <div className="main center">
      <div className="col-main">
        <button className="back-btn" onClick={() => navigate('/research')}><Icon name="chevleft" className="sm"/>Back to research</button>

        {r.status === 'RETRACTED' && (
          <div className="rd-banner retracted">
            <div className="rd-banner-ico"><Icon name="flag"/></div>
            <div>
              <b>Retracted</b>
              <p>This work has been retracted by its author and is kept publicly readable for citation integrity.</p>
            </div>
          </div>
        )}
        {r.status === 'ARCHIVED' && (
          <div className="rd-banner archived">
            <div className="rd-banner-ico"><Icon name="lock"/></div>
            <div>
              <b>Archived</b>
              <p>Hidden from public feeds but still readable by direct link — for superseded papers that should remain citable.</p>
            </div>
          </div>
        )}
        {r.status === 'DRAFT' && isAuthor && (
          <div className="rd-banner draft">
            <div className="rd-banner-ico"><Icon name="doc"/></div>
            <div>
              <b>Draft</b>
              <p>Only you can see this. Publish when ready to mint an IRC ID — the official paper identifier that stays stable through later unpublish/republish.</p>
            </div>
          </div>
        )}

        {/* author lifecycle toolbar (§6.2-6.7) */}
        {isAuthor && (
          <div className="flex gap-8 mb-12 rd-author-bar" style={{ flexWrap:'wrap', marginBottom:12 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}><Icon name="compose" className="xs"/>Edit</button>
            {r.status === 'DRAFT' && <button className="btn btn-primary btn-sm" onClick={publish}><Icon name="upload" className="xs"/>Publish</button>}
            {r.status === 'PUBLISHED' && <button className="btn btn-secondary btn-sm" onClick={unpublish}><Icon name="download" className="xs"/>Unpublish</button>}
            {r.status !== 'ARCHIVED' && <button className="btn btn-secondary btn-sm" onClick={archive}><Icon name="bookmark" className="xs"/>Archive</button>}
            {r.status !== 'RETRACTED' && <button className="btn btn-secondary btn-sm" style={{ color:'var(--rose)' }} onClick={retract}><Icon name="flag" className="xs"/>Retract</button>}
            {r.status === 'RETRACTED' && <button className="btn btn-primary btn-sm" onClick={unretract}><Icon name="check" className="xs"/>Unretract</button>}
            <button className="btn btn-secondary btn-sm" style={{ color:'var(--rose)', marginLeft:'auto' }} onClick={removeResearch}><Icon name="close" className="xs"/>Delete</button>
          </div>
        )}

        <div className={'rd-hero' + (showVideo ? ' playing' : '')} style={showVideo ? undefined : { background: r.cover }}>
          {showVideo && r.videoPromoUrl ? (
            <>
              <div className="rd-stage-bg" style={{ background: r.cover }} aria-hidden="true"/>
              <div className="rd-stage-veil" aria-hidden="true"/>
              <div className="rd-stage">
                <video className="rd-video" src={r.videoPromoUrl} poster={r.videoPromoThumb || undefined}
                  controls autoPlay playsInline onEnded={() => setShowVideo(false)}/>
              </div>
              <button className="rd-video-close" onClick={() => setShowVideo(false)} aria-label="Close video" title="Close (Esc)">
                <Icon name="close"/>
              </button>
            </>
          ) : (
            <>
              <div className="rd-ids">
                {r.irc && <span className="font-mono">{r.irc}</span>}
                <span className="rd-pub">{r.status}</span>
              </div>
              {r.hasVideo && <button className="rd-play" onClick={() => setShowVideo(true)} aria-label="Play promo video"><Icon name="play"/></button>}
              <div className="rd-overlay">
                <h1>{r.title}</h1>
                <div className="rd-by">
                  <Avatar initials={u.initials} color={u.avc} size={32} src={u.profileImage}/>
                  <span>{u.full}{u.verified && <Verify scholar/>}</span>
                  <span className="muted">·</span><span>{r.time}</span>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="rd-grid">
          <div>
            <section className="card card-pad">
              <h3 className="title"><Icon name="doc" className="sm"/>Abstract</h3>
              <RichText html={r.abstractHtml} source={r.abstract} format={r.bodyFormat} className="rd-abstract"/>
            </section>
            {(r.descriptionHtml || r.description) && (
              <section className="card card-pad">
                <h3 className="title"><Icon name="book" className="sm"/>Overview</h3>
                <RichText html={r.descriptionHtml} source={r.description} format={r.bodyFormat} className="rd-text"/>
              </section>
            )}
            {/* All published media, grouped by type — figures (with lightbox), inline video & audio players, downloadable file cards. */}
            {(() => {
              const media  = (r.mediaFiles || []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
              const images = media.filter(m => m.type === 'IMAGE')
              const videos = media.filter(m => m.type === 'VIDEO')
              const audios = media.filter(m => m.type === 'AUDIO')
              const files  = media.filter(m => m.type === 'DOCUMENT' || m.type === 'OTHER')
              return (<>
                {!!images.length && (
                  <section className="card card-pad">
                    <h3 className="title"><Icon name="image" className="sm"/>Figures</h3>
                    <div className="rd-gallery">
                      {images.map((m, i) => (
                        <figure key={m.id || i} className="rd-figure" onClick={() => setLightbox(i)}>
                          <div className="rd-figure-img">
                            {m.url
                              ? <img src={m.url} alt={m.altText || m.caption || ''} loading="lazy"/>
                              : <div className="rd-figure-fallback"/>}
                            <span className="rd-figure-num">Fig. {i + 1}</span>
                          </div>
                          {(m.caption || m.altText) && (
                            <figcaption><b>Fig. {i + 1}.</b> {m.caption || m.altText}</figcaption>
                          )}
                        </figure>
                      ))}
                    </div>
                  </section>
                )}
                {!!videos.length && (
                  <section className="card card-pad">
                    <h3 className="title"><Icon name="video" className="sm"/>Video materials</h3>
                    {videos.map((m) => (
                      <div key={m.id} className="rd-media-block">
                        <video src={m.url} poster={m.thumbnailUrl || undefined} controls playsInline preload="metadata"/>
                        {(m.caption || m.name) && (
                          <div className="rd-media-meta">
                            <b>{m.caption || m.name}</b>
                            <small className="muted">{[m.mimeType, fmtBytes(m.fileSize), fmtDuration(m.duration)].filter(Boolean).join(' · ')}</small>
                          </div>
                        )}
                      </div>
                    ))}
                  </section>
                )}
                {!!audios.length && (
                  <section className="card card-pad">
                    <h3 className="title"><Icon name="audio" className="sm"/>Audio materials</h3>
                    {audios.map((m) => (
                      <div key={m.id} className="rd-media-block">
                        <audio src={m.url} controls preload="metadata" style={{ width:'100%' }}/>
                        {(m.caption || m.name) && (
                          <div className="rd-media-meta">
                            <b>{m.caption || m.name}</b>
                            <small className="muted">{[m.mimeType, fmtBytes(m.fileSize), fmtDuration(m.duration)].filter(Boolean).join(' · ')}</small>
                          </div>
                        )}
                      </div>
                    ))}
                  </section>
                )}
                {!!files.length && r.downloadsEnabled && (
                  <section className="card card-pad">
                    <h3 className="title"><Icon name="doc" className="sm"/>Downloadable files</h3>
                    <div className="rd-files">
                      {files.map((m) => (
                        <button key={m.id} className="rd-file" onClick={() => downloadMedia(m.id)}>
                          <span className="rd-file-ic"><Icon name={m.type === 'DOCUMENT' ? 'doc' : 'paperclip'} className="sm"/></span>
                          <div className="rd-file-info">
                            <b>{m.name || m.caption || 'file'}</b>
                            <small className="muted">{[m.mimeType || m.type?.toLowerCase(), fmtBytes(m.fileSize)].filter(Boolean).join(' · ')}</small>
                            {m.caption && m.name && <p>{m.caption}</p>}
                          </div>
                          <span className="rd-file-action"><Icon name="download" className="sm"/></span>
                        </button>
                      ))}
                    </div>
                  </section>
                )}
              </>)
            })()}
            {!!r.contributors?.length && (
              <section className="card card-pad">
                <h3 className="title"><Icon name="users" className="sm"/>Contributors</h3>
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
            {!!r.sources?.length && (
              <section className="card card-pad">
                <h3 className="title"><Icon name="cite" className="sm"/>References</h3>
                <ol className="rd-refs">
                  {r.sources.map((s, i) => (
                    <li key={s.id || i}><SourceRow s={s}/></li>
                  ))}
                </ol>
              </section>
            )}
          </div>

          <aside className="rd-rail">
            <div className="card card-pad">
              <button className="btn btn-primary btn-lg btn-block" onClick={download}><Icon name="download" className="sm"/>Download PDF</button>
              <div className="rd-rail-row">
                <button className={'btn btn-secondary btn-sm ' + (me.liked ? 'on-rose' : '')} onClick={react}><Icon name="heart" className="xs"/>{me.liked ? 'Reacted' : 'React'}</button>
                <button className={'btn btn-secondary btn-sm ' + (me.saved ? 'on-brass' : '')} onClick={save}><Icon name="bookmark" className="xs"/>{me.saved ? 'Saved' : 'Save'}</button>
                <button className="btn btn-secondary btn-sm" onClick={() => { api.research.recordShare(id).catch(() => {}); showToast('Share link copied') }}><Icon name="share" className="xs"/></button>
              </div>
              <div className="rd-metrics">
                <div className="rdm"><b>{fmt(r.metrics.views)}</b><small>VIEWS</small></div>
                <div className="rdm"><b>{r.metrics.downloads}</b><small>DOWNLOADS</small></div>
                <div className="rdm"><b>{r.metrics.citations}</b><small>CITATIONS</small></div>
                <div className="rdm"><b>{fmt(r.metrics.reactions)}</b><small>REACTIONS</small></div>
              </div>
              {r.citation && (
                <div className="rd-cite">
                  <div className="field-label">Cite this work</div>
                  <div className="cite-box font-serif">{r.citation}</div>
                  <div className="flex gap-12" style={{ marginTop:8 }}>
                    <button className="text-sm" style={{color:'var(--emerald)',fontWeight:600}} onClick={copyCite}><Icon name="cite" className="xs"/> Copy citation</button>
                    <button className="text-sm" style={{color:'var(--emerald)',fontWeight:600}} onClick={cite}><Icon name="check" className="xs"/> I cited this</button>
                  </div>
                </div>
              )}
            </div>
            {!!r.tags?.length && (
              <div className="card card-pad">
                <h3 className="title"><Icon name="hash" className="sm"/>Topics</h3>
                <div className="qna-tags">
                  {r.tags.map(t => (
                    <a key={t} onClick={() => navigate(`/tags/${encodeURIComponent(t)}`)} style={{ cursor:'pointer' }}>#{t}</a>
                  ))}
                </div>
              </div>
            )}
          </aside>
        </div>

        <section className="card card-pad" style={{ marginTop:16 }}>
          <h3 className="title"><Icon name="comment" className="sm"/>Comments <span className="muted" style={{ fontWeight:400 }}>({fmt(r.metrics.comments)})</span></h3>
          {r.commentsEnabled ? (
            <div className="cmt-box" style={{ marginTop:0, marginBottom:8 }}>
              <Avatar initials={(user?.full || 'Y').slice(0,1).toUpperCase()} color="linear-gradient(135deg,#159a76,#0a4a3c)" size={32} src={user?.profileImage}/>
              <input className="field" dir="auto" placeholder={cFile ? `${cFile.name} attached…` : 'Add a comment…'} value={cText} onChange={e => setCText(e.target.value)} onKeyDown={e => { if (e.key==='Enter') addComment() }}/>
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
                      <input className="field" dir="auto" autoFocus placeholder={`Reply to ${cu.full}…`} value={replyText} onChange={e => setReplyText(e.target.value)} onKeyDown={e => { if (e.key==='Enter') submitReply(c); if (e.key==='Escape') { setReplyTo(null); setReplyText('') } }}/>
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
      </div>

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
