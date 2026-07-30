/* =========================================================
   Channel panels — post comments and hashtag lookup
   ---------------------------------------------------------
   Two sheets that only exist on a channel:

   COMMENTS. A comment is an ordinary message in the LINKED
   DISCUSSION GROUP that replies to the channel post — which is
   why editing, reacting, deleting and search all work on one
   without a second implementation. Two consequences the sheet
   has to carry honestly:
     · the returned message's `conversationId` is the GROUP's,
       not the channel's, so nothing here may be merged into the
       channel timeline;
     · commenting AUTO-JOINS the caller into the discussion
       group (join-source COMMENT). That is a membership change
       someone should be told about before it happens, not
       after, so the composer says so the first time.

   TAGS. `#hashtags` are extracted server-side from the body and
   re-extracted on every edit, and the lookup is an EXACT keyword
   match — `#ml` and `#machinelearning` are different tags. So
   this is a lookup, not a search, and the empty state says so
   rather than suggesting a spelling.
   ========================================================= */
import React from 'react'
import { Icon, Avatar, Verify, showToast } from '../ui.jsx'
import { Loader, ErrorState } from '../states.jsx'
import { api } from '../../api/index.js'
import { useChat } from '../../context/ChatContext.jsx'
import { chatError } from './chatErrors.js'

/* ---------------------------------------------------------
   Comments on one post.
   --------------------------------------------------------- */
export function CommentsPanel({ channelId, post, linkedGroupId, onClose, onCountChange, onOpenProfile }) {
  const { enrichAuthor, watchUsers } = useChat()
  const [rows, setRows] = React.useState([])
  const [state, setState] = React.useState('loading')
  const [text, setText] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const [joined, setJoined] = React.useState(false)

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const load = React.useCallback(async () => {
    setState('loading')
    try {
      const res = await api.channels.discussion.list(channelId, post.id, { limit: 50 })
      // Newest-first off the wire; read oldest-first like any other thread.
      setRows(res.slice().reverse())
      setState('ready')
      const ids = res.map(m => m.senderId).filter(Boolean)
      if (ids.length) watchUsers(ids)
    } catch (e) {
      setState(e?.status === 400 ? 'unlinked' : 'error')
    }
  }, [channelId, post.id, watchUsers])

  React.useEffect(() => { load() }, [load])

  const send = async () => {
    const body = text.trim()
    if (!body || sending) return
    setSending(true)
    try {
      const m = await api.channels.discussion.add(channelId, post.id, {
        clientNonce: api.chat.newNonce(), type: 'TEXT', body,
      })
      setRows(prev => [...prev, m])
      setText('')
      setJoined(true)
      // The post's counter moves with it; the `message.comment` frame will
      // confirm the same delta, and useThread's handler is idempotent enough
      // that the double-apply is what the actor-skip below prevents.
      onCountChange?.(post.id, +1)
    } catch (e) {
      showToast(chatError(e, 'Could not post the comment'))
    } finally { setSending(false) }
  }

  return (
    <aside className="ch-search cc-panel" role="dialog" aria-label={`Comments on this post`}>
      <header className="ch-search-head">
        <h3><Icon name="comment" className="sm"/>Comments</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close">
          <Icon name="close" className="sm"/>
        </button>
      </header>

      <div className="cc-post">
        <div className="cc-post-body" dir="auto">
          {post.body?.slice(0, 240) || 'This post'}
        </div>
      </div>

      <div className="cc-list">
        {state === 'loading' && <Loader label="Loading comments…"/>}
        {state === 'error' && <ErrorState message="The comments could not be loaded." onRetry={load}/>}
        {state === 'unlinked' && (
          <p className="cst-empty">
            This channel has no discussion group linked, so comments are off.
            An admin can link one from the channel’s management console.
          </p>
        )}

        {state === 'ready' && rows.length === 0 && (
          <p className="cst-empty">No comments yet. Be the first.</p>
        )}

        {state === 'ready' && rows.map(m => {
          const who = enrichAuthor(m.sender, m.senderId)
          return (
            <div className="cc-row" key={m.id}>
              <button className="ch-av-btn" onClick={() => onOpenProfile?.(m.senderId)}
                aria-label={`View ${who?.full || 'this person'}’s profile`}>
                <Avatar size={30} src={who?.profileImage} initials={who?.initials || '·'} color={who?.avc}/>
              </button>
              <div className="cc-row-body">
                {/* The author's SIGN, not just a name: clickable name with the
                    verified mark, the @handle in the archive's gold serif, and
                    the clock pushed to the ledger edge. `handleOf`'s 'member'
                    fallback means "no username on the wire" — not a handle,
                    so it is not signed as one. */}
                <div className="cc-row-who">
                  <button
                    type="button"
                    className="cc-row-name"
                    dir="auto"
                    onClick={() => onOpenProfile?.(m.senderId)}
                  >
                    {who?.full || 'Member'}
                    {who?.verified && <Verify scholar={who.role === 'SCHOLAR'}/>}
                  </button>
                  {who?.handle && who.handle !== 'member' && (
                    <span className="cc-row-handle">@{who.handle}</span>
                  )}
                  <span className="cc-row-t">{m.time}</span>
                </div>
                <div className="cc-row-txt" dir="auto">{m.body}</div>
              </div>
            </div>
          )
        })}
      </div>

      {state !== 'unlinked' && (
        <div className="cc-compose">
          {!joined && (
            <p className="cc-note">
              Commenting joins you to this channel’s discussion group.
            </p>
          )}
          <div className="cc-compose-row">
            <textarea
              className="field" rows={2} value={text} dir="auto" maxLength={8000}
              placeholder="Write a comment…"
              onChange={e => setText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault(); send()
                }
              }}
            />
            <button className="btn btn-primary" disabled={!text.trim() || sending} onClick={send}>
              {sending ? '…' : <Icon name="send" className="sm"/>}
            </button>
          </div>
        </div>
      )}

      {linkedGroupId && (
        <footer className="cc-foot">
          Comments live in the linked group — open it to see the whole discussion.
        </footer>
      )}
    </aside>
  )
}

/* ---------------------------------------------------------
   Every post carrying one tag.
   --------------------------------------------------------- */
export function TagPanel({ conversationId, tag, onClose, onJumpTo }) {
  const [rows, setRows] = React.useState([])
  const [state, setState] = React.useState('loading')

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  React.useEffect(() => {
    let alive = true
    setState('loading')
    api.chat.messages.byTag(conversationId, tag)
      .then(res => { if (alive) { setRows(res); setState('ready') } })
      .catch(() => { if (alive) setState('error') })
    return () => { alive = false }
  }, [conversationId, tag])

  return (
    <aside className="ch-search cc-panel" role="dialog" aria-label={`Posts tagged ${tag}`}>
      <header className="ch-search-head">
        <h3><Icon name="hash" className="sm"/>#{tag}</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close">
          <Icon name="close" className="sm"/>
        </button>
      </header>

      <div className="cc-list">
        {state === 'loading' && <Loader label="Looking up the tag…"/>}
        {state === 'error' && <ErrorState message="That lookup failed."/>}

        {state === 'ready' && rows.length === 0 && (
          <p className="cst-empty">
            Nothing carries <b>#{tag}</b> here. Tags match exactly — a post
            tagged <b>#{tag}s</b> is a different tag.
          </p>
        )}

        {state === 'ready' && rows.map(m => (
          <button className="cc-hit" key={m.id} onClick={() => onJumpTo?.(m.id)}>
            <span className="cc-hit-body" dir="auto">
              {m.body?.slice(0, 160) || `${m.type} post`}
            </span>
            <span className="cc-hit-meta">
              {m.time}
              {m.views != null && <><Icon name="eye" className="xs"/>{m.views}</>}
            </span>
          </button>
        ))}
      </div>
    </aside>
  )
}
