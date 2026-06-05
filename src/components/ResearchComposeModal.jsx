/* =========================================================
   Research composer — full RESEARCH_API coverage.

   CREATE (§6.1): one multipart POST sends the whole
   CreateResearchRequest (title, description, abstractText,
   keywords, citation, visibility, scheduledPublishAt,
   comments/downloads toggles, tags, sources[], mediaFiles[],
   contributors[]) + files[]. Then, post-create, the parts that
   can't be inlined are uploaded against the new draft id:
     · MEDIA_FILE source files  (§10.2)
     · cover image              (§8.1)
     · video promo + thumbnail  (§7.1)
   Finally publish now (§6.3) unless a future scheduledPublishAt
   was set (the backend auto-publishes then — §23).

   EDIT (§6.2): PATCH metadata + tags + sources + schedule, then
   reconcile contributors (PUT §11.2), cover (§8), video (§7) and
   media files (§9) only where they changed.

   Scholar / Researcher / Admin only.
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, Avatar, Verify, showToast, ChipInput } from './ui.jsx'
import { AddSourceForm, SOURCE_LABEL } from './SourceForm.jsx'
import { RichTextEditor } from './RichTextEditor.jsx'
import { TagInput } from './TagInput.jsx'
import { renderMarkdown, renderPlain } from '../lib/richtext.js'
import { useAuth } from '../context/AuthContext.jsx'
import { api } from '../api/index.js'
import { normalizeTags } from '../api/tags.js'

/* When editing an existing research, convert the stored source into HTML so
   the WYSIWYG editor always shows formatted content (not raw Markdown). */
function toRichHtml(source, fmt) {
  if (!source) return ''
  const f = (fmt || 'PLAIN').toUpperCase()
  if (f === 'HTML') return source
  if (f === 'MARKDOWN') return renderMarkdown(source)
  return renderPlain(source)
}

const VIS = [['PUBLIC', 'Public'], ['FOLLOWERS_ONLY', 'Followers'], ['PRIVATE', 'Private']]   // ResearchVisibility
const CONTRIB_ROLES = [                                                                        // ContributorRole (§4)
  ['CO_AUTHOR', 'Co-author'], ['ADVISOR', 'Advisor'], ['REVIEWER', 'Reviewer'],
  ['TRANSLATOR', 'Translator'], ['EDITOR', 'Editor'], ['CONTRIBUTOR', 'Contributor'],
]

/* ISO ⇆ <input type="datetime-local"> value (local wall-clock).
   Only surfaces a still-future schedule — a stale (past) one would
   otherwise block every save behind the "must be in the future" guard. */
function toLocalInput(iso) {
  if (!iso) return ''
  const d = new Date(iso); if (isNaN(d) || d.getTime() <= Date.now()) return ''
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/* Object-URL preview for a picked File, revoked on change/unmount. */
function useObjectUrl(file) {
  const [url, setUrl] = React.useState(null)
  React.useEffect(() => {
    if (!file) { setUrl(null); return }
    const u = URL.createObjectURL(file); setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file])
  return url
}

function Toggle({ title, desc, on, onChange, disabled }) {
  return (
    <div className="set-toggle" style={disabled ? { opacity:.5 } : undefined}>
      <div><b>{title}</b>{desc && <small className="muted">{desc}</small>}</div>
      <button className={'sw ' + (on ? 'on' : '')} disabled={disabled} onClick={() => !disabled && onChange(!on)}/>
    </div>
  )
}

/* Left-rail sections + scroll-spy targets. icon = project Icon name. */
const RM_SECTIONS = [
  { id:'essentials',   icon:'doc',       label:'Essentials',      hint:'Title · abstract · description' },
  { id:'discovery',    icon:'hash',      label:'Discovery',       hint:'Keywords · tags · citation' },
  { id:'media',        icon:'image',     label:'Media',           hint:'Cover & promo video' },
  { id:'contributors', icon:'users',     label:'Contributors',    hint:'Co-authors & advisors' },
  { id:'sources',      icon:'cite',      label:'Sources',         hint:'References & citations' },
  { id:'files',        icon:'paperclip', label:'Files & figures', hint:'PDF · datasets · figures' },
  { id:'publishing',   icon:'settings',  label:'Publishing',      hint:'Permissions & schedule' },
]

/* One content section. Module-level (stable identity) so the rich-text editors
   inside never remount on re-render. `innerRef` registers the node so the rail
   can scroll-spy / jump to it. */
function RmSection({ id, icon, title, tag, innerRef, children }) {
  return (
    <section className="rm-sec" data-sec={id} ref={innerRef}>
      <header className="rm-sec-hd">
        <span className="rm-sec-ic"><Icon name={icon} className="sm"/></span>
        <h3 className="rm-sec-t">{title}</h3>
        {tag && <span className="rm-sec-tag">{tag}</span>}
      </header>
      <div className="rm-sec-body">{children}</div>
    </section>
  )
}

/* ---- Contributor picker (§11) — researcher/scholar-only search (§9.6) ---- */
function ContributorsField({ value, onChange, meId }) {
  const [q, setQ] = React.useState('')
  const [results, setResults] = React.useState([])
  const [loading, setLoading] = React.useState(false)

  React.useEffect(() => {
    const term = q.trim()
    if (term.length < 2) { setResults([]); setLoading(false); return }
    let alive = true; setLoading(true)
    const t = setTimeout(() => {
      api.users.search(term, { eligibleContributor: true, size: 8 })   // RESEARCHER / SCHOLAR only
        .then(list => { if (alive) setResults(list || []) })
        .catch(() => { if (alive) setResults([]) })
        .finally(() => { if (alive) setLoading(false) })
    }, 260)
    return () => { alive = false; clearTimeout(t) }
  }, [q])

  const taken = new Set(value.map(c => c.userId))
  const visible = results.filter(u => u.id && u.id !== meId && !taken.has(u.id))

  const add = (u) => {
    onChange([...value, { userId: u.id, full: u.full, handle: u.handle, initials: u.initials, avc: u.avc, profileImage: u.profileImage, verified: u.verified, role: 'CO_AUTHOR', note: '' }])
    setQ(''); setResults([])
  }
  const patch = (i, k, v) => onChange(value.map((c, idx) => idx === i ? { ...c, [k]: v } : c))
  const remove = (i) => onChange(value.filter((_, idx) => idx !== i))
  const move = (i, dir) => {                       // reorder → displayOrder is sent as array position
    const j = i + dir; if (j < 0 || j >= value.length) return
    const next = value.slice();[next[i], next[j]] = [next[j], next[i]]; onChange(next)
  }

  return (
    <div style={{ display:'grid', gap:10 }}>
      {value.map((c, i) => (
        <div key={c.userId} className="src-row" style={{ alignItems:'flex-start', flexWrap:'wrap' }}>
          <Avatar initials={c.initials} color={c.avc} size={36} src={c.profileImage}/>
          <div className="src-info" style={{ flex:'1 1 180px' }}>
            <b className="flex-c gap-6">{c.full} {c.verified && <Verify scholar/>}</b>
            <small className="muted">@{c.handle}</small>
            <input className="field" style={{ height:36, marginTop:6 }} placeholder="Contribution note (e.g. Wrote section 3 — methodology)"
              value={c.note} onChange={e => patch(i, 'note', e.target.value)}/>
          </div>
          <div className="flex" style={{ flexDirection:'column', gap:6, alignItems:'flex-end' }}>
            <select className="field" style={{ height:36, maxWidth:140 }} value={c.role} onChange={e => patch(i, 'role', e.target.value)}>
              {CONTRIB_ROLES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <div className="flex gap-6">
              <button className="icon-btn" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}><Icon name="chevup" className="xs"/></button>
              <button className="icon-btn" title="Move down" disabled={i === value.length - 1} onClick={() => move(i, 1)}><Icon name="chevdown" className="xs"/></button>
              <button className="icon-btn" title="Remove" onClick={() => remove(i)}><Icon name="close" className="sm"/></button>
            </div>
          </div>
        </div>
      ))}

      <div className="explore-search" style={{ height:44, marginBottom:0 }}>
        <Icon name="search" className="sm"/>
        <input placeholder="Search scholars & researchers to add…" value={q} onChange={e => setQ(e.target.value)}/>
        {loading && <span className="muted text-xs">…</span>}
      </div>
      {!!visible.length && (
        <div className="card" style={{ overflow:'hidden' }}>
          {visible.map(u => (
            <button key={u.id} className="rail-row" style={{ width:'100%', textAlign:'left', padding:'10px 12px' }} onClick={() => add(u)}>
              <Avatar initials={u.initials} color={u.avc} size={34} src={u.profileImage}/>
              <div className="rail-info">
                <div className="rail-name"><b>{u.full}</b> {u.verified && <Verify scholar/>}</div>
                <div className="rail-sub">@{u.handle} · {(u.role || 'member').toLowerCase()}</div>
              </div>
              <Icon name="follow" className="sm"/>
            </button>
          ))}
        </div>
      )}
      {q.trim().length >= 2 && !loading && !visible.length && (
        <p className="muted text-xs">No eligible co-authors found. Only verified researchers & scholars can be added.</p>
      )}
    </div>
  )
}

export function ResearchComposeModal({ onClose, onCreated, editResearch = null, onEdited }) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const me = user || { full: 'You' }
  const isEdit = !!editResearch

  /* ---- text fields ---- */
  const [title, setTitle] = React.useState(editResearch?.title || '')
  // The composer is always WYSIWYG (HTML) — opening MD/PLAIN content
  // renders it to HTML so the user can keep editing in the rich editor.
  // Prefer the RAW abstract source (HTML/MD) for the editor — `abstract` is
  // stripHtml'd to plain text for card previews, so editing it directly would
  // drop all the author's formatting.
  const [abstractText, setAbstract] = React.useState(() => toRichHtml(editResearch?.abstractSource ?? editResearch?.abstract, editResearch?.bodyFormat))
  const [description,  setDescription] = React.useState(() => toRichHtml(editResearch?.description || editResearch?.overview, editResearch?.bodyFormat))
  // BodyFormat — always HTML in this modal (the WYSIWYG editor is the only entry).
  // Server's renderer will re-render both fields under HTML on save.
  const [bodyFormat] = React.useState('HTML')
  const [keywords, setKeywords] = React.useState(editResearch?.keywords || '')
  const [citation, setCitation] = React.useState(editResearch?.citation || '')
  const [tags, setTags] = React.useState(normalizeTags(editResearch?.tags || []))
  const [visibility, setVisibility] = React.useState(editResearch?.visibility || 'PUBLIC')
  const [commentsEnabled, setComments] = React.useState(editResearch ? editResearch.commentsEnabled !== false : true)
  const [downloadsEnabled, setDownloads] = React.useState(editResearch ? editResearch.downloadsEnabled !== false : true)
  const [scheduledAt, setScheduledAt] = React.useState(toLocalInput(editResearch?.scheduledPublishAt))
  const [publishNow, setPublishNow] = React.useState(false)

  /* ---- sources [{ req, file }] ---- */
  const [sources, setSources] = React.useState(() => (editResearch?.sources || []).map(s => ({
    req: { sourceType: s.type, title: s.title, citationText: s.citationText || undefined, url: s.url || undefined, isbn: s.isbn || undefined }, file: null,
  })))

  /* ---- contributors [{ userId, full, …, role, note }] ---- */
  const [contribs, setContribs] = React.useState(() => (editResearch?.contributors || []).map(c => ({
    userId: c._user?.id || c.user || '', full: c._user?.full || 'Member', handle: c._user?.handle || 'member',
    initials: c._user?.initials || 'M', avc: c._user?.avc, profileImage: c._user?.profileImage, verified: !!c._user?.verified,
    role: c.role || 'CO_AUTHOR', note: c.note || '',
  })).filter(c => c.userId))
  const initialContribKey = React.useRef(JSON.stringify((editResearch?.contributors || []).map(c => [c._user?.id, c.role, c.note])))

  /* ---- new media files [{ file, caption, altText }] + existing (edit) ---- */
  const [media, setMedia] = React.useState([])
  const [existingMedia, setExistingMedia] = React.useState(() => (editResearch?.mediaFiles || []).map(m => ({ id: m.id, name: m.name || m.caption || 'file', caption: m.caption || '', type: m.type })))
  const [removedMedia, setRemovedMedia] = React.useState([])
  const mediaRef = React.useRef(null)

  /* ---- cover image ---- */
  // The cover endpoint (and media/video) is gated to scholars/researchers; a plain
  // USER gets a 403. Guard up-front so we never push an op that silently 403s.
  const canCover = ['SCHOLAR', 'RESEARCHER', 'ADMIN', 'SUPER_ADMIN'].includes(String(user?.role || '').toUpperCase())
  const [coverFile, setCoverFile] = React.useState(null)
  const [coverRemoved, setCoverRemoved] = React.useState(false)
  const coverRef = React.useRef(null)
  const coverPreview = useObjectUrl(coverFile)
  const existingCover = editResearch?.coverImageUrl || null
  const coverShown = coverPreview || (coverRemoved ? null : existingCover)

  /* ---- video promo (+ optional thumbnail) ---- */
  const [videoFile, setVideoFile] = React.useState(null)
  const [thumbFile, setThumbFile] = React.useState(null)
  const [videoRemoved, setVideoRemoved] = React.useState(false)
  const videoRef = React.useRef(null)
  const thumbRef = React.useRef(null)
  const videoPreview = useObjectUrl(videoFile)
  const thumbPreview = useObjectUrl(thumbFile)
  const existingVideo = editResearch?.videoPromoUrl || null
  const existingThumb = editResearch?.videoPromoThumb || null
  const videoShown = videoPreview || (videoRemoved ? null : existingVideo)

  const [busy, setBusy] = React.useState(false)
  const busyRef = React.useRef(false)   // synchronous lock — blocks double-submits before the disabled state renders
  // Per-step progress (id → { name, status: pending|running|done|failed, error })
  const stepsRef = React.useRef({})
  const [steps, setSteps] = React.useState({})
  const [saveError, setSaveError] = React.useState(null)            // { critical: bool, message, updated? }

  const updateStep = React.useCallback((id, status, error = null) => {
    stepsRef.current = { ...stepsRef.current, [id]: { ...stepsRef.current[id], status, error } }
    setSteps({ ...stepsRef.current })
  }, [])

  /* ---- media handlers ---- */
  const onPickMedia = (e) => {
    const picked = Array.from(e.target.files || [])
    if (picked.length) setMedia(m => [
      ...m,
      ...picked.map(f => ({ _id: Math.random().toString(36).slice(2, 11), file: f, caption: f.name, altText: '' })),
    ])
    e.target.value = ''
  }
  const patchMedia = (i, k, v) => setMedia(m => m.map((x, idx) => idx === i ? { ...x, [k]: v } : x))
  const removeMedia = (i) => setMedia(m => m.filter((_, idx) => idx !== i))
  const dropExisting = (id) => { setExistingMedia(em => em.filter(m => m.id !== id)); setRemovedMedia(r => [...r, id]) }
  const removeSource = (i) => setSources(s => s.filter((_, idx) => idx !== i))

  const removeCover = () => { if (coverFile) setCoverFile(null); else setCoverRemoved(true) }
  const removeVideo = () => { if (videoFile) { setVideoFile(null); setThumbFile(null) } else setVideoRemoved(true) }

  const buildContribReqs = () => contribs.map((c, i) => ({ userId: c.userId, role: c.role, displayOrder: i + 1, contributionNote: c.note?.trim() || undefined }))

  /* ===========================================================================
     submit — orchestrated update / create.
       1. Run the critical metadata op (PATCH for edit, multipart POST for create).
          If it fails, the modal stays open and a banner offers Retry — the
          user never loses their form state.
       2. After it succeeds, run ALL the rest (contributors, media diff, cover,
          video, publish) IN PARALLEL with per-step progress tracking.
       3. Each op has an onSuccess hook that clears the matching local state
          (e.g. drops the uploaded file from `media`) so Retry never re-uploads
          something that already succeeded.
       4. If every op succeeds → close + notify parent.
          If some fail → keep modal open, show what failed, "Retry failed"
          re-runs only those, "Close anyway" accepts the partial save.
  ============================================================================ */
  const submit = async () => {
    if (busyRef.current) return        // already saving → ignore the extra click (prevents duplicate research)
    if (!title.trim()) return

    // validate schedule (must be in the future — §23)
    let schedISO = null
    if (scheduledAt) {
      const d = new Date(scheduledAt)
      if (isNaN(d)) { showToast('Invalid publish date'); return }
      if (d.getTime() <= Date.now()) { showToast('Schedule time must be in the future'); return }
      schedISO = d.toISOString()
    }

    // Tags are normalized by TagInput, but re-normalize before send for safety (SEARCH_API §8.5).
    // Research §7.2: tags only count toward trending once the paper is PUBLISHED.
    const tagList = normalizeTags(tags)
    const sourceReqs = sources.map((s, i) => ({ ...s.req, displayOrder: i }))

    /* ---- Build the plan ---- */
    let critical, buildParallel
    if (isEdit) {
      critical = {
        id: 'metadata', name: 'Saving details, tags & sources',
        run: () => api.research.update(editResearch.id, {                  // §6.2
          title: title.trim(), description, abstractText, bodyFormat, keywords, citation: citation || null,
          visibility, scheduledPublishAt: schedISO, commentsEnabled, downloadsEnabled, tags: tagList, sources: sourceReqs,
        }),
      }
      buildParallel = () => {
        const ops = []
        const contribKey = JSON.stringify(contribs.map(c => [c.userId, c.role, c.note]))
        if (contribKey !== initialContribKey.current) ops.push({
          id: 'contribs', name: 'Updating contributors',
          run: () => api.research.replaceContributors(editResearch.id, buildContribReqs()),
          onSuccess: () => { initialContribKey.current = contribKey },     // mark synced
        })
        removedMedia.forEach(mid => ops.push({
          id: `media-del-${mid}`, name: 'Removing a file',
          run: () => api.research.deleteMedia(editResearch.id, mid),
          onSuccess: () => setRemovedMedia(r => r.filter(x => x !== mid)),
        }))
        media.forEach((m, i) => ops.push({
          id: `media-add-${m._id}`, name: `Uploading ${m.file.name}`,
          run: () => {
            const fd = new FormData(); fd.append('file', m.file)
            return api.research.addMedia(editResearch.id, fd, {
              caption: m.caption || undefined, altText: m.altText || undefined,
              displayOrder: existingMedia.length + i,
            })
          },
          onSuccess: () => setMedia(prev => prev.filter(x => x._id !== m._id)),
        }))
        if (coverFile && !canCover) showToast('Cover upload needs a Scholar or Researcher role — saved without it')
        if (coverFile && canCover) ops.push({
          id: 'cover', name: 'Uploading cover image',
          run: () => api.research.uploadCover(editResearch.id, coverFile),
          onSuccess: () => setCoverFile(null),
        })
        else if (coverRemoved && existingCover) ops.push({
          id: 'cover-rm', name: 'Removing cover image',
          run: () => api.research.removeCover(editResearch.id),
          onSuccess: () => setCoverRemoved(false),
        })
        if (videoFile) ops.push({
          id: 'video', name: 'Uploading promo video',
          run: () => { const fd = new FormData(); fd.append('video', videoFile); if (thumbFile) fd.append('thumbnail', thumbFile); return api.research.uploadVideoPromo(editResearch.id, fd) },
          onSuccess: () => { setVideoFile(null); setThumbFile(null) },
        })
        else if (videoRemoved && existingVideo) ops.push({
          id: 'video-rm', name: 'Removing promo video',
          run: () => api.research.removeVideoPromo(editResearch.id),
          onSuccess: () => setVideoRemoved(false),
        })
        return ops
      }
    } else {
      const data = {
        title: title.trim(), description, abstractText, bodyFormat, keywords, citation: citation || null,
        visibility, scheduledPublishAt: schedISO, commentsEnabled, downloadsEnabled, tags: tagList,
        sources: sourceReqs,
        mediaFiles: media.map((m, i) => ({ caption: m.caption || m.file.name, altText: m.altText || null, displayOrder: i })),
        contributors: buildContribReqs(),
      }
      const fd = new FormData()
      fd.append('data', new Blob([JSON.stringify(data)], { type: 'application/json' }))   // §6.1: data part is application/json
      media.forEach(m => fd.append('files', m.file))                                       // files[i] ⇄ mediaFiles[i]

      critical = {
        id: 'create', name: 'Saving research draft',
        run: () => api.research.create(fd),
        onSuccess: () => setMedia([]),                                     // files are consumed by the multipart
      }
      buildParallel = (created) => {
        const ops = []
        // MEDIA_FILE sources — upload each one to its newly-created source row (§10.2)
        if (created?.id && Array.isArray(created.sources)) {
          sources.forEach((s, i) => {
            if (!s.file) return
            const match = created.sources.find(cs => cs.displayOrder === i)
                       || created.sources.find(cs => cs.sourceType === 'MEDIA_FILE' && cs.title === s.req.title)
            if (!match) return
            ops.push({
              id: `src-file-${i}`, name: `Attaching source: ${s.file.name}`,
              run: () => { const sfd = new FormData(); sfd.append('file', s.file); return api.research.uploadSourceFile(created.id, match.id, sfd) },
            })
          })
        }
        if (coverFile && created?.id && !canCover) showToast('Cover upload needs a Scholar or Researcher role — published without it')
        if (coverFile && created?.id && canCover) ops.push({
          id: 'cover', name: 'Uploading cover image',
          run: () => api.research.uploadCover(created.id, coverFile),
          onSuccess: () => setCoverFile(null),
        })
        if (videoFile && created?.id) ops.push({
          id: 'video', name: 'Uploading promo video',
          run: () => { const vfd = new FormData(); vfd.append('video', videoFile); if (thumbFile) vfd.append('thumbnail', thumbFile); return api.research.uploadVideoPromo(created.id, vfd) },
          onSuccess: () => { setVideoFile(null); setThumbFile(null) },
        })
        if (publishNow && !schedISO && created?.id) ops.push({
          id: 'publish', name: 'Publishing research',
          run: () => api.research.publish(created.id),
        })
        return ops
      }
    }

    /* ---- Execute ---- */
    busyRef.current = true; setBusy(true); setSaveError(null)   // claim the lock before the first await so a 2nd click can't get in
    stepsRef.current = { [critical.id]: { name: critical.name, status: 'pending', error: null } }
    setSteps({ ...stepsRef.current })

    // 1) critical
    updateStep(critical.id, 'running')
    let criticalResult
    try {
      criticalResult = await critical.run()
      updateStep(critical.id, 'done')
      critical.onSuccess?.(criticalResult)
    } catch (e) {
      updateStep(critical.id, 'failed', e)
      setSaveError({ critical: true, message: e?.message || 'Could not save your changes' })
      setBusy(false); busyRef.current = false
      return
    }

    // 2) parallel — build now that the critical result is known
    const parallel = buildParallel(criticalResult)
    if (parallel.length) {
      parallel.forEach(op => { stepsRef.current[op.id] = { name: op.name, status: 'pending', error: null } })
      setSteps({ ...stepsRef.current })
      await Promise.all(parallel.map(async (op) => {
        updateStep(op.id, 'running')
        try { const r = await op.run(); updateStep(op.id, 'done'); op.onSuccess?.(r) }
        catch (e) { updateStep(op.id, 'failed', e) }
      }))
    }

    setBusy(false); busyRef.current = false

    // 3) tally + decide
    const failures = Object.values(stepsRef.current).filter(s => s.status === 'failed')
    if (failures.length) {
      setSaveError({ critical: false, message: `${failures.length} step${failures.length > 1 ? 's' : ''} couldn’t finish.`, updated: criticalResult })
      return
    }

    // Full success — toast, notify, close (create: also navigate to detail)
    showToast(isEdit ? 'Research updated' : (schedISO ? 'Scheduled for publication' : publishNow ? 'Research published' : 'Draft saved'))
    if (isEdit) onEdited?.(criticalResult); else onCreated?.(criticalResult)
    onClose()
    if (!isEdit && criticalResult?.id) navigate(`/research/${criticalResult.id}`)
  }

  /* Accept whatever did save and leave the rest behind — close the modal with the partial update applied. */
  const acceptPartial = () => {
    const updated = saveError?.updated
    setSaveError(null); setSteps({})
    if (isEdit) updated && onEdited?.(updated)
    else if (updated) { onCreated?.(updated); if (updated.id) navigate(`/research/${updated.id}`) }
    onClose()
  }

  const ctaLabel = busy ? 'Saving…' : isEdit ? 'Save changes' : scheduledAt ? 'Schedule' : publishNow ? 'Publish' : 'Create draft'

  /* ---- left-rail scroll-spy + completion ---- */
  const scrollRef = React.useRef(null)
  const secRefs = React.useRef({})
  const [activeSec, setActiveSec] = React.useState('essentials')
  const [progress, setProgress] = React.useState(0)
  const onScroll = () => {
    const c = scrollRef.current; if (!c) return
    const top = c.scrollTop + 130
    let cur = RM_SECTIONS[0].id
    for (const s of RM_SECTIONS) { const el = secRefs.current[s.id]; if (el && el.offsetTop <= top) cur = s.id }
    setActiveSec(cur)
    const denom = c.scrollHeight - c.clientHeight || 1
    setProgress(Math.max(0, Math.min(1, c.scrollTop / denom)))
  }
  const goto = (id) => { const el = secRefs.current[id], c = scrollRef.current; if (el && c) c.scrollTo({ top: Math.max(0, el.offsetTop - 16), behavior:'smooth' }) }
  const meInitials = me.initials || (me.full || 'Y').slice(0, 2).toUpperCase()
  const done = {
    essentials:   !!title.trim(),
    discovery:    tags.length > 0 || !!keywords.trim(),
    media:        !!coverShown || !!videoShown,
    contributors: contribs.length > 0,
    sources:      sources.length > 0,
    files:        media.length > 0 || existingMedia.length > 0,
    publishing:   true,
  }

  return (
    <div className="overlay open rm-overlay" onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="modal rm-modal" role="dialog" aria-label={isEdit ? 'Edit research' : 'Publish research'}>
        {/* Header — emblem + title + live progress bar */}
        <header className="rm-hd">
          <span className="rm-hd-pat" aria-hidden="true"/>
          <span className="rm-hd-emblem" aria-hidden="true"><i/></span>
          <div className="rm-hd-text">
            <h2 className="rm-hd-title">{isEdit ? 'Edit research' : 'Publish research'}</h2>
            <p className="rm-hd-sub">{isEdit
              ? 'Refine your paper — formatting, sources, media & contributors.'
              : 'Scholarly work — rich formatting, sources, media & co-authors.'}</p>
          </div>
          <button className="rm-hd-close" onClick={onClose} disabled={busy} aria-label="Close"><Icon name="close" className="sm"/></button>
          <div className="rm-hd-progress"><span style={{ width: (progress * 100).toFixed(1) + '%' }}/></div>
        </header>

        <div className="rm-body">
          {/* Section rail */}
          <nav className="rm-nav" aria-label="Sections">
            <ul className="rm-nav-list">
              {RM_SECTIONS.map(s => (
                <li key={s.id}>
                  <button type="button" className={'rm-nav-item' + (activeSec === s.id ? ' on' : '')} onClick={() => goto(s.id)}>
                    <span className="rm-nav-ic"><Icon name={s.icon} className="sm"/></span>
                    <span className="rm-nav-tx"><span className="rm-nav-l">{s.label}</span><span className="rm-nav-h">{s.hint}</span></span>
                    {done[s.id] && <span className="rm-nav-ck"><Icon name="check" className="xs"/></span>}
                  </button>
                </li>
              ))}
            </ul>
            <div className="rm-nav-foot">
              <Avatar initials={meInitials} color={me.avc} size={36} src={me.profileImage}/>
              <div className="rm-nav-foot-tx"><span className="rm-nf-name">{me.full}</span><span className="rm-nf-role">Corresponding author</span></div>
            </div>
          </nav>

          {/* Scrollable content */}
          <div className="rm-content" ref={scrollRef} onScroll={onScroll}>
          {/* ---- progress overlay (active while saving) ---- */}
          {busy && (
            <div className="cm-saving">
              <div className="cm-saving-head">
                <span className="cm-mini-spin"/>
                <h4>{isEdit ? 'Saving your changes…' : 'Publishing your research…'}</h4>
              </div>
              <ul className="cm-step-list" role="list">
                {Object.entries(steps).map(([id, s]) => (
                  <li key={id} className={'cm-step ' + s.status}>
                    <span className="cm-step-icon">
                      {s.status === 'done'    && <Icon name="check" className="xs"/>}
                      {s.status === 'running' && <span className="cm-mini-spin sm"/>}
                      {s.status === 'failed'  && <Icon name="close" className="xs"/>}
                    </span>
                    <span className="cm-step-name">{s.name}</span>
                    {s.error?.message && <span className="cm-step-err">{s.error.message}</span>}
                  </li>
                ))}
              </ul>
              <p className="cm-saving-note muted text-xs">
                Running {Object.keys(steps).length} step{Object.keys(steps).length > 1 ? 's' : ''} — uploads run in parallel, you can leave this open.
              </p>
            </div>
          )}

          {/* ---- error banner (after a critical or partial failure; modal stays open) ---- */}
          {!busy && saveError && (
            <div className={'cm-save-err ' + (saveError.critical ? 'critical' : 'partial')}>
              <div className="cm-save-err-ic"><Icon name="flag"/></div>
              <div className="cm-save-err-body">
                <b>{saveError.critical ? 'Couldn’t save your changes' : 'Saved with issues'}</b>
                <p>{saveError.message}</p>
                {!saveError.critical && (
                  <p className="muted text-xs">Your details are saved. Only the failing pieces need another try — your existing form values are kept intact.</p>
                )}
                <ul className="cm-step-list cm-step-list-compact">
                  {Object.entries(steps).filter(([, s]) => s.status === 'failed').map(([id, s]) => (
                    <li key={id} className="cm-step failed">
                      <span className="cm-step-icon"><Icon name="close" className="xs"/></span>
                      <span className="cm-step-name">{s.name}</span>
                      {s.error?.message && <span className="cm-step-err">{s.error.message}</span>}
                    </li>
                  ))}
                </ul>
                <div className="cm-save-err-actions">
                  <button type="button" className="btn btn-primary btn-sm" onClick={submit}>
                    <Icon name="upload" className="xs"/>Retry{saveError.critical ? '' : ' failed steps'}
                  </button>
                  {!saveError.critical && (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={acceptPartial}>Close anyway</button>
                  )}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSaveError(null)}>Dismiss</button>
                </div>
              </div>
            </div>
          )}

          {/* ---- the form (hidden while a save is in progress so the progress panel reads cleanly) ---- */}
          {!busy && (
            <div className="rm-inner">
              <RmSection id="essentials" icon="doc" title="Essentials" tag="required" innerRef={el => (secRefs.current.essentials = el)}>
                <div className="rm-field">
                  <label className="rm-lbl">Title</label>
                  <input className="inp inp-lg rm-title" placeholder="The effects of X on Y" value={title} onChange={e => setTitle(e.target.value)}/>
                </div>
                <div className="rm-field">
                  <label className="rm-lbl">Description <span className="rm-lbl-h">the full write-up kept on the published page</span></label>
                  <RichTextEditor value={description} format="HTML" onChange={setDescription} minHeight={200} showFormat={false}
                    placeholder="Write your research — headings, lists, tables, images, colours, highlights…"/>
                </div>
                <div className="rm-field">
                  <label className="rm-lbl">Abstract <span className="rm-lbl-h">select any text to format</span></label>
                  <RichTextEditor value={abstractText} format="HTML" onChange={setAbstract} minHeight={360} showFormat={false}
                    placeholder="A concise abstract of the work — select any text and use the toolbar to format it."/>
                </div>
              </RmSection>

              <RmSection id="discovery" icon="hash" title="Discovery" tag="how readers find it" innerRef={el => (secRefs.current.discovery = el)}>
                <div className="rm-field">
                  <label className="rm-lbl">Keywords <span className="rm-lbl-h">comma or Enter to add</span></label>
                  <ChipInput value={keywords ? keywords.split(/[,،؛\n]+/).map(s => s.trim()).filter(Boolean) : []}
                    onChange={arr => setKeywords(arr.join(', '))}
                    placeholder="Add a keyword (e.g. methodology) — comma or Enter"/>
                  <p className="rm-micro">Free-text terms that boost search — separate from tags.</p>
                </div>
                <div className="rm-field">
                  <label className="rm-lbl">Tags <span className="rm-lbl-h">{tags.length}/30 · comma or Enter to add</span></label>
                  <TagInput value={tags} onChange={setTags} scope="RESEARCH" placeholder="Add a tag (e.g. methodology) — comma or Enter"/>
                  <p className="rm-micro">Tags surface in trending only after you publish.</p>
                </div>
                <div className="rm-grid2">
                  <div className="rm-field"><label className="rm-lbl">Visibility</label>
                    <div className="rm-sel">
                      <span className="rm-sel-ic"><Icon name={visibility === 'PUBLIC' ? 'globe' : visibility === 'PRIVATE' ? 'lock' : 'users'} className="xs"/></span>
                      <select value={visibility} onChange={e => setVisibility(e.target.value)}>{VIS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                      <span className="rm-sel-cv"><Icon name="chevdown" className="xs"/></span>
                    </div>
                  </div>
                  <div className="rm-field"><label className="rm-lbl">Suggested citation</label><input className="inp rm-cite" placeholder="Al-Qaradawi, Y. (2026). …" value={citation} onChange={e => setCitation(e.target.value)}/></div>
                </div>
              </RmSection>

              <RmSection id="media" icon="image" title="Media" tag="shown on research cards" innerRef={el => (secRefs.current.media = el)}>
                <input ref={coverRef} type="file" hidden accept="image/*" onChange={e => { const f = e.target.files?.[0]; if (f) { setCoverFile(f); setCoverRemoved(false) } e.target.value = '' }}/>
                <input ref={videoRef} type="file" hidden accept="video/mp4,video/webm,video/quicktime" onChange={e => { const f = e.target.files?.[0]; if (f) { setVideoFile(f); setVideoRemoved(false) } e.target.value = '' }}/>
                <input ref={thumbRef} type="file" hidden accept="image/*" onChange={e => { const f = e.target.files?.[0]; if (f) setThumbFile(f); e.target.value = '' }}/>
                <div className="rm-grid2">
                  <div className="rm-field">
                    <label className="rm-lbl">Cover image</label>
                    {coverShown ? (
                      <div className="rm-media-prev">
                        <div className="rm-cover" style={{ background:`center/cover no-repeat url("${coverShown}")` }}/>
                        <div className="rm-media-acts">
                          <button className="btn btn-secondary btn-sm" onClick={() => coverRef.current?.click()}><Icon name="upload" className="xs"/>Replace</button>
                          <button className="btn btn-secondary btn-sm" style={{ color:'var(--rose)' }} onClick={removeCover}><Icon name="close" className="xs"/>Remove</button>
                        </div>
                      </div>
                    ) : (
                      <button type="button" className="rm-drop tall" onClick={() => coverRef.current?.click()}>
                        <span className="rm-drop-ic"><Icon name="image"/></span>
                        <span className="rm-drop-t">Add a cover image</span>
                        <span className="rm-drop-h">PNG / JPG · landscape works best</span>
                      </button>
                    )}
                    {coverFile && !canCover && <small className="rm-warn"><Icon name="lock" className="xs"/> Cover needs a Scholar / Researcher role.</small>}
                  </div>
                  <div className="rm-field">
                    <label className="rm-lbl">Promo video</label>
                    {videoShown ? (
                      <div className="rm-media-prev">
                        <video src={videoShown} poster={(thumbPreview || (videoRemoved ? null : existingThumb)) || undefined} controls playsInline className="rm-video"/>
                        <div className="rm-media-acts">
                          <button className="btn btn-secondary btn-sm" onClick={() => videoRef.current?.click()}><Icon name="upload" className="xs"/>Replace</button>
                          <button className="btn btn-secondary btn-sm" onClick={() => thumbRef.current?.click()}><Icon name="image" className="xs"/>{thumbFile ? 'Thumb set' : 'Thumbnail'}</button>
                          <button className="btn btn-secondary btn-sm" style={{ color:'var(--rose)' }} onClick={removeVideo}><Icon name="close" className="xs"/>Remove</button>
                        </div>
                      </div>
                    ) : (
                      <button type="button" className="rm-drop tall" onClick={() => videoRef.current?.click()}>
                        <span className="rm-drop-ic"><Icon name="video"/></span>
                        <span className="rm-drop-t">Add a promo video</span>
                        <span className="rm-drop-h">MP4 / WebM / MOV · auto-detected</span>
                      </button>
                    )}
                  </div>
                </div>
              </RmSection>

              <RmSection id="contributors" icon="users" title="Contributors" tag="co-authors · advisors · translators" innerRef={el => (secRefs.current.contributors = el)}>
                <ContributorsField value={contribs} onChange={setContribs} meId={me.id}/>
              </RmSection>

              <RmSection id="sources" icon="cite" title="Sources & references" innerRef={el => (secRefs.current.sources = el)}>
                {sources.map((s, i) => (
                  <div key={i} className="rm-src-row">
                    <span className="rm-src-badge">{SOURCE_LABEL[s.req.sourceType] || s.req.sourceType}</span>
                    <span className="rm-src-title">{s.req.title}{s.file ? ` · ${s.file.name}` : ''}</span>
                    <button className="icon-btn" title="Remove" onClick={() => removeSource(i)}><Icon name="close" className="sm"/></button>
                  </div>
                ))}
                <div style={{ marginTop: sources.length ? 12 : 0 }}>
                  <AddSourceForm onAdd={(req, file) => setSources(s => [...s, { req, file }])}/>
                </div>
              </RmSection>

              <RmSection id="files" icon="paperclip" title="Files & figures" tag="paper PDF · datasets · figures" innerRef={el => (secRefs.current.files = el)}>
                {existingMedia.map(m => (
                  <div key={m.id} className="rm-src-row">
                    <span className="rm-src-badge">{(m.type || 'file').toLowerCase()}</span>
                    <span className="rm-src-title">{m.name}{m.caption ? ` · ${m.caption}` : ''}</span>
                    <button className="icon-btn" title="Remove file" onClick={() => dropExisting(m.id)}><Icon name="close" className="sm"/></button>
                  </div>
                ))}
                <input ref={mediaRef} type="file" hidden multiple accept=".pdf,.doc,.docx,image/*,video/*,audio/*" onChange={onPickMedia}/>
                <button type="button" className="rm-drop tall" onClick={() => mediaRef.current?.click()}>
                  <span className="rm-drop-ic"><Icon name="upload"/></span>
                  <span className="rm-drop-t">{isEdit ? 'Add more files' : 'Click to add files'}</span>
                  <span className="rm-drop-h">PDF · DOCX · images · audio · video</span>
                </button>
                {media.map((m, i) => (
                  <div key={i} className="rm-file-card">
                    <div className="rm-file-head">
                      <span className="flex-c gap-6 text-sm" style={{ minWidth:0 }}><Icon name="doc" className="sm"/><span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{m.file.name}</span></span>
                      <button className="icon-btn" onClick={() => removeMedia(i)}><Icon name="close" className="xs"/></button>
                    </div>
                    <div className="rm-grid2" style={{ marginTop:8 }}>
                      <input className="inp" style={{ height:38 }} placeholder="Caption" value={m.caption} onChange={e => patchMedia(i, 'caption', e.target.value)}/>
                      <input className="inp" style={{ height:38 }} placeholder="Alt text (accessibility)" value={m.altText} onChange={e => patchMedia(i, 'altText', e.target.value)}/>
                    </div>
                  </div>
                ))}
              </RmSection>

              <RmSection id="publishing" icon="settings" title="Publishing" tag="permissions & schedule" innerRef={el => (secRefs.current.publishing = el)}>
                <Toggle title="Allow comments" desc="Readers can discuss your work." on={commentsEnabled} onChange={setComments}/>
                <Toggle title="Allow downloads" desc="Let readers save the attached files." on={downloadsEnabled} onChange={setDownloads}/>
                <div className="set-toggle">
                  <div><b>Schedule publication</b><small className="muted">Leave empty to keep it a draft (or publish now below).</small></div>
                  <input className="inp inp-date" type="datetime-local" value={scheduledAt} onChange={e => setScheduledAt(e.target.value)}/>
                </div>
                {!!scheduledAt && (
                  <div className="flex-c gap-6 text-xs" style={{ color:'var(--emerald)', marginTop:6 }}>
                    <Icon name="check" className="xs"/>Auto-publishes at the scheduled time — no need to publish manually.
                  </div>
                )}
                {scheduledAt && <button className="text-xs muted" style={{ marginTop:4 }} onClick={() => setScheduledAt('')}>Clear schedule</button>}
                {!isEdit && <Toggle title="Publish immediately" desc="Otherwise it's saved as a draft you can publish later." on={publishNow} onChange={setPublishNow} disabled={!!scheduledAt}/>}
              </RmSection>

              <div className="rm-end"><span/></div>
            </div>
          )}
          </div>
        </div>

        <footer className="rm-ftr">
          <div className="rm-ftr-as">
            <Avatar initials={meInitials} color={me.avc} size={28} src={me.profileImage}/>
            <span>{isEdit ? 'Editing as' : 'Publishing as'} <strong>{me.full}</strong></span>
          </div>
          <div className="rm-ftr-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="button" className={'btn btn-primary' + (!isEdit && publishNow ? ' rm-go' : '')} disabled={busy || !title.trim()} onClick={submit}>{ctaLabel}</button>
          </div>
        </footer>
      </div>
    </div>
  )
}
