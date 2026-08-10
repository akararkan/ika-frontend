/* =========================================================
   Research composer — full RESEARCH_API coverage.
   MIDAD studio layout: a full-page, 3-column manuscript desk —
   left "Contents" rail (scroll-spy + completion ticks), a center
   canvas that reads like the published masthead (cover hero ·
   title · abstract · manuscript · contributors · sources · files),
   and a right "Publication" rail (visibility · schedule ·
   permissions · citation · keywords · tags).

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

   MODERATION (src/lib/moderation.js). CREATE is never scored — a
   draft is private, so the classifier only runs where the text
   would become public:
     · PUBLISH  → 400 CONTENT_REJECTED (refused, paper stays a
                  draft), 400 CONTENT_UNDER_REVIEW (a verdict on
                  this exact text is still in flight — the ONE
                  place in this modal where retrying is honest),
                  or a 200 whose paper is STILL `status:"DRAFT"`,
                  which is a HOLD, not a failure.
     · EDIT of a live paper → refused (transaction rolled back,
                  nothing changed) or held, in which case the
                  paper drops back to DRAFT with its publishedAt
                  intact and vanishes from readers until it clears.
     · media captions / alt text / contributor notes → instant
                  accept-or-refuse; these rows have no hidden
                  state, so there is no held case to render.
   All of it lands in the existing critical/step machinery below —
   a refusal is just a step whose error is a moderation error, and
   it is shown with the SERVER'S OWN WORDS and no Retry, because
   resubmitting identical text can only be refused identically.

   Scholar / Researcher / Admin only.
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, Avatar, Verify, showToast, ChipInput } from './ui.jsx'
import { AddSourceForm, SOURCE_LABEL } from './SourceForm.jsx'
import { RichTextEditor } from './RichTextEditor.jsx'
import { TagInput } from './TagInput.jsx'
import { ModerationAlert, ModerationNotice } from './Moderation.jsx'
import { renderMarkdown, renderPlain } from '../lib/richtext.js'
import { isModerationError, isUnderReview, heldPublish } from '../lib/moderation.js'
import { useAuth, hasRole } from '../context/AuthContext.jsx'
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

const VIS = [                                                                                  // ResearchVisibility
  ['PUBLIC', 'Public', 'globe'],
  ['FOLLOWERS_ONLY', 'Followers', 'users'],
  ['PRIVATE', 'Private', 'lock'],
]
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

/* Right-rail toggle switch (comments / downloads). */
function RailSwitch({ on, onChange }) {
  return (
    <button type="button" className={'rm-switch' + (on ? ' on' : '')} onClick={() => onChange(!on)} aria-pressed={on}>
      <span className="rm-switch-knob"/>
    </button>
  )
}

/* Left-rail "Contents" sections + scroll-spy targets. */
const RM_SECTIONS = [
  { id:'cover',        no:'01', label:'Cover & title',   hint:'Masthead' },
  { id:'abstract',     no:'02', label:'Abstract',        hint:'The summary' },
  { id:'body',         no:'03', label:'Manuscript',      hint:'Full body' },
  { id:'contributors', no:'04', label:'Contributors',    hint:'Co-authors' },
  { id:'sources',      no:'05', label:'Sources',         hint:'Bibliography' },
  { id:'files',        no:'06', label:'Files & figures', hint:'Attachments' },
]

/* One content section. Module-level (stable identity) so the rich-text editors
   inside never remount on re-render. `innerRef` registers the node so the rail
   can scroll-spy / jump to it. */
function RmSection({ id, no, title, hint, tag, innerRef, children }) {
  return (
    <section className="rm-sec" data-sec={id} ref={innerRef}>
      <header className="rm-sechd">
        <span className="rm-secno font-mono">{no}</span>
        <h2 className="rm-sectt">{title}</h2>
        <span className="rm-secrule"/>
        {tag ? <span className="rm-sectag">{tag}</span> : hint ? <span className="rm-sechint">{hint}</span> : null}
      </header>
      <div className="rm-secbody">{children}</div>
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
      api.users.searchList(term, { eligibleContributor: true, size: 8 })   // RESEARCHER / SCHOLAR only
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
    <div className="rm-contribs">
      {value.map((c, i) => (
        <div key={c.userId} className="rm-contrib">
          <div className="rm-contrib-id">
            <span className="rm-contrib-no font-mono">{String(i + 1).padStart(2, '0')}</span>
            <Avatar initials={c.initials} color={c.avc} size={42} src={c.profileImage}/>
          </div>
          <div className="rm-contrib-main">
            <div className="rm-contrib-name"><b>{c.full}</b> {c.verified && <Verify scholar/>}<span className="rm-contrib-handle">@{c.handle}</span></div>
            <input className="inp rm-contrib-note" placeholder="Contribution note (e.g. Wrote the methodology section)"
              value={c.note} onChange={e => patch(i, 'note', e.target.value)}/>
          </div>
          <div className="rm-contrib-side">
            <div className="rm-sel">
              <select value={c.role} onChange={e => patch(i, 'role', e.target.value)}>
                {CONTRIB_ROLES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              <span className="rm-sel-cv"><Icon name="chevdown" className="xs"/></span>
            </div>
            <div className="rm-contrib-moves">
              <button className="icon-btn" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}><Icon name="chevup" className="xs"/></button>
              <button className="icon-btn" title="Move down" disabled={i === value.length - 1} onClick={() => move(i, 1)}><Icon name="chevdown" className="xs"/></button>
              <button className="icon-btn" title="Remove" onClick={() => remove(i)}><Icon name="close" className="sm"/></button>
            </div>
          </div>
        </div>
      ))}

      <div className="rm-search">
        <Icon name="search" className="sm"/>
        <input placeholder="Search scholars & researchers to add…" value={q} onChange={e => setQ(e.target.value)}/>
        {loading && <span className="muted text-xs">…</span>}
      </div>
      {!!visible.length && (
        <div className="rm-cands">
          {visible.map(u => (
            <button key={u.id} className="rm-cand" onClick={() => add(u)}>
              <Avatar initials={u.initials} color={u.avc} size={36} src={u.profileImage}/>
              <div className="rm-cand-tx">
                <div className="rm-cand-name"><b>{u.full}</b> {u.verified && <Verify scholar/>}</div>
                <div className="rm-cand-sub font-mono">@{u.handle} · {(u.role || 'member').toLowerCase()}</div>
              </div>
              <span className="rm-cand-add"><Icon name="follow" className="sm"/>Add</span>
            </button>
          ))}
        </div>
      )}
      {q.trim().length >= 2 && !loading && !visible.length && (
        <p className="rm-empty-hint">No eligible co-authors found. Only verified researchers & scholars can be added.</p>
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
  // Right-rail "when to publish": draft | now | schedule. Derived state that
  // drives the underlying publishNow / scheduledAt fields submit() already reads.
  const [scheduleMode, setScheduleMode] = React.useState(() => toLocalInput(editResearch?.scheduledPublishAt) ? 'schedule' : 'draft')
  const setMode = (m) => {
    setScheduleMode(m)
    if (m === 'draft') { setPublishNow(false); setScheduledAt('') }
    else if (m === 'now') { setPublishNow(true); setScheduledAt('') }
    else { setPublishNow(false) }   // schedule keeps whatever is in scheduledAt
  }

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
  const canCover = hasRole(user, 'SCHOLAR', 'RESEARCHER', 'ADMIN', 'SUPER_ADMIN')
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
  // A hold is a SUCCESS with a wait attached, so it gets its own overlay instead
  // of the error one: { kind: 'publish' | 'edit', result }. Held publishes are
  // detected inside the parallel loop, hence the ref — the tally below reads it
  // in the same tick, long before a setState would have landed.
  const [hold, setHold] = React.useState(null)
  const publishHeldRef = React.useRef(false)

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

  /* The success tail, shared by an ordinary save and by the hold overlay's Done —
     a hold has to hand the same result to the parent, it just says its piece
     first. `held` rides along in the router state so the detail page we land on
     can explain the draft the author is about to see instead of leaving them to
     wonder why "Publish now" produced a draft. */
  const finishSave = (result, held = false) => {
    showToast(held
      ? (isEdit ? 'Saved — your changes are being checked' : 'Saved — your paper is being checked')
      : isEdit ? 'Research updated' : (scheduledAt ? 'Scheduled for publication' : publishNow ? 'Research published' : 'Draft saved'))
    if (isEdit) onEdited?.(result); else onCreated?.(result)
    onClose()
    if (!isEdit && result?.id) navigate(`/research/${result.id}`, held ? { state: { moderationHeld: true } } : undefined)
  }

  /* ===========================================================================
     submit — orchestrated update / create.
       1. Run the critical metadata op (PATCH for edit, multipart POST for create).
          If it fails, the page stays open and a banner offers Retry — the
          user never loses their form state.
       2. After it succeeds, run ALL the rest (contributors, media diff, cover,
          video, publish) IN PARALLEL with per-step progress tracking.
       3. Each op has an onSuccess hook that clears the matching local state
          (e.g. drops the uploaded file from `media`) so Retry never re-uploads
          something that already succeeded.
       4. If every op succeeds → close + notify parent.
          If some fail → keep open, show what failed, "Retry failed"
          re-runs only those, "Close anyway" accepts the partial save.
       5. Moderation rides on the same rails, with two twists: a refusal is a
          failed step whose error is a moderation error, and it loses the Retry
          button (identical text ⇒ identical refusal); a HOLD is not a failure at
          all — it opens the held overlay and then completes the save normally.
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
          // §6.3 answers a HOLD with a plain 200 whose paper is still a DRAFT —
          // the one surface on the platform whose hold is inferable without a
          // marker (heldPublish). That is not a failed step: the paper is saved
          // and goes public by itself the moment the check clears.
          onSuccess: (res) => { if (heldPublish(res)) publishHeldRef.current = true },
        })
        return ops
      }
    }

    /* ---- Execute ---- */
    busyRef.current = true; setBusy(true); setSaveError(null); setHold(null)   // claim the lock before the first await so a 2nd click can't get in
    publishHeldRef.current = false
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
      /* A moderation refusal is not "we couldn't save it" — the request was
         perfectly well formed and the server persisted nothing on purpose. It
         gets the server's own sentence and the appeal link (rendered by
         <ModerationAlert/> in the overlay) rather than our generic copy, and the
         form below stays exactly as the author left it. */
      setSaveError(isModerationError(e)
        ? { critical: true, error: e }
        : { critical: true, message: e?.message || 'Could not save your changes' })
      setBusy(false); busyRef.current = false
      return
    }

    /* A held EDIT of a live paper answers 200 with the paper knocked back to
       DRAFT (publishedAt preserved). Anchoring on the status we opened WITH is
       what keeps this honest: an ordinary draft edit also returns DRAFT, and
       badging that as "checking" would invent a hold the wire never reported.
       Only PUBLISHED → DRAFT across a PATCH means the checker took it. */
    const editHeld = isEdit
      && String(editResearch?.status || '').toUpperCase() === 'PUBLISHED'
      && heldPublish(criticalResult)

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
      const refused = failures.filter(s => isModerationError(s.error)).length
      setSaveError({
        critical: false, updated: criticalResult,
        /* Count refusals separately from breakages: "2 steps couldn't finish"
           reads like a flaky upload, and a refusal is not an outage. */
        message: refused === failures.length
          ? `${refused === 1 ? 'One part' : `${refused} parts`} of this paper ${refused === 1 ? 'was' : 'were'} refused.`
          : `${failures.length} step${failures.length > 1 ? 's' : ''} couldn’t finish.`,
      })
      return
    }

    // Everything landed — but "landed" can still mean "waiting on a verdict".
    if (publishHeldRef.current || editHeld) { setHold({ kind: editHeld ? 'edit' : 'publish', result: criticalResult }); return }
    finishSave(criticalResult)
  }

  /* Accept whatever did save and leave the rest behind — close with the partial update applied. */
  const acceptPartial = () => {
    const updated = saveError?.updated
    setSaveError(null); setSteps({})
    if (isEdit) updated && onEdited?.(updated)
    else if (updated) { onCreated?.(updated); if (updated.id) navigate(`/research/${updated.id}`) }
    onClose()
  }

  const ctaLabel = busy ? 'Saving…' : isEdit ? 'Save changes' : scheduleMode === 'schedule' ? 'Schedule' : scheduleMode === 'now' ? 'Publish' : 'Create draft'

  /* ---- the moderation view of whatever just failed ----
     Read off the STEPS, not off `saveError`: a partial save can succeed at
     everything and still have one caption refused, and the dialog must lead with
     the refusal either way. Only the first one is rendered — every refusal on the
     platform carries the same sentence, so a stack of them would say one thing
     four times. */
  const failedSteps = Object.entries(steps).filter(([, s]) => s.status === 'failed')
  const modErr = failedSteps.map(([, s]) => s.error).find(isModerationError) || null
  const modPending = isUnderReview(modErr)          // "not yet" — the only refusal worth retrying
  const dialogTitle = modErr
    ? (modPending ? 'Still being checked' : saveError?.critical ? 'Your changes were refused' : 'Part of this was refused')
    : saveError?.critical ? 'Couldn’t save your changes' : 'Saved with issues'

  /* ---- left-rail scroll-spy + completion ---- */
  const scrollRef = React.useRef(null)
  const secRefs = React.useRef({})
  const [activeSec, setActiveSec] = React.useState('cover')
  const onScroll = () => {
    const c = scrollRef.current; if (!c) return
    const top = c.scrollTop + 150
    let cur = RM_SECTIONS[0].id
    for (const s of RM_SECTIONS) { const el = secRefs.current[s.id]; if (el && el.offsetTop <= top) cur = s.id }
    setActiveSec(cur)
  }
  const goto = (id) => { const el = secRefs.current[id], c = scrollRef.current; if (el && c) c.scrollTo({ top: Math.max(0, el.offsetTop - 28), behavior:'smooth' }) }
  const activeIndex = Math.max(0, RM_SECTIONS.findIndex(s => s.id === activeSec))
  const meInitials = me.initials || (me.full || 'Y').slice(0, 2).toUpperCase()
  const today = React.useMemo(() => new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }), [])

  const done = {
    cover:        !!title.trim() || !!coverShown,
    abstract:     !!abstractText && abstractText.replace(/<[^>]*>/g, '').trim().length > 0,
    body:         !!description && description.replace(/<[^>]*>/g, '').trim().length > 0,
    contributors: contribs.length > 0,
    sources:      sources.length > 0,
    files:        media.length > 0 || existingMedia.length > 0,
  }

  const fileCount = media.length + existingMedia.length
  const statusText = [
    `${sources.length} source${sources.length === 1 ? '' : 's'}`,
    `${contribs.length} contributor${contribs.length === 1 ? '' : 's'}`,
    `${fileCount} file${fileCount === 1 ? '' : 's'}`,
  ].join('  ·  ')

  const visIndex = Math.max(0, VIS.findIndex(v => v[0] === visibility))
  const scheduleOpts = isEdit
    ? [
        { k: 'draft', label: 'Save changes', hint: 'Keep its current state' },
        { k: 'schedule', label: 'Schedule a publish time', hint: 'Auto-publish later' },
      ]
    : [
        { k: 'draft', label: 'Save as draft', hint: 'Keep refining privately' },
        { k: 'now', label: 'Publish now', hint: 'Make it public immediately' },
        { k: 'schedule', label: 'Schedule', hint: 'Auto-publish at a set time' },
      ]

  return (
    <div className="overlay open rm-overlay" role="dialog" aria-label={isEdit ? 'Edit research' : 'Publish research'}>
      <div className="rm-app">

        {/* ============ TOP BAR ============ */}
        <header className="rm-top">
          <div className="rm-top-l">
            <button className="rm-back" onClick={onClose} disabled={busy} aria-label="Back"><Icon name="chevleft" className="sm"/></button>
            <div className="rm-top-text">
              <span className="rm-top-kick font-mono">{isEdit ? 'Edit manuscript' : 'New manuscript'}</span>
              <span className="rm-top-title">{title.trim() || 'Untitled manuscript'}</span>
            </div>
            <span className="rm-top-badge font-mono">{isEdit ? 'Editing' : 'Draft'}</span>
          </div>

          <div className="rm-top-c">
            <span className="rm-top-status"><span className="rm-top-dot"/>{statusText}</span>
          </div>

          <div className="rm-top-r">
            <button type="button" className="rm-cancel" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="button" className="rm-cta" disabled={busy || !title.trim()} onClick={submit}>
              <Icon name="feather" className="sm"/>{ctaLabel}
            </button>
          </div>
        </header>

        {/* ============ BODY: rail · canvas · publication ============ */}
        <div className="rm-grid">

          {/* ---- LEFT RAIL: contents ---- */}
          <nav className="rm-rail" aria-label="Contents">
            <div className="rm-rail-cap">Contents <b lang="ar" dir="rtl">الفهرس</b></div>
            <div className="rm-rail-list">
              <div className="rm-rail-marker" style={{ transform: `translateY(${activeIndex * 56}px)` }}/>
              <div className="rm-rail-bar" style={{ transform: `translateY(${activeIndex * 56}px)` }}/>
              {RM_SECTIONS.map((s) => (
                <button key={s.id} type="button" className={'rm-rail-item' + (activeSec === s.id ? ' on' : '')} onClick={() => goto(s.id)}>
                  <span className="rm-rail-no font-mono">{s.no}</span>
                  <span className="rm-rail-tx"><span className="rm-rail-l">{s.label}</span><span className="rm-rail-h">{s.hint}</span></span>
                  {done[s.id] && <span className="rm-rail-ck"><Icon name="check" className="xs"/></span>}
                </button>
              ))}
            </div>
            <div className="rm-rail-foot">
              <Avatar initials={meInitials} color={me.avc} size={36} src={me.profileImage}/>
              <div className="rm-rail-foot-tx"><span className="rm-rf-name">{me.full}</span><span className="rm-rf-role">Corresponding author</span></div>
            </div>
          </nav>

          {/* ---- CENTER: the manuscript canvas ---- */}
          <div className="rm-canvas" ref={scrollRef} onScroll={onScroll}>
            <div className="rm-page t-stagger">

              {/* hidden file inputs */}
              <input ref={coverRef} type="file" hidden accept="image/*" onChange={e => { const f = e.target.files?.[0]; if (f) { setCoverFile(f); setCoverRemoved(false) } e.target.value = '' }}/>
              <input ref={videoRef} type="file" hidden accept="video/mp4,video/webm,video/quicktime" onChange={e => { const f = e.target.files?.[0]; if (f) { setVideoFile(f); setVideoRemoved(false) } e.target.value = '' }}/>
              <input ref={thumbRef} type="file" hidden accept="image/*" onChange={e => { const f = e.target.files?.[0]; if (f) setThumbFile(f); e.target.value = '' }}/>
              <input ref={mediaRef} type="file" hidden multiple accept=".pdf,.doc,.docx,image/*,video/*,audio/*" onChange={onPickMedia}/>

              {/* 01 · Cover & title */}
              <section ref={el => (secRefs.current.cover = el)}>
                {coverShown ? (
                  <div className="rm-cover-on" style={{ backgroundImage: `url("${coverShown}")` }}>
                    <span className="rm-cover-scrim" aria-hidden="true"/>
                    <div className="rm-cover-acts">
                      <button type="button" className="rm-cv-btn" onClick={() => coverRef.current?.click()}><Icon name="image" className="xs"/>Replace</button>
                      <button type="button" className="rm-cv-btn danger" onClick={removeCover} aria-label="Remove cover"><Icon name="close" className="sm"/></button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="rm-cover-empty" onClick={() => coverRef.current?.click()}>
                    <span className="rm-cv-ic"><Icon name="image"/></span>
                    <span className="rm-cv-t">Add a cover image</span>
                    <span className="rm-cv-h font-mono">landscape · framed on the research card</span>
                  </button>
                )}
                {coverFile && !canCover && <small className="rm-warn"><Icon name="lock" className="xs"/> Cover image needs a Scholar / Researcher role.</small>}

                {/* masthead */}
                <div className="rm-mast">
                  <span className="rm-mast-kick font-mono">Research manuscript</span>
                  <input className="rm-mast-title" dir="auto" placeholder="Untitled manuscript"
                    value={title} onChange={e => setTitle(e.target.value)}/>
                  <div className="rm-mast-by">
                    <Avatar initials={meInitials} color={me.avc} size={30} src={me.profileImage}/>
                    <span>by <b>{me.full}</b></span>
                    <span className="rm-mast-dot"/>
                    <span className="rm-mast-date font-mono">{today}</span>
                  </div>
                </div>

                {/* promo video tile */}
                <div className="rm-promo">
                  {videoShown ? (
                    <video className="rm-promo-vid" src={videoShown} poster={(thumbPreview || (videoRemoved ? null : existingThumb)) || undefined} controls playsInline/>
                  ) : (
                    <button type="button" className="rm-promo-thumb" onClick={() => videoRef.current?.click()}><Icon name="play"/></button>
                  )}
                  <div className="rm-promo-tx">
                    <div className="rm-promo-t">Promo video <span className="muted">· optional</span></div>
                    <div className="rm-promo-h">A short clip shown on the reader page. MP4 / WebM / MOV.</div>
                    <div className="rm-promo-acts">
                      <button type="button" className="rm-promo-btn" onClick={() => videoRef.current?.click()}>{videoShown ? 'Replace' : 'Upload video'}</button>
                      {videoShown && <button type="button" className="rm-promo-btn" onClick={() => thumbRef.current?.click()}>{thumbFile ? 'Thumb set' : 'Thumbnail'}</button>}
                      {videoShown && <button type="button" className="rm-promo-btn danger" onClick={removeVideo}>Remove</button>}
                    </div>
                  </div>
                </div>
              </section>

              <div className="rm-divider"/>

              {/* 02 · Abstract */}
              <RmSection id="abstract" no="02" title="Abstract" hint="select text to format" innerRef={el => (secRefs.current.abstract = el)}>
                <div className="rm-abstract">
                  <RichTextEditor value={abstractText} format="HTML" onChange={setAbstract} minHeight={200} showFormat={false}
                    placeholder="A concise summary of the work — what you asked, how you studied it, and what you found."/>
                </div>
              </RmSection>

              <div className="rm-divider"/>

              {/* 03 · Manuscript */}
              <RmSection id="body" no="03" title="Manuscript" hint="the full write-up" innerRef={el => (secRefs.current.body = el)}>
                <RichTextEditor value={description} format="HTML" onChange={setDescription} minHeight={320} showFormat={false}
                  placeholder="Write your research — headings, lists, tables, images, colours, highlights…"/>
              </RmSection>

              <div className="rm-divider"/>

              {/* 04 · Contributors */}
              <RmSection id="contributors" no="04" title="Contributors" hint="co-authors · advisors · translators" innerRef={el => (secRefs.current.contributors = el)}>
                <ContributorsField value={contribs} onChange={setContribs} meId={me.id}/>
              </RmSection>

              <div className="rm-divider"/>

              {/* 05 · Sources */}
              <RmSection id="sources" no="05" title="Sources & references" hint={`${sources.length} reference${sources.length === 1 ? '' : 's'}`} innerRef={el => (secRefs.current.sources = el)}>
                {!!sources.length && (
                  <ol className="rm-src-list">
                    {sources.map((s, i) => (
                      <li key={i} className="rm-src-item">
                        <span className="rm-src-no font-mono">{String(i + 1).padStart(2, '0')}</span>
                        <div className="rm-src-body">
                          <span className="rm-src-badge font-mono">{SOURCE_LABEL[s.req.sourceType] || s.req.sourceType}</span>
                          <div className="rm-src-title">{s.req.title}</div>
                          {(s.req.citationText || s.req.url || s.file) && (
                            <div className="rm-src-meta font-mono">{s.file ? s.file.name : (s.req.citationText || s.req.url)}</div>
                          )}
                        </div>
                        <button className="icon-btn" title="Remove" onClick={() => removeSource(i)}><Icon name="close" className="sm"/></button>
                      </li>
                    ))}
                  </ol>
                )}
                <div className="rm-src-add">
                  <AddSourceForm onAdd={(req, file) => setSources(s => [...s, { req, file }])}/>
                </div>
              </RmSection>

              <div className="rm-divider"/>

              {/* 06 · Files & figures */}
              <RmSection id="files" no="06" title="Files & figures" hint="paper PDF · datasets · figures" innerRef={el => (secRefs.current.files = el)}>
                <div className="rm-files-grid">
                  {existingMedia.map(m => (
                    <div key={m.id} className="rm-file">
                      <div className="rm-file-hd">
                        <span className="rm-file-ic font-mono">{(m.type || 'file').slice(0, 4).toUpperCase()}</span>
                        <div className="rm-file-tx">
                          <div className="rm-file-nm">{m.name}</div>
                          <div className="rm-file-meta font-mono">{m.caption || 'saved file'}</div>
                        </div>
                        <button className="icon-btn" title="Remove file" onClick={() => dropExisting(m.id)}><Icon name="close" className="xs"/></button>
                      </div>
                    </div>
                  ))}
                  {media.map((m, i) => (
                    <div key={m._id} className="rm-file">
                      <div className="rm-file-hd">
                        <span className="rm-file-ic font-mono">{(m.file.name.split('.').pop() || 'file').slice(0, 4).toUpperCase()}</span>
                        <div className="rm-file-tx">
                          <div className="rm-file-nm">{m.file.name}</div>
                          <div className="rm-file-meta font-mono">{(m.file.size / 1024 / 1024).toFixed(1)} MB</div>
                        </div>
                        <button className="icon-btn" title="Remove" onClick={() => removeMedia(i)}><Icon name="close" className="xs"/></button>
                      </div>
                      <input className="inp rm-file-cap" placeholder="Caption" value={m.caption} onChange={e => patchMedia(i, 'caption', e.target.value)}/>
                      <input className="inp rm-file-cap" placeholder="Alt text (accessibility)" value={m.altText} onChange={e => patchMedia(i, 'altText', e.target.value)}/>
                    </div>
                  ))}
                  <button type="button" className="rm-file-add" onClick={() => mediaRef.current?.click()}>
                    <span className="rm-file-add-ic"><Icon name="upload"/></span>
                    <span className="rm-file-add-t">Add files</span>
                    <span className="rm-file-add-h font-mono">PDF · DOCX · images · data</span>
                  </button>
                </div>
              </RmSection>

              <div className="rm-end"/>
            </div>
          </div>

          {/* ---- RIGHT RAIL: publication ---- */}
          <aside className="rm-pub" aria-label="Publication">
            <span className="rm-pub-cap">Publication</span>

            {/* visibility */}
            <div className="rm-pub-block">
              <label className="rm-pub-label">Who can see it</label>
              <div className="rm-seg">
                <div className="rm-seg-marker" style={{ transform: `translateX(${visIndex * 100}%)` }}/>
                {VIS.map(([k, l, ic]) => (
                  <button key={k} type="button" className={'rm-seg-btn' + (visibility === k ? ' on' : '')} onClick={() => setVisibility(k)}>
                    <Icon name={ic} className="sm"/><span>{l}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* schedule */}
            <div className="rm-pub-block">
              <label className="rm-pub-label">When to publish</label>
              <div className="rm-sched">
                {scheduleOpts.map(o => (
                  <button key={o.k} type="button" className={'rm-sched-opt' + (scheduleMode === o.k ? ' on' : '')} onClick={() => setMode(o.k)}>
                    <span className="rm-sched-ring">{scheduleMode === o.k && <span className="rm-sched-dot"/>}</span>
                    <span className="rm-sched-tx"><span className="rm-sched-l">{o.label}</span><span className="rm-sched-h">{o.hint}</span></span>
                  </button>
                ))}
                {scheduleMode === 'schedule' && (
                  <input className="inp rm-sched-date" type="datetime-local" value={scheduledAt} onChange={e => { setScheduledAt(e.target.value); setScheduleMode('schedule') }}/>
                )}
              </div>
            </div>

            <div className="rm-pub-rule"/>

            {/* permissions */}
            <label className="rm-pub-label">Reader permissions</label>
            <div className="rm-perm-row">
              <div className="rm-perm-tx"><span className="rm-perm-l">Allow comments</span><span className="rm-perm-h">Readers can discuss the work</span></div>
              <RailSwitch on={commentsEnabled} onChange={setComments}/>
            </div>
            <div className="rm-perm-row">
              <div className="rm-perm-tx"><span className="rm-perm-l">Allow downloads</span><span className="rm-perm-h">Let readers save attached files</span></div>
              <RailSwitch on={downloadsEnabled} onChange={setDownloads}/>
            </div>

            <div className="rm-pub-rule"/>

            {/* citation */}
            <label className="rm-pub-label">Suggested citation</label>
            <input className="inp rm-pub-input rm-cite" placeholder="Al-Qaradawi, Y. (2026). Title. Journal." value={citation} onChange={e => setCitation(e.target.value)}/>

            {/* keywords */}
            <label className="rm-pub-label" style={{ marginTop: 18 }}>Keywords</label>
            <ChipInput value={keywords ? keywords.split(/[,،؛\n]+/).map(s => s.trim()).filter(Boolean) : []}
              onChange={arr => setKeywords(arr.join(', '))}
              placeholder="Add a keyword — comma or Enter"/>

            {/* tags */}
            <label className="rm-pub-label" style={{ marginTop: 18 }}>Tags <span className="rm-pub-label-h">· {tags.length}/30 · surface in trending</span></label>
            <TagInput value={tags} onChange={setTags} scope="RESEARCH" placeholder="Add a tag — comma or Enter"/>
          </aside>
        </div>

        {/* ============ SAVING OVERLAY ============ */}
        {busy && (
          <div className="rm-scrim">
            <div className="rm-dialog">
              <div className="rm-dialog-hd">
                <span className="rm-spin"/>
                <h3>{isEdit ? 'Saving your changes…' : 'Publishing your research…'}</h3>
              </div>
              <ul className="rm-steps">
                {Object.entries(steps).map(([id, s]) => (
                  <li key={id} className={'rm-step ' + s.status}>
                    <span className="rm-step-ic">
                      {s.status === 'done'    && <Icon name="check" className="xs"/>}
                      {s.status === 'running' && <span className="rm-spin sm"/>}
                      {s.status === 'failed'  && <Icon name="close" className="xs"/>}
                    </span>
                    <span className="rm-step-nm">{s.name}</span>
                    {s.error?.message && <span className="rm-step-err">{s.error.message}</span>}
                  </li>
                ))}
              </ul>
              <p className="rm-dialog-note">Uploads run in parallel — you can leave this open.</p>
            </div>
          </div>
        )}

        {/* ============ ERROR OVERLAY ============ */}
        {!busy && saveError && (
          <div className="rm-scrim">
            <div className={'rm-dialog' + (saveError.critical ? ' critical' : ' partial')}>
              <div className="rm-dialog-hd">
                <span className="rm-dialog-flag"><Icon name={modErr ? (modPending ? 'hourglass' : 'shield') : 'flag'}/></span>
                <h3>{dialogTitle}</h3>
              </div>
              {/* The server's own sentence, verbatim, with the appeal link beside
                  it — never our paraphrase, never a hint at what tripped. */}
              {modErr
                ? <ModerationAlert error={modErr} onRetry={modPending ? submit : undefined}/>
                : <p className="rm-dialog-msg">{saveError.message}</p>}
              {!saveError.critical && (
                <p className="rm-dialog-note">
                  {modErr
                    ? 'Everything else is saved and nothing you typed was lost. Edit the wording and save again — the step that was refused is listed below.'
                    : 'Your details are saved. Only the failing pieces need another try — your form values are kept intact.'}
                </p>
              )}
              <ul className="rm-steps">
                {failedSteps.map(([id, s]) => (
                  <li key={id} className="rm-step failed">
                    <span className="rm-step-ic"><Icon name={isModerationError(s.error) ? 'shield' : 'close'} className="xs"/></span>
                    <span className="rm-step-nm">{s.name}</span>
                    {/* A refusal's copy is already rendered once, in full, above.
                        Repeating it here in 11px would truncate the only thing
                        the author is allowed to be told. */}
                    {s.error?.message && !isModerationError(s.error) && <span className="rm-step-err">{s.error.message}</span>}
                  </li>
                ))}
              </ul>
              <div className="rm-dialog-acts">
                {/* No Retry on a refusal: the identical text can only be refused
                    identically, so the way forward is Dismiss → edit → save. A
                    CONTENT_UNDER_REVIEW is the exception, and its retry lives
                    inside <ModerationAlert/> above so there is only ever one. */}
                {!modErr && <button type="button" className="rm-cta" onClick={submit}><Icon name="upload" className="xs"/>Retry{saveError.critical ? '' : ' failed steps'}</button>}
                {!saveError.critical && <button type="button" className="rm-cancel" onClick={acceptPartial}>Close anyway</button>}
                <button type="button" className="rm-dialog-dismiss" onClick={() => setSaveError(null)}>{modErr ? 'Back to editing' : 'Dismiss'}</button>
              </div>
            </div>
          </div>
        )}

        {/* ============ HELD OVERLAY ============ */}
        {/* Not an error: the save landed, the verdict did not. Publish held → the
            paper is still a draft and publishes itself when it clears; edit held →
            a live paper has just left the readers' view, which is the single most
            alarming thing this module can do silently. */}
        {!busy && !saveError && hold && (
          <div className="rm-scrim">
            <div className="rm-dialog">
              <div className="rm-dialog-hd">
                <span className="rm-dialog-flag"><Icon name="hourglass"/></span>
                <h3>{hold.kind === 'edit' ? 'Saved — your changes are being checked' : 'Saved — your paper is being checked'}</h3>
              </div>
              <ModerationNotice state="checking" kind="research paper"/>
              <p className="rm-dialog-note">
                {hold.kind === 'edit'
                  ? 'Until it clears, the paper is back to Draft and readers can’t see it. It returns to Published — keeping its original publication date — on its own.'
                  : 'It stays a draft until then and goes public by itself. You don’t need to press Publish again.'}
              </p>
              <div className="rm-dialog-acts">
                <button type="button" className="rm-cta" onClick={() => finishSave(hold.result, true)}><Icon name="check" className="xs"/>Got it</button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
