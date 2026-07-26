/* =========================================================
   ChannelPage — /channels/:id
   ---------------------------------------------------------
   The channel's PROFILE, as distinct from its timeline. The
   timeline is the ordinary conversation at /chat/<id> and always
   was; what had no home until now is everything that describes
   the channel rather than carrying its posts — cover art, the
   verified badge, the category, live stories, the permanent
   highlight rail, and (for admins) the door into the management
   console.

   Three viewer states, not two, and the page has to say which:
     · SUBSCRIBED   → open the timeline
     · PENDING      → a join request is filed and waiting; the
                      subscribe button must not offer to file a
                      second one
     · NOT A MEMBER → subscribe, which on a `joinByRequest`
                      channel FILES A REQUEST rather than joining
   `ChannelResponse` carries all three (`subscribed`,
   `pendingJoinRequest`), so none of it is inferred.

   The read floor still applies: the backend floors conversation
   reads at membership, so the post list below is only fetched
   once the viewer is in. For everyone else the page is honest
   about it rather than rendering an empty timeline that looks
   like a channel with nothing in it.
   ========================================================= */
import React from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Icon, Avatar, showToast, Verify } from '../components/ui.jsx'
import { Loader, ErrorState, EmptyState } from '../components/states.jsx'
import { openShare } from '../components/ShareSheet.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { useChat } from '../context/ChatContext.jsx'
import { api } from '../api/index.js'
import { chatError } from '../components/chat/chatErrors.js'
import { tintOf, crestOf, nfmt, dateLabel } from '../components/channels/channelArt.js'
import { ChannelStoryRail } from '../components/channels/ChannelStories.jsx'
import { ChannelHighlightRail } from '../components/channels/ChannelHighlights.jsx'
import { ChannelManage } from '../components/channels/ChannelManage.jsx'

/* The settings that a READER can see the effect of, rendered as plain badges.
   Knobs that only matter to admins (language, accent colour) are deliberately
   absent — this row exists to explain behaviour the reader will meet, not to
   dump the settings blob. */
function SettingBadges({ ch }) {
  const s = ch.settings || {}
  const badges = [
    s.signMessages     && ['edit', 'Posts are signed'],
    s.protectedContent && ['lock', 'Forwarding is off'],
    s.hiddenSubscribers&& ['eyeoff', 'Subscribers hidden'],
    s.joinByRequest    && ['hourglass', 'Approval required'],
    !s.reactionsEnabled&& ['heart', 'Reactions off'],
  ].filter(Boolean)
  if (!badges.length) return null
  return (
    <div className="cp-badges">
      {badges.map(([icon, label]) => (
        <span className="cp-badge" key={label}><Icon name={icon} className="xs"/>{label}</span>
      ))}
    </div>
  )
}

export function ChannelPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { upsertConvo, subscribe, myId } = useChat()

  const [ch, setCh] = React.useState(null)
  const [state, setState] = React.useState('loading')   // loading | ready | missing | denied | error
  const [busy, setBusy] = React.useState(false)
  const [managing, setManaging] = React.useState(false)
  const [reload, setReload] = React.useState(0)

  React.useEffect(() => {
    let alive = true
    setState('loading')
    api.channels.get(id)
      .then(res => { if (alive) { setCh(res); setState(res ? 'ready' : 'missing') } })
      .catch(e => {
        if (!alive) return
        // 403 on a PRIVATE channel is not an error — it is the answer. The page
        // says "invite only" rather than "something went wrong".
        setState(e?.status === 404 ? 'missing' : e?.status === 403 ? 'denied' : 'error')
      })
    return () => { alive = false }
  }, [id, reload])

  /* Realtime, on the delta model the rest of the app uses: `member.changed`
     carries no counter, so ±1 is applied locally, and my OWN echo is skipped
     because the toggle below already moved the number optimistically.
     `conversation.updated / CHANNEL_INFO_CHANGED` is the one event that cannot
     be applied as a delta — the payload says "something changed", not what —
     so it re-fetches. */
  React.useEffect(() => subscribe((evt) => {
    if (String(evt?.conversationId) !== String(id)) return
    if (evt.type === 'member.changed') {
      if (String(evt.userId) === String(myId)) return
      const d = evt.memberChange === 'SUBSCRIBED' || evt.memberChange === 'ADDED' ? 1
        : evt.memberChange === 'UNSUBSCRIBED' ? -1 : 0
      if (d) setCh(prev => (prev ? { ...prev, subscriberCount: Math.max(0, prev.subscriberCount + d) } : prev))
    } else if (evt.type === 'conversation.updated' && evt.memberChange === 'CHANNEL_INFO_CHANGED') {
      setReload(n => n + 1)
    }
  }), [subscribe, id, myId])

  const isOwner = !!ch && String(ch.ownerId) === String(user?.id)
  const isMember = !!ch && (ch.subscribed || isOwner)
  const canManage = !!ch && (isOwner || ch.myRole === 'ADMIN')

  /* Open = read the timeline. The backend floors conversation reads at
     membership even for a PUBLIC channel, so a non-member must join first —
     subscribe is idempotent and a brand-new subscriber sees the full history.
     A `joinByRequest` channel cannot be opened this way at all: subscribing
     files a request, so navigating afterwards would land on a 403. */
  const open = async () => {
    if (!ch) return
    if (isMember) { navigate(`/chat/${ch.id}`); return }
    if (!ch.publicChannel) { showToast('This channel is invite-only'); return }
    setBusy(true)
    try {
      const next = await api.channels.subscribe(ch.id)
      setCh(next)
      if (next.pendingJoinRequest) {
        showToast('Request sent — an admin will review it')
        return
      }
      try { const c = await api.chat.conversations.get(ch.id); if (c) upsertConvo(c) }
      catch { /* it will arrive with the next inbox load */ }
      navigate(`/chat/${ch.id}`)
    } catch (e) {
      showToast(chatError(e, 'Could not open the channel'))
    } finally { setBusy(false) }
  }

  const toggle = async () => {
    if (!ch || busy) return
    setBusy(true)
    const before = ch.subscribed
    try {
      if (before) {
        await api.channels.unsubscribe(ch.id)
        setCh(p => ({ ...p, subscribed: false, myRole: null, subscriberCount: Math.max(0, p.subscriberCount - 1) }))
        showToast('Unsubscribed')
      } else {
        const next = await api.channels.subscribe(ch.id)
        setCh(next)
        if (!next.pendingJoinRequest) {
          try { const c = await api.chat.conversations.get(ch.id); if (c) upsertConvo(c) }
          catch { /* next inbox load */ }
        }
        showToast(next.pendingJoinRequest ? 'Request sent' : 'Subscribed')
      }
    } catch (e) {
      showToast(chatError(e, 'Could not update the subscription'))
    } finally { setBusy(false) }
  }

  if (state === 'loading') {
    return <div className="main center"><div className="col-main"><Loader label="Opening the channel…"/></div></div>
  }
  if (state !== 'ready' || !ch) {
    return (
      <div className="main center"><div className="col-main">
        <ErrorState
          message={{
            missing: 'That channel no longer exists — it may have been deleted.',
            denied: 'This is a private channel. You need an invite link to see it.',
            error: 'The channel could not be loaded right now.',
          }[state] || 'The channel could not be loaded right now.'}
          onRetry={() => (state === 'error' ? setReload(n => n + 1) : navigate('/channels'))}
        />
      </div></div>
    )
  }

  const tint = tintOf(ch.id)

  return (
    <div className={'main wide cp-page tint-' + tint}>
      <div className="col-main">
        {/* ---------- hero: cover, crest, identity ---------- */}
        <header className="cp-hero">
          {/* The cover goes in as a CUSTOM PROPERTY, not as `background-image`
              — the stylesheet layers it over the derived gradient, so a cover
              that fails to load degrades to the channel's own art instead of a
              bare box. See the note on `.cp-cover`. */}
          <div className={'cp-cover' + (ch.coverUrl ? ' has-img' : '')}
            style={ch.coverUrl ? { '--cover': `url("${encodeURI(ch.coverUrl)}")` } : undefined}>
            {!ch.coverUrl && <Icon name="broadcast" className="cp-cover-mark"/>}
            <div className="cp-cover-scrim" aria-hidden="true"/>
          </div>

          <div className="cp-ident">
            <div className="cp-avatar">
              {ch.avatarUrl
                ? <Avatar size={96} src={ch.avatarUrl} initials={crestOf(ch)}/>
                : <span className="cp-crest" aria-hidden="true">{crestOf(ch)}</span>}
            </div>

            <div className="cp-ident-body">
              <h1 className="cp-title" dir="auto">
                {ch.title}
                {/* Platform-granted, never owner-settable — so it is rendered
                    with the same component the rest of the app uses for a
                    verified person, not a channel-only lookalike. */}
                {ch.verified && <Verify/>}
              </h1>
              <div className="cp-sub">
                {ch.handle
                  ? <span className="cp-handle">@{ch.handle}</span>
                  : <span className="cp-handle muted"><Icon name="lock" className="xs"/>Private channel</span>}
                {ch.category && (
                  <button className="cp-cat" onClick={() => navigate(`/channels?category=${encodeURIComponent(ch.category)}`)}>
                    {ch.category}
                  </button>
                )}
              </div>

              <div className="cp-stats">
                <span><b>{nfmt(ch.subscriberCount)}</b> {ch.subscriberCount === 1 ? 'subscriber' : 'subscribers'}</span>
                <span className="cp-dot">·</span>
                <span><b>{nfmt(ch.postCount)}</b> {ch.postCount === 1 ? 'post' : 'posts'}</span>
                {ch.createdAt && <><span className="cp-dot">·</span><span>since {dateLabel(ch.createdAt)}</span></>}
              </div>
            </div>

            <div className="cp-acts">
              <button className="btn btn-primary" disabled={busy} onClick={open}>
                {isMember ? 'Open channel' : ch.pendingJoinRequest ? 'Awaiting approval' : 'Subscribe & open'}
              </button>

              {/* The owner cannot unsubscribe (the API refuses), and a pending
                  requester has nothing to toggle — so neither gets a disabled
                  control that could only ever 403. */}
              {!isOwner && !ch.pendingJoinRequest && (ch.publicChannel || ch.subscribed) && (
                <button className={'btn' + (ch.subscribed ? ' on' : '')} disabled={busy} onClick={toggle}>
                  {ch.subscribed
                    ? <><span className="cn-btn-a"><Icon name="check" className="xs"/>Subscribed</span>
                        <span className="cn-btn-b">Unsubscribe</span></>
                    : 'Subscribe'}
                </button>
              )}

              {ch.shareUrl && (
                <button className="icon-btn" title="Share" aria-label={`Share ${ch.title}`}
                  onClick={() => openShare({ kind: 'channel', url: ch.shareUrl, title: ch.title })}>
                  <Icon name="share" className="sm"/>
                </button>
              )}

              {canManage && (
                <button className="icon-btn" title="Manage channel" aria-label="Manage channel"
                  onClick={() => setManaging(true)}>
                  <Icon name="settings" className="sm"/>
                </button>
              )}
            </div>
          </div>
        </header>

        {ch.pendingJoinRequest && (
          <div className="cp-note">
            <Icon name="hourglass" className="sm"/>
            <div>
              <b>Your request is waiting.</b> This channel approves subscribers by hand —
              you will be notified when an admin decides.
            </div>
          </div>
        )}

        {ch.description && <p className="cp-desc" dir="auto">{ch.description}</p>}
        <SettingBadges ch={ch}/>

        {/* ---------- stories & highlights ----------
            Both are audience-gated server-side (public → anyone, private →
            subscribers), so they are rendered for everyone and the fetch
            itself decides — a 403 simply yields an empty rail. */}
        <ChannelStoryRail channel={ch} canManage={canManage}/>
        <ChannelHighlightRail channel={ch} canManage={canManage}/>

        {/* ---------- what a non-member is being offered ---------- */}
        {!isMember && (
          <EmptyState
            icon="broadcast"
            title={ch.publicChannel ? 'Subscribe to read the posts' : 'This channel is invite-only'}
            sub={ch.publicChannel
              ? 'Posts, media and discussion open up the moment you subscribe — and the whole history comes with them.'
              : 'Ask an admin for an invite link; private channels cannot be joined from search.'}
          />
        )}

        {isMember && <ChannelAbout ch={ch} onOpen={() => navigate(`/chat/${ch.id}`)}/>}
      </div>

      {managing && (
        <ChannelManage
          channel={ch}
          onClose={() => setManaging(false)}
          onChanged={(next) => setCh(next)}
        />
      )}
    </div>
  )
}

/* The member-facing summary: the shortcuts into the timeline's own surfaces
   (media gallery, comments) plus the facts that are not visible from a post. */
function ChannelAbout({ ch, onOpen }) {
  const navigate = useNavigate()
  return (
    <section className="cp-about">
      <h2 className="cp-h2">About this channel</h2>
      <dl className="cp-facts">
        <div><dt>Visibility</dt><dd>{ch.publicChannel ? 'Public — anyone can find and subscribe' : 'Private — invite only'}</dd></div>
        {ch.category && <div><dt>Category</dt><dd>{ch.category}</dd></div>}
        {ch.settings?.language && <div><dt>Language</dt><dd>{ch.settings.language}</dd></div>}
        {/* The KEY already says "Subscribers" — repeating the word in the value
            ("Subscribers … 1.3k subscribers") read like a stutter. The value is
            just the figure. */}
        <div><dt>Subscribers</dt><dd>{nfmt(ch.subscriberCount)}</dd></div>
        <div><dt>Posts</dt><dd>{nfmt(ch.postCount)}</dd></div>
        <div>
          <dt>Comments</dt>
          <dd>
            {ch.linkedGroupId
              ? <button className="cp-link" onClick={() => navigate(`/chat/${ch.linkedGroupId}`)}>
                  Open the discussion group
                </button>
              : 'Off — no discussion group is linked'}
          </dd>
        </div>
      </dl>
      <button className="btn btn-primary cp-open" onClick={onOpen}>
        <Icon name="message" className="xs"/>Go to the posts
      </button>
    </section>
  )
}

export default ChannelPage
