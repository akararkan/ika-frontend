/* =========================================================
   ChannelManage — the admin console
   ---------------------------------------------------------
   Everything an admin can change about a channel, behind one
   tabbed modal. Which tabs appear is decided by the
   caller's OWN rights, read from `GET /channels/{id}/admins`
   rather than guessed from `myRole`: an admin with
   `canChangeInfo` off must not be shown an Info form whose every
   save 403s.

   Two wire behaviours shape the forms:

     · `settings` is a WHOLE-OBJECT replacement. PATCHing
       `{ settings: { signMessages: true } }` resets every other
       knob to its default. So the panel always sends the
       complete blob (`channelSettingsTo`) built from the state
       it loaded — never a delta.
     · Turning a public channel private CLEARS its @handle
       (Telegram behaviour), and going public again therefore
       needs a new one. The toggle says so before it is thrown,
       not after.

   Slow mode lives with the discussion group because that is
   what it throttles: it is a GroupSettings knob on a
   conversation, admins are exempt, and on a broadcast channel
   where only admins can post it would do nothing at all.
   ========================================================= */
import React from 'react'
import { Icon, showToast } from '../ui.jsx'
import { Loader } from '../states.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { api } from '../../api/index.js'
import { channelSettingsTo } from '../../api/chat.js'
import { chatError } from '../chat/chatErrors.js'
import { useChat } from '../../context/ChatContext.jsx'
import { ChannelAdmins, ChannelRequests } from './ChannelAdmins.jsx'
import { ChannelSubscribers } from './ChannelSubscribers.jsx'
import { ChannelInvites } from './ChannelInvites.jsx'
import { ChannelStats } from './ChannelStats.jsx'
import { tintOf, crestOf } from './channelArt.js'
import { useImageViewer } from '../ImageLightbox.jsx'
import { useImageRatio, coverStyle } from '../../lib/useImageRatio.js'

const HANDLE_RE = /^[a-z0-9_]{3,32}$/

const SLOW_PRESETS = [
  [0, 'Off'], [10, '10s'], [30, '30s'], [60, '1m'], [300, '5m'], [900, '15m'], [3600, '1h'],
]
// chip labels are terse by design; the toast speaks in words ('1m' also reads as one month)
const SLOW_WORDS = { 10: '10 seconds', 30: '30 seconds', 60: 'minute', 300: '5 minutes', 900: '15 minutes', 3600: 'hour' }

/* ---------------------------------------------------------
   Tab 1 — identity: photo, cover, title, handle, category.
   --------------------------------------------------------- */
function InfoTab({ channel, onChanged }) {
  const [title, setTitle] = React.useState(channel.title)
  const [description, setDescription] = React.useState(channel.description)
  const [handle, setHandle] = React.useState(channel.handle)
  const [category, setCategory] = React.useState(channel.category)
  const [isPublic, setIsPublic] = React.useState(channel.publicChannel)
  const [busy, setBusy] = React.useState(false)
  const [uploading, setUploading] = React.useState(null)   // 'photo' | 'cover'
  const { open, viewer } = useImageViewer()   // tapping the art shows it full-size; the chips still edit it
  const coverAr = useImageRatio(channel.coverUrl)   // the preview takes the cover's own shape

  const cleanHandle = handle.trim().replace(/^@/, '').toLowerCase()
  const handleBad = isPublic && !!cleanHandle && !HANDLE_RE.test(cleanHandle)
  const needsHandle = isPublic && !HANDLE_RE.test(cleanHandle)

  const dirty = title !== channel.title
    || description !== channel.description
    || cleanHandle !== channel.handle
    || category !== channel.category
    || isPublic !== channel.publicChannel

  const save = async () => {
    if (!title.trim() || needsHandle || busy) return
    setBusy(true)
    try {
      const next = await api.channels.update(channel.id, {
        title: title.trim(),
        description: description.trim(),
        handle: isPublic ? cleanHandle : undefined,
        category: category.trim(),          // an empty string CLEARS it, per the API
        publicChannel: isPublic,
      })
      showToast('Channel updated')
      onChanged?.(next)
    } catch (e) {
      showToast(chatError(e, 'Could not save the changes'))
    } finally { setBusy(false) }
  }

  const pick = (which) => async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''                     // let the same file be chosen twice
    if (!file) return
    setUploading(which)
    try {
      const next = which === 'photo'
        ? await api.channels.photo(channel.id, file)
        : await api.channels.cover(channel.id, file)
      showToast(which === 'photo' ? 'Photo updated' : 'Cover updated')
      onChanged?.(next)
    } catch (err) {
      showToast(chatError(err, 'The image could not be uploaded'))
    } finally { setUploading(null) }
  }

  const clear = (which) => async () => {
    const ok = await uiConfirm({
      title: which === 'photo' ? 'Remove the photo?' : 'Remove the cover?',
      message: 'The channel falls back to its derived art.',
      confirmLabel: 'Remove', danger: true, icon: 'trash',
    })
    if (!ok) return
    try {
      if (which === 'photo') await api.channels.removePhoto(channel.id)
      else await api.channels.removeCover(channel.id)
      onChanged?.({ ...channel, [which === 'photo' ? 'avatarUrl' : 'coverUrl']: null })
    } catch (e) { showToast(chatError(e, 'Could not remove it')) }
  }

  return (
    <div className="cm-stack">
      {/* Identity banner — the same cover/crest/tint composition the profile
          and the discovery card wear, editable in place. */}
      <div className={'cm-art tint-' + tintOf(channel.id)}>
        <div className={'cm-art-cover' + (channel.coverUrl ? ' has-img' : '')}
          style={coverStyle(channel.coverUrl, coverAr)}>
          {/* The whole plate opens the picture, as its own button UNDER the
              edit chips (z-index) — a hit area that covers the controls would
              nest one control inside another and swallow them for a reader. */}
          {channel.coverUrl && (
            <button type="button" className="cm-art-open" onClick={() => open(channel.coverUrl)}
              aria-label="View the cover full size" title="View the cover full size"/>
          )}
          <div className="cm-art-acts">
            <label className="cm-art-btn">
              {uploading === 'cover'
                ? <span className="cm-art-spin" aria-hidden="true"/>
                : <Icon name="image" className="xs"/>}
              {uploading === 'cover' ? 'Uploading…' : channel.coverUrl ? 'Replace cover' : 'Add cover'}
              <input type="file" accept="image/*" hidden onChange={pick('cover')} disabled={uploading === 'cover'}/>
            </label>
            {channel.coverUrl && (
              <button type="button" className="cm-art-btn" onClick={clear('cover')}
                aria-label="Remove the cover" title="Remove the cover">
                <Icon name="trash" className="xs"/>
              </button>
            )}
          </div>
        </div>

        <div className="cm-art-id">
          <div className="cm-art-photo">
            {channel.avatarUrl
              ? <img src={channel.avatarUrl} alt=""/>
              : <span className="cm-art-crest" aria-hidden="true">{crestOf(channel)}</span>}
            {channel.avatarUrl && (
              <button type="button" className="cm-art-open" onClick={() => open(channel.avatarUrl)}
                aria-label="View the photo full size" title="View the photo full size"/>
            )}
            <label className="cm-art-cam" title={channel.avatarUrl ? 'Replace the photo' : 'Add a photo'}>
              {uploading === 'photo'
                ? <span className="cm-art-spin" aria-hidden="true"/>
                : <Icon name="image" className="xs"/>}
              <input type="file" accept="image/*" hidden onChange={pick('photo')} disabled={uploading === 'photo'}/>
            </label>
          </div>
          <div className="cm-art-meta">
            <div className="cm-art-name" title={title.trim() || channel.title}><bdi>{title.trim() || channel.title}</bdi></div>
            <div className="cm-art-sub">{channel.handle ? '@' + channel.handle : 'private channel'}</div>
          </div>
          {channel.avatarUrl && (
            <button type="button" className="cn-btn cm-art-clear" onClick={clear('photo')}>Remove photo</button>
          )}
        </div>
      </div>

      <div className="cn-form">
        <label className="cn-field">
          <span>Name <i className="cn-count">{title.length}/120</i></span>
          <input className="field" value={title} maxLength={120} dir="auto"
            onChange={e => setTitle(e.target.value)}/>
        </label>

        <label className="cn-field">
          <span>Description <i className="cn-count">{description.length}/500</i></span>
          <textarea className="field" rows={3} maxLength={500} value={description} dir="auto"
            onChange={e => setDescription(e.target.value)}/>
        </label>

        <label className="cn-field">
          <span>Category <small>a topic keyword for the directory, e.g. science</small></span>
          <input className="field" value={category} maxLength={48}
            onChange={e => setCategory(e.target.value)} placeholder="science"/>
        </label>

        <div className="ci-row cn-visrow">
          <Icon name={isPublic ? 'globe' : 'lock'}/>
          <div className="ci-row-body">
            <div className="ci-row-title">{isPublic ? 'Public channel' : 'Private channel'}</div>
            <div className="ci-row-sub">
              {isPublic
                ? 'Listed in discovery and joinable at its @handle.'
                : channel.publicChannel
                  ? <>Going private <b>releases</b> the @handle — someone else can take it, and going public again needs a new one.</>
                  : 'Hidden from discovery. People get in through an invite link.'}
            </div>
          </div>
          <button type="button" className={'ci-switch' + (isPublic ? ' on' : '')}
            role="switch" aria-checked={isPublic} aria-label="Public channel"
            onClick={() => setIsPublic(v => !v)}/>
        </div>

        {isPublic && (
          <label className="cn-field">
            <span>Handle</span>
            <div className={'cn-handle' + (handleBad ? ' bad' : '')}>
              <span aria-hidden="true">@</span>
              <input className="field" value={handle} maxLength={32}
                onChange={e => setHandle(e.target.value)} placeholder="ai_research"/>
            </div>
            <small className={'cn-hint' + (handleBad ? ' bad' : '')}>
              {handleBad
                ? '3–32 characters — lowercase letters, numbers and underscores only.'
                : 'The address people share. It must be unique across the platform.'}
            </small>
          </label>
        )}
      </div>

      <div className="cm-save">
        <span className={'cm-dirty' + (dirty ? ' on' : '')} aria-live="polite">
          {dirty ? 'Unsaved changes' : 'All saved'}
        </span>
        {needsHandle && <span className="cm-save-note">A public channel needs a valid handle.</span>}
        <button className="btn btn-primary" disabled={!dirty || !title.trim() || needsHandle || busy} onClick={save}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
      {viewer}
    </div>
  )
}

/* One boolean knob. Declared at module scope, not inside SettingsTab: a
   component created during render is a NEW type every pass, so React would
   unmount and remount the whole row — losing focus mid-interaction. */
function SwitchRow({ on, icon, title, sub, onToggle }) {
  return (
    <div className="ci-row">
      <Icon name={icon}/>
      <div className="ci-row-body">
        <div className="ci-row-title">{title}</div>
        <div className="ci-row-sub">{sub}</div>
      </div>
      <button type="button" className={'ci-switch' + (on ? ' on' : '')}
        role="switch" aria-checked={!!on} aria-label={title} onClick={onToggle}/>
    </div>
  )
}

/* ---------------------------------------------------------
   Tab 2 — behaviour. The whole settings blob, always sent whole.
   --------------------------------------------------------- */
function SettingsTab({ channel, onChanged }) {
  const [s, setS] = React.useState(() => ({ ...channel.settings }))
  const [busy, setBusy] = React.useState(false)

  const dirty = JSON.stringify(s) !== JSON.stringify(channel.settings)

  const save = async () => {
    setBusy(true)
    try {
      // The complete blob — a partial `settings` would reset the omitted knobs.
      const next = await api.channels.update(channel.id, { settings: channelSettingsTo(s) })
      showToast('Settings saved')
      onChanged?.(next)
    } catch (e) {
      showToast(chatError(e, 'Could not save the settings'))
    } finally { setBusy(false) }
  }

  const toggle = (k) => () => setS(p => ({ ...p, [k]: !p[k] }))

  return (
    <div className="cm-stack">
      <div className="ci-label">Posting</div>
      <div className="cm-group">
        <SwitchRow on={s.signMessages} onToggle={toggle('signMessages')} icon="edit" title="Sign posts"
          sub="Each post carries the @username of the admin who published it."/>
        <SwitchRow on={s.protectedContent} onToggle={toggle('protectedContent')} icon="lock" title="Protect content"
          sub="Posts cannot be forwarded out, and clients disable copy and save."/>
      </div>

      <div className="ci-label">Audience</div>
      <div className="cm-group">
        <SwitchRow on={s.joinByRequest} onToggle={toggle('joinByRequest')} icon="hourglass" title="Approve new subscribers"
          sub="New subscribers wait for an admin’s approval before they join."/>
        <SwitchRow on={s.hiddenSubscribers} onToggle={toggle('hiddenSubscribers')} icon="eyeoff" title="Hide the subscriber list"
          sub="Only admins can see who is subscribed. The count stays public."/>
      </div>

      <div className="ci-label">Reactions</div>
      <div className="cm-group">
        <SwitchRow on={s.reactionsEnabled} onToggle={toggle('reactionsEnabled')} icon="heart" title="Allow reactions"
          sub="No one can react to posts while this is off."/>
      </div>

      <label className="cn-field">
        <span>Language <small>shown on the channel’s page — e.g. ckb, ar, en</small></span>
        <input className="field" value={s.language || ''} maxLength={16}
          onChange={e => setS(p => ({ ...p, language: e.target.value }))} placeholder="ckb"/>
      </label>

      <div className="cm-save">
        <span className={'cm-dirty' + (dirty ? ' on' : '')} aria-live="polite">
          {dirty ? 'Unsaved changes' : 'All saved'}
        </span>
        <button className="btn btn-primary" disabled={!dirty || busy} onClick={save}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------
   Tab 3 — the discussion group, and the slow mode that belongs
   to it.
   --------------------------------------------------------- */
function DiscussionTab({ channel, onChanged }) {
  const { conversations } = useChat()
  const [busy, setBusy] = React.useState(false)
  const [slow, setSlow] = React.useState(0)
  const [linkedTitle, setLinkedTitle] = React.useState('')

  /* Only a GROUP I administer can be linked, and only one channel per group —
     so the picker is my admin/owner groups, not every conversation. */
  const candidates = React.useMemo(
    () => conversations.filter(c => c.isGroup && !c.isChannel && (c.myRole === 'OWNER' || c.myRole === 'ADMIN')),
    [conversations],
  )

  const linked = React.useMemo(
    () => conversations.find(c => String(c.id) === String(channel.linkedGroupId)) || null,
    [conversations, channel.linkedGroupId],
  )

  React.useEffect(() => {
    if (!channel.linkedGroupId) { setSlow(0); setLinkedTitle(''); return }
    if (linked) { setSlow(linked.slowModeSeconds || 0); setLinkedTitle(linked.displayTitle); return }
    // Not in my inbox cache — fetch it so the slow-mode control starts from the
    // real value instead of silently defaulting to "off".
    let alive = true
    api.chat.conversations.get(channel.linkedGroupId)
      .then(c => { if (alive && c) { setSlow(c.slowModeSeconds || 0); setLinkedTitle(c.displayTitle) } })
      .catch(() => {})
    return () => { alive = false }
  }, [channel.linkedGroupId, linked])

  const link = async (groupId) => {
    setBusy(true)
    try {
      await api.channels.discussion.link(channel.id, groupId)
      showToast('Discussion group linked')
      onChanged?.({ ...channel, linkedGroupId: groupId })
    } catch (e) {
      showToast(chatError(e, 'That group already serves another channel.'))
    } finally { setBusy(false) }
  }

  const unlink = async () => {
    const ok = await uiConfirm({
      title: 'Turn comments off?',
      message: 'Existing comments stay in the group, but subscribers can no longer comment on posts.',
      confirmLabel: 'Unlink', danger: true, icon: 'block',
    })
    if (!ok) return
    setBusy(true)
    try {
      await api.channels.discussion.unlink(channel.id)
      showToast('Comments turned off')
      onChanged?.({ ...channel, linkedGroupId: null })
    } catch (e) { showToast(chatError(e, 'Could not unlink the group')) }
    finally { setBusy(false) }
  }

  const [slowSaving, setSlowSaving] = React.useState(false)
  const setSlowMode = async (seconds) => {
    if (!channel.linkedGroupId || slowSaving) return
    const before = slow
    setSlow(seconds)
    setSlowSaving(true)
    try {
      await api.chat.conversations.update(channel.linkedGroupId, { settings: { slowModeSeconds: seconds } })
      showToast(seconds ? `Slow mode: one message every ${SLOW_WORDS[seconds] || SLOW_PRESETS.find(p => p[0] === seconds)?.[1]}` : 'Slow mode off')
    } catch (e) {
      setSlow(before)
      showToast(chatError(e, 'Could not change slow mode'))
    } finally { setSlowSaving(false) }
  }

  return (
    <div className="cm-stack">
      <p className="ca-intro">
        Link a group and replies to your posts become threaded comments in it.
        Subscribers are joined into the group automatically the first time they
        comment.
      </p>

      {channel.linkedGroupId ? (
        <>
          <div className="ca-row">
            <Icon name="users"/>
            <div className="ca-row-body">
              <div className="ca-row-t"><bdi>{linkedTitle || 'Linked group'}</bdi></div>
              <div className="ca-row-s">Comments are on</div>
            </div>
            <button className="cn-btn" disabled={busy} onClick={unlink}>Unlink</button>
          </div>

          <div className="ci-label">Slow mode</div>
          <p className="ca-intro">
            Throttles ordinary members to one message per window in the discussion
            group. You and the other admins are exempt.
          </p>
          <div className="cn-filters" role="group" aria-label="Slow mode interval">
            {SLOW_PRESETS.map(([sec, label]) => (
              <button key={sec} className={'cn-chip' + (slow === sec ? ' on' : '')} disabled={slowSaving}
                aria-pressed={slow === sec} onClick={() => setSlowMode(sec)}>{label}</button>
            ))}
          </div>
          <small className="cn-hint">Applies immediately — there is no save step for slow mode.</small>
        </>
      ) : (
        <>
          <div className="ci-label">Pick a group</div>
          {candidates.length === 0 ? (
            <p className="cst-empty">
              You do not administer any group yet. Create one from Messages, then
              come back — a group can serve exactly one channel.
            </p>
          ) : candidates.map(g => (
            <div className="ca-row" key={g.id}>
              <Icon name="users"/>
              <div className="ca-row-body">
                <div className="ca-row-t"><bdi>{g.displayTitle}</bdi></div>
                <div className="ca-row-s">{g.memberCount || 0} members</div>
              </div>
              <button className="cn-btn primary" disabled={busy} onClick={() => link(g.id)}>Link</button>
            </div>
          ))}
        </>
      )}
    </div>
  )
}

/* ---------------------------------------------------------
   The shell.
   --------------------------------------------------------- */
export function ChannelManage({ channel, onClose, onChanged }) {
  const { myId, subscribe } = useChat()
  const [tab, setTab] = React.useState('info')
  const [me, setMe] = React.useState(null)          // my own admin row → my rights
  const [state, setState] = React.useState('loading')

  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      /* A stacked layer (rights editor, add-admin picker, confirm dialog) owns
         this press. Those listeners were added AFTER this one and run later —
         stopPropagation cannot shield them — so the shell simply declines to
         close while anything sits above it. */
      if (document.querySelectorAll('.ch-modal-overlay').length > 1) return
      if (document.querySelector('.dlg-overlay')) return
      e.stopPropagation()
      onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /* My rights come off the admin list, not off `myRole`: "ADMIN" says nothing
     about WHICH rights I hold, and every tab below is gated on a specific one. */
  React.useEffect(() => {
    let alive = true
    api.channels.admins.list(channel.id)
      .then(rows => {
        if (!alive) return
        setMe(rows.find(a => String(a.userId) === String(myId)) || null)
        setState('ready')
      })
      .catch(() => { if (alive) { setMe(null); setState('ready') } })
    return () => { alive = false }
  }, [channel.id, myId])

  /* Memoised because the effect below depends on it — a fresh array every
     render would re-run that effect on every keystroke inside a tab.
     The 5th column is the pane's one-line description, rendered in the
     editorial header so every destination opens the same way. */
  const TABS = React.useMemo(() => {
    const owner = me?.isOwner
    const may = (key) => !!me && (owner || me.rights[key] !== false)
    return [
      ['info',      'Info',     'edit',      may('canChangeInfo'),
        'The channel’s public identity — what people see before they subscribe.'],
      ['settings',  'Settings', 'settings',  may('canChangeInfo'),
        'How the channel behaves for its subscribers.'],
      ['admins',    'Admins',   'shield',    !!me,
        'Rights only ever remove capability — a new admin starts with all of them.'],
      ['subscribers','Subscribers','users',  !!me,
        'Everyone who is in — and the door for letting people in or showing them out.'],
      ['invites',   'Invites',  'link',      may('canInviteUsers'),
        'Private doors into the channel — each link admits people on its own terms.'],
      ['requests',  'Requests', 'hourglass', may('canApproveJoinRequests'),
        'People waiting for a decision.'],
      ['discussion','Comments', 'comment',   may('canChangeInfo'),
        'Link a group and replies to posts become threaded comments in it.'],
      ['stats',     'Statistics','trending', !!me,
        'How the channel is growing and being read.'],
    ].filter(t => t[3])
  }, [me])

  // A tab can vanish (rights edited elsewhere) — never leave the shell pointing
  // at one that is no longer rendered.
  React.useEffect(() => {
    if (state === 'ready' && TABS.length && !TABS.some(t => t[0] === tab)) setTab(TABS[0][0])
  }, [state, TABS, tab])

  return (
    <div className="ch-modal-overlay cm-overlay" role="dialog" aria-modal="true"
      aria-label={`Manage ${channel.title}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="ch-modal cm-modal">
        <div className="ch-modal-head cm-head">
          {/* the channel's own crest, not a generic gear — the console header
              carries the same identity as the profile masthead and the card */}
          <div className={'cm-head-mark tint-' + tintOf(channel.id)} aria-hidden="true">
            {channel.avatarUrl ? <img src={channel.avatarUrl} alt=""/> : crestOf(channel)}
          </div>
          <div className="cm-head-t">
            <span className="cm-head-k">Manage channel</span>
            {/* fit-content box: an RTL title stays anchored under the kicker
                instead of stranding at the h3's far right edge */}
            <h3 dir="auto" title={channel.title}>{channel.title}</h3>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close">
            <Icon name="close" className="sm"/>
          </button>
        </div>

        {state === 'loading' ? (
          <div className="ch-modal-body"><Loader label="Checking your rights…"/></div>
        ) : !me ? (
          <div className="ch-modal-body">
            <p className="cst-empty">
              You are not an admin of this channel — there is nothing here to manage.
            </p>
          </div>
        ) : (
          <div className="cm-split">
            {/* A nav of destinations, not a tablist: the panes swap wholesale
                like pages, and plain nav semantics need no roving-tabindex
                machinery. Desktop: a vertical rail — all destinations visible.
                ≤720px: the horizontal pill rail, active pill kept in view. */}
            <nav className="cm-tabs" aria-label="Channel management">
              {TABS.map(([key, label, icon]) => (
                <button key={key} aria-current={tab === key ? 'page' : undefined}
                  className={'cm-tab-btn' + (tab === key ? ' on' : '')}
                  onClick={(e) => {
                    setTab(key)
                    e.currentTarget.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' })
                  }}>
                  <Icon name={icon} className="xs"/>{label}
                </button>
              ))}
            </nav>

            <div className="ch-modal-body cm-body">
              {/* keyed: the header + pane rise together on every switch */}
              <div className="cm-pane" key={tab}>
                <header className="cm-pane-head">
                  <h4>{TABS.find(t => t[0] === tab)?.[1]}</h4>
                  <p>{TABS.find(t => t[0] === tab)?.[4]}</p>
                </header>
                {tab === 'info'       && <InfoTab channel={channel} onChanged={onChanged}/>}
                {tab === 'settings'   && <SettingsTab channel={channel} onChanged={onChanged}/>}
                {tab === 'admins'     && <ChannelAdmins channel={channel} myId={myId}/>}
                {tab === 'subscribers'&& <ChannelSubscribers channel={channel} myId={myId} me={me} subscribe={subscribe}/>}
                {tab === 'invites'    && <ChannelInvites channel={channel}/>}
                {tab === 'requests'   && <ChannelRequests channel={channel} subscribe={subscribe}/>}
                {tab === 'discussion' && <DiscussionTab channel={channel} onChanged={onChanged}/>}
                {tab === 'stats'      && <ChannelStats channel={channel}/>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default ChannelManage
