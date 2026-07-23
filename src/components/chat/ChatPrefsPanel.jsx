/* =========================================================
   ChatPrefsPanel — the three chat privacy switches.
   ---------------------------------------------------------
   Read receipts and last-seen are RECIPROCAL: you can never take
   a signal you refuse to give. Turn receipts off and you stop
   sending blue ticks AND stop seeing everyone else's; hide your
   last-seen and you stop seeing theirs. Typing is the odd one
   out — one-directional, so turning it off only silences your
   own outbound events.

   That asymmetry is the whole reason this panel exists as a
   separate surface with explanatory copy instead of three bare
   toggles in a settings list: a user who reads "read receipts"
   as "what I broadcast" will be surprised when other people's
   ticks vanish too. Every switch here states BOTH halves.

   These compose with — never override — the relationship-level
   suppression already applied for a pending message request, a
   RESTRICTED thread, or a block.
   ========================================================= */
import React from 'react'
import { Icon } from '../ui.jsx'
import { useChat } from '../../context/ChatContext.jsx'
import { Switch } from './Switch.jsx'

const ROWS = [
  {
    key: 'readReceiptsEnabled',
    icon: 'checks',
    title: 'Read receipts',
    on: 'You send read and delivered ticks, appear in group “Seen by”, and see all of that from people who also share.',
    off: 'No ticks in either direction. You won’t see when your messages are read, and nobody sees when you read theirs.',
  },
  {
    key: 'lastSeenVisible',
    icon: 'clock',
    title: 'Last seen',
    on: 'Your last-seen time is visible to your contacts, and theirs to you.',
    off: 'Your last-seen is hidden — and you stop seeing anyone else’s. The online dot still shows either way.',
  },
  {
    key: 'typingIndicatorsEnabled',
    icon: 'edit',
    title: 'Typing indicators',
    on: 'People see “typing…”, “recording a voice note”, and the rest while you compose.',
    off: 'You never broadcast a typing indicator. You still see other people’s.',
  },
]

export function ChatPrefsPanel({ onClose }) {
  const { chatSettings, updateChatSettings } = useChat()
  const [busy, setBusy] = React.useState(null)

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const flip = async (key, value) => {
    setBusy(key)
    try { await updateChatSettings({ [key]: value }) }
    catch { /* the context rolls back and toasts */ }
    finally { setBusy(null) }
  }

  return (
    <div className="ch-search ch-prefs" role="region" aria-label="Chat privacy">
      <div className="ch-search-head">
        <h3><Icon name="lock" className="sm"/>Chat privacy</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Close chat privacy" title="Close">
          <Icon name="close" className="sm"/>
        </button>
      </div>

      <div className="ch-search-body">
        <p className="ch-search-hint">
          Read receipts and last seen are reciprocal — switching one off stops it
          in <em>both</em> directions.
        </p>

        {ROWS.map(row => {
          const on = chatSettings?.[row.key] !== false
          return (
            <div className={'ci-row ch-prefrow' + (on ? '' : ' off')} key={row.key}>
              <Icon name={row.icon}/>
              <div className="ci-row-body">
                <div className="ci-row-title">{row.title}</div>
                <div className="ci-row-sub">{on ? row.on : row.off}</div>
              </div>
              <Switch
                on={on}
                disabled={busy === row.key}
                onChange={(v) => flip(row.key, v)}
                label={row.title}
              />
            </div>
          )
        })}

        <p className="ch-prefs-foot">
          These sit on top of the protections that always apply: someone whose
          message request you haven’t accepted, a member you’ve restricted, and
          anyone you’ve blocked never see your receipts, typing or presence.
        </p>
      </div>
    </div>
  )
}

export default ChatPrefsPanel
