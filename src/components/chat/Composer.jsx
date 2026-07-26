/* =========================================================
   Composer — everything below the thread.
   ---------------------------------------------------------
   Text, attachments (pick · paste · drop), voice notes, emoji,
   and the reply/edit context strip. It is a controlled shell
   around one autogrowing <textarea>; the parent owns sending.

   Decisions worth knowing:
   - Enter sends, Shift+Enter breaks a line — but ONLY on
     pointer-fine devices. On a phone the on-screen Return key
     must insert a newline (there is a send button right there),
     so the shortcut is gated behind a hover/fine-pointer check.
   - Typing pings are fired on keystroke and throttled INSIDE
     ChatContext (one ping / 3s / conversation); the composer
     also sends an explicit stop on submit and on unmount so a
     "…is typing" never sticks after the tab closes.
   - Voice notes record through MediaRecorder into a single Blob
     and are uploaded via the multipart endpoint. The stream's
     tracks are stopped in every exit path — a live mic light
     left on after a cancelled recording is unacceptable.
   - The draft is lifted to the parent by conversation id so
     switching chats and coming back keeps what you typed.
   ========================================================= */
import React from 'react'
import { Icon, showToast } from '../ui.jsx'
import { Popover } from './Popover.jsx'
import { ACTIVITY, uploadActivityOf } from './activity.js'

const EMOJI = [
  '😀', '😁', '😂', '🤣', '😊', '😇', '🙂', '😉',
  '😍', '🥰', '😘', '😋', '🤔', '🤫', '🤝', '🙏',
  '🤲', '👍', '👎', '👏', '💪', '✍️', '🕌', '📿',
  '📖', '📚', '✨', '🌙', '⭐', '☀️', '🌸', '🔥',
  '❤️', '💚', '💙', '🤍', '😢', '😭', '😮', '😴',
  '🎉', '✅', '❌', '⚠️', '💡', '🎯', '📌', '🔗',
]

/** Cap: the backend accepts 8000 chars for a message body. */
const MAX_BODY = 8000
/** Attachments per message — keeps one upload request sane. */
const MAX_FILES = 10

const isFinePointer = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(hover: hover) and (pointer: fine)').matches

/** seconds → "0:07" */
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** seconds → "24h" / "7d" / "90d" — the disappearing-timer badge. */
function ttlLabel(secs) {
  const n = Number(secs) || 0
  if (n <= 0) return ''
  if (n % 86400 === 0) return `${n / 86400}d`
  if (n % 3600 === 0) return `${n / 3600}h`
  return `${Math.round(n / 60)}m`
}

/* Send-later presets. `scheduledAt` is a LOCAL wall-clock string
   (`yyyy-MM-ddTHH:mm:ss`) with no zone suffix, matching the documented
   ScheduleMessageRequest example — appending a `Z` would silently shift
   every scheduled message by the reader's UTC offset. */
function localStamp(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`
}

function schedulePresets() {
  const now = new Date()
  const inHour = new Date(now.getTime() + 3600 * 1000)

  const tonight = new Date(now); tonight.setHours(20, 0, 0, 0)
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0)
  const nextWeek = new Date(now); nextWeek.setDate(nextWeek.getDate() + 7); nextWeek.setHours(9, 0, 0, 0)

  const rows = [{ key: 'hour', label: 'In an hour', at: inHour }]
  // "Tonight" is meaningless once it is already past 20:00 — drop it rather
  // than offering a preset the server would reject as being in the past.
  if (tonight > now) rows.push({ key: 'tonight', label: 'Tonight', at: tonight })
  rows.push({ key: 'tomorrow', label: 'Tomorrow morning', at: tomorrow })
  rows.push({ key: 'week', label: 'Next week', at: nextWeek })
  return rows
}

/** The concrete time a preset resolves to, shown beside its label —
 *  "14:52" today/tomorrow, "Fri 09:00" further out. */
function presetTime(d) {
  const t = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const now = new Date()
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1)
  if (d.toDateString() === now.toDateString() || d.toDateString() === tomorrow.toDateString()) return t
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${t}`
}

export function Composer({
  conversationId,
  disabled,
  lockedReason,
  replyTo,
  editing,
  draft = '',
  onDraftChange,
  onSendText,
  onSendFiles,
  onCommitEdit,
  onCancelReply,
  onCancelEdit,
  onTyping,
  onSchedule,
  onOpenScheduled,
  onExtras,
  scheduledCount = 0,
  disappearingSeconds = 0,
  /* Slow mode: one message per window for NON-admins (the owner and admins
     are exempt server-side). `0` means off, and it is off for an exempt
     caller too — ChatPage resolves that before it reaches here, so this
     component never has to know who is an admin. */
  slowModeSeconds = 0,
  /* Channel admins can post without waking anyone. Only shown where the wire
     supports it (a channel you may post to) — elsewhere `silent` is a field
     the server ignores, and a control that does nothing is worse than none. */
  allowSilent = false,
  placeholder = 'Write a message…',
}) {
  const [files, setFiles] = React.useState([])
  const [emojiOpen, setEmojiOpen] = React.useState(false)
  const [schedOpen, setSchedOpen] = React.useState(false)
  const [customWhen, setCustomWhen] = React.useState('')
  /* The presets and the "no earlier than" floor are stamped ONCE, when the
     picker opens — reading the clock while rendering is impure and would also
     let "Tonight" quietly disappear out from under an open menu at 20:00. */
  const [schedWindow, setSchedWindow] = React.useState({ rows: [], min: '' })
  const [recording, setRecording] = React.useState(false)
  const [recSecs, setRecSecs] = React.useState(0)
  const [dragging, setDragging] = React.useState(false)
  // Send is async; without an in-flight flag the button swaps to the MIC as
  // soon as the draft clears, so a double-click's second hit started a
  // recording instead of being a harmless no-op.
  const [sending, setSending] = React.useState(false)
  /* Seconds left before slow mode lets the next message through. Armed
     locally after a successful send AND corrected by a 429 — the server is the
     authority on the window, and its `retryAfterSeconds` is what a second tab
     (or a clock that drifted) is reconciled against. */
  const [cooldown, setCooldown] = React.useState(0)
  const [silent, setSilent] = React.useState(false)

  const taRef = React.useRef(null)
  const fileRef = React.useRef(null)
  const imageRef = React.useRef(null)
  const emojiWrapRef = React.useRef(null)
  const emojiBtnRef = React.useRef(null)
  const schedBtnRef = React.useRef(null)
  const recRef = React.useRef({ recorder: null, chunks: [], stream: null, timer: null, cancelled: false })
  const secsRef = React.useRef(0)          // `onstop` fires from a stale closure — read the ref
  const previewsRef = React.useRef([])

  const text = draft

  /* ---------- autogrow ---------- */
  const resize = React.useCallback(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(160, ta.scrollHeight)}px`
  }, [])
  React.useEffect(() => { resize() }, [text, resize])

  /* ---------- focus + reset when the conversation or context changes ---------- */
  React.useEffect(() => {
    setFiles([])
    setEmojiOpen(false)
    setSchedOpen(false)
    setCustomWhen('')
    /* Switching conversations must ABORT any recording in progress. The
       Composer does not unmount between chats (same element, new props), so
       the unmount teardown never fires here — without this an in-flight voice
       note would be delivered into whichever chat you happened to land on.
       Guarded on the ref so the first mount is a no-op. */
    const r = recRef.current
    if (r.recorder) {
      r.cancelled = true
      try { r.recorder.stop() } catch { /* onstop still runs cleanup */ }
    }
  }, [conversationId])

  React.useEffect(() => {
    if (replyTo || editing) taRef.current?.focus()
  }, [replyTo, editing])

  /* ---------- object-url hygiene for attachment previews ---------- */
  const previewFor = React.useCallback((file) => {
    const url = URL.createObjectURL(file)
    previewsRef.current.push(url)
    return url
  }, [])
  const revokeAll = React.useCallback(() => {
    previewsRef.current.forEach(u => { try { URL.revokeObjectURL(u) } catch { /* noop */ } })
    previewsRef.current = []
  }, [])
  React.useEffect(() => () => revokeAll(), [revokeAll])

  /* ---------- emoji popover dismissal ---------- */
  /* Dismissal is Popover's — the picker portals to <body>, so a
     contains() test against this wrapper would read every emoji click as an
     outside click and close before the character was inserted. */

  /* ---------- attachments ---------- */
  const addFiles = React.useCallback((incoming) => {
    const list = Array.from(incoming || []).filter(Boolean)
    if (!list.length) return
    setFiles(prev => {
      const room = MAX_FILES - prev.length
      if (room <= 0) { showToast(`Up to ${MAX_FILES} attachments per message`); return prev }
      if (list.length > room) showToast(`Only ${room} more attachment${room === 1 ? '' : 's'} fit`)
      const added = list.slice(0, room).map(f => ({
        file: f,
        url: f.type.startsWith('image/') || f.type.startsWith('video/') ? previewFor(f) : null,
      }))
      return [...prev, ...added]
    })
  }, [previewFor])

  const removeFile = (idx) => setFiles(prev => prev.filter((_, i) => i !== idx))

  const onPaste = (e) => {
    const items = Array.from(e.clipboardData?.files || [])
    if (items.length) { e.preventDefault(); addFiles(items) }
  }

  /* ---------- live activity (typing / recording / sending) ----------
     `onTyping` is an inline arrow from ChatPage, so its identity changes on
     every parent render. Timers and MediaRecorder callbacks read it through
     this latest-ref — depending on it directly is the documented landmine
     that killed recordings whenever the thread re-rendered. */
  const onTypingRef = React.useRef(onTyping)
  React.useEffect(() => { onTypingRef.current = onTyping })

  const stopTyping = React.useCallback(() => onTypingRef.current?.(false), [])

  /* Broadcast `activity` for the whole duration of `run` (an upload, say),
     re-pinging under the server's typing TTL, then always send the stop. */
  const withActivity = React.useCallback(async (activity, run) => {
    onTypingRef.current?.(true, activity)
    const iv = setInterval(() => onTypingRef.current?.(true, activity), 2000)
    try { return await run() }
    finally { clearInterval(iv); onTypingRef.current?.(false) }
  }, [])

  const submit = React.useCallback(async () => {
    if (sending) return
    const body = text.trim()

    if (editing) {
      if (!body) return
      onCommitEdit?.(body)
      onDraftChange?.('')
      stopTyping()
      return
    }

    if (files.length) {
      const payload = files.map(f => f.file)
      setFiles([])
      revokeAll()
      onDraftChange?.('')
      setSending(true)
      // The receiver sees "sending a photo…" for as long as the upload runs.
      try { await withActivity(uploadActivityOf(payload), () => onSendFiles?.({ files: payload, body })) }
      finally { setSending(false) }
      return
    }

    if (!body) return
    onDraftChange?.('')
    stopTyping()
    setSending(true)
    try {
      await onSendText?.({ body, silent })
      // Per-post, not a mode: the next message gets a notification unless the
      // author asks for silence again.
      setSilent(false)
      if (slowModeSeconds > 0) setCooldown(slowModeSeconds)
    } catch (e) {
      /* Over quota. The server's own `Retry-After` beats the local guess —
         another device may have sent in this window, so our countdown was
         never running. http.js has already surfaced the toast. */
      if (e?.status === 429) setCooldown(e.retryAfterSeconds ?? slowModeSeconds ?? 5)
    } finally { setSending(false) }
  }, [sending, text, files, editing, onCommitEdit, onDraftChange, onSendFiles, onSendText,
      revokeAll, stopTyping, withActivity, slowModeSeconds, silent])

  /* One interval for the whole countdown, torn down when it reaches zero —
     not a fresh timeout per tick, which would drift. */
  React.useEffect(() => {
    if (cooldown <= 0) return undefined
    const t = setInterval(() => setCooldown(n => Math.max(0, n - 1)), 1000)
    return () => clearInterval(t)
  }, [cooldown > 0])   // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = (e) => {
    // `isComposing` (or keyCode 229) means an IME candidate window is open —
    // Enter is COMMITTING the composition, not sending. Without this guard,
    // Arabic/Kurdish/CJK input sends a half-typed word.
    if (e.nativeEvent?.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && !e.shiftKey && isFinePointer()) {
      e.preventDefault()
      submit()
      return
    }
    if (e.key === 'Escape') {
      if (editing) onCancelEdit?.()
      else if (replyTo) onCancelReply?.()
    }
  }

  const onChange = (e) => {
    const v = e.target.value.slice(0, MAX_BODY)
    onDraftChange?.(v)
    if (v.trim()) onTyping?.(true, ACTIVITY.TYPING)
  }

  /* ---------- voice notes ---------- */
  const cleanupRecorder = React.useCallback(() => {
    const r = recRef.current
    clearInterval(r.timer)
    r.timer = null
    r.stream?.getTracks?.().forEach(t => { try { t.stop() } catch { /* noop */ } })
    r.stream = null
    r.recorder = null
    r.chunks = []
    secsRef.current = 0
    setRecording(false)
    setRecSecs(0)
  }, [])

  /* Teardown must run ONLY on unmount. An earlier version listed
     [cleanupRecorder, stopTyping] as deps — but `stopTyping` closes over
     `onTyping`, which the parent passes as an inline arrow, so its identity
     changed on every ChatPage render (a typing tick, a presence tick, any
     incoming message). React then ran this effect's CLEANUP between renders,
     which cancelled and stopped the MediaRecorder: recording a voice note was
     killed by unrelated activity in the thread. The teardown reads its
     collaborators through a ref so the dep array can stay genuinely empty. */
  const teardownRef = React.useRef(null)
  React.useEffect(() => {
    // latest-ref: refreshed after every render, never read during one
    teardownRef.current = () => {
      recRef.current.cancelled = true
      try { recRef.current.recorder?.stop() } catch { /* noop */ }
      cleanupRecorder()
      stopTyping()
    }
  })
  React.useEffect(() => () => { teardownRef.current?.() }, [])

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      showToast('Voice messages are not supported on this device')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
        .find(t => MediaRecorder.isTypeSupported?.(t)) || ''
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      const r = recRef.current
      r.recorder = recorder
      r.stream = stream
      r.chunks = []
      r.cancelled = false

      recorder.ondataavailable = (e) => { if (e.data?.size) r.chunks.push(e.data) }
      recorder.onstop = async () => {
        const cancelled = r.cancelled
        const blob = new Blob(r.chunks, { type: recorder.mimeType || 'audio/webm' })
        const secs = secsRef.current            // state here is the start-of-recording snapshot
        cleanupRecorder()
        stopTyping()                            // retire "recording…" on every exit, cancel included
        if (cancelled || blob.size < 900) return
        const ext = (recorder.mimeType || '').includes('mp4') ? 'm4a'
          : (recorder.mimeType || '').includes('ogg') ? 'ogg' : 'webm'
        const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: blob.type })
        await withActivity(ACTIVITY.SENDING_VOICE,
          () => onSendFiles?.({ files: [file], body: '', durationMs: secs * 1000 }))
      }

      recorder.start()
      setRecording(true)
      setRecSecs(0)
      secsRef.current = 0
      onTypingRef.current?.(true, ACTIVITY.RECORDING_VOICE)   // the mic is live NOW
      r.timer = setInterval(() => {
        secsRef.current += 1
        setRecSecs(secsRef.current)
        // keep the receiver's "recording a voice message…" alive; the context
        // throttles this to one POST per ~3s
        onTypingRef.current?.(true, ACTIVITY.RECORDING_VOICE)
        // hard stop at 5 minutes so a forgotten recording can't grow unbounded
        if (secsRef.current >= 300) { try { recorder.stop() } catch { /* noop */ } }
      }, 1000)
    } catch {
      showToast('Microphone permission is required for voice messages')
      cleanupRecorder()
    }
  }

  const stopRecording = (cancel) => {
    const r = recRef.current
    r.cancelled = !!cancel
    try { r.recorder?.stop() } catch { cleanupRecorder(); stopTyping() }
  }

  /* ---------- locked (restricted / left / read-only) ---------- */
  if (disabled) {
    return (
      <div className="ch-locked">
        <Icon name="lock"/>
        <span>{lockedReason || 'You can’t send messages in this conversation.'}</span>
      </div>
    )
  }

  const canSend = (!!text.trim() || files.length > 0) && cooldown === 0
  const contextMsg = editing || replyTo

  return (
    <div
      className={'ch-composer' + (dragging ? ' dropping' : '')}
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false) }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        addFiles(e.dataTransfer?.files)
      }}
    >
      {/* Disappearing messages are enforced at WRITE time, so the warning
          belongs on the composer, not the thread: everything typed from here
          expires, while the history above it does not. */}
      {disappearingSeconds > 0 && (
        <div className="ch-ttlnote">
          <Icon name="hourglass" className="sm"/>
          <span>New messages disappear after <b>{ttlLabel(disappearingSeconds)}</b></span>
        </div>
      )}

      {/* Slow mode. Shown ONLY while the clock is running: a standing "slow
          mode is on" banner over an empty composer is nagging, whereas a
          countdown answers the only question the writer actually has. */}
      {cooldown > 0 && (
        <div className="ch-ttlnote ch-slownote" role="status">
          <Icon name="hourglass" className="sm"/>
          <span>Slow mode — you can send again in <b>{cooldown}s</b></span>
        </div>
      )}

      {contextMsg && (
        <div className={'ch-ctx' + (editing ? ' editing' : '')}>
          <Icon name={editing ? 'edit' : 'reply'} className="sm"/>
          <div className="ch-ctx-body">
            <div className="ch-ctx-label">
              {editing ? 'Editing message' : `Replying to ${replyTo.sender?.full || replyTo.sender?.handle || 'message'}`}
            </div>
            <div className="ch-ctx-text" dir="auto">
              {contextMsg.body
                || (contextMsg.media?.[0]
                  ? { IMAGE: 'Photo', VIDEO: 'Video', VOICE: 'Voice message', FILE: 'File' }[contextMsg.media[0].kind] || 'Attachment'
                  : 'Message')}
            </div>
          </div>
          <button
            type="button"
            className="ch-ctx-x"
            onClick={() => (editing ? onCancelEdit?.() : onCancelReply?.())}
            aria-label={editing ? 'Cancel editing' : 'Cancel reply'}
          >
            <Icon name="close" className="sm"/>
          </button>
        </div>
      )}

      {!!files.length && (
        <div className="ch-tray">
          {files.map((f, i) => (
            <div className="ch-tray-item" key={`${f.file.name}-${i}`}>
              {f.url && f.file.type.startsWith('image/') && <img src={f.url} alt=""/>}
              {f.url && f.file.type.startsWith('video/') && <video src={f.url} muted/>}
              {!f.url && <Icon name={f.file.type.startsWith('audio/') ? 'mic' : 'doc'}/>}
              {!f.file.type.startsWith('image/') && (
                <span className="ch-tray-name">{f.file.name}</span>
              )}
              <button
                type="button"
                className="ch-tray-x"
                onClick={() => removeFile(i)}
                aria-label={`Remove ${f.file.name}`}
              >
                <Icon name="close"/>
              </button>
            </div>
          ))}
        </div>
      )}

      {recording ? (
        <div className="ch-inputrow">
          <div className="ch-rec">
            <span className="ch-rec-dot" aria-hidden="true"/>
            <span className="ch-rec-time">{mmss(recSecs)}</span>
            <span className="ch-rec-hint">Recording voice message…</span>
            <button type="button" className="ch-rec-x" onClick={() => stopRecording(true)}>Cancel</button>
          </div>
          <button
            type="button"
            className="ch-send"
            onClick={() => stopRecording(false)}
            aria-label="Send voice message"
            title="Send"
          >
            <Icon name="send"/>
          </button>
        </div>
      ) : (
        <div className="ch-inputrow">
          <div className="ch-emoji-wrap" ref={emojiWrapRef}>
            <button
              type="button"
              ref={emojiBtnRef}
              className={'ch-cbtn' + (emojiOpen ? ' on' : '')}
              onClick={() => setEmojiOpen(v => !v)}
              aria-label="Insert emoji"
              aria-expanded={emojiOpen}
              title="Emoji"
            >
              <Icon name="smile"/>
            </button>
            <Popover
              anchorRef={emojiBtnRef}
              open={emojiOpen}
              onClose={() => setEmojiOpen(false)}
              className="ch-emoji"
              role="dialog"
              ariaLabel="Emoji picker"
              align="start"
              prefer="top"
            >
              <div className="ch-emoji-label">Frequently used</div>
              <div className="ch-emoji-grid">
                  {EMOJI.map(e => (
                    <button
                      key={e}
                      type="button"
                      className="ch-emoji-b"
                      onClick={() => {
                        onDraftChange?.((text + e).slice(0, MAX_BODY))
                        taRef.current?.focus()
                      }}
                      aria-label={`Insert ${e}`}
                    >
                      {e}
                    </button>
                ))}
              </div>
            </Popover>
          </div>

          <button
            type="button"
            className="ch-cbtn"
            onClick={() => imageRef.current?.click()}
            aria-label="Attach photo or video"
            title="Photo or video"
          >
            <Icon name="image"/>
          </button>
          <button
            type="button"
            className="ch-cbtn"
            onClick={() => fileRef.current?.click()}
            aria-label="Attach a file"
            title="File"
          >
            <Icon name="paperclip"/>
          </button>

          <input
            ref={imageRef}
            type="file"
            accept="image/*,video/*"
            multiple
            hidden
            onChange={(e) => { addFiles(e.target.files); e.target.value = '' }}
          />
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => { addFiles(e.target.files); e.target.value = '' }}
          />

          <div className="ch-inputwrap">
            <textarea
              ref={taRef}
              className="ch-input"
              rows={1}
              value={text}
              placeholder={editing ? 'Edit your message…' : placeholder}
              onChange={onChange}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onBlur={stopTyping}
              dir="auto"
              aria-label="Message"
            />
          </div>

          {/* Silent posting — delivers normally, sends no push. Offered only
              where it means something: a channel post reaches every
              subscriber's lock screen, which is exactly the cost a correction
              or a footnote should not pay. It is a per-post choice, so it
              RESETS after each send rather than latching. */}
          {!editing && allowSilent && (
            <button
              type="button"
              className={'ch-cbtn' + (silent ? ' on' : '')}
              onClick={() => setSilent(v => !v)}
              aria-pressed={silent}
              aria-label={silent ? 'Silent post — no notification' : 'Post silently'}
              title={silent ? 'Silent — subscribers get no push' : 'Send without a notification'}
            >
              <Icon name={silent ? 'mute' : 'volume'}/>
            </button>
          )}

          {/* The types a textarea cannot express — poll, location, contact.
              Hidden while editing: an edit changes a message's BODY, and none
              of these are a body. */}
          {!editing && !!onExtras && (
            <button type="button" className="ch-cbtn" onClick={onExtras}
              aria-label="Send a poll, location or contact" title="Poll · location · contact">
              <Icon name="qna"/>
            </button>
          )}

          {/* Send-later. Offered only for plain text: the schedule endpoint
              takes pre-uploaded storage keys, and chat has no separate upload
              step, so a queued message can never carry a picked file. */}
          {!editing && !!onSchedule && (
            <>
              <button
                type="button"
                ref={schedBtnRef}
                className={'ch-cbtn ch-sched-btn' + (schedOpen ? ' on' : '')}
                onClick={() => {
                  if (!schedOpen) {
                    setSchedWindow({
                      rows: schedulePresets(),
                      min: localStamp(new Date(Date.now() + 60000)).slice(0, 16),
                    })
                  }
                  setSchedOpen(v => !v)
                }}
                aria-label={scheduledCount > 0 ? `Schedule — ${scheduledCount} queued` : 'Schedule this message'}
                aria-expanded={schedOpen}
                title="Send later"
              >
                <Icon name="clock"/>
                {scheduledCount > 0 && <span className="ch-sched-n" aria-hidden="true">{scheduledCount}</span>}
              </button>
              <Popover
                anchorRef={schedBtnRef}
                open={schedOpen}
                onClose={() => setSchedOpen(false)}
                className="ch-schedpop"
                role="dialog"
                ariaLabel="Send later"
                align="end"
                prefer="top"
              >
                <div className="ch-schedpop-head">
                  <Icon name="clock" className="sm"/>
                  <span>Send later</span>
                  {scheduledCount > 0 && !!onOpenScheduled && (
                    <button type="button" className="ch-schedpop-queue"
                      onClick={() => { setSchedOpen(false); onOpenScheduled() }}
                      title="Open the scheduled queue">
                      {scheduledCount} queued
                    </button>
                  )}
                </div>
                {!text.trim() && !files.length && (
                  <p className="ch-schedpop-hint">Write the message first, then pick a time.</p>
                )}
                <div className="ch-schedpop-list">
                  {schedWindow.rows.map(p => (
                    <button
                      key={p.key}
                      type="button"
                      className="ch-schedpop-row"
                      disabled={!text.trim()}
                      onClick={() => {
                        setSchedOpen(false)
                        onSchedule?.({ body: text, scheduledAt: localStamp(p.at) })
                      }}
                    >
                      <Icon name="clock" className="xs"/>
                      <span className="ch-schedpop-lbl">{p.label}</span>
                      <span className="ch-schedpop-at">{presetTime(p.at)}</span>
                    </button>
                  ))}
                </div>
                <div className="ch-schedpop-sep" aria-hidden="true"><span>or pick a time</span></div>
                <div className="ch-schedpop-custom">
                  <input
                    type="datetime-local"
                    className="field"
                    aria-label="Pick a date and time"
                    value={customWhen}
                    min={schedWindow.min}
                    onChange={(e) => setCustomWhen(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-primary ch-schedpop-go"
                    disabled={!customWhen || !text.trim()}
                    onClick={() => {
                      setSchedOpen(false)
                      // <input type="datetime-local"> gives "yyyy-MM-ddTHH:mm";
                      // the API wants seconds, and it must stay zone-less.
                      onSchedule?.({ body: text, scheduledAt: `${customWhen}:00`.slice(0, 19) })
                      setCustomWhen('')
                    }}
                  >
                    <Icon name="send" className="xs"/>Schedule
                  </button>
                </div>
              </Popover>
            </>
          )}

          {canSend || editing || sending ? (
            <button
              type="button"
              className="ch-send"
              onClick={submit}
              disabled={!canSend || sending}
              aria-label={editing ? 'Save changes' : 'Send message'}
              title={editing ? 'Save' : 'Send'}
            >
              <Icon name={editing ? 'check' : 'send'}/>
            </button>
          ) : (
            <button
              type="button"
              className="ch-send"
              onClick={startRecording}
              aria-label="Record a voice message"
              title="Voice message"
            >
              <Icon name="mic"/>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default Composer
