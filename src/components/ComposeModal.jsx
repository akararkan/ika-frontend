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
import { SoundMix } from './SoundMix.jsx'
import { DEFAULT_MIX, withMix, soundLabel } from '../lib/soundMix.js'
import { TagInput } from './TagInput.jsx'
import { StoryEditor } from './StoryEditor.jsx'
import { ModerationAlert } from './Moderation.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { api } from '../api/index.js'
import { normalizeTags } from '../api/tags.js'
import { isHeld, isModerationError, moderationText } from '../lib/moderation.js'
import { useCooldown } from '../hooks/useCooldown.js'

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
/* A reel is a video OR a photo: a still reel plays for STILL_SECS with whatever
   sound is attached, the same way Facebook turns a photo into a reel. */
const ACCEPT = { EMBEDDED:'image/*,video/*', REEL:'video/*,image/*', STORY:'image/*,video/*' }
const STILL_SECS = 30


// view visibility ('FOLLOWERS') → backend PostVisibility enum (for edit prefill)
const VIS_TO_ENUM = { PUBLIC:'PUBLIC', FOLLOWERS:'FOLLOWERS_ONLY', FOLLOWERS_ONLY:'FOLLOWERS_ONLY', ONLY_ME:'ONLY_ME', CLOSE_FRIENDS:'CLOSE_FRIENDS' }

/* Map the documented POST error envelopes (§3) + the multipart-create
   custom bodies (§6.2) to a friendly, accurate message for the toast. */
function composeError(e) {
  const code = e?.code, status = e?.status
  /* Moderation FIRST, and specifically before the `post_create_failed` arm
     below. The multipart create endpoint wraps the service call in a bare
     `catch (Exception)`, so a refusal comes back as that same 500 with the
     moderation sentence in `message` and no errorCode at all — the generic
     "uploaded but the post failed and was rolled back" line would then be a
     flat lie about a content decision. isBlocked() (via isModerationError)
     owns that discrimination; see the MULTIPART_BLOCK note in lib/moderation.js.
     The normal composer path never reaches here — a moderation failure renders
     as <ModerationAlert/> inside the modal — but this helper is the file's one
     error-to-copy funnel and must not be the thing that mistranslates it. */
  if (isModerationError(e)) return moderationText(e)
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
  const me = user || { full: 'You', initials: 'Y', avc: 'linear-gradient(135deg,#1f4e7e,#00172f)' }
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
  const [mix, setMix] = React.useState(DEFAULT_MIX)      // authored balance, set before publishing
  const [recording, setRecording] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [cooldown, startCooldown] = useCooldown()       // 429 countdown — draft kept, Publish disabled for the hint
  const [storyEditor, setStoryEditor] = React.useState(false)   // STORY: open the rich editor
  const [storyDraft, setStoryDraft] = React.useState(null)      // editor result: { kind, media, thumbnail, textContent }
  /* Set when a story published but its poll sticker was REFUSED: the story id
     the reworded sticker must attach to. Publish becomes sticker-only while
     this is set; discarded with the modal. */
  const pollTarget = React.useRef(null)
  /* A moderation refusal is the one failure that must NOT close the modal or
     toast: the draft is the only copy of the text, the message is the only
     guidance the server gives, and a toast takes both away in 3.6s. It renders
     as a band under the header, beside the Publish button that produced it. */
  const [modErr, setModErr] = React.useState(null)

  const fileRef = React.useRef(null)
  const recRef = React.useRef(null)
  const chunksRef = React.useRef([])
  const visOptions = tab === 'STORY' ? [...VIS, { key:'CLOSE_FRIENDS', icon:'users', label:'Close friends' }] : VIS
  const visMeta = visOptions.find(v => v.key === vis) || VIS[0]
  const heading = isEdit ? 'Edit post' : tab === 'QUESTION' ? 'Ask a question' : tab === 'STORY' ? 'Add to your story' : 'Create'

  // reset attachments when switching tabs
  React.useEffect(() => { setFiles([]); setRecording(false); setSound(null); setMix(DEFAULT_MIX); if (vis === 'CLOSE_FRIENDS' && tab !== 'STORY') setVis('PUBLIC') }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  // live media thumbnails — images, videos AND audio get object URLs so the
  // gallery can show the real media (revoked on change/unmount)
  const previews = React.useMemo(
    () => files.map(f => ({
      name: f.name,
      isImage: f.type.startsWith('image'),
      isVideo: f.type.startsWith('video'),
      isAudio: f.type.startsWith('audio'),
      url: /^(image|video|audio)\//.test(f.type) ? URL.createObjectURL(f) : null,
    })),
    [files],
  )
  React.useEffect(() => () => previews.forEach(p => p.url && URL.revokeObjectURL(p.url)), [previews])

  // a REEL whose attachment is a photo → the still-reel flow (30s + a sound)
  const stillReel = tab === 'REEL' && !!files[0] && files[0].type.startsWith('image')

  const pickFiles = () => fileRef.current?.click()
  const addFiles = (picked) => { if (picked.length) setFiles(prev => (tab === 'REEL' ? picked.slice(0, 1) : [...prev, ...picked])) }
  const onPicked = (e) => { addFiles(Array.from(e.target.files || [])); e.target.value = '' }
  // real drag & drop onto the drop zones (previously click-only)
  const [dragOver, setDragOver] = React.useState(false)
  const dropProps = {
    onDragOver: (e) => { e.preventDefault(); setDragOver(true) },
    onDragLeave: () => setDragOver(false),
    onDrop: (e) => { e.preventDefault(); setDragOver(false); addFiles(Array.from(e.dataTransfer?.files || [])) },
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

  /* Every text setter goes through these: a refusal is about THIS text, so it
     dies the moment the text changes. Left standing it would keep accusing a
     draft the author has already rewritten — and rewriting is the ONLY way
     forward out of a block, so the panel must never look like a verdict on the
     new words. */
  const editText = (v) => { setModErr(null); setText(v) }
  const editTitle = (v) => { setModErr(null); setTitle(v) }

  /* The "it went up" line, told honestly.
     A held post comes back as an ordinary 200 whose `status` is PENDING_REVIEW:
     it exists, it carries our text, and it is visible to nobody but us until it
     clears. Saying "Published" there would claim something the author cannot
     check for themselves — held posts are dropped from EVERY list endpoint, the
     author's own profile and home feed included, so the card this composer hands
     to the feed is the only place that post can be seen at all until it clears.
     (PENDING and IN_REVIEW collapse into that one wire string, so a post can
     only ever reach the 'checking' state — never 'review'.) */
  const announce = (created) => {
    if (isHeld(created)) showToast('Posted — being checked. Only you can see it until it clears.', 'warn')
    else showToast('Published')
  }

  /* ---- publish ---- */
  const publish = async () => {
    setBusy(true)
    setModErr(null)
    try {
      if (isEdit) {
        // PATCH /api/v1/posts/{id} — EditPostCommand (§6.4). Every field is
        // nullable ("leave untouched"); the composer edits body + visibility.
        // The PATCH response shape has been a moving target (Jackson aliasing
        // fix landed May 2026), so we re-fetch the canonical state via GET
        // and broadcast THAT — guarantees the feed/post page show what the
        // server actually stored, including re-extracted hashtags.
        const patched = await api.posts.edit(editPost.id, { textContent: text, visibility: vis })
        let fresh
        try { fresh = await api.posts.get(editPost.id) } catch { /* fall back below */ }
        /* A HELD edit is a normal 200 that already APPLIED the new text and
           flipped `status` to PENDING_REVIEW — the post keeps our words and
           loses its audience until the verdict lands. A REJECTED edit never
           reached the row at all and arrives in the catch below, with the old
           text still live. Carry the status through the fallback too, or a
           failed re-read would silently downgrade a held post to "published". */
        const saved = fresh || {
          ...editPost,
          body: text,
          visibility: vis === 'FOLLOWERS_ONLY' ? 'FOLLOWERS' : vis,
          status: patched?.status || editPost.status,
        }
        const heldEdit = isHeld(saved)
        onEdited?.(saved)
        showToast(heldEdit ? 'Saved — being checked. Only you can see the change until it clears.' : 'Post updated',
          heldEdit ? 'warn' : 'ok')
        onClose(); return

      } else if (tab === 'QUESTION') {
        // CreateQuestionRequest (QNA_API §6.1): title, body, tags[], keywords, answersLocked, maxAnswers
        // Tags are already normalized by TagInput; re-normalize defensively (SEARCH_API §8.5).
        const tags = normalizeTags(qTags)
        const maxAnswers = qMax.trim() ? Math.max(1, parseInt(qMax, 10) || 0) || null : null
        const created = await api.qna.create({ title, body: text, tags, keywords: qKeywords.trim() || undefined, answersLocked: qLocked, maxAnswers })
        /* No held branch here on purpose: QuestionResponse carries no
           moderation field of any kind, so a question waiting on a verdict is
           byte-identical to one that cleared. The wire cannot tell us, and
           guessing would badge clean questions as "Checking…". A refusal still
           lands in the catch below, which is the half we CAN see. */
        showToast('Question posted')
        window.dispatchEvent(new CustomEvent('ika:question-created', { detail: created }))

      } else if (tab === 'STORY') {
        /* Second pass after a refused poll sticker: the STORY itself already
           exists (pollTarget holds its id), so only the reworded sticker is
           resubmitted — re-creating the story would post it twice. Media/text
           changes made in the editor meanwhile cannot apply to the published
           frame; the sticker is the only part still in flight. */
        if (pollTarget.current && storyDraft?.poll) {
          const { question, optionA, optionB, x, y } = storyDraft.poll
          try {
            await api.stories.attachPoll(pollTarget.current, { question, optionA, optionB, posX: Math.round(x), posY: Math.round(y) })
          } catch (e) {
            if (isModerationError(e)) { setModErr(e); return }   // still refused — keep the draft, try other words
            throw e
          }
          pollTarget.current = null
          showToast('Poll added to your story')
          window.dispatchEvent(new CustomEvent('ika:story-created'))
          onClose()
          return
        }
        let created
        let pollErr = null      // a refused poll sticker, reported after the story's own line
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
            /* Still best-effort — the story is up and a failed sticker must not
               sink it — but a REFUSED poll is a content decision, not a hiccup,
               and swallowing it made the sticker vanish with nothing said. Poll
               text is scored with submitOrRefuse, which turns even a merely
               borderline question (or the classifier simply being unreachable)
               into a hard 400, so this is the likeliest refusal in the whole
               story flow. Held here, not toasted here: there is one toast
               element, and the "Story added" line below would overwrite it. */
            await api.stories.attachPoll(created.storyId || created.id, req).catch(e => { pollErr = e })
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
        /* Stories DO carry a marker (`moderationStatus: PENDING | IN_REVIEW`,
           null once approved) and, unlike posts, the author keeps getting the
           row back from /stories/by-author — so the honest line here is that it
           went up but nobody else has it yet. */
        const heldStory = isHeld(created)
        if (pollErr && isModerationError(pollErr)) {
          /* The STORY is up — only the sticker was refused, and refused text
             must keep its draft (rule 1's sibling: a toast destroys it). Keep
             the modal open with the poll intact, show the sentence inline, and
             remember the story id so Publish now retries JUST the sticker. */
          pollTarget.current = created.storyId || created.id
          window.dispatchEvent(new CustomEvent('ika:story-created', { detail: created }))   // the frame itself is real
          setModErr(pollErr)
          return
        }
        if (pollErr) {
          showToast('Your story is up, but the poll sticker could not be added', 'warn')
        } else {
          showToast(heldStory ? 'Story added — being checked. Only you can see it until it clears.' : 'Story added',
            heldStory ? 'warn' : 'ok')
        }
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
        /* A picked Sound needs BOTH halves. `soundId` is bookkeeping — it
           adopts the sound (§19) and bumps use_count — but the server never
           copies the sound's audio onto the post, so a post that sent only
           `soundId` comes back with `audioTrackUrl: null` and the viewer has
           nothing to play. The track url + label are what make it audible;
           the RAW url is stored so the value stays host-independent. */
        if (sound) {
          fd.append('soundId', sound.id)
          const url = sound.audioUrlRaw || sound.audioUrl
          // …#mix=orig,music — the authored balance (see SoundMix.jsx)
          if (url) fd.append('audioTrackUrl', tab === 'REEL' ? withMix(url, mix) : url)
          fd.append('audioTrackName', soundLabel(sound))
        }
        files.forEach(f => fd.append('files', f)) // §6.2 accepts files/media/file/video/image
        const created = await api.posts.createMultipart(fd)
        onPublished?.(created); announce(created)

      } else {
        // text-only JSON create (POST_API §6.1)
        const created = await api.posts.create({
          postType: tab, visibility: vis, textContent: text, mediaUrls: [], mediaTypes: [],
          soundId: sound?.id || null,
          // see the multipart branch: `soundId` alone is silent
          audioTrackUrl: sound ? (sound.audioUrlRaw || sound.audioUrl || null) : null,
          audioTrackName: sound ? soundLabel(sound) : null,
        })
        onPublished?.(created); announce(created)
      }
      onClose()
    } catch (e) {
      /* Moderation is not a failed request: nothing here is retriable by
         hammering it, and the text is worth more than the modal. Keep the modal
         open with the draft where it is and render the server's own words
         inline — verbatim, undecorated (rule 1 in lib/moderation.js). Everything
         else stays a toast, because everything else is worth re-trying. */
      if (isModerationError(e)) { setModErr(e); return }
      /* 429 → countdown, not a dead end (error guide §2.3): the draft stays
         where it is and Publish disables for the server's own retry hint. */
      startCooldown(e)
      showToast(composeError(e), 'err')
    } finally {
      setBusy(false)
    }
  }

  const disabled = busy || cooldown > 0 || (
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
  const insertToken = (ch) => { setModErr(null); setText(t => { const s = t || ''; return (s && !/\s$/.test(s) ? s + ' ' : s) + ch }) }

  // Story editor is a separate full-screen surface; render it instead of the
  // compose modal while it's open so the canvas gets the whole viewport.
  if (storyEditor) {
    return (
      <StoryEditor
        initialMedia={storyDraft?.media || files[0] || null}
        /* The refusal has to travel INTO the editor. A story's caption lives on
           the editor's stage, not in this modal's textarea, so the only way to
           act on "this text was refused" is to reopen the editor — which
           replaces this whole surface. Without these two props the author
           rewrites the caption with the sentence they are trying to satisfy no
           longer on screen. */
        error={modErr}
        onDismissError={() => setModErr(null)}
        onCancel={() => setStoryEditor(false)}
        onSave={(draft) => {
          setStoryDraft(draft)
          /* The draft just changed, so the standing refusal is about wording
             that no longer exists — the same rule editText/editTitle follow.
             Left standing it would accuse a caption the author already fixed. */
          setModErr(null)
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
          <div className="cm-headwrap"><span className="cm-kicker">New entry</span><h3>{heading}</h3></div>
          <button className="btn btn-primary cm-publish" disabled={disabled} onClick={publish}>
            <Icon name="feather" className="sm"/>{busy ? (isEdit ? 'Saving…' : 'Posting…') : cooldown > 0 ? `Wait ${cooldown}s` : isEdit ? 'Save' : tab === 'QUESTION' ? 'Post' : tab === 'STORY' ? 'Add' : 'Publish'}
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

        {/* Between the header and the SCROLLING body on purpose: the alert has
            to stay next to the Publish button that produced it, and anything
            inside .mbody can be scrolled out of sight the moment the draft is
            longer than the modal. `onRetry` is inert for posts today — this
            module only ever throws CONTENT_REJECTED, and <ModerationAlert/>
            shows the button for CONTENT_UNDER_REVIEW alone — but a re-submit is
            exactly the right action on the day one of these paths starts
            answering "not yet" instead of "no". */}
        {modErr && (
          <div style={{ padding: '0 16px' }}>
            <ModerationAlert error={modErr} onRetry={publish} onDismiss={() => setModErr(null)}/>
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

          {/* STORY tab: all text is added INSIDE the StoryEditor design surface
              (baked into the image), so the modal's plain textarea would be
              redundant and confusing. Hide it. Every other tab keeps it. */}
          {tab !== 'STORY' && (
            <div className="cm-sheet">
              {tab === 'QUESTION' && (
                <input className="field cm-qtitle" dir="auto" placeholder="What would you like to ask?" value={title} onChange={e => editTitle(e.target.value)}/>
              )}
              <MentionBox as="textarea" className="cm-area" dir="auto" placeholder={PLACEHOLDER[tab]} value={text} onChange={e => editText(e.target.value)}/>
            </div>
          )}

          {/* hidden file input shared by drop zone + attach buttons */}
          {!isEdit && <input ref={fileRef} type="file" hidden accept={ACCEPT[tab] || (tab === 'VOICE_POST' ? 'audio/*' : '*/*')}
            multiple={tab === 'EMBEDDED' || tab === 'STORY'} onChange={onPicked}/>}

          {/* selected media — live preview gallery (real video frames, playable) */}
          {!isEdit && !!files.length && (
            <div className={'cm-previews' + (tab === 'REEL' ? ' is-reel' : '')}>
              {previews.map((p, i) => (
                <div key={i} className={'cm-prev' + (i === 0 && tab === 'EMBEDDED' && previews.length > 1 ? ' lead' : '') + (p.isAudio ? ' is-audio' : '')}>
                  {p.isImage && <img src={p.url} alt=""/>}
                  {p.isVideo && (
                    <video
                      src={p.url} muted playsInline loop preload="metadata"
                      onMouseEnter={e => e.currentTarget.play().catch(() => {})}
                      onMouseLeave={e => { e.currentTarget.pause(); e.currentTarget.currentTime = 0 }}
                      onClick={e => { const v = e.currentTarget; if (v.paused) v.play().catch(() => {}); else v.pause() }}
                    />
                  )}
                  {p.isAudio && (
                    <div className="cm-prev-audio">
                      <span className="cm-prev-audio-ic"><Icon name="music"/></span>
                      <div className="cm-prev-audio-col">
                        <b>{p.name}</b>
                        <audio src={p.url} controls preload="metadata"/>
                      </div>
                    </div>
                  )}
                  {!p.isImage && !p.isVideo && !p.isAudio && <span className="cm-prev-ic"><Icon name="music" className="lg"/></span>}
                  {p.isVideo && <span className="cm-prev-badge"><Icon name="video" className="xs"/>hover to play</span>}
                  {i === 0 && tab === 'EMBEDDED' && previews.length > 1 && <span className="cm-prev-lead">Lead figure</span>}
                  <button className="cm-prev-x" onClick={() => removeFile(i)} aria-label="Remove"><Icon name="close" className="xs"/></button>
                  {!p.isImage && !p.isVideo && !p.isAudio && <span className="cm-prev-name">{p.name}</span>}
                </div>
              ))}
              {tab === 'EMBEDDED' && (
                <button className="cm-prev-add" onClick={pickFiles} aria-label="Add more media">
                  <Icon name="upload"/><span>Add more</span>
                </button>
              )}
            </div>
          )}

          {!isEdit && tab === 'EMBEDDED' && (
            <div className={'cm-drop' + (dragOver ? ' over' : '')} onClick={pickFiles} style={{ cursor:'pointer' }} {...dropProps}>
              <Icon name="image" className="lg"/>
              <b>Attach figures — drag or browse</b>
              <span className="text-xs">JPG, PNG, WebP or MP4 · figures appear plate-framed in your post</span>
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
            <div className={'cm-drop' + (dragOver ? ' over' : '')} onClick={pickFiles} style={{ cursor:'pointer' }} {...dropProps}>
              <Icon name="reels" className="lg"/>
              <b>Attach your reel</b>
              <span className="text-xs">MP4 or WebM — or a photo, which plays for {STILL_SECS} seconds · vertical 9:16</span>
            </div>
          )}
          {/* A photo reel has no sound of its own: whatever is picked below is
              the ONLY thing anyone will hear. Say so where the choice is made,
              rather than letting the author find out after publishing. */}
          {!isEdit && tab === 'REEL' && stillReel && (
            <p className="muted text-sm" style={{ marginTop: 10 }}>
              <Icon name="clock" className="xs"/>{' '}
              This photo plays for {STILL_SECS} seconds.{' '}
              {sound ? 'Your chosen sound plays over it.' : 'Add a sound below, or it goes out silent.'}
            </p>
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
          {/* The balance is authored HERE, where the sound was chosen and while
              the clip is still a local file that can be played instantly — not
              left to whoever watches it later. Reels only: nothing else on the
              platform plays a post's added sound. */}
          {!isEdit && tab === 'REEL' && sound && (
            <SoundMix sound={sound} mix={mix} onChange={setMix} file={files[0] || null}/>
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
            {!isEdit && <button style={{ color:'var(--ink-soft)' }} title="Add photo / video" onClick={pickFiles}><Icon name="image"/></button>}
            <button style={{ color:'var(--blue)' }} title="Mention someone" onClick={() => insertToken('@')}><Icon name="at"/></button>
            <button style={{ color:'var(--blue)' }} title="Add hashtag" onClick={() => insertToken('#')}><Icon name="hash"/></button>
          </div>
          <span className="cm-count font-mono">{(tab === 'QUESTION' ? title : text).length}/5000</span>
        </div>
      </div>
    </div>
  )
}
