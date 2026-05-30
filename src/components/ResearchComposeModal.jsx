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
import { Icon, Avatar, Verify, showToast } from './ui.jsx'
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

function SectionHead({ icon, title, hint, first }) {
  return (
    <div className={'cm-section' + (first ? ' first' : '')}>
      <span className="cm-section-ic"><Icon name={icon} className="sm"/></span>
      <b className="cm-section-title">{title}</b>
      {hint && <span className="muted text-xs cm-section-hint">{hint}</span>}
    </div>
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
  const [abstractText, setAbstract] = React.useState(() => toRichHtml(editResearch?.abstract, editResearch?.bodyFormat))
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
        if (coverFile) ops.push({
          id: 'cover', name: 'Uploading cover image',
          run: () => { const fd = new FormData(); fd.append('image', coverFile); return api.research.uploadCover(editResearch.id, fd) },
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
        if (coverFile && created?.id) ops.push({
          id: 'cover', name: 'Uploading cover image',
          run: () => { const cfd = new FormData(); cfd.append('image', coverFile); return api.research.uploadCover(created.id, cfd) },
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
    setBusy(true); setSaveError(null)
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
      setBusy(false)
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

    setBusy(false)

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

  return (
    <div className="overlay open" onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="modal cm-research" style={{ maxWidth: 760 }}>
        <div className="mhead">
          <h3>{isEdit ? 'Edit research' : 'Publish research'}</h3>
          <button className="x" onClick={onClose} disabled={busy} aria-label="Close"><Icon name="close" className="sm"/></button>
        </div>

        <div className="mbody cm-research-body" style={{ position:'relative' }}>
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
          {!busy && (<>
          {/* ---- core text ---- */}
          <SectionHead icon="doc" title="Essentials" hint="title, abstract, body, taxonomy" first/>
          <label className="field-label">Title</label>
          <input className="field lg" placeholder="The effects of X on Y" value={title} onChange={e => setTitle(e.target.value)}/>

          <label className="field-label" style={{ marginTop:14 }}>Abstract</label>
          <RichTextEditor
            value={abstractText}
            format="HTML"
            onChange={setAbstract}
            placeholder="A concise abstract of the work — select any text and use the toolbar to format it."
            minHeight={140}
            showFormat={false}
          />

          <label className="field-label" style={{ marginTop:14 }}>Body / overview</label>
          <RichTextEditor
            value={description}
            format="HTML"
            onChange={setDescription}
            placeholder="Write your research — headings, lists, tables, images, colours, highlights…"
            minHeight={260}
            showFormat={false}
          />

          <div className="set-grid">
            <div><label className="field-label">Keywords</label><input className="field" placeholder="X, Y, methodology" value={keywords} onChange={e => setKeywords(e.target.value)}/></div>
            <div><label className="field-label">Visibility</label><select className="field" value={visibility} onChange={e => setVisibility(e.target.value)}>{VIS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            <div style={{ gridColumn:'1/-1' }}>
              <label className="field-label">Tags</label>
              <TagInput value={tags} onChange={setTags} scope="RESEARCH" placeholder="Add tag (e.g. methodology), Enter to add"/>
              <small className="muted text-xs" style={{ marginTop:4, display:'block' }}>Tags appear in trending only after you publish (SEARCH_API §7.2).</small>
            </div>
            <div style={{ gridColumn:'1/-1' }}><label className="field-label">Suggested citation</label><input className="field" placeholder="Al-Qaradawi, Y. (2026). …" value={citation} onChange={e => setCitation(e.target.value)}/></div>
          </div>

          {/* ---- cover image (§8) ---- */}
          <SectionHead icon="image" title="Cover image" hint="shown on research cards"/>
          <input ref={coverRef} type="file" hidden accept="image/*" onChange={e => { const f = e.target.files?.[0]; if (f) { setCoverFile(f); setCoverRemoved(false) } e.target.value = '' }}/>
          {coverShown ? (
            <div>
              <div style={{ height:150, borderRadius:14, border:'1px solid var(--line)', background:`center/cover no-repeat url("${coverShown}")` }}/>
              <div className="flex gap-8" style={{ marginTop:8 }}>
                <button className="btn btn-secondary btn-sm" onClick={() => coverRef.current?.click()}><Icon name="upload" className="xs"/>Replace</button>
                <button className="btn btn-secondary btn-sm" style={{ color:'var(--rose)' }} onClick={removeCover}><Icon name="close" className="xs"/>Remove</button>
              </div>
            </div>
          ) : (
            <div className="cm-drop" onClick={() => coverRef.current?.click()} style={{ cursor:'pointer' }}>
              <Icon name="image" className="lg"/><b>Add a cover image</b><span className="text-xs">PNG / JPG · landscape works best</span>
            </div>
          )}

          {/* ---- video promo (§7) ---- */}
          <SectionHead icon="video" title="Video promo" hint="short MP4/MOV · duration auto-detected"/>
          <input ref={videoRef} type="file" hidden accept="video/mp4,video/webm,video/quicktime" onChange={e => { const f = e.target.files?.[0]; if (f) { setVideoFile(f); setVideoRemoved(false) } e.target.value = '' }}/>
          <input ref={thumbRef} type="file" hidden accept="image/*" onChange={e => { const f = e.target.files?.[0]; if (f) setThumbFile(f); e.target.value = '' }}/>
          {videoShown ? (
            <div>
              <video src={videoShown} poster={(thumbPreview || (videoRemoved ? null : existingThumb)) || undefined} controls playsInline
                style={{ width:'100%', maxHeight:240, borderRadius:14, background:'#000' }}/>
              <div className="flex gap-8" style={{ marginTop:8, flexWrap:'wrap' }}>
                <button className="btn btn-secondary btn-sm" onClick={() => videoRef.current?.click()}><Icon name="upload" className="xs"/>Replace video</button>
                <button className="btn btn-secondary btn-sm" onClick={() => thumbRef.current?.click()}><Icon name="image" className="xs"/>{thumbFile ? 'Thumbnail set' : 'Set thumbnail'}</button>
                <button className="btn btn-secondary btn-sm" style={{ color:'var(--rose)' }} onClick={removeVideo}><Icon name="close" className="xs"/>Remove</button>
              </div>
            </div>
          ) : (
            <div className="cm-drop" onClick={() => videoRef.current?.click()} style={{ cursor:'pointer' }}>
              <Icon name="video" className="lg"/><b>Add a promo video</b><span className="text-xs">MP4 / WebM / MOV</span>
            </div>
          )}

          {/* ---- contributors (§11) ---- */}
          <SectionHead icon="users" title="Contributors" hint="co-authors, advisors, translators…"/>
          <ContributorsField value={contribs} onChange={setContribs} meId={me.id}/>

          {/* ---- sources (§10) ---- */}
          <SectionHead icon="cite" title="Sources & references"/>
          {sources.map((s, i) => (
            <div key={i} className="flex gap-8" style={{ marginTop:8, alignItems:'center' }}>
              <span className="src-tag">{SOURCE_LABEL[s.req.sourceType] || s.req.sourceType}</span>
              <span style={{ flex:1, fontSize:13 }}>{s.req.title}{s.file ? ` · ${s.file.name}` : ''}</span>
              <button className="icon-btn" title="Remove" onClick={() => removeSource(i)}><Icon name="close" className="sm"/></button>
            </div>
          ))}
          <div style={{ marginTop:10 }}>
            <AddSourceForm onAdd={(req, file) => setSources(s => [...s, { req, file }])}/>
          </div>

          {/* ---- files / figures (§9) ---- */}
          <SectionHead icon="doc" title="Files & figures" hint="paper PDF, datasets, figures"/>
          {/* existing media (edit) with remove */}
          {existingMedia.map(m => (
            <div key={m.id} className="src-row" style={{ marginBottom:8 }}>
              <span className="src-ic" style={{ background:'#15302a' }}><Icon name={m.type === 'IMAGE' ? 'image' : m.type === 'VIDEO' ? 'video' : m.type === 'AUDIO' ? 'mic' : 'doc'} className="sm"/></span>
              <div className="src-info"><b>{m.name}</b><small className="muted">{m.caption || (m.type || '').toLowerCase()}</small></div>
              <button className="icon-btn" title="Remove file" onClick={() => dropExisting(m.id)}><Icon name="close" className="sm"/></button>
            </div>
          ))}
          <input ref={mediaRef} type="file" hidden multiple accept=".pdf,.doc,.docx,image/*,video/*,audio/*" onChange={onPickMedia}/>
          <div className="cm-drop" onClick={() => mediaRef.current?.click()} style={{ cursor:'pointer' }}>
            <Icon name="upload" className="lg"/><b>{isEdit ? 'Add more files' : 'Click to add files'}</b>
            <span className="text-xs">PDF / DOCX / images / audio / video</span>
          </div>
          {media.map((m, i) => (
            <div key={i} className="card-tight card" style={{ marginTop:8 }}>
              <div className="flex-c gap-8" style={{ justifyContent:'space-between' }}>
                <span className="flex-c gap-6 text-sm" style={{ minWidth:0 }}><Icon name="doc" className="sm"/><span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{m.file.name}</span></span>
                <button className="icon-btn" onClick={() => removeMedia(i)}><Icon name="close" className="xs"/></button>
              </div>
              <div className="set-grid" style={{ marginTop:8 }}>
                <input className="field" style={{ height:38 }} placeholder="Caption" value={m.caption} onChange={e => patchMedia(i, 'caption', e.target.value)}/>
                <input className="field" style={{ height:38 }} placeholder="Alt text (accessibility)" value={m.altText} onChange={e => patchMedia(i, 'altText', e.target.value)}/>
              </div>
            </div>
          ))}

          {/* ---- settings ---- */}
          <SectionHead icon="settings" title="Publishing"/>
          <Toggle title="Allow comments" on={commentsEnabled} onChange={setComments}/>
          <Toggle title="Allow downloads" on={downloadsEnabled} onChange={setDownloads}/>
          <div className="set-toggle">
            <div><b>Schedule publication</b><small className="muted">Leave empty to keep it a draft (or publish now below).</small></div>
            <input className="field" type="datetime-local" style={{ maxWidth:230, marginLeft:'auto' }} value={scheduledAt} onChange={e => setScheduledAt(e.target.value)}/>
          </div>
          {!!scheduledAt && (
            <div className="flex-c gap-6 text-xs" style={{ color:'var(--emerald)', marginTop:6 }}>
              <Icon name="check" className="xs"/>Auto-publishes at the scheduled time — no need to publish manually.
            </div>
          )}
          {scheduledAt && <button className="text-xs muted" style={{ marginTop:4 }} onClick={() => setScheduledAt('')}>Clear schedule</button>}
          {!isEdit && <Toggle title="Publish immediately" desc="Otherwise it's saved as a draft you can publish later." on={publishNow} onChange={setPublishNow} disabled={!!scheduledAt}/>}
          </>)}
        </div>

        <div className="mfoot">
          <span className="muted text-xs">{isEdit ? 'Editing as' : 'Publishing as'} <b style={{ color:'var(--ink-2)' }}>{me.full}</b></span>
          <button className="btn btn-primary" style={{ marginLeft:'auto' }} disabled={busy || !title.trim()} onClick={submit}>
            {ctaLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
