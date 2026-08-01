/* =========================================================
   PrivacyPanel — the field-visibility resolver UI over
   /settings/privacy. One card per PRIVACY_GROUPS group; every
   FieldKey gets a visibility select. Writes are optimistic;
   the server answers each write with the FULL refreshed map,
   which replaces local state so resolver-side effects land.
   ========================================================= */
import React from 'react'
import { showToast } from '../ui.jsx'
import { Loader, ErrorState } from '../states.jsx'
import { api, VISIBILITY_LEVELS, VISIBILITY_LABELS, PRIVACY_GROUPS } from '../../api/index.js'
import { SetCard } from './shared.jsx'

/* Card icons in PRIVACY_GROUPS order: Profile fields, Content,
   Connections, Who can… */
const GROUP_ICONS = ['user', 'image', 'users', 'lock']

const LEAD_SUB = 'Who can see each part of your profile and activity. These rules are ' +
  'enforced by the server when data is queried and serialized — restricted fields are ' +
  'never sent to other people, not just hidden in the app.'

/* One-line context only where it genuinely helps. */
const FIELD_DESCS = {
  EMAIL_ADDRESS: 'Defaults to only me. Anyone allowed here sees your address on your profile.',
  PHONE_NUMBER: 'Defaults to only me. Anyone allowed here sees your number on your profile.',
}

export function PrivacyPanel() {
  const [map, setMap] = React.useState(null)     // null = loading; {} keyed by FieldKey
  const [error, setError] = React.useState(false)
  const [tick, setTick] = React.useState(0)
  const seq = React.useRef(0)                    // last write wins the full-map replace

  React.useEffect(() => {
    let alive = true
    setMap(null); setError(false)
    api.settings.privacy.map()
      .then(m => { if (alive) setMap(m || {}) })
      .catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [tick])

  const setLevel = (field, level) => {
    const prevVal = map?.[field]
    if (prevVal === level) return
    const mySeq = ++seq.current
    setMap(cur => ({ ...cur, [field]: level }))                    // optimistic
    api.settings.privacy.setField(field, level)
      .then(fresh => {
        if (seq.current === mySeq && fresh) setMap(fresh)          // authoritative refreshed map
        showToast('Visibility updated')
      })
      .catch(() => {
        // Revert only if this optimistic value is still the one showing.
        setMap(cur => (cur && cur[field] === level ? { ...cur, [field]: prevVal } : cur))
        showToast('Could not save — reverted')
      })
  }

  if (error) {
    return <ErrorState message="Could not load your privacy settings" onRetry={() => setTick(t => t + 1)}/>
  }
  if (map === null) return <Loader label="Loading privacy settings…"/>

  return (
    <div className="set-stack">
      {PRIVACY_GROUPS.map((group, gi) => (
        <SetCard key={group.label} icon={GROUP_ICONS[gi] || 'lock'} title={group.label}
          sub={gi === 0 ? LEAD_SUB : undefined}>
          {group.keys.map(([key, label]) => {
            const value = map[key] || 'EVERYONE'
            return (
              <div key={key} className="stx-row">
                <div>
                  <b>{label}</b>
                  {FIELD_DESCS[key] && <small>{FIELD_DESCS[key]}</small>}
                  {value === 'CUSTOM' && <small>Custom audiences are managed in the Audiences tab.</small>}
                </div>
                <select className="field" aria-label={label + ' visibility'} value={value}
                  onChange={e => setLevel(key, e.target.value)}>
                  {VISIBILITY_LEVELS.map(l => (
                    <option key={l} value={l}>{VISIBILITY_LABELS[l] || l}</option>
                  ))}
                </select>
              </div>
            )
          })}
        </SetCard>
      ))}
    </div>
  )
}
