/* =========================================================
   Settings — Appearance & Accessibility (cosmetic sections).
   Both blocks sync verbatim through /settings/{section}: the
   backend stores them and never interprets them — applying
   them to the running app is the prefs applier's job, so a
   reset fires `ika:prefs-changed` for it to pick up. Edits
   are optimistic JSON Merge Patches via useSection
   (shared.jsx); the whole-block PUT is used by nothing but
   "Reset to defaults", which is exactly what it wants.
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
  const { block, setField, loading, error, retry } = useSection('appearance')
  if (loading) {
    return <SetCard icon="sparkle" title="Appearance"><Loader/></SetCard>
  }
  /* A failed load must NOT render the compiled-in defaults: every control
     would claim a value the account does not hold, and the person would
     "correct" settings that never arrived. */
  if (error) {
    return (
      <SetCard icon="sparkle" title="Appearance">
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
    <SetCard icon="sparkle" title="Appearance"
      sub="These preferences are saved to your account and sync to every device you sign in on.">
      <ControlRow title="Theme" desc="System follows your device setting. Applies on your next visit.">
        <Seg ariaLabel="Theme" value={theme}
          options={[['SYSTEM', 'System'], ['LIGHT', 'Light'], ['DARK', 'Dark']]}
          onChange={v => setField('theme', v)}/>
      </ControlRow>
      <ControlRow title="Text size" desc="Base size for body text across the app.">
        <Seg ariaLabel="Text size" value={fontSize}
          options={[['SMALL', 'Small'], ['MEDIUM', 'Medium'], ['LARGE', 'Large'], ['XLARGE', 'Extra large']]}
          onChange={v => setField('fontSize', v)}/>
      </ControlRow>
      <ControlRow title="Density" desc="Compact tightens spacing to fit more on screen.">
        <Seg ariaLabel="Density" value={density}
          options={[['COMFORTABLE', 'Comfortable'], ['COMPACT', 'Compact']]}
          onChange={v => setField('density', v)}/>
      </ControlRow>
      <ControlRow title="Interface scale" desc="Scales the whole interface, not just text.">
        <Seg ariaLabel="Interface scale" value={scale}
          options={[[0.9, '90%'], [1, '100%'], [1.1, '110%'], [1.25, '125%']]}
          onChange={v => setField('interfaceScale', v)}/>
      </ControlRow>
      <ToggleRow title="Reduced motion" desc="Minimise animations and transitions."
        on={!!block.reducedMotion} onToggle={() => setField('reducedMotion', !block.reducedMotion)}/>
      <ControlRow title="Accent colour" desc="Used for highlights and controls where a custom accent is supported.">
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
  const { block, setField, loading, error, retry } = useSection('accessibility')
  if (loading) {
    return <SetCard icon="eye" title="Accessibility"><Loader/></SetCard>
  }
  // Same reasoning as Appearance: defaults must never impersonate saved values.
  if (error) {
    return (
      <SetCard icon="eye" title="Accessibility">
        <ErrorState message="Could not load your accessibility settings" onRetry={retry}/>
      </SetCard>
    )
  }
  const rows = [
    ['largeText', 'Large text', 'Increase text size beyond the appearance setting.', false],
    ['highContrast', 'High contrast', 'Stronger colours and borders for readability.', false],
    ['screenReader', 'Optimise for screen readers', 'Extra labels and structure for assistive technology.', false],
    ['closedCaptions', 'Show closed captions on videos when available', 'Captions appear automatically when a video provides them.', false],
    ['reducedMotion', 'Reduced motion', 'Minimise animations and transitions.', false],
    ['voiceNavigation', 'Voice navigation', 'Navigate with voice commands where supported.', false],
    ['hapticFeedback', 'Haptic feedback', 'Vibration feedback on supported devices.', true],
  ]
  return (
    <SetCard icon="eye" title="Accessibility"
      sub="These preferences are saved to your account and sync to every device you sign in on.">
      {rows.map(([key, title, desc, dflt]) => {
        const on = !!(block[key] ?? dflt)
        return (
          <ToggleRow key={key} title={title} desc={desc} on={on}
            onToggle={() => setField(key, !on)}/>
        )
      })}
      <ResetToDefaults section="accessibility" name="accessibility" defaults={ACCESSIBILITY_DEFAULTS} onDone={onReset}/>
    </SetCard>
  )
}
