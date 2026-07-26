/* =========================================================
   Channel highlights — the permanent rail on the profile
   ---------------------------------------------------------
   Highlights are the answer to stories expiring: adding a story
   to one SNAPSHOTS it, so the archive keeps its own copy of the
   media and text and survives the source story's TTL. Two
   consequences drive this file:

     · You can only archive a story that is still LIVE. Once the
       TTL fires there is nothing left to snapshot and the call
       404s — so the "add" flow lists live stories rather than
       offering a free-text id, and says why the list can be
       empty.
     · A snapshot is INDEPENDENT of the story. Deleting the story
       later does not empty the highlight, and removing a
       snapshot does not touch the story. The copy says which one
       a destructive action hits.

   Reordering is exposed as explicit move-left / move-right
   buttons rather than drag. `PATCH …/highlights/order` takes the
   FULL left-to-right list, so the client always sends the whole
   sequence — a partial list would silently drop the omitted
   rail entries to the end.
   ========================================================= */
import React from 'react'
import { Icon, showToast } from '../ui.jsx'
import { uiConfirm, uiPrompt } from '../Dialog.jsx'
import { api } from '../../api/index.js'
import { chatError } from '../chat/chatErrors.js'
import { untilLabel } from './channelArt.js'

export function ChannelHighlightRail({ channel, canManage }) {
  const [rows, setRows] = React.useState([])
  const [state, setState] = React.useState('loading')
  const [open, setOpen] = React.useState(null)      // the highlight being viewed
  const [editing, setEditing] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      const res = await api.channels.highlights.list(channel.id)
      setRows(res); setState(res.length ? 'ready' : 'empty')
    } catch {
      // Audience-gated exactly like stories — a 403 reads as "nothing to show".
      setRows([]); setState('empty')
    }
  }, [channel.id])

  React.useEffect(() => { load() }, [load])

  const create = async () => {
    const title = (await uiPrompt({ title: 'New highlight', label: 'Name', initial: '' }))?.trim()
    if (!title) return
    setBusy(true)
    try {
      const h = await api.channels.highlights.create(channel.id, { title })
      setRows(prev => [...prev, h]); setState('ready')
      showToast('Highlight created')
    } catch (e) { showToast(chatError(e, 'Could not create the highlight')) }
    finally { setBusy(false) }
  }

  /* Move is optimistic AND authoritative: the server returns the rewritten
     rail, so the local swap is replaced by the server's answer rather than
     trusted — two admins reordering at once otherwise diverge silently. */
  const move = async (i, delta) => {
    const j = i + delta
    if (j < 0 || j >= rows.length || busy) return
    const next = rows.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    setRows(next)
    setBusy(true)
    try {
      const saved = await api.channels.highlights.reorder(channel.id, next.map(h => h.highlightId))
      if (saved?.length) setRows(saved)
    } catch (e) {
      setRows(rows)
      showToast(chatError(e, 'Could not save the new order'))
    } finally { setBusy(false) }
  }

  const remove = async (h) => {
    const ok = await uiConfirm({
      title: `Delete “${h.title}”?`,
      message: 'The highlight and its archived copies go away. The original stories are not affected.',
      confirmLabel: 'Delete', danger: true, icon: 'trash',
    })
    if (!ok) return
    try {
      await api.channels.highlights.remove(channel.id, h.highlightId)
      setRows(prev => {
        const next = prev.filter(x => x.highlightId !== h.highlightId)
        if (!next.length) setState('empty')
        return next
      })
      showToast('Highlight deleted')
    } catch (e) { showToast(chatError(e, 'Could not delete the highlight')) }
  }

  if (state === 'loading') return null
  if (state === 'empty' && !canManage) return null

  return (
    <section className="chl-wrap">
      <div className="cp-section-head">
        <h2 className="cp-h2">Highlights</h2>
        {canManage && (
          <div className="cp-head-acts">
            {rows.length > 1 && (
              <button className="cn-btn" aria-pressed={editing} onClick={() => setEditing(v => !v)}>
                {editing ? 'Done' : 'Reorder'}
              </button>
            )}
            <button className="cn-btn primary" disabled={busy} onClick={create}>
              <Icon name="compose" className="xs"/>New
            </button>
          </div>
        )}
      </div>

      {state === 'empty' ? (
        <p className="chl-empty">
          Nothing archived yet. A highlight keeps chosen stories on the profile
          permanently — snapshot them <b>before</b> they expire.
        </p>
      ) : (
        <div className="chl-rail">
          {rows.map((h, i) => (
            <div className="chl-item" key={h.highlightId}>
              <button className="chl-cover" onClick={() => setOpen(h)}>
                {h.coverUrl
                  ? <img src={h.coverUrl} alt="" loading="lazy"/>
                  : <Icon name="bookmark" className="chl-cover-mark"/>}
              </button>
              <span className="chl-title" dir="auto">{h.title}</span>

              {canManage && editing && (
                <div className="chl-move">
                  <button className="icon-btn" disabled={i === 0 || busy}
                    onClick={() => move(i, -1)} aria-label={`Move ${h.title} left`}>
                    <Icon name="chevleft" className="xs"/>
                  </button>
                  <button className="icon-btn" disabled={i === rows.length - 1 || busy}
                    onClick={() => move(i, 1)} aria-label={`Move ${h.title} right`}>
                    <Icon name="chevright" className="xs"/>
                  </button>
                  <button className="icon-btn danger" onClick={() => remove(h)} aria-label={`Delete ${h.title}`}>
                    <Icon name="trash" className="xs"/>
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {open && (
        <HighlightSheet
          channel={channel}
          highlight={open}
          canManage={canManage}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  )
}

/* ---------------------------------------------------------
   One highlight's snapshots, plus the admin's curation tools.
   --------------------------------------------------------- */
function HighlightSheet({ channel, highlight, canManage, onClose }) {
  const [rows, setRows] = React.useState([])
  const [state, setState] = React.useState('loading')
  const [live, setLive] = React.useState([])          // live stories available to archive
  const [adding, setAdding] = React.useState(false)
  const [i, setI] = React.useState(0)

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const load = React.useCallback(async () => {
    try {
      const res = await api.channels.highlights.stories(channel.id, highlight.highlightId)
      setRows(res); setState(res.length ? 'ready' : 'empty'); setI(0)
    } catch (e) {
      setState('error'); showToast(chatError(e, 'Could not open the highlight'))
    }
  }, [channel.id, highlight.highlightId])

  React.useEffect(() => { load() }, [load])

  const openAdd = async () => {
    setAdding(true)
    try { setLive(await api.channels.stories.list(channel.id)) }
    catch { setLive([]) }
  }

  const archive = async (story) => {
    try {
      const snap = await api.channels.highlights.addStory(channel.id, highlight.highlightId, story.storyId)
      setRows(prev => [...prev, snap]); setState('ready'); setAdding(false)
      showToast('Archived to the highlight')
    } catch (e) {
      // The most likely 404 here is a story that expired between listing and
      // tapping — say that, rather than a generic failure.
      showToast(e?.status === 404
        ? 'That story has already expired — it can no longer be archived'
        : chatError(e, 'Could not archive the story'))
    }
  }

  const drop = async (snap) => {
    const ok = await uiConfirm({
      title: 'Remove from this highlight?',
      message: 'Only the archived copy is removed. The original story is untouched.',
      confirmLabel: 'Remove', danger: true, icon: 'trash',
    })
    if (!ok) return
    try {
      await api.channels.highlights.removeStory(channel.id, highlight.highlightId, snap.storyId)
      setRows(prev => {
        const next = prev.filter(x => x.storyId !== snap.storyId)
        if (!next.length) setState('empty')
        setI(n => Math.max(0, Math.min(n, next.length - 1)))
        return next
      })
    } catch (e) { showToast(chatError(e, 'Could not remove it')) }
  }

  const cur = rows[i] || null

  return (
    <div className="cs-viewer" role="dialog" aria-modal="true" aria-label={highlight.title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="cs-stage">
        <header className="cs-vhead">
          <span className="cs-vwho">
            <Icon name="bookmark" className="sm"/>
            <span className="cs-vtitle" dir="auto">{highlight.title}</span>
            {!!rows.length && <span className="cs-vtime">{i + 1} / {rows.length}</span>}
          </span>
          <span className="cs-vacts">
            {canManage && (
              <button className="icon-btn" title="Archive a live story" aria-label="Archive a live story" onClick={openAdd}>
                <Icon name="compose" className="sm"/>
              </button>
            )}
            {canManage && cur && (
              <button className="icon-btn" title="Remove this one" aria-label="Remove from highlight" onClick={() => drop(cur)}>
                <Icon name="trash" className="sm"/>
              </button>
            )}
            <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close">
              <Icon name="close" className="sm"/>
            </button>
          </span>
        </header>

        <div className="cs-body">
          {state === 'loading' && <div className="cs-textonly">Loading…</div>}

          {state === 'empty' && (
            <div className="cs-textonly">
              This highlight is empty.
              {canManage && ' Archive a live story into it to get started.'}
            </div>
          )}

          {cur && (
            cur.storyType === 'VIDEO' && cur.mediaUrl
              ? <video className="cs-media" src={cur.mediaUrl} poster={cur.thumbnailUrl || undefined} controls playsInline/>
              : cur.mediaUrl
                ? <img className="cs-media" src={cur.mediaUrl} alt={cur.textContent || 'Archived story'}/>
                : <div className="cs-textonly" dir="auto">{cur.textContent}</div>
          )}

          {cur?.mediaUrl && cur.textContent && (
            <div className="cs-caption" dir="auto">{cur.textContent}</div>
          )}
        </div>

        {i > 0 && (
          <button className="cs-nav prev" onClick={() => setI(i - 1)} aria-label="Previous">
            <Icon name="chevleft"/>
          </button>
        )}
        {i < rows.length - 1 && (
          <button className="cs-nav next" onClick={() => setI(i + 1)} aria-label="Next">
            <Icon name="chevright"/>
          </button>
        )}
      </div>

      {adding && (
        <div className="cs-sheet" role="dialog" aria-label="Archive a story">
          <div className="cs-sheet-head">
            <h3><Icon name="bookmark" className="sm"/>Archive a live story</h3>
            <button className="icon-btn" onClick={() => setAdding(false)} aria-label="Close">
              <Icon name="close" className="sm"/>
            </button>
          </div>
          <div className="cs-sheet-body">
            {live.length === 0 ? (
              <p className="cs-sheet-empty">
                No live stories. Only a story that has not yet expired can be
                archived — post one first, then come back here.
              </p>
            ) : live.map(s => (
              <button key={s.storyId} className="chl-pick" onClick={() => archive(s)}>
                <span className="chl-pick-art">
                  {s.thumbnailUrl || s.mediaUrl
                    ? <img src={s.thumbnailUrl || s.mediaUrl} alt="" loading="lazy"/>
                    : <Icon name="doc" className="sm"/>}
                </span>
                <span className="chl-pick-body">
                  <span className="chl-pick-t" dir="auto">{s.textContent || s.storyType}</span>
                  <span className="chl-pick-s">expires {untilLabel(s.expiresAt)}</span>
                </span>
                <Icon name="chevright" className="xs"/>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default ChannelHighlightRail
