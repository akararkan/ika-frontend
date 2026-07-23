/* =========================================================
   Chat invite redemption — /chat/join/:token
   ---------------------------------------------------------
   An invite link is a URL someone pastes into another app, so
   redeeming it has to be a route rather than a button inside the
   info panel. This page does exactly one thing: POST the token,
   then REPLACE itself with the group's thread so the invite URL
   never sits in the history (a back-tap would re-POST a token
   that is now one use lighter).

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
  if (e?.code === 'BLOCKED') return 'You can’t join this group.'
  if (e?.code === 'NOT_FOUND') return 'That group no longer exists.'
  return chatError(e, 'This invite link could not be opened.')
}

export function ChatJoinPage() {
  const { token } = useParams()
  const navigate = useNavigate()
  const { upsertConvo } = useChat()
  const [error, setError] = React.useState(null)
  const claimedRef = React.useRef(false)

  React.useEffect(() => {
    // StrictMode double-invokes effects in dev; a second POST would burn a
    // second use of the link, so the claim is guarded by a ref, not state.
    if (!token || claimedRef.current) return
    claimedRef.current = true
    let alive = true
    api.chat.members.join(token)
      .then(convo => {
        if (!alive) return
        if (convo?.id) {
          upsertConvo(convo)
          navigate(`/chat/${convo.id}`, { replace: true })   // replace: don't re-POST on back
        } else {
          navigate('/chat', { replace: true })
        }
      })
      .catch(e => { if (alive) setError(reasonOf(e)) })
    return () => { alive = false }
  }, [token, navigate, upsertConvo])

  return (
    <div className="main wide ch-main ch-solo">
      <section className="ch-pane ch-pane-thread">
        {error ? (
          <div className="ch-blank">
            <div className="ch-blank-mark"><Icon name="link" className="lg"/></div>
            <h2 className="ch-blank-title">Invite <em>unavailable</em></h2>
            <p className="ch-blank-sub">{error}</p>
            <button className="btn btn-primary" onClick={() => navigate('/chat', { replace: true })}>
              <Icon name="chat" className="xs"/>Go to messages
            </button>
          </div>
        ) : (
          <Loader label="Joining the group…"/>
        )}
      </section>
    </div>
  )
}

export default ChatJoinPage
