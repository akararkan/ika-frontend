/* =========================================================
   Settings — Appearance & Accessibility (cosmetic sections).
   Both blocks sync verbatim through /settings/{section}: the
   backend stores them and never interprets them — applying
   them to the running app is the prefs applier's job, so a
   reset fires `ika:prefs-changed` for it to pick up. Edits
   are optimistic JSON Merge Patches via useSection
   (shared.jsx); the whole-block PUT is used by nothing but
   "Reset to defaults", which is exactly what it wants.

   COPY RULE FOR THIS CARD: lib/prefs.js is the only consumer,
   and only five things reach the screen — theme, density,
   contrast, reduced motion and the font/scale trio (prefs.css).
   prefersHaptics() and prefersCaptions() exist beside them but
   have no caller yet, so those two rows are stored-and-synced
   like accentColor, screenReader and voiceNavigation. Every row
   in the second group has to SAY it does nothing: a control that
   silently no-ops reads as a bug and sends people hunting for
   the effect they were promised. When a caller lands (haptic()
   at MessageBubble.jsx:357, a <track> on the video players),
   delete that sentence — it is the only copy that goes stale.
   ========================================================= */
import React from 'react'
import { Icon, showToast } from '../ui.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { Loader, ErrorState } from '../states.jsx'
import { api } from '../../api/index.js'
import { SetCard, ToggleRow, Seg, ControlRow, useSection } from './shared.jsx'

const DEFAULT_ACCENT = '#1B7F5A'

/* The exact entity defaults. PUT replaces the WHOLE block (omitted keys become
   null server-side), so these objects must stay complete. */
const APPEARANCE_DEFAULTS = {
  theme: 'SYSTEM', fontSize: 'MEDIUM', density: 'COMFORTABLE',
  interfaceScale: 1.0, reducedMotion: false, accentColor: DEFAULT_ACCENT,
}
const ACCESSIBILITY_DEFAULTS = {
  largeText: false, highContrast: false, screenReader: false, closedCaptions: false,
  reducedMotion: false, voiceNavigation: false, hapticFeedback: true,
}

/** Whole-block reset. The parent remounts its card on success, so useSection
 *  re-reads the section and every control shows the reset value. */
function ResetToDefaults({ section, name, defaults, onDone }) {
  const [busy, setBusy] = React.useState(false)
  const alive = React.useRef(true)
  React.useEffect(() => () => { alive.current = false }, [])

  const run = async () => {
    const ok = await uiConfirm({
      title: `Reset ${name} settings?`,
      message: 'Every option in this section goes back to its default. Other settings are untouched.',
      confirmLabel: 'Reset',
      icon: 'refresh',
    })
    if (!ok) return
    setBusy(true)
    try {
      await api.settings.replaceSection(section, defaults)
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

/* Colour pickers fire change events continuously while dragging, so the
   swatch edits locally and commits once on blur (picker closed). */
function AccentControl({ value, onCommit }) {
  const [v, setV] = React.useState(value)
  React.useEffect(() => { setV(value) }, [value])
  return (
    <div className="flex gap-8" style={{ alignItems: 'center' }}>
      <input
        type="color" className="field" style={{ width: 64, padding: 4, height: 38 }}
        aria-label="Accent colour" value={v}
        onChange={e => setV(e.target.value)}
        onBlur={() => { if (v !== value) onCommit(v) }}
      />
      <button type="button" className="btn btn-ghost btn-sm"
        onClick={() => { setV(DEFAULT_ACCENT); if (value !== DEFAULT_ACCENT) onCommit(DEFAULT_ACCENT) }}>
        Reset
      </button>
    </div>
  )
}

export function AppearancePanel() {
  const [gen, setGen] = React.useState(0)
  return <AppearanceCard key={gen} onReset={() => {
    window.dispatchEvent(new Event('ika:prefs-changed'))
    setGen(g => g + 1)
  }}/>
}

function AppearanceCard({ onReset }) {
  const { block, setField, statusOf, loading, error, retry } = useSection('appearance')
  if (loading) {
    return <SetCard id="appearance" icon="sparkle" title="Appearance"><Loader/></SetCard>
  }
  /* A failed load must NOT render the compiled-in defaults: every control
     would claim a value the account does not hold, and the person would
     "correct" settings that never arrived. */
  if (error) {
    return (
      <SetCard id="appearance" icon="sparkle" title="Appearance">
        <ErrorState message="Could not load your appearance settings" onRetry={retry}/>
      </SetCard>
    )
  }
  const theme = block.theme ?? 'SYSTEM'
  const fontSize = block.fontSize ?? 'MEDIUM'
  const density = block.density ?? 'COMFORTABLE'
  const scale = Number(block.interfaceScale ?? 1)          // stored 1 or 1.0 — Seg compares with ===
  const accent = block.accentColor ?? DEFAULT_ACCENT
  return (
    <SetCard id="appearance" icon="sparkle" title="Appearance"
      sub="These preferences are saved to your account and sync to every device you sign in on.">
      <ControlRow title="Theme" desc="System follows your device setting. Changes take effect straight away."
        status={statusOf('theme')}>
        <Seg ariaLabel="Theme" value={theme}
          options={[['SYSTEM', 'System'], ['LIGHT', 'Light'], ['DARK', 'Dark']]}
          onChange={v => setField('theme', v)}/>
      </ControlRow>
      {/* NO "dark mode is unfinished" caveat here. theme.css:295 carries the
          token remap and warm/dark.css is the repair layer for the literals
          that could not follow it — both shipped, and it loads last in the
          warm layer. A warning on a finished feature is its own dishonesty. */}
      <ControlRow title="Text size" desc="Base size for body text across the app."
        status={statusOf('fontSize')}>
        <Seg ariaLabel="Text size" value={fontSize}
          options={[['SMALL', 'Small'], ['MEDIUM', 'Medium'], ['LARGE', 'Large'], ['XLARGE', 'Extra large']]}
          onChange={v => setField('fontSize', v)}/>
      </ControlRow>
      <ControlRow title="Density" desc="Compact tightens spacing to fit more on screen."
        status={statusOf('density')}>
        <Seg ariaLabel="Density" value={density}
          options={[['COMFORTABLE', 'Comfortable'], ['COMPACT', 'Compact']]}
          onChange={v => setField('density', v)}/>
      </ControlRow>
      <ControlRow title="Interface scale" desc="Scales body text everywhere, on top of the text size above."
        status={statusOf('interfaceScale')}>
        <Seg ariaLabel="Interface scale" value={scale}
          options={[[0.9, '90%'], [1, '100%'], [1.1, '110%'], [1.25, '125%']]}
          onChange={v => setField('interfaceScale', v)}/>
      </ControlRow>
      <ToggleRow title="Reduced motion" desc="Minimise animations and transitions."
        on={!!block.reducedMotion} status={statusOf('reducedMotion')}
        onToggle={() => setField('reducedMotion', !block.reducedMotion)}/>
      <ControlRow title="Accent colour"
        desc="Stored and synced for surfaces that support a custom accent. Nothing in the current theme reads it yet, so you will not see a change."
        status={statusOf('accentColor')}>
        <AccentControl value={accent} onCommit={v => setField('accentColor', v)}/>
      </ControlRow>
      <ResetToDefaults section="appearance" name="appearance" defaults={APPEARANCE_DEFAULTS} onDone={onReset}/>
    </SetCard>
  )
}

export function AccessibilityPanel() {
  const [gen, setGen] = React.useState(0)
  return <AccessibilityCard key={gen} onReset={() => {
    window.dispatchEvent(new Event('ika:prefs-changed'))
    setGen(g => g + 1)
  }}/>
}

function AccessibilityCard({ onReset }) {
  const { block, setField, statusOf, loading, error, retry } = useSection('accessibility')
  if (loading) {
    return <SetCard id="accessibility" icon="eye" title="Accessibility"><Loader/></SetCard>
  }
  // Same reasoning as Appearance: defaults must never impersonate saved values.
  if (error) {
    return (
      <SetCard id="accessibility" icon="eye" title="Accessibility">
        <ErrorState message="Could not load your accessibility settings" onRetry={retry}/>
      </SetCard>
    )
  }
  /* Descriptions state what the client actually does with each flag. Three
     are real (largeText and highContrast are painted by prefs.css;
     reducedMotion kills the transitions). The other four are stored and
     synced only and say so — see the COPY RULE at the top of this file for
     the caller each of them is waiting on. */
  const rows = [
    ['largeText', 'Large text', 'Increase text size beyond the appearance setting.', false],
    ['highContrast', 'High contrast', 'Stronger borders and less muted text.', false],
    ['screenReader', 'Optimise for screen readers', 'Saved and synced. The app ships the same labels and landmarks either way, so this changes nothing on its own.', false],
    ['closedCaptions', 'Show closed captions on videos when available', 'Saved and synced, ready for when captions arrive. No video here carries a caption track yet, so there is nothing to switch on.', false],
    ['reducedMotion', 'Reduced motion', 'Minimise animations and transitions.', false],
    ['voiceNavigation', 'Voice navigation', 'A device preference this app records and syncs — it has no voice commands of its own.', false],
    ['hapticFeedback', 'Haptic feedback', 'Saved and synced. Nothing checks it yet, so the one buzz the app makes — holding a chat message — happens either way.', true],
  ]
  return (
    <SetCard id="accessibility" icon="eye" title="Accessibility"
      sub="These preferences are saved to your account and sync to every device you sign in on.">
      {rows.map(([key, title, desc, dflt]) => {
        const on = !!(block[key] ?? dflt)
        return (
          <ToggleRow key={key} title={title} desc={desc} on={on} status={statusOf(key)}
            onToggle={() => setField(key, !on)}/>
        )
      })}
      <ResetToDefaults section="accessibility" name="accessibility" defaults={ACCESSIBILITY_DEFAULTS} onDone={onReset}/>
    </SetCard>
  )
}
