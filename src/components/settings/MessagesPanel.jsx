/* =========================================================
   Settings v2 — Messages panel. The `messages` cosmetic block
   (wallpaper / chatTheme / fontSize / enterToSend) edited
   optimistically through useSection('messages'). Values sync
   verbatim; chat surfaces that support them apply them.
   Every edit is a partial PATCH; the whole-block PUT is used
   by nothing but "Reset to defaults", which is the one write
   that really does mean "replace the block".
   ========================================================= */
import React from 'react'
import { Icon, showToast } from '../ui.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { ErrorState } from '../states.jsx'
import { api } from '../../api/index.js'
import { SetCard, ToggleRow, Seg, ControlRow, useSection } from './shared.jsx'

/* The exact entity defaults — PUT nulls anything omitted, so keep this
   complete. */
const MESSAGES_DEFAULTS = {
  wallpaper: 'DEFAULT', chatTheme: 'DEFAULT', fontSize: 'MEDIUM', enterToSend: true,
}

const WALLPAPERS = [
  ['#F2F0F0', 'Porcelain'],
  ['#DCE9F6', 'Sky'],
  ['#E4EDE9', 'Sage'],
  ['#F5EAD7', 'Parchment'],
]

const swatchStyle = (bg, on) => ({
  width: 28, height: 28, borderRadius: '50%', padding: 0, flex: 'none',
  background: bg, cursor: 'pointer',
  border: on ? '2px solid var(--ox-blue-link)' : '1px solid var(--ox-stone)',
})

/** Whole-block reset. The panel remounts its card on success, so useSection
 *  re-reads the section and every control shows the reset value. */
function ResetToDefaults({ onDone }) {
  const [busy, setBusy] = React.useState(false)
  const alive = React.useRef(true)
  React.useEffect(() => () => { alive.current = false }, [])

  const run = async () => {
    const ok = await uiConfirm({
      title: 'Reset message settings?',
      message: 'Every option in this section goes back to its default. Other settings are untouched.',
      confirmLabel: 'Reset',
      icon: 'refresh',
    })
    if (!ok) return
    setBusy(true)
    try {
      await api.settings.replaceSection('messages', MESSAGES_DEFAULTS)
      showToast('Settings reset')
      onDone()
    } catch (e) {
      if (e?.status !== 429) showToast('Could not reset')       // 429 toasts globally
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  return (
    <div className="set-actions">
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={run}>
        <Icon name="refresh" className="xs"/>{busy ? 'Resetting…' : 'Reset to defaults'}
      </button>
    </div>
  )
}

export function MessagesPanel() {
  const [gen, setGen] = React.useState(0)
  return <MessagesCard key={gen} onReset={() => setGen(g => g + 1)}/>
}

function MessagesCard({ onReset }) {
  const { block, setField, loading, error, retry } = useSection('messages')
  const [customHex, setCustomHex] = React.useState(null)
  const timerRef = React.useRef(null)
  React.useEffect(() => () => clearTimeout(timerRef.current), [])

  if (loading) {
    return (
      <SetCard icon="message" title="Messages">
        <p className="muted text-sm">Loading…</p>
      </SetCard>
    )
  }
  /* Never render the defaults as though they were the saved values — see the
     same guard in AppearancePanel. */
  if (error) {
    return (
      <SetCard icon="message" title="Messages">
        <ErrorState message="Could not load your message settings" onRetry={retry}/>
      </SetCard>
    )
  }

  const wallpaper = block?.wallpaper ?? 'DEFAULT'
  const chatTheme = block?.chatTheme ?? 'DEFAULT'
  const fontSize = block?.fontSize ?? 'MEDIUM'
  const enterToSend = block?.enterToSend ?? true

  const isPreset = (hex) => WALLPAPERS.some(([v]) => v.toLowerCase() === String(hex).toLowerCase())
  const customOn = wallpaper !== 'DEFAULT' && !isPreset(wallpaper)

  const pickCustom = (e) => {
    const hex = e.target.value
    setCustomHex(hex)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setField('wallpaper', hex), 400)
  }

  return (
    <SetCard icon="message" title="Messages"
      sub="Synced across your devices; applied by chat surfaces that support them.">

      <ToggleRow
        title="Enter sends the message"
        desc="When off, Enter makes a new line instead."
        on={enterToSend}
        onToggle={() => setField('enterToSend', !enterToSend)}
      />

      <ControlRow title="Font size" desc="Text size inside conversations.">
        <Seg ariaLabel="Font size" value={fontSize}
          options={[['SMALL', 'Small'], ['MEDIUM', 'Medium'], ['LARGE', 'Large']]}
          onChange={(v) => setField('fontSize', v)}
        />
      </ControlRow>

      <ControlRow title="Chat theme" desc="Bubble and accent colors in chats.">
        <Seg ariaLabel="Chat theme" value={chatTheme}
          options={[['DEFAULT', 'Classic'], ['OXFORD', 'Oxford'], ['SKY', 'Sky']]}
          onChange={(v) => setField('chatTheme', v)}
        />
      </ControlRow>

      <ControlRow title="Chat wallpaper" desc="Background behind your conversations.">
        <div className="flex gap-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" title="Default" aria-label="Default wallpaper"
            aria-pressed={wallpaper === 'DEFAULT'}
            style={swatchStyle(
              'linear-gradient(135deg, #fff 46%, var(--ox-stone) 46%, var(--ox-stone) 54%, #fff 54%)',
              wallpaper === 'DEFAULT')}
            onClick={() => wallpaper !== 'DEFAULT' && setField('wallpaper', 'DEFAULT')}
          />
          {WALLPAPERS.map(([hex, name]) => {
            const on = wallpaper.toLowerCase() === hex.toLowerCase()
            return (
              <button key={hex} type="button" title={name} aria-label={`${name} wallpaper`}
                aria-pressed={on}
                style={swatchStyle(hex, on)}
                onClick={() => !on && setField('wallpaper', hex)}
              />
            )
          })}
          <input type="color" title="Custom color" aria-label="Custom wallpaper color"
            value={customHex ?? (customOn ? wallpaper : '#ffffff')}
            style={swatchStyle('none', customOn)}
            onChange={pickCustom}
          />
        </div>
      </ControlRow>

      <ResetToDefaults onDone={onReset}/>
    </SetCard>
  )
}
