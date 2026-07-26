/* =========================================================
   Invite links — many at once, each revocable on its own
   ---------------------------------------------------------
   The single fact this panel is built around: the plaintext
   token comes back EXACTLY ONCE, on create. Only a hash is
   stored, so `GET /invite-links` returns metadata with no token
   and the link can never be recovered — not by an admin, not by
   support, not by re-reading the row.

   That drives three decisions here:
     · a freshly-created link is pinned at the top with its URL
       visible and pre-selected, and it says the link cannot be
       shown again;
     · older rows show what the link IS (uses, expiry, approval)
       and offer revoke, never "copy";
     · revoking is offered without a confirm on a link that has
       never been used, and with one on a link people are
       actively joining through.

   A link dies three different ways — revoked, expired,
   exhausted — and "revoked" is the only one anybody did on
   purpose, so the row names which.
   ========================================================= */
import React from 'react'
import { Icon, showToast } from '../ui.jsx'
import { Loader, ErrorState } from '../states.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { api } from '../../api/index.js'
import { chatError } from '../chat/chatErrors.js'
import { dateLabel, untilLabel } from './channelArt.js'

const EXPIRY_PRESETS = [
  [null, 'Never'],
  [1, '1 hour'],
  [24, '1 day'],
  [168, '1 week'],
  [720, '30 days'],
]

const USE_PRESETS = [
  [null, 'Unlimited'],
  [1, '1 use'],
  [10, '10 uses'],
  [100, '100 uses'],
]

/** What killed this link, or null while it still works. */
function deadReason(link) {
  if (link.revoked) return 'Revoked'
  if (link.expired) return 'Expired'
  if (link.exhausted) return 'Use limit reached'
  return null
}

function LinkRow({ link, onRevoke, fresh }) {
  const dead = deadReason(link)
  const inputRef = React.useRef(null)

  // A brand-new link is the one moment its URL exists in the client. Select it
  // so a single ⌘C works even if the copy button is missed.
  React.useEffect(() => {
    if (fresh && inputRef.current) { inputRef.current.focus(); inputRef.current.select() }
  }, [fresh])

  const copy = async () => {
    try { await navigator.clipboard.writeText(link.shareUrl || link.token); showToast('Link copied') }
    catch { showToast('Could not copy — select the link and copy it by hand') }
  }

  return (
    <div className={'cil-row' + (dead ? ' dead' : '') + (fresh ? ' fresh' : '')}>
      <div className="cil-main">
        {fresh && link.shareUrl ? (
          <>
            <div className="cil-fresh-label">
              <Icon name="check" className="xs"/>New link — copy it now
            </div>
            <div className="cil-url">
              <input ref={inputRef} className="field" readOnly value={link.shareUrl} dir="ltr"
                onFocus={e => e.target.select()} aria-label="Invite link"/>
              <button className="cn-btn primary" onClick={copy}>
                <Icon name="copy" className="xs"/>Copy
              </button>
            </div>
            <p className="cil-once">
              This is the only time the link is shown — for security it can never
              be recovered, not even by you. If you lose it, create a new one.
            </p>
          </>
        ) : (
          <div className="cil-title">
            <Icon name="link" className="xs"/>
            {dead ? <s>Invite link</s> : 'Invite link'}
            {link.requiresApproval && <span className="cn-tag"><Icon name="hourglass" className="xs"/>Needs approval</span>}
            {dead && <span className="cn-tag dead">{dead}</span>}
          </div>
        )}

        <div className="cil-meta">
          <span><b>{link.useCount}</b>{link.maxUses != null ? ` of ${link.maxUses}` : ''} used</span>
          <span className="cp-dot">·</span>
          <span>
            {link.expiresAt ? `expires ${untilLabel(link.expiresAt)}` : 'never expires'}
          </span>
          {link.createdAt && <><span className="cp-dot">·</span><span>made {dateLabel(link.createdAt)}</span></>}
        </div>
      </div>

      {!dead && (
        <button className="icon-btn danger" title="Revoke" aria-label="Revoke this invite link"
          onClick={() => onRevoke(link)}>
          <Icon name="block" className="sm"/>
        </button>
      )}
    </div>
  )
}

export function ChannelInvites({ channel }) {
  const [rows, setRows] = React.useState([])
  const [state, setState] = React.useState('loading')
  const [fresh, setFresh] = React.useState(null)      // the one link whose token we hold
  const [expiry, setExpiry] = React.useState(168)
  const [uses, setUses] = React.useState(null)
  const [approval, setApproval] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    setState('loading')
    try { setRows(await api.channels.invites.list(channel.id)); setState('ready') }
    catch { setState('error') }
  }, [channel.id])

  React.useEffect(() => { load() }, [load])

  const create = async () => {
    setBusy(true)
    try {
      const link = await api.channels.invites.create(channel.id, {
        expiresInHours: expiry ?? undefined,
        maxUses: uses ?? undefined,
        requiresApproval: approval,
      })
      setFresh(link)
      // The list row for it has no token, so keep the fresh one separate rather
      // than merging — merging would drop the URL the admin still needs.
      setRows(prev => [link, ...prev.filter(r => r.id !== link.id)])
      setState('ready')
    } catch (e) {
      showToast(chatError(e, 'Could not create an invite link'))
    } finally { setBusy(false) }
  }

  const revoke = async (link) => {
    if (link.useCount > 0) {
      const ok = await uiConfirm({
        title: 'Revoke this link?',
        message: `${link.useCount} ${link.useCount === 1 ? 'person has' : 'people have'} already joined through it. They stay — the link simply stops working for anyone else.`,
        confirmLabel: 'Revoke', danger: true, icon: 'block',
      })
      if (!ok) return
    }
    try {
      await api.channels.invites.revoke(channel.id, link.id)
      setRows(prev => prev.map(r => (r.id === link.id ? { ...r, revoked: true } : r)))
      if (fresh?.id === link.id) setFresh(null)
      showToast('Link revoked')
    } catch (e) { showToast(chatError(e, 'Could not revoke the link')) }
  }

  const live = rows.filter(r => !deadReason(r))
  const dead = rows.filter(r => deadReason(r))

  return (
    <div className="cil">
      <div className="cil-make">
        <div className="ci-label">Create a link</div>

        <div className="cil-opts">
          <div className="cil-opt">
            <span className="cil-opt-l">Expires</span>
            <div className="cn-filters" role="group" aria-label="Link expiry">
              {EXPIRY_PRESETS.map(([h, label]) => (
                <button key={label} className={'cn-chip' + (expiry === h ? ' on' : '')}
                  aria-pressed={expiry === h} onClick={() => setExpiry(h)}>{label}</button>
              ))}
            </div>
          </div>

          <div className="cil-opt">
            <span className="cil-opt-l">Uses</span>
            <div className="cn-filters" role="group" aria-label="Maximum uses">
              {USE_PRESETS.map(([n, label]) => (
                <button key={label} className={'cn-chip' + (uses === n ? ' on' : '')}
                  aria-pressed={uses === n} onClick={() => setUses(n)}>{label}</button>
              ))}
            </div>
          </div>
        </div>

        <div className="ci-row">
          <Icon name="hourglass"/>
          <div className="ci-row-body">
            <div className="ci-row-title">Review before letting people in</div>
            <div className="ci-row-sub">
              Anyone using this link waits for an admin’s approval instead of
              joining right away. Each attempt still counts toward the use limit.
            </div>
          </div>
          <button type="button" className={'ci-switch' + (approval ? ' on' : '')}
            role="switch" aria-checked={approval} aria-label="Require approval"
            onClick={() => setApproval(v => !v)}/>
        </div>

        <button className="btn btn-primary" disabled={busy} onClick={create}>
          {busy ? 'Creating…' : 'Create invite link'}
        </button>
      </div>

      {state === 'loading' && <Loader label="Loading links…"/>}
      {state === 'error' && <ErrorState message="The invite links could not be loaded." onRetry={load}/>}

      {state === 'ready' && (
        <>
          {live.length === 0 && !fresh && (
            <p className="cst-empty">No links are live. Create one above — you can have as many as you like, and revoke any of them on its own.</p>
          )}
          {live.map(l => (
            <LinkRow key={l.id} link={l} onRevoke={revoke} fresh={fresh?.id === l.id}/>
          ))}

          {!!dead.length && (
            <details className="cil-dead">
              <summary>{dead.length} link{dead.length === 1 ? '' : 's'} no longer working</summary>
              {dead.map(l => <LinkRow key={l.id} link={l} onRevoke={revoke}/>)}
            </details>
          )}
        </>
      )}
    </div>
  )
}

export default ChannelInvites
