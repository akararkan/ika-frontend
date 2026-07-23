/* =========================================================
   SeenBySheet — the group "Seen by" list for one message.
   ---------------------------------------------------------
   Privacy is SYMMETRIC and the empty state carries most of the
   meaning here, so it is spelled out rather than shrugged at:
   the endpoint returns an EMPTY list if *you* turned read
   receipts off, and it silently omits any reader who turned
   *theirs* off. The sender is always excluded. So "nobody yet"
   and "you gave up the right to know" are the same wire answer —
   the copy has to disambiguate them, which it can, because the
   client knows its own setting.
   ========================================================= */
import React from 'react'
import { Icon, Avatar, Verify } from '../ui.jsx'
import { Loader } from '../states.jsx'
import { useChat } from '../../context/ChatContext.jsx'
import { api } from '../../api/index.js'

export function SeenBySheet({ msg, onClose, onOpenProfile }) {
  const { enrichAuthor, watchUsers, chatSettings } = useChat()
  const [rows, setRows] = React.useState(null)         // null = still loading
  const [error, setError] = React.useState(false)
  const boxRef = React.useRef(null)

  const receiptsOff = chatSettings?.readReceiptsEnabled === false

  React.useEffect(() => {
    if (!msg?.id) return undefined
    let alive = true
    api.chat.messages.seenBy(msg.id)
      .then(r => { if (alive) setRows(r) })
      .catch(() => { if (alive) { setRows([]); setError(true) } })
    return () => { alive = false }
  }, [msg?.id])

  React.useEffect(() => {
    const ids = (rows || []).map(r => r.userId).filter(Boolean)
    if (ids.length) watchUsers(ids)
  }, [rows, watchUsers])

  React.useEffect(() => {
    const opener = document.activeElement
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    boxRef.current?.querySelector('button')?.focus()
    return () => {
      window.removeEventListener('keydown', onKey)
      if (opener instanceof HTMLElement) opener.focus()
    }
  }, [onClose])

  return (
    <div className="ch-fwd-overlay" role="dialog" aria-modal="true" aria-label="Seen by"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="ch-fwd ch-seen" ref={boxRef}>
        <div className="ch-fwd-head">
          <h3><Icon name="checks" className="sm"/>Seen by</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close">
            <Icon name="close" className="sm"/>
          </button>
        </div>

        {msg?.body && <p className="ch-fwd-snip" dir="auto">{msg.body.slice(0, 140)}</p>}

        <div className="ch-fwd-list">
          {rows === null && <Loader label="Checking…"/>}

          {rows !== null && rows.length === 0 && (
            <p className="ch-fwd-empty">
              {receiptsOff
                ? 'Your read receipts are off, so nobody’s “seen” status is shared with you. Turn them back on in chat privacy to see this list.'
                : error
                  ? 'Read receipts are unavailable for this message.'
                  : 'Nobody has read this yet. Members who turned their own read receipts off never appear here.'}
            </p>
          )}

          {(rows || []).map(p => {
            const who = enrichAuthor(p._author, p.userId)
            return (
              <button key={p.userId} className="ch-seen-row"
                onClick={() => onOpenProfile?.(p.userId)}>
                <Avatar size={34} src={who?.profileImage || null} initials={who?.initials || '·'} color={who?.avc}/>
                <span className="ch-seen-body">
                  <span className="ch-seen-nm" dir="auto">
                    {who?.full || p.fullName || p.username}
                    {who?.verified && <Verify scholar={who.role === 'SCHOLAR'}/>}
                  </span>
                  <span className="ch-seen-at">@{p.handle || p.username}</span>
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default SeenBySheet
