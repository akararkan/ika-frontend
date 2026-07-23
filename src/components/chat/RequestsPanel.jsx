/* =========================================================
   RequestsPanel — the Message Requests inbox.
   ---------------------------------------------------------
   A stranger's first contact never lands in the main inbox: the
   backend quarantines it behind a `message_requests` row and
   gives them exactly three pre-acceptance messages. This panel
   is the recipient's side of that contract.

   Accept graduates the thread into the normal inbox (and unlocks
   receipts/typing, which are suppressed while a request is
   pending). Decline hides it silently — deliberately WITHOUT
   telling the requester. Block does both and blocks the account.

   The three actions are optimistic in ChatContext, so the row
   disappears immediately and restores itself if the call fails.
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, Avatar, Verify } from '../ui.jsx'
import { EmptyState, Loader } from '../states.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { useChat } from '../../context/ChatContext.jsx'

/* STRANGER_MESSAGE_CAP — a stranger may send this many messages into an
   un-accepted thread; the next one is refused with REQUEST_LIMIT_REACHED.
   Mirrored from message-requests.md purely to label the inbox; the server
   owns the actual enforcement. */
const STRANGER_CAP = 3

function RequestRow({ req, onOpen }) {
  const navigate = useNavigate()
  const { acceptRequest, declineRequest, blockRequest, watchUsers, enrichAuthor } = useChat()
  const [busy, setBusy] = React.useState(false)

  // MessageRequestResponse carries no avatar either — resolve the requester.
  React.useEffect(() => {
    if (req.requesterId) watchUsers([req.requesterId])
  }, [req.requesterId, watchUsers])

  const run = async (fn) => {
    if (busy) return
    setBusy(true)
    try { await fn() } catch { /* the context toasts + restores the row */ }
    finally { setBusy(false) }
  }

  const doBlock = () => run(async () => {
    const ok = await uiConfirm({
      title: 'Block this person',
      message: `Block @${req.requester?.handle || 'this account'}? They won’t be able to message or follow you.`,
      danger: true,
      confirmLabel: 'Block',
    })
    if (!ok) return
    await blockRequest(req.id)
  })

  const who = enrichAuthor(req.requester, req.requesterId)

  return (
    <div className="rq-row">
      <button
        type="button"
        className="ch-av-btn"
        onClick={() => who?.id && navigate(`/u/${who.id}`)}
        aria-label={`View ${who?.full || 'profile'}`}
      >
        <Avatar size={42} src={who?.profileImage || null} initials={who?.initials || '·'} color={who?.avc}/>
      </button>

      <div className="rq-body">
        <div className="rq-name">
          <span dir="auto">{who?.full || 'Someone'}</span>
          {who?.verified && <Verify scholar={who.role === 'SCHOLAR'}/>}
        </div>
        {who?.handle && <div className="rq-handle">@{who.handle}</div>}
        <div className="rq-meta">
          {req.messageCount || 1} message{(req.messageCount || 1) === 1 ? '' : 's'} · {req.time}
          {/* A stranger gets STRANGER_MESSAGE_CAP messages before you answer,
              then the 4th is refused. Showing the cap only once it is reached
              turns "they went quiet" into "they ran out of room" — otherwise
              silence reads as them losing interest, when the app stopped them. */}
          {(req.messageCount || 0) >= STRANGER_CAP && (
            <span className="rq-capped" title={`A first message is limited to ${STRANGER_CAP} messages`}>
              · limit reached
            </span>
          )}
        </div>

        <div className="rq-actions">
          <button
            type="button"
            className="rq-btn primary"
            disabled={busy}
            onClick={() => run(async () => {
              await acceptRequest(req.id)
              if (req.conversationId) onOpen?.(req.conversationId)
            })}
          >
            Accept
          </button>
          <button
            type="button"
            className="rq-btn"
            disabled={busy}
            onClick={() => req.conversationId && onOpen?.(req.conversationId)}
          >
            Read
          </button>
          <button
            type="button"
            className="rq-btn"
            disabled={busy}
            onClick={() => run(() => declineRequest(req.id))}
          >
            Decline
          </button>
          <button type="button" className="rq-btn danger" disabled={busy} onClick={doBlock}>
            Block
          </button>
        </div>
      </div>
    </div>
  )
}

export function RequestsPanel({ onOpen }) {
  const { requests, loadRequests } = useChat()
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    let alive = true
    loadRequests().finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [loadRequests])

  if (loading && !requests.length) return <div className="chat-list"><Loader label="Loading requests…"/></div>

  if (!requests.length) {
    return (
      <div className="chat-list">
        <EmptyState
          icon="message"
          title="No message requests"
          sub="Messages from people you don’t follow will wait here."
        />
      </div>
    )
  }

  return (
    <div className="chat-list">
      <div className="chat-group-label">
        Pending · {requests.length}
      </div>
      {requests.map(r => <RequestRow key={r.id} req={r} onOpen={onOpen}/>)}
      <div className="ch-start" style={{ paddingTop: 18 }}>
        <Icon name="lock" className="sm"/> They can’t see whether you’ve read their messages.
      </div>
    </div>
  )
}

export default RequestsPanel
