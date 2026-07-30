/* =========================================================
   ChannelLinkPage — /c/:handle
   ---------------------------------------------------------
   The route behind a public channel's shareUrl
   ({irc.base-url}/c/{handle}, see docs/chat/channels.md). It
   resolves the handle via GET /channels/by-handle/{handle} and
   shows the channel's card — WHO you are being asked to join —
   before anything is written. One button does the rest: the
   backend floors conversation reads at membership, so opening
   subscribes first (idempotent) and then navigates, exactly
   like ChannelsPage.openChannel.
   ========================================================= */
import React from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Icon, showToast } from '../components/ui.jsx'
import { Loader, ErrorState } from '../components/states.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { useChat } from '../context/ChatContext.jsx'
import { api } from '../api/index.js'
import { chatError } from '../components/chat/chatErrors.js'

/* Same derivation ChannelsPage uses — the six discipline tints, keyed on the
   id so this card wears the identical colour it wears in discovery. */
function tintOf(id) {
  const s = String(id || '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 997
  return h % 6
}
function crestOf(ch) {
  const src = (ch.title || ch.handle || '#').trim()
  return [...src][0]?.toUpperCase() || '#'
}

export function ChannelLinkPage() {
  const navigate = useNavigate()
  const { handle } = useParams()
  const { user } = useAuth()
  const { upsertConvo } = useChat()

  const [ch, setCh] = React.useState(null)
  const [state, setState] = React.useState('loading')   // loading | ready | missing | error
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    let alive = true
    setState('loading')
    api.channels.byHandle(handle)
      .then(res => { if (alive) { setCh(res); setState(res ? 'ready' : 'missing') } })
      .catch(e => { if (alive) setState(e?.status === 404 ? 'missing' : 'error') })
    return () => { alive = false }
  }, [handle])

  const open = async () => {
    if (!ch || busy || ch.pendingJoinRequest) return
    const isMember = ch.subscribed || String(ch.ownerId) === String(user?.id)
    if (!isMember) {
      setBusy(true)
      try {
        const res = await api.channels.subscribe(ch.id)
        /* On a joinByRequest channel this FILES A REQUEST and answers with a
           non-member (`pendingJoinRequest: true`) — navigating to the thread
           would 403. Stay on the card and let it say what happened. */
        if (res?.pendingJoinRequest) {
          setCh(res)
          setBusy(false)
          showToast('Request sent — an admin needs to approve you')
          return
        }
        if (res) setCh(res)
        try { const c = await api.chat.conversations.get(ch.id); if (c) upsertConvo(c) }
        catch { /* it will arrive with the next inbox load */ }
        showToast('Subscribed')
      } catch (e) {
        showToast(chatError(e, 'Could not open the channel'))
        setBusy(false)
        return
      }
    }
    navigate(`/chat/${ch.id}`, { replace: true })
  }

  if (state === 'loading') {
    return <div className="main center"><div className="col-main"><Loader label="Finding the channel…"/></div></div>
  }
  if (state !== 'ready') {
    return (
      <div className="main center"><div className="col-main">
        <ErrorState
          message={state === 'missing'
            ? `There is no channel at @${handle} — the link may be old, or the channel was deleted.`
            : 'The channel could not be looked up right now.'}
          onRetry={() => navigate('/channels')}
        />
      </div></div>
    )
  }

  const isMember = ch.subscribed || String(ch.ownerId) === String(user?.id)
  return (
    <div className="main center cn-page">
      <div className="col-main">
        <div className="cn-linkcard">
          <article className={'cn-card tint-' + tintOf(ch.id)}>
            <div className="cn-card-cover" aria-hidden="true">
              <Icon name="broadcast" className="cn-card-mark"/>
              {ch.subscribed && <span className="cn-card-flag"><Icon name="check" className="xs"/>Subscribed</span>}
            </div>
            <div className="cn-card-crest" aria-hidden="true">{crestOf(ch)}</div>
            <div className="cn-card-body">
              <h3 className="cn-card-title" dir="auto">{ch.title}</h3>
              <div className="cn-card-handle">@{ch.handle}</div>
              {ch.description
                ? <p className="cn-card-desc" dir="auto">{ch.description}</p>
                : <p className="cn-card-desc empty">No description yet.</p>}
            </div>
            <footer className="cn-card-foot">
              <span className="cn-card-meta">
                <Icon name="users" className="xs"/>
                {ch.subscriberCount}<span className="cn-card-metaw">&nbsp;subscriber{ch.subscriberCount === 1 ? '' : 's'}</span>
              </span>
              <div className="cn-card-acts">
                <button className="cn-btn primary" disabled={busy || ch.pendingJoinRequest} onClick={open}>
                  {busy ? 'Opening…'
                    : ch.pendingJoinRequest ? 'Awaiting approval'
                    : isMember ? 'Open channel' : 'Subscribe & open'}
                </button>
              </div>
            </footer>
          </article>
          <p className="cn-linkcard-note">
            A channel is a broadcast — its admins post, you read. You can
            unsubscribe at any time from the channel’s details.
          </p>
        </div>
      </div>
    </div>
  )
}

export default ChannelLinkPage
