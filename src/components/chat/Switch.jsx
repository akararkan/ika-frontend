/* =========================================================
   Switch — the chat module's toggle atom.
   ---------------------------------------------------------
   `role="switch"` + `aria-checked`, not a checkbox: the control
   is a bare <button> with no label element of its own, so the
   accessible name has to arrive through `label`. Its skin is
   `.ci-switch` in chat.css (with an RTL guard on the knob's
   translate) — the class name predates this extraction and is
   shared by the info panel and the privacy panel, so don't
   rename it without renaming the CSS.
   ========================================================= */
export function Switch({ on, onChange, label, disabled }) {
  return (
    <button
      type="button"
      className={'ci-switch' + (on ? ' on' : '')}
      role="switch"
      aria-checked={!!on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
    />
  )
}

export default Switch
