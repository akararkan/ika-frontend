/* =========================================================
   Channel stories — the rail, the viewer, the composer
   ---------------------------------------------------------
   A channel story is an ORDINARY story whose author is the
   CHANNEL: `authorId` is the channel id and `visibility` is
   "CHANNEL". That is not a detail — it is why the TTL, the view
   log, the A/B poll and the tray SSE all work here without a
   second implementation. Only the create/list/delete calls are
   channel-scoped (they carry the `canManageStories` gate); every
   *read* of a story reuses `/stories/{id}/…`.

   Three things this surface has to get right:

     · TTL is chosen at post time (8 / 16 / 24h) and is the ONLY
       lifetime control — there is no extend. The composer says
       so, and the rail shows the remaining time, because a story
       the admin thinks is still up is worse than no story.
     · The viewer log is admin-only. A plain subscriber asking
       for it gets a 403, so the button is not rendered for them
       rather than rendered and then apologising.
     · Views are recorded once per (story, viewer) server-side,
       so `recordView` is fire-and-forget and its failure is
       deliberately silent — a lost view marker must never
       interrupt watching.
   ========================================================= */
import React from 'react'
import { Icon, Avatar, showToast } from '../ui.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { api } from '../../api/index.js'
import { chatError } from '../chat/chatErrors.js'
import { crestOf, untilLabel, nfmt } from './channelArt.js'

const LIFETIMES = [
  [8,  '8 hours'],
  [16, '16 hours'],
  [24, '24 hours'],
]

/* ---------------------------------------------------------
   The rail — one ring per live story, plus the admin's "add".
   --------------------------------------------------------- */
export function ChannelStoryRail({ channel, canManage }) {
  const [rows, setRows] = React.useState([])
  const [state, setState] = React.useState('loading')   // loading | ready | empty
  const [viewing, setViewing] = React.useState(-1)
  const [composing, setComposing] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      const res = await api.channels.stories.list(channel.id)
      setRows(res)
      setState(res.length ? 'ready' : 'empty')
    } catch {
      // Audience-gated server-side: a 403 for a non-subscriber is the answer,
      // not a failure, and it renders as "no stories" rather than an error.
      setRows([]); setState('empty')
    }
  }, [channel.id])

  React.useEffect(() => { load() }, [load])

  /* A story that expires while the page is open should leave the rail on its
     own — the TTL is server-side and there is no event for it, so the rail
     re-checks on the minute rather than showing a ring that 404s when tapped. */
  React.useEffect(() => {
    if (!rows.length) return undefined
    const t = setInterval(() => {
      setRows(prev => prev.filter(s => !s.expiresAt || new Date(s.expiresAt).getTime() > Date.now()))
    }, 60000)
    return () => clearInterval(t)
  }, [rows.length])

  if (state === 'loading') return null
  if (state === 'empty' && !canManage) return null

  return (
    <section className="cs-rail-wrap">
      <div className="cp-section-head">
        <h2 className="cp-h2">Stories</h2>
        {!!rows.length && <span className="cp-count">{rows.length}</span>}
      </div>

      <div className="cs-rail">
        {canManage && (
          <button className="cs-add" onClick={() => setComposing(true)}>
            <span className="cs-add-mark"><Icon name="compose"/></span>
            <span className="cs-add-label">Add story</span>
          </button>
        )}

        {rows.map((s, i) => (
          <button key={s.storyId} className="cs-ring" onClick={() => setViewing(i)}>
            {/* The halo is a separate element, not a box-shadow: a conic
                gradient ring needs its own painted circle, and the gap between
                ring and art comes from the art's own border — the exact
                anatomy of every story ring on the platform. */}
            <span className="cs-halo" aria-hidden="true">
              <span className="cs-ring-art">
                {s.thumbnailUrl || s.mediaUrl
                  ? <img src={s.thumbnailUrl || s.mediaUrl} alt="" loading="lazy"/>
                  : <span className="cs-ring-text" dir="auto">{s.textContent.slice(0, 40)}</span>}
              </span>
            </span>
            <span className="cs-ring-meta">{untilLabel(s.expiresAt) || 'live'}</span>
          </button>
        ))}

        {state === 'empty' && canManage && (
          <p className="cs-rail-empty">
            Nothing live. A story posted here appears in every subscriber’s tray
            and disappears on its own.
          </p>
        )}
      </div>

      {viewing >= 0 && rows[viewing] && (
        <ChannelStoryViewer
          channel={channel}
          stories={rows}
          index={viewing}
          canManage={canManage}
          onIndex={setViewing}
          onClose={() => setViewing(-1)}
          onDeleted={(storyId) => {
            setRows(prev => prev.filter(s => s.storyId !== storyId))
            setViewing(-1)
          }}
        />
      )}

      {composing && (
        <ChannelStoryComposer
          channel={channel}
          onClose={() => setComposing(false)}
          onPosted={(s) => { setComposing(false); setRows(prev => [s, ...prev]); setState('ready') }}
        />
      )}
    </section>
  )
}

/* ---------------------------------------------------------
   The viewer — media, the A/B poll, the admin's viewer log.
   --------------------------------------------------------- */
function ChannelStoryViewer({ channel, stories, index, canManage, onIndex, onClose, onDeleted }) {
  const story = stories[index]
  const [poll, setPoll] = React.useState(null)
  const [tally, setTally] = React.useState({ voteA: 0, voteB: 0, choice: null })
  const [viewers, setViewers] = React.useState(null)     // null = sheet closed
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.()
      if (e.key === 'ArrowRight' && index < stories.length - 1) onIndex(index + 1)
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onIndex, index, stories.length])

  /* Record the view, then read the poll if there is one. The view marker is
     deliberately unguarded: it is deduped server-side and a failure here must
     never stop the story rendering. */
  React.useEffect(() => {
    let alive = true
    setPoll(null)
    api.channels.stories.recordView(story.storyId).catch(() => {})
    ;(async () => {
      try {
        const p = await api.stories.getPoll(story.storyId)
        if (!p?.pollId || !alive) return
        const [res, mine] = await Promise.all([
          api.channels.stories.results(p.pollId).catch(() => null),
          api.channels.stories.myVote(p.pollId).catch(() => null),
        ])
        if (!alive) return
        setPoll(p)
        setTally({ voteA: res?.voteA ?? 0, voteB: res?.voteB ?? 0, choice: mine?.choice ?? null })
      } catch { /* no poll on this story */ }
    })()
    return () => { alive = false }
  }, [story.storyId])

  const vote = async (choice) => {
    if (!poll || busy) return
    setBusy(true)
    const before = tally
    // Optimistic, and it MOVES the vote rather than adding one: a changed vote
    // decrements the old side, which a naive +1 would leave double-counted.
    setTally(t => ({
      choice,
      voteA: t.voteA + (choice === 'A' ? 1 : 0) - (t.choice === 'A' ? 1 : 0),
      voteB: t.voteB + (choice === 'B' ? 1 : 0) - (t.choice === 'B' ? 1 : 0),
    }))
    try {
      const r = await api.channels.stories.vote(poll.pollId, choice)
      setTally({ choice: r?.choice ?? choice, voteA: r?.voteA ?? 0, voteB: r?.voteB ?? 0 })
    } catch (e) {
      setTally(before)
      showToast(chatError(e, 'Could not record your vote'))
    } finally { setBusy(false) }
  }

  const remove = async () => {
    const ok = await uiConfirm({
      title: 'Delete this story?',
      message: 'It disappears for every subscriber, along with any poll attached to it. This cannot be undone.',
      confirmLabel: 'Delete', danger: true, icon: 'trash',
    })
    if (!ok) return
    try {
      await api.channels.stories.remove(channel.id, story.storyId)
      showToast('Story deleted')
      onDeleted?.(story.storyId)
    } catch (e) { showToast(chatError(e, 'Could not delete the story')) }
  }

  const total = tally.voteA + tally.voteB
  const pct = (n) => (total > 0 ? Math.round((n / total) * 100) : 0)

  return (
    <div className="cs-viewer" role="dialog" aria-modal="true" aria-label={`${channel.title} story`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="cs-stage">
        {/* progress pips — which of the channel's live stories this is */}
        <div className="cs-pips" aria-hidden="true">
          {stories.map((s, i) => <span key={s.storyId} className={'cs-pip' + (i === index ? ' on' : i < index ? ' done' : '')}/>)}
        </div>

        <header className="cs-vhead">
          <span className="cs-vwho">
            {channel.avatarUrl
              ? <Avatar size={30} src={channel.avatarUrl} initials={crestOf(channel)}/>
              : <span className="cs-vcrest">{crestOf(channel)}</span>}
            <span className="cs-vtitle" dir="auto">{channel.title}</span>
            <span className="cs-vtime">{untilLabel(story.expiresAt)}</span>
          </span>
          <span className="cs-vacts">
            {canManage && (
              <>
                <button className="icon-btn" title="Who watched" aria-label="Who watched"
                  onClick={async () => {
                    try { setViewers(await api.channels.stories.viewers(story.storyId)) }
                    catch (e) { showToast(chatError(e, 'Could not load the viewers')) }
                  }}>
                  <Icon name="eye" className="sm"/>
                </button>
                <button className="icon-btn" title="Delete" aria-label="Delete story" onClick={remove}>
                  <Icon name="trash" className="sm"/>
                </button>
              </>
            )}
            <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close">
              <Icon name="close" className="sm"/>
            </button>
          </span>
        </header>

        <div className="cs-body">
          {story.storyType === 'VIDEO' && story.mediaUrl
            ? <video className="cs-media" src={story.mediaUrl} poster={story.thumbnailUrl || undefined} controls autoPlay playsInline/>
            : story.mediaUrl
              ? <img className="cs-media" src={story.mediaUrl} alt={story.textContent || 'Story'}/>
              : <div className="cs-textonly" dir="auto">{story.textContent}</div>}

          {story.mediaUrl && story.textContent && (
            <div className="cs-caption" dir="auto">{story.textContent}</div>
          )}

          {poll && (
            <div className="cs-poll">
              <div className="cs-poll-q" dir="auto">{poll.question}</div>
              <div className="cs-poll-opts">
                {[['A', poll.optionA, tally.voteA], ['B', poll.optionB, tally.voteB]].map(([k, label, n]) => (
                  <button key={k} className={'cs-poll-opt' + (tally.choice === k ? ' mine' : '')}
                    disabled={busy} onClick={() => vote(k)} style={{ '--pct': `${pct(n)}%` }}>
                    <span className="cs-poll-fill" aria-hidden="true"/>
                    <span className="cs-poll-label" dir="auto">{label}</span>
                    {/* The tally is only shown once the viewer has voted —
                        seeing the split first is what biases an A/B poll. */}
                    {tally.choice && <span className="cs-poll-pct">{pct(n)}%</span>}
                  </button>
                ))}
              </div>
              {tally.choice
                ? <div className="cs-poll-total">{nfmt(total)} {total === 1 ? 'vote' : 'votes'}</div>
                : <div className="cs-poll-total">Pick one to see the result</div>}
            </div>
          )}
        </div>

        {index > 0 && (
          <button className="cs-nav prev" onClick={() => onIndex(index - 1)} aria-label="Previous story">
            <Icon name="chevleft"/>
          </button>
        )}
        {index < stories.length - 1 && (
          <button className="cs-nav next" onClick={() => onIndex(index + 1)} aria-label="Next story">
            <Icon name="chevright"/>
          </button>
        )}
      </div>

      {viewers && (
        <div className="cs-sheet" role="dialog" aria-label="Viewers">
          <div className="cs-sheet-head">
            <h3><Icon name="eye" className="sm"/>{viewers.length} {viewers.length === 1 ? 'viewer' : 'viewers'}</h3>
            <button className="icon-btn" onClick={() => setViewers(null)} aria-label="Close"><Icon name="close" className="sm"/></button>
          </div>
          <div className="cs-sheet-body">
            {viewers.length === 0
              ? <p className="cs-sheet-empty">Nobody has watched this yet.</p>
              : viewers.map(v => (
                  <div className="cs-viewer-row" key={`${v.viewerId}-${v.viewedAt}`}>
                    <Avatar size={30} initials="·"/>
                    <span className="cs-viewer-id">{v.viewerId}</span>
                    <span className="cs-viewer-t">{v.time}</span>
                  </div>
                ))}
          </div>
        </div>
      )}
    </div>
  )
}

/* ---------------------------------------------------------
   The composer — multipart when there is a file, JSON when the
   story is pure text. Both paths accept an optional A/B poll,
   which is a SECOND call: the poll attaches to a story that
   already exists, so a failure there leaves the story up rather
   than rolling anything back, and the toast says so.
   --------------------------------------------------------- */
function ChannelStoryComposer({ channel, onClose, onPosted }) {
  const [text, setText] = React.useState('')
  const [file, setFile] = React.useState(null)
  const [preview, setPreview] = React.useState(null)
  const [hours, setHours] = React.useState(24)
  const [withPoll, setWithPoll] = React.useState(false)
  const [poll, setPoll] = React.useState({ question: '', optionA: '', optionB: '' })
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  // Object URLs are a leak if the file changes or the modal closes without one
  // being revoked, and a stale preview is the visible symptom.
  React.useEffect(() => {
    if (!file) { setPreview(null); return undefined }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const pollReady = !withPoll || (poll.question.trim() && poll.optionA.trim() && poll.optionB.trim())
  const canPost = (!!file || !!text.trim()) && pollReady && !busy

  const submit = async () => {
    if (!canPost) return
    setBusy(true)
    try {
      const story = file
        ? await api.channels.stories.upload(channel.id, { media: file, textContent: text.trim() || undefined, lifetimeHours: hours })
        : await api.channels.stories.create(channel.id, { storyType: 'TEXT', textContent: text.trim(), lifetimeHours: hours })

      if (withPoll && story?.storyId) {
        try {
          await api.channels.stories.attachPoll(channel.id, story.storyId, {
            question: poll.question.trim(), optionA: poll.optionA.trim(), optionB: poll.optionB.trim(),
          })
        } catch {
          // The story is already live — say what actually happened rather than
          // implying the whole post failed.
          showToast('Story posted, but the poll could not be attached')
          onPosted?.(story)
          return
        }
      }
      showToast('Story posted')
      onPosted?.(story)
    } catch (e) {
      showToast(chatError(e, 'Could not post the story'))
    } finally { setBusy(false) }
  }

  return (
    <div className="ch-modal-overlay" role="dialog" aria-modal="true" aria-label="Post a channel story"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose?.() }}>
      <div className="ch-modal cn-modal">
        <div className="ch-modal-head">
          <h3><Icon name="camera" className="sm"/>Story as {channel.title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close" disabled={busy}>
            <Icon name="close" className="sm"/>
          </button>
        </div>

        <div className="ch-modal-body cn-modal-body single">
          <div className="cn-form">
            <label className="cn-field">
              <span>Media <small>optional</small></span>
              <input type="file" className="field" accept="image/*,video/*"
                onChange={e => setFile(e.target.files?.[0] || null)}/>
            </label>

            {preview && (
              <div className="cs-preview">
                {file?.type?.startsWith('video/')
                  ? <video src={preview} controls playsInline/>
                  : <img src={preview} alt=""/>}
                <button className="cn-btn" onClick={() => setFile(null)}>Remove</button>
              </div>
            )}

            <label className="cn-field">
              <span>{file ? 'Caption' : 'Text'}</span>
              <textarea className="field" rows={3} maxLength={2000} value={text} dir="auto"
                onChange={e => setText(e.target.value)}
                placeholder={file ? 'Say something about it…' : 'What is happening?'}/>
            </label>

            <div className="cn-field">
              <span>Disappears after</span>
              <div className="cs-ttl" role="group" aria-label="Story lifetime">
                {LIFETIMES.map(([h, label]) => (
                  <button key={h} type="button" className={'cn-chip' + (hours === h ? ' on' : '')}
                    aria-pressed={hours === h} onClick={() => setHours(h)}>{label}</button>
                ))}
              </div>
              <small className="cn-hint">
                This cannot be changed later — a story has one lifetime, set now.
              </small>
            </div>

            <div className="ci-row cn-visrow">
              <Icon name="qna"/>
              <div className="ci-row-body">
                <div className="ci-row-title">Ask a question</div>
                <div className="ci-row-sub">A two-option poll subscribers can tap. Results stay hidden until they vote.</div>
              </div>
              <button type="button" className={'ci-switch' + (withPoll ? ' on' : '')}
                role="switch" aria-checked={withPoll} aria-label="Attach a poll"
                onClick={() => setWithPoll(v => !v)}/>
            </div>

            {withPoll && (
              <div className="cs-pollform">
                <label className="cn-field">
                  <span>Question</span>
                  <input className="field" maxLength={300} value={poll.question} dir="auto"
                    onChange={e => setPoll(p => ({ ...p, question: e.target.value }))}
                    placeholder="Which should we cover next?"/>
                </label>
                <div className="cs-pollrow">
                  <label className="cn-field">
                    <span>Option A</span>
                    <input className="field" maxLength={100} value={poll.optionA} dir="auto"
                      onChange={e => setPoll(p => ({ ...p, optionA: e.target.value }))}/>
                  </label>
                  <label className="cn-field">
                    <span>Option B</span>
                    <input className="field" maxLength={100} value={poll.optionB} dir="auto"
                      onChange={e => setPoll(p => ({ ...p, optionB: e.target.value }))}/>
                  </label>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="ch-modal-foot">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" disabled={!canPost} onClick={submit}>
            {busy ? 'Posting…' : 'Post story'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------
   The subscriber-facing tray: every subscribed channel that has
   something live right now. Rendered on ChannelsPage above the
   grid — the same shape the user-story tray already has, so the
   two read as one system.
   --------------------------------------------------------- */
export function ChannelStoryTray({ onOpen }) {
  const [rows, setRows] = React.useState([])

  React.useEffect(() => {
    let alive = true
    api.channels.stories.tray()
      .then(r => { if (alive) setRows(r) })
      .catch(() => { if (alive) setRows([]) })
    return () => { alive = false }
  }, [])

  /* The tray SSE carries channel stories too (`visibility: "CHANNEL"`, with
     `authorId` = the channel id), so a story published while this page is open
     lights the ring without a refetch of the whole tray. */
  React.useEffect(() => api.stories.trayStream({
    onNewStory: (ev) => {
      if (String(ev?.visibility || '').toUpperCase() !== 'CHANNEL') return
      api.channels.stories.tray().then(setRows).catch(() => {})
    },
    onStoryRemoved: (ev) => {
      if (String(ev?.visibility || '').toUpperCase() !== 'CHANNEL') return
      setRows(prev => prev
        .map(c => ({ ...c, stories: c.stories.filter(s => s.storyId !== ev?.storyId) }))
        .filter(c => c.stories.length))
    },
  }), [])

  if (!rows.length) return null

  return (
    <section className="cn-section">
      <div className="cn-section-head">
        <h2 className="cn-section-t">Live stories</h2>
        <span className="cn-section-n">{rows.length}</span>
      </div>
      <div className="cs-tray">
        {rows.map(c => (
          <button key={c.channelId} className="cs-tray-item" onClick={() => onOpen?.(c)}>
            <span className="cs-halo" aria-hidden="true">
              <span className="cs-tray-ring">
                {c.avatarUrl
                  ? <img src={c.avatarUrl} alt="" loading="lazy"/>
                  : <span className="cs-tray-crest">{crestOf(c)}</span>}
              </span>
            </span>
            <span className="cs-tray-name" dir="auto">{c.title}</span>
            <span className="cs-tray-n">{c.stories.length}</span>
          </button>
        ))}
      </div>
    </section>
  )
}
