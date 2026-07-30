/* =========================================================
   Chat invite redemption — /chat/join/:token
   ---------------------------------------------------------
   An invite link is a URL someone pastes into another app, so
   redeeming it has to be a route rather than a button inside the
   info panel. This page POSTs the token once, then either
   REPLACEs itself with the joined thread (so the invite URL never
   sits in the history — a back-tap would re-POST a token that is
   now one use lighter), or — for an approval-required link —
   stays put to say the join request was filed. That second arm is
   this page's only chance to say it: the wire consumes the use,
   answers PENDING_APPROVAL with a null conversation, and nothing
   else in the app will ever mention the request until an admin
   decides (CHANNEL_JOIN_APPROVED arrives as a notification).

   The backend consumes a use atomically inside a guarded UPDATE,
   so a double-click or a race between two joiners can never take
   the link past `maxUses` — the loser simply gets INVITE_INVALID.
   Being already a member is a silent success on the server too:
   it returns the conversation instead of erroring.
   ========================================================= */
import React from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/index.js'
import { Icon } from '../components/ui.jsx'
import { Loader } from '../components/states.jsx'
import { useChat } from '../context/ChatContext.jsx'
import { chatError } from '../components/chat/chatErrors.js'

/** Invite failures are all "this link doesn't work" from the user's side.
 *  INVITE_INVALID and CONVERSATION_NOT_FOUND come from the shared catalog so
 *  they read identically wherever they surface; only the two cases the catalog
 *  cannot know about are special-cased here — BLOCKED means "can't JOIN" in
 *  this context rather than "can't message", and `NOT_FOUND` is an undocumented
 *  bare-404 spelling this route has to tolerate. */
function reasonOf(e) {
  if (e?.code === 'BLOCKED') return 'You can’t join this conversation.'
  if (e?.code === 'NOT_FOUND') return 'That group or channel no longer exists.'
  return chatError(e, 'This invite link could not be opened.')
}

export function ChatJoinPage() {
  const { token } = useParams()
  const navigate = useNavigate()
  const { upsertConvo } = useChat()
  // 'joining' | 'pending' | 'error' — pending is a SUCCESS arm: the link
  // required approval, the use was consumed and a join request is now filed.
  const [state, setState] = React.useState('joining')
  const [error, setError] = React.useState(null)
  const claimedRef = React.useRef(false)

  React.useEffect(() => {
    // StrictMode double-invokes effects in dev; a second POST would burn a
    // second use of the link, so the claim is guarded by a ref, not state.
    if (!token || claimedRef.current) return
    claimedRef.current = true
    let alive = true
    api.chat.members.join(token)
      .then(({ pending, conversation }) => {
        if (!alive) return
        if (conversation?.id) {
          upsertConvo(conversation)
          navigate(`/chat/${conversation.id}`, { replace: true })   // replace: don't re-POST on back
        } else if (pending) {
          setState('pending')   // stay: this page is the only place the answer can be shown
        } else {
          navigate('/chat', { replace: true })
        }
      })
      .catch(e => { if (alive) { setError(reasonOf(e)); setState('error') } })
    return () => { alive = false }
  }, [token, navigate, upsertConvo])

  return (
    <div className="main wide ch-main ch-solo">
      <section className="ch-pane ch-pane-thread">
        {state === 'error' ? (
          <div className="ch-blank">
            <div className="ch-blank-mark"><Icon name="link" className="lg"/></div>
            <h2 className="ch-blank-title">Invite <em>unavailable</em></h2>
            <p className="ch-blank-sub">{error}</p>
            <button className="btn btn-primary" onClick={() => navigate('/chat', { replace: true })}>
              <Icon name="chat" className="xs"/>Go to messages
            </button>
          </div>
        ) : state === 'pending' ? (
          <div className="ch-blank">
            <div className="ch-blank-mark"><Icon name="hourglass" className="lg"/></div>
            <h2 className="ch-blank-title">Request <em>sent</em></h2>
            <p className="ch-blank-sub">
              This invite needs an admin’s approval before you’re let in.
              You’ll get a notification as soon as they decide — nothing more
              to do here.
            </p>
            <button className="btn btn-primary" onClick={() => navigate('/chat', { replace: true })}>
              <Icon name="chat" className="xs"/>Go to messages
            </button>
          </div>
        ) : (
          <Loader label="Joining…"/>
        )}
      </section>
    </div>
  )
}

export default ChatJoinPage
