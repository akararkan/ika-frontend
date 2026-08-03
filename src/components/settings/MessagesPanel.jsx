/* =========================================================
   Settings v2 — Messages panel. The `messages` cosmetic block
   (wallpaper / chatTheme / fontSize / enterToSend) edited
   optimistically through useSection('messages'). The backend
   stores the block verbatim and interprets none of it, so the
   card owns the WRITE and lib/chatPrefs.js owns the APPLY —
   both read the same resolver, which is why the preview below
   cannot drift from what a real conversation renders.
   Every edit is a partial PATCH; the whole-block PUT is used
   by nothing but "Reset to defaults", which is the one write
   that really does mean "replace the block".
   ========================================================= */
import React from 'react'
import { Icon, showToast } from '../ui.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { Loader, ErrorState } from '../states.jsx'
import { api } from '../../api/index.js'
import { SetCard, SubHead, ToggleRow, Seg, ControlRow, useSection } from './shared.jsx'
import { PREFS_EVENT } from '../../lib/prefs.js'
import {
  MESSAGE_DEFAULTS, WALLPAPER_PRESETS, CHAT_THEME_TINT,
  applyChatPrefs, resolveChatPrefs,
} from '../../lib/chatPrefs.js'

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
      await api.settings.replaceSection('messages', MESSAGE_DEFAULTS)
      showToast('Settings reset')
      onDone()
    } catch (e) {
      if (e?.status !== 429) showToast('Could not reset', 'err')   // 429 toasts globally
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

/* A sample of the three cosmetic values, drawn from resolveChatPrefs — the
   same function chatPrefs.js paints the real thread with — so nobody has to
   open a conversation to find out what a swatch does. Only the incoming
   bubble carries the theme tint, exactly as the applier does it. */
function ChatPreview({ prefs, themeLabel, sizeLabel, wallpaperLabel }) {
  const bubble = {
    maxWidth: '76%', padding: '8px 12px 7px', borderRadius: 16,
    fontSize: Math.round(15 * prefs.fontScale * 10) / 10, lineHeight: 1.5,
  }
  return (
    <div
      role="img"
      aria-label={`Preview: ${themeLabel} theme, ${sizeLabel} text, ${wallpaperLabel} wallpaper`}
      style={{
        display: 'flex', flexDirection: 'column', gap: 8,
        margin: '10px 0 2px', padding: '13px 14px', borderRadius: 12,
        border: '1px solid var(--line)',
        background: prefs.wallpaper || 'var(--paper-2)',
      }}
    >
      <span style={{
        ...bubble, alignSelf: 'flex-start', color: 'var(--ink)',
        background: CHAT_THEME_TINT[prefs.theme] || 'var(--card)',
        border: '1px solid var(--line)',
      }}>
        Have you seen the new folio?
      </span>
      {/* the FIXED ramp, not --navy: --navy resolves to Sky under
          data-theme="dark" (theme.css:310), which would put off-white ink on
          a near-white plate. dark.css:196 re-plates the real bubble; a two-
          line sample does not need the same machinery to stay legible. */}
      <span style={{
        ...bubble, alignSelf: 'flex-end', background: 'var(--ox-blue)', color: 'var(--ox-off-white)',
      }}>
        Reading it now.
      </span>
    </div>
  )
}

export function MessagesPanel() {
  const [gen, setGen] = React.useState(0)
  /* The PUT goes round useSection, which is what normally fires PREFS_EVENT
     after a cosmetic write — without this the appliers listening for it (and
     their localStorage caches) would keep painting the pre-reset block until
     the next full reload. */
  return <MessagesCard key={gen} onReset={() => {
    window.dispatchEvent(new Event(PREFS_EVENT))
    setGen(g => g + 1)
  }}/>
}

function MessagesCard({ onReset }) {
  const { block, setField, statusOf, loading, error, retry } = useSection('messages')
  const [customHex, setCustomHex] = React.useState(null)
  const timerRef = React.useRef(null)
  React.useEffect(() => () => clearTimeout(timerRef.current), [])

  /* Apply what the card is showing. `block` is replaced on every optimistic
     edit, so the running app follows the controls immediately instead of
     waiting for a reload — and a failed PATCH reverts here too.
     NOT on `error`: useSection hands back an empty block on a failed load,
     and applying that would silently repaint chat in the defaults the user
     never chose. Same rule as loadAndApplyChatPrefs — a failure leaves the
     DOM exactly as it was. */
  React.useEffect(() => { if (block && !error) applyChatPrefs(block) }, [block, error])

  if (loading) {
    return (
      <SetCard id="messages" icon="message" title="Messages">
        <Loader/>
      </SetCard>
    )
  }
  /* Never render the defaults as though they were the saved values — see the
     same guard in AppearancePanel. */
  if (error) {
    return (
      <SetCard id="messages" icon="message" title="Messages">
        <ErrorState message="Could not load your message settings" onRetry={retry}/>
      </SetCard>
    )
  }

  const wallpaper = block?.wallpaper ?? 'DEFAULT'
  const chatTheme = block?.chatTheme ?? 'DEFAULT'
  const fontSize = block?.fontSize ?? 'MEDIUM'
  const enterToSend = block?.enterToSend ?? true
  const prefs = resolveChatPrefs(block)

  const isPreset = (hex) => WALLPAPER_PRESETS.some(([, v]) => v.toLowerCase() === String(hex).toLowerCase())
  const customOn = wallpaper !== 'DEFAULT' && !isPreset(wallpaper) && !!prefs.wallpaper
  /* The wire also allows a media id ("a media id, a preset key, or a hex
     colour"), which another client can write and this one cannot paint. */
  const unpaintable = wallpaper !== 'DEFAULT' && !prefs.wallpaper
  /* Spoken name for the preview — the swatches are the only visual cue, so
     the sample has to say which one is on. */
  const wallpaperLabel = unpaintable ? 'unavailable'
    : WALLPAPER_PRESETS.find(([, v]) => v.toLowerCase() === wallpaper.toLowerCase())?.[2].toLowerCase()
      ?? (customOn ? 'custom colour' : 'default')

  const pickCustom = (e) => {
    const hex = e.target.value
    setCustomHex(hex)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setField('wallpaper', hex), 400)
  }
  /* Every non-custom pick has to KILL the pending debounce: dragging the
     colour picker and then clicking a preset inside 400ms would otherwise
     let the stale custom write land last and win. Dropping customHex at the
     same time stops the picker swatch showing a colour that is no longer the
     wallpaper. */
  const chooseWallpaper = (value) => {
    clearTimeout(timerRef.current)
    setCustomHex(null)
    if (wallpaper !== value) setField('wallpaper', value)
  }

  return (
    <SetCard id="messages" icon="message" title="Messages"
      sub="Saved to your account and synced to every device you sign in on.">

      <ToggleRow
        title="Enter sends the message"
        desc="When off, Enter starts a new line instead. Saved and synced now — the message composer does not read it yet, so on a keyboard Enter still sends."
        on={enterToSend}
        status={statusOf('enterToSend')}
        onToggle={() => setField('enterToSend', !enterToSend)}
      />

      <SubHead>Chat appearance</SubHead>
      <ChatPreview
        prefs={prefs}
        themeLabel={{ DEFAULT: 'Classic', OXFORD: 'Oxford', SKY: 'Sky' }[prefs.theme]}
        sizeLabel={{ SMALL: 'small', MEDIUM: 'medium', LARGE: 'large' }[String(fontSize).toUpperCase()] || 'medium'}
        wallpaperLabel={wallpaperLabel}
      />

      <ControlRow title="Font size" desc="Text size inside conversations." status={statusOf('fontSize')}>
        <Seg ariaLabel="Font size" value={fontSize}
          options={[['SMALL', 'Small'], ['MEDIUM', 'Medium'], ['LARGE', 'Large']]}
          onChange={(v) => setField('fontSize', v)}
        />
      </ControlRow>

      <ControlRow title="Chat theme"
        desc="Tints the bubbles from the person you are talking to. Your own stay Oxford Blue."
        status={statusOf('chatTheme')}>
        <Seg ariaLabel="Chat theme" value={chatTheme}
          options={[['DEFAULT', 'Classic'], ['OXFORD', 'Oxford'], ['SKY', 'Sky']]}
          onChange={(v) => setField('chatTheme', v)}
        />
      </ControlRow>

      <ControlRow title="Chat wallpaper" desc="A flat colour behind your conversations."
        status={statusOf('wallpaper')}>
        <div className="flex gap-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" title="Default" aria-label="Default wallpaper"
            aria-pressed={wallpaper === 'DEFAULT'}
            style={swatchStyle(
              'linear-gradient(135deg, #fff 46%, var(--ox-stone) 46%, var(--ox-stone) 54%, #fff 54%)',
              wallpaper === 'DEFAULT')}
            onClick={() => chooseWallpaper('DEFAULT')}
          />
          {WALLPAPER_PRESETS.map(([key, hex, name]) => {
            /* the value written is the HEX, not the key — chatPrefs.js reads
               both, but a colour needs no resolution step to paint */
            const on = wallpaper.toLowerCase() === hex.toLowerCase()
            return (
              <button key={key} type="button" title={name} aria-label={`${name} wallpaper`}
                aria-pressed={on}
                style={swatchStyle(hex, on)}
                onClick={() => chooseWallpaper(hex)}
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

      {unpaintable && (
        <div className="stx-note info">
          <Icon name="info"/>
          <span>Your wallpaper was set on another device to something this one cannot draw — an image, or a
            pattern it does not know. It stays saved and synced, but conversations here show the plain
            background until you pick a colour above.</span>
        </div>
      )}

      <ResetToDefaults onDone={onReset}/>
    </SetCard>
  )
}
