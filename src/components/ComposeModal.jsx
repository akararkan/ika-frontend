/* =========================================================
   Compose modal — TEXT / EMBEDDED / REEL / VOICE / QUESTION / STORY
   ---------------------------------------------------------
   Real media upload: when files are attached we POST the
   MULTIPART create endpoint (POST_API §6.2) which streams the
   binaries to R2. Otherwise we POST the JSON create (§6.1).
   Only backend-supported fields are sent.
   ========================================================= */
import React from 'react'
import { Icon, Avatar, showToast } from './ui.jsx'
import { MentionBox } from './MentionBox.jsx'
import { SoundPicker } from './SoundPicker.jsx'
import { TagInput } from './TagInput.jsx'
import { StoryEditor } from './StoryEditor.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { api } from '../api/index.js'
import { normalizeTags } from '../api/tags.js'

const TABS = [
  { key:'TEXT',       icon:'compose', label:'Post' },
  { key:'EMBEDDED',   icon:'image',   label:'Photo' },
  { key:'REEL',       icon:'reels',   label:'Reel' },
  { key:'VOICE_POST', icon:'mic',     label:'Voice' },
  { key:'QUESTION',   icon:'qna',     label:'Ask' },
  { key:'STORY',      icon:'compose', label:'Story' },
]
const VIS = [
  { key:'PUBLIC',         icon:'globe', label:'Public' },
  { key:'FOLLOWERS_ONLY', icon:'users', label:'Followers' },
  { key:'ONLY_ME',        icon:'lock',  label:'Only me' },
]
const PLACEHOLDER = {
  TEXT:'Share knowledge with the community…',
  EMBEDDED:'Say something about your photos…',
  REEL:'Write a caption for your reel…',
  VOICE_POST:'Add a short description for your voice note…',
  QUESTION:"Add context, what you've already read, and what you're unsure about…",
  STORY:'Add text to your story…',
}
const ACCEPT = { EMBEDDED:'image/*,video/*', REEL:'video/*', STORY:'image/*,video/*' }

// view visibility ('FOLLOWERS') → backend PostVisibility enum (for edit prefill)
const VIS_TO_ENUM = { PUBLIC:'PUBLIC', FOLLOWERS:'FOLLOWERS_ONLY', FOLLOWERS_ONLY:'FOLLOWERS_ONLY', ONLY_ME:'ONLY_ME', CLOSE_FRIENDS:'CLOSE_FRIENDS' }

/* Map the documented POST error envelopes (§3) + the multipart-create
   custom bodies (§6.2) to a friendly, accurate message for the toast. */
function composeError(e) {
  const code = e?.code, status = e?.status
  if (code === 'upload_failed')      return 'Media upload failed — nothing was published. Please try again.'        // §6.2 (502)
  if (code === 'post_create_failed') return 'Media uploaded but the post failed and was rolled back. Try again.'    // §6.2 (500)
  if (status === 401)                                      return 'Please sign in to publish.'                       // bare body (§2)
  if (status === 413 || code === 'FILE_TOO_LARGE')         return 'That file is too large.'                         // §3 (413)
  if (status === 415 || code === 'UNSUPPORTED_MEDIA_TYPE') return 'That file type is not supported.'                 // §3 (415)
  if (status === 429 || code === 'RATE_LIMITED')           return 'You are posting too fast — wait a moment.'        // §3 (429)
  if (code === 'VALIDATION_FAILED' && e?.fieldErrors?.length) return e.fieldErrors[0].message                       // §3 fieldErrors
  return e?.message || 'Could not publish'
}

/* Story preview chip inside the compose modal — shown after the user has
   designed something via <StoryEditor>. Clicking it reopens the editor. */
function StoryDraftPreview({ draft, onEdit, onClear }) {
  const [url, setUrl] = React.useState(null)
  React.useEffect(() => {
    if (!draft?.media) return
    const u = URL.createObjectURL(draft.media)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [draft?.media])
  return (
    <div className="cm-story-draft">
      <div className="cm-story-draft-cover" style={{ backgroundImage: url ? `url("${url}")` : undefined }}>
        {draft?.kind === 'VIDEO' && <span className="cm-story-draft-pill"><Icon name="video" className="xs"/>Video</span>}
      </div>
      <div className="cm-story-draft-meta">
        <b>Story ready</b>
        <small className="muted">Tap to keep editing, or hit Publish.</small>
        <div className="flex gap-8" style={{ marginTop:8 }}>
          <button className="btn btn-secondary btn-sm" onClick={onEdit}><Icon name="compose" className="xs"/>Edit</button>
          <button className="btn btn-secondary btn-sm" style={{ color:'var(--rose)' }} onClick={onClear}><Icon name="close" className="xs"/>Discard</button>
        </div>
      </div>
    </div>
  )
}

export function ComposeModal({ type = 'TEXT', editPost = null, onClose, onPublished, onEdited }) {
  const { user } = useAuth()
  const me = user || { full: 'You', initials: 'Y', avc: 'linear-gradient(135deg,#159a76,#0a4a3c)' }
  const isEdit = !!editPost   // edit mode → PATCH /api/v1/posts/{id} (§6.4)

  const [tab, setTab] = React.useState(isEdit ? (editPost.type || 'TEXT') : type)
  const [text, setText] = React.useState(isEdit ? (editPost.body || '') : '')
  const [vis, setVis] = React.useState(isEdit ? (VIS_TO_ENUM[editPost.visibility] || 'PUBLIC') : 'PUBLIC')
  const [title, setTitle] = React.useState('')
  const [qTags, setQTags] = React.useState([])         // QUESTION tags — chip array (server caps at 30, §8.5)
  const [qKeywords, setQKeywords] = React.useState('') // QUESTION free-text search keywords
  const [qLocked, setQLocked] = React.useState(false)  // QUESTION answersLocked on create
  const [qMax, setQMax] = React.useState('')           // QUESTION maxAnswers ('' = unlimited)
  const [files, setFiles] = React.useState([])
  const [sound, setSound] = React.useState(null)
  const [recording, setRecording] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [storyEditor, setStoryEditor] = React.useState(false)   // STORY: open the rich editor
  const [storyDraft, setStoryDraft] = React.useState(null)      // editor result: { kind, media, thumbnail, textContent }

  const fileRef = React.useRef(null)
  const recRef = React.useRef(null)
  const chunksRef = React.useRef([])
  const visOptions = tab === 'STORY' ? [...VIS, { key:'CLOSE_FRIENDS', icon:'users', label:'Close friends' }] : VIS
  const visMeta = visOptions.find(v => v.key === vis) || VIS[0]
  const heading = isEdit ? 'Edit post' : tab === 'QUESTION' ? 'Ask a question' : tab === 'STORY' ? 'Add to your story' : 'Create'

  // reset attachments when switching tabs
  React.useEffect(() => { setFiles([]); setRecording(false); setSound(null); if (vis === 'CLOSE_FRIENDS' && tab !== 'STORY') setVis('PUBLIC') }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  // image thumbnails (revoked on change/unmount)
  const previews = React.useMemo(
    () => files.map(f => ({ name: f.name, isImage: f.type.startsWith('image'), isVideo: f.type.startsWith('video'), url: f.type.startsWith('image') ? URL.createObjectURL(f) : null })),
    [files],
  )
  React.useEffect(() => () => previews.forEach(p => p.url && URL.revokeObjectURL(p.url)), [previews])

  const pickFiles = () => fileRef.current?.click()
  const onPicked = (e) => {
    const picked = Array.from(e.target.files || [])
    if (picked.length) setFiles(prev => (tab === 'REEL' ? picked.slice(0, 1) : [...prev, ...picked]))
    e.target.value = ''
  }
  const removeFile = (i) => setFiles(fs => fs.filter((_, idx) => idx !== i))

  /* ---- voice recording ---- */
  const startRec = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream)
      chunksRef.current = []
      mr.ondataavailable = (e) => chunksRef.current.push(e.data)
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        setFiles([new File([blob], 'voice-note.webm', { type: 'audio/webm' })])
        stream.getTracks().forEach(t => t.stop())
      }
      mr.start(); recRef.current = mr; setRecording(true)
    } catch {
      showToast('Microphone unavailable — upload an audio file instead')
      fileRef.current?.click()
    }
  }
  const stopRec = () => { try { recRef.current?.stop() } catch { /* ignore */ } setRecording(false) }
  const voiceTap = () => { if (recording) stopRec(); else if (files.length) setFiles([]); else startRec() }

  /* ---- publish ---- */
  const publish = async () => {
    setBusy(true)
    try {
      if (isEdit) {
        // PATCH /api/v1/posts/{id} — EditPostCommand (§6.4). Every field is
        // nullable ("leave untouched"); the composer edits body + visibility.
        // The PATCH response shape has been a moving target (Jackson aliasing
        // fix landed May 2026), so we re-fetch the canonical state via GET
        // and broadcast THAT — guarantees the feed/post page show what the
        // server actually stored, including re-extracted hashtags.
        await api.posts.edit(editPost.id, { textContent: text, visibility: vis })
        let fresh
        try { fresh = await api.posts.get(editPost.id) } catch { /* fall back below */ }
        onEdited?.(fresh || { ...editPost, body: text, visibility: vis === 'FOLLOWERS_ONLY' ? 'FOLLOWERS' : vis })
        showToast('Post updated'); onClose(); return

      } else if (tab === 'QUESTION') {
        // CreateQuestionRequest (QNA_API §6.1): title, body, tags[], keywords, answersLocked, maxAnswers
        // Tags are already normalized by TagInput; re-normalize defensively (SEARCH_API §8.5).
        const tags = normalizeTags(qTags)
        const maxAnswers = qMax.trim() ? Math.max(1, parseInt(qMax, 10) || 0) || null : null
        const created = await api.qna.create({ title, body: text, tags, keywords: qKeywords.trim() || undefined, answersLocked: qLocked, maxAnswers })
        showToast('Question posted')
        window.dispatchEvent(new CustomEvent('ika:question-created', { detail: created }))

      } else if (tab === 'STORY') {
        let created
        // Prefer the rich-editor result (flattened PNG with text layers baked
        // in) over a raw file. Falls back to a text-only story if nothing was
        // designed.
        if (storyDraft?.media) {
          const fd = new FormData()
          fd.append('storyType', storyDraft.kind || 'IMAGE')
          fd.append('visibility', vis)
          const caption = (storyDraft.textContent || text || '').trim()
          if (caption) fd.append('textContent', caption)
          fd.append('media', storyDraft.media)
          if (storyDraft.thumbnail) fd.append('thumbnail', storyDraft.thumbnail)
          created = await api.stories.createMultipart(fd)
          // Attach the poll sticker (if any) once the story exists — best-effort,
          // a failed poll shouldn't sink the published story. posX/posY carry the
          // authored placement so the viewer can honour it once the backend stores them.
          if (storyDraft.poll && (created?.storyId || created?.id)) {
            const { question, optionA, optionB, x, y } = storyDraft.poll
            const req = { question, optionA, optionB, posX: Math.round(x), posY: Math.round(y) }
            await api.stories.attachPoll(created.storyId || created.id, req).catch(() => {})
          }
        } else if (files.length) {
          // Legacy path — user attached a file without opening the editor.
          const fd = new FormData()
          fd.append('storyType', files[0].type.startsWith('video') ? 'VIDEO' : 'IMAGE')
          fd.append('visibility', vis)
          if (text) fd.append('textContent', text)
          fd.append('media', files[0])
          created = await api.stories.createMultipart(fd)
        } else {
          created = await api.stories.create({ storyType: 'TEXT', visibility: vis, textContent: text })
        }
        showToast('Story added')
        // refresh the story tray in place — no reload needed
        window.dispatchEvent(new CustomEvent('ika:story-created', { detail: created }))

      } else if (files.length) {
        // multipart create — streams binaries to R2 (POST_API §6.2)
        const fd = new FormData()
        fd.append('postType', tab)               // PostType enum (§4)
        fd.append('visibility', vis)             // PostVisibility enum (§4)
        if (text) fd.append('textContent', text)
        // VOICE_POST carries a display label for the audio track (§5 / §6.1).
        if (tab === 'VOICE_POST') fd.append('audioTrackName', (files[0].name || 'Voice note').replace(/\.[^./\\]+$/, ''))
        if (sound) fd.append('soundId', sound.id) // adopts a Sound (§19), bumps use_count
        files.forEach(f => fd.append('files', f)) // §6.2 accepts files/media/file/video/image
        const created = await api.posts.createMultipart(fd)
        onPublished?.(created); showToast('Published')

      } else {
        // text-only JSON create (POST_API §6.1)
        const created = await api.posts.create({ postType: tab, visibility: vis, textContent: text, mediaUrls: [], mediaTypes: [], soundId: sound?.id || null })
        onPublished?.(created); showToast('Published')
      }
      onClose()
    } catch (e) {
      showToast(composeError(e))
    } finally {
      setBusy(false)
    }
  }

  const disabled = busy || (
    isEdit             ? (tab === 'TEXT' && !text.trim()) :
    tab === 'QUESTION' ? !title.trim() :
    tab === 'TEXT'     ? !text.trim() :
    tab === 'REEL'     ? !files.length :
    tab === 'VOICE_POST' ? !files.length :
    tab === 'STORY'    ? !storyDraft?.media :       // editor must produce a design
    /* EMBEDDED */ !files.length && !text.trim()
  )

  // Footer affordances append to the body text (the @ / # then trigger the
  // usual tag/mention flows as the user keeps typing).
  const insertToken = (ch) => setText(t => { const s = t || ''; return (s && !/\s$/.test(s) ? s + ' ' : s) + ch })

  // Story editor is a separate full-screen surface; render it instead of the
  // compose modal while it's open so the canvas gets the whole viewport.
  if (storyEditor) {
    return (
      <StoryEditor
        initialMedia={storyDraft?.media || files[0] || null}
        onCancel={() => setStoryEditor(false)}
        onSave={(draft) => {
          setStoryDraft(draft)
          setStoryEditor(false)
        }}
      />
    )
  }

  return (
    <div className="overlay open cm-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal cm-modal">
        <div className="cm-top">
          <button className="cm-cancel" onClick={onClose}>Cancel</button>
          <h3>{heading}</h3>
          <button className="btn btn-primary cm-publish" disabled={disabled} onClick={publish}>
            {busy ? (isEdit ? 'Saving…' : 'Posting…') : isEdit ? 'Save' : tab === 'QUESTION' ? 'Post' : tab === 'STORY' ? 'Add' : 'Publish'}
          </button>
        </div>

        {/* postType is immutable on edit (§6.4 has no postType field) — hide the picker */}
        {!isEdit && (
          <div className="cm-tabs">
            {TABS.map(t => (
              <button key={t.key} className={'cm-tab ' + (tab===t.key ? 'on' : '')} onClick={() => setTab(t.key)}>
                <Icon name={t.icon} className="xs"/>{t.label}
              </button>
            ))}
          </div>
        )}

        <div className="mbody">
          <div className="cm-author">
            <Avatar initials={me.initials} color={me.avc} size={44} src={me.profileImage}/>
            <div>
              <b>{me.full}</b>
              <div className="cm-vis" role="button" onClick={() => { const i = visOptions.findIndex(v => v.key === vis); setVis(visOptions[(i + 1) % visOptions.length].key) }}>
                <Icon name={visMeta.icon} className="xs"/>{visMeta.label}
              </div>
            </div>
          </div>

          {tab === 'QUESTION' && (
            <input className="field lg" dir="auto" placeholder="What would you like to ask?" value={title} onChange={e => setTitle(e.target.value)} style={{ marginBottom:12 }}/>
          )}

          {/* STORY tab: all text is added INSIDE the StoryEditor design surface
              (baked into the image), so the modal's plain textarea would be
              redundant and confusing. Hide it. Every other tab keeps it. */}
          {tab !== 'STORY' && (
            <MentionBox as="textarea" className="cm-area" dir="auto" placeholder={PLACEHOLDER[tab]} value={text} onChange={e => setText(e.target.value)}/>
          )}

          {/* hidden file input shared by drop zone + attach buttons */}
          {!isEdit && <input ref={fileRef} type="file" hidden accept={ACCEPT[tab] || (tab === 'VOICE_POST' ? 'audio/*' : '*/*')}
            multiple={tab === 'EMBEDDED' || tab === 'STORY'} onChange={onPicked}/>}

          {/* selected files preview */}
          {!isEdit && !!files.length && (
            <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginTop:12 }}>
              {previews.map((p, i) => (
                <div key={i} style={{ position:'relative', width:84, height:84, borderRadius:12, overflow:'hidden', border:'1px solid var(--line)', background:'var(--card-2)', display:'grid', placeItems:'center' }}>
                  {p.isImage
                    ? <img src={p.url} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }}/>
                    : <Icon name={p.isVideo ? 'video' : 'music'} className="lg"/>}
                  <button onClick={() => removeFile(i)} style={{ position:'absolute', top:4, right:4, width:22, height:22, borderRadius:'50%', background:'rgba(11,26,22,.7)', color:'#fff', display:'grid', placeItems:'center' }}>
                    <Icon name="close" className="xs"/>
                  </button>
                  {!p.isImage && <span style={{ position:'absolute', bottom:0, left:0, right:0, fontSize:9, padding:'2px 4px', background:'rgba(11,26,22,.7)', color:'#fff', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{p.name}</span>}
                </div>
              ))}
            </div>
          )}

          {!isEdit && tab === 'EMBEDDED' && (
            <div className="cm-drop" onClick={pickFiles} style={{ cursor:'pointer' }}>
              <Icon name="image" className="lg"/>
              <b>Click to add photos or video</b>
              <span className="text-xs">JPG, PNG, WebP or MP4 · up to 10 files</span>
            </div>
          )}
          {!isEdit && tab === 'STORY' && (
            storyDraft?.media ? (
              <StoryDraftPreview draft={storyDraft} onEdit={() => setStoryEditor(true)} onClear={() => setStoryDraft(null)}/>
            ) : (
              <div className="cm-drop" onClick={() => setStoryEditor(true)} style={{ cursor:'pointer' }}>
                <Icon name="image" className="lg"/>
                <b>Design your story</b>
                <span className="text-xs">Photo or gradient · add draggable text, fonts, colours, rotation</span>
              </div>
            )
          )}
          {!isEdit && tab === 'REEL' && (
            <div className="cm-drop" onClick={pickFiles} style={{ cursor:'pointer' }}>
              <Icon name="reels" className="lg"/>
              <b>Click to add your reel video</b>
              <span className="text-xs">MP4 or WebM · vertical 9:16 works best</span>
            </div>
          )}
          {!isEdit && tab === 'VOICE_POST' && (
            <div className="cm-voice">
              <div className="cv-pill"><span className="cv-rec"/>{recording ? 'Recording…' : files.length ? 'Recorded' : 'Ready to record'}</div>
              <button className="cv-btn" onClick={voiceTap}><Icon name={recording ? 'pause' : files.length ? 'close' : 'mic'}/></button>
              <small style={{ opacity:.85 }}>
                {recording ? 'Tap to stop' : files.length ? `${files[0].name} · tap to re-record` : 'Tap to record, or '}
                {!recording && !files.length && <a style={{ textDecoration:'underline', cursor:'pointer' }} onClick={pickFiles}>upload an audio file</a>}
              </small>
            </div>
          )}

          {!isEdit && (tab === 'TEXT' || tab === 'EMBEDDED' || tab === 'REEL') && (
            <SoundPicker value={sound} onChange={setSound}/>
          )}

          {!isEdit && tab === 'QUESTION' && (
            <>
              <TagInput value={qTags} onChange={setQTags} scope="QUESTION" placeholder="Add tag (e.g. fiqh), Enter to add"/>
              <input className="field" placeholder="Search keywords (optional, helps discovery)" value={qKeywords} onChange={e => setQKeywords(e.target.value)} style={{ marginTop:10 }}/>
              <div className="flex gap-8" style={{ marginTop:10, alignItems:'center' }}>
                <input className="field" type="number" min="1" placeholder="Max answers (optional)" value={qMax} onChange={e => setQMax(e.target.value)} style={{ maxWidth:200 }}/>
                <button type="button" className={'btn btn-sm ' + (qLocked ? 'btn-primary' : 'btn-secondary')} onClick={() => setQLocked(v => !v)}>
                  <Icon name="lock" className="xs"/>{qLocked ? 'Answers locked' : 'Lock answers'}
                </button>
              </div>
            </>
          )}

        </div>

        {/* Attach bar + character count (prototype .m-cmp footer) */}
        <div className="cm-footbar">
          <div className="cm-tools">
            {!isEdit && <button style={{ color:'#3f9a6b' }} title="Add photo / video" onClick={pickFiles}><Icon name="image"/></button>}
            <button style={{ color:'#bd9344' }} title="Mention someone" onClick={() => insertToken('@')}><Icon name="at"/></button>
            <button style={{ color:'#0e6b54' }} title="Add hashtag" onClick={() => insertToken('#')}><Icon name="hash"/></button>
          </div>
          <span className="cm-count font-mono">{(tab === 'QUESTION' ? title : text).length}/5000</span>
        </div>
      </div>
    </div>
  )
}
