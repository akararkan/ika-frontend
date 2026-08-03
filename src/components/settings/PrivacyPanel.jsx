/* =========================================================
   PrivacyPanel — the field-visibility resolver UI over
   /settings/privacy. One card per PRIVACY_GROUPS group; every
   FieldKey gets a visibility select. Writes are optimistic;
   the server answers each write with the FULL refreshed map
   (stored values merged over PrivacyDefaults), which replaces
   local state so the server's view always wins.

   The two list-backed levels are explained AT THE POINT OF
   CHOICE, because neither is what the label suggests:
     CUSTOM        → VisibilityResolver calls
                     isInAnyCustomList(owner, viewer) — the UNION of every
                     custom list, and SetVisibilityRequest carries only
                     `visibility`, so a field can never be bound to one list.
     CLOSE_FRIENDS → the platform close-friends list; an empty one makes the
                     field effectively Only me.
   ========================================================= */
import React from 'react'
import { Loader, ErrorState } from '../states.jsx'
import { api, VISIBILITY_LEVELS, VISIBILITY_LABELS, PRIVACY_GROUPS } from '../../api/index.js'
import { SetCard, ControlRow, SeeAlso, Skeleton, useWriteStatus } from './shared.jsx'

/* Card icons in PRIVACY_GROUPS order: Profile fields, Content,
   Connections, Who can… */
const GROUP_ICONS = ['user', 'image', 'users', 'lock']

/* Only `privacy` is in index.data.js — the search index points every privacy
   row at it. The rest exist so a deep link can still reach the lower cards. */
const GROUP_IDS = ['privacy', 'privacy-content', 'privacy-connections', 'privacy-who']

/* HONESTY: the old sub promised "enforced by the server when data is queried and
   serialized — restricted fields are never sent to other people". That is not
   true today. VisibilityResolver is documented as "the single enforcement
   funnel", but NOTHING calls it: no file outside ak.dev.irc.app.settings.privacy
   imports that package, and resolve/isVisible have no call sites at all. The
   write path is real (PrivacyService.setFieldPolicy stores the level and writes
   a SettingsAuditService row), so the control is worth keeping — the promise
   about read paths is not. Say what the server actually does. */
const LEAD_SUB = 'Who can see each part of your profile and activity. Every change is saved to ' +
  'your account and recorded in your settings history. Not every place content is served ' +
  'filters against these rules yet, so treat them as your stated preference rather than a ' +
  'guarantee about anything you have already published.'

/* /users/me/close-friends is a Page (server default 20), so the count is a page
   length, not a total — ask for a big page and mark it "+" when it saturates. */
const CLOSE_PAGE = 100

/* One-line context only where it genuinely helps. Both rows used to say the
   allowed audience "sees your address on your profile" — no profile surface
   renders either field, so the sentence is guidance about the level, not a
   claim about where the value appears. */
const FIELD_DESCS = {
  EMAIL_ADDRESS: 'Defaults to only me, the narrowest level. Widen it only for people you would give your address to directly.',
  PHONE_NUMBER: 'Defaults to only me, the narrowest level. Widen it only for people you would give your number to directly.',
}

export function PrivacyPanel() {
  const [map, setMap] = React.useState(null)     // null = loading; {} keyed by FieldKey
  const [error, setError] = React.useState(false)
  const [tick, setTick] = React.useState(0)
  /* Audience sizes behind the two list-backed levels. null = not known (the
     fetch failed or hasn't landed); the hint then drops the number rather than
     blocking the panel — a privacy screen that will not render is worse than
     one without a head count. */
  const [reach, setReach] = React.useState({ lists: null, people: null, close: null, closeMore: false })
  const { statusOf, track } = useWriteStatus()
  const seq = React.useRef(0)                    // last write wins the full-map replace

  React.useEffect(() => {
    let alive = true
    setMap(null); setError(false)
    api.settings.privacy.map()
      .then(m => { if (alive) setMap(m || {}) })
      .catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [tick])

  /* Blast radius for CUSTOM: the number of lists AND the DEDUPLICATED head
     count across them, since the resolver unions the lists. Loaded once —
     lists change on the Audiences tab, not here. */
  React.useEffect(() => {
    let alive = true
    api.settings.privacy.lists.all()
      .then(async rows => {
        const custom = (rows || []).filter(r => r.type === 'CUSTOM')
        if (!alive) return
        setReach(r => ({ ...r, lists: custom.length }))
        const rosters = await Promise.all(
          custom.map(l => api.settings.privacy.lists.members(l.id).catch(() => null)))
        /* One unreadable roster makes the union a lower bound — say nothing
           rather than under-state who can see the field. */
        if (!alive || rosters.some(r => r === null)) return
        setReach(r => ({ ...r, people: new Set(rosters.flat()).size }))
      })
      .catch(() => {})
    api.closeFriends.list({ size: CLOSE_PAGE })
      .then(rows => {
        if (!alive) return
        const n = (rows || []).length
        setReach(r => ({ ...r, close: n, closeMore: n >= CLOSE_PAGE }))
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const setLevel = (field, level) => {
    const prevVal = map?.[field]
    if (prevVal === level) return
    const mySeq = ++seq.current
    setMap(cur => ({ ...cur, [field]: level }))                    // optimistic
    track(field, api.settings.privacy.setField(field, level)
      .then(fresh => {
        if (seq.current === mySeq && fresh) setMap(fresh)          // authoritative refreshed map
      })
      .catch(e => {
        // Revert only if this optimistic value is still the one showing.
        setMap(cur => (cur && cur[field] === level ? { ...cur, [field]: prevVal } : cur))
        throw e
      })).catch(() => {})    // the row already says "Not saved" and flashed the revert
  }

  /* The honest sentence for a list-backed level. `warn` marks the states where
     the chosen level currently hides the field from everyone. */
  const hintFor = (value) => {
    if (value === 'CUSTOM') {
      const { lists, people } = reach
      if (lists === 0) {
        return { warn: true, text: 'You have no custom audiences yet, so nobody else can see this.' }
      }
      /* Lists exist but every roster is empty — don't pair the "visible to
         anyone on…" sentence with a (0 people) parenthesis, it reads as a
         contradiction next to the chip. */
      if (people === 0) {
        return { warn: true, text: 'Your custom audiences are all empty, so nobody else can see this yet.' }
      }
      const where = lists == null
        ? 'anyone on any of your custom audiences'
        : `anyone on any of your ${lists} custom ${lists === 1 ? 'audience' : 'audiences'}`
      const total = people == null ? '' : ` (${people} ${people === 1 ? 'person' : 'people'} in all, counted once)`
      return {
        text: `Visible to ${where}${total}. Your lists are pooled into one audience — a field cannot be limited to just one of them.`,
      }
    }
    if (value === 'CLOSE_FRIENDS') {
      const { close, closeMore } = reach
      if (close === 0) return { warn: true, text: 'Your close friends list is empty, so nobody else can see this yet.' }
      if (close == null) return { text: 'Visible to the people on your close friends list.' }
      return { text: `Visible to the ${close}${closeMore ? '+' : ''} ${close === 1 ? 'person' : 'people'} on your close friends list.` }
    }
    return null
  }

  if (error) {
    return (
      <div className="set-stack">
        <SetCard id={GROUP_IDS[0]} icon={GROUP_ICONS[0]} title={PRIVACY_GROUPS[0].label} sub={LEAD_SUB}>
          <ErrorState message="Could not load your privacy settings" onRetry={() => setTick(t => t + 1)}/>
        </SetCard>
      </div>
    )
  }

  if (map === null) {
    return (
      <div className="set-stack">
        {PRIVACY_GROUPS.map((group, gi) => (
          <SetCard key={group.label} id={GROUP_IDS[gi]} icon={GROUP_ICONS[gi] || 'lock'} title={group.label}
            sub={gi === 0 ? LEAD_SUB : undefined}>
            {gi === 0 ? <Loader label="Loading privacy settings…"/> : <Skeleton rows={group.keys.length}/>}
          </SetCard>
        ))}
      </div>
    )
  }

  return (
    <div className="set-stack">
      {PRIVACY_GROUPS.map((group, gi) => {
        const levels = new Set(group.keys.map(([key]) => map[key] || 'EVERYONE'))
        return (
          <SetCard key={group.label} id={GROUP_IDS[gi]} icon={GROUP_ICONS[gi] || 'lock'} title={group.label}
            sub={gi === 0 ? LEAD_SUB : undefined}>
            {group.keys.map(([key, label]) => {
              const value = map[key] || 'EVERYONE'
              const hint = hintFor(value)
              const desc = (FIELD_DESCS[key] || hint) ? (
                <>
                  {FIELD_DESCS[key]}
                  {hint && (
                    <span className="stx-hint">
                      {hint.warn && <><span className="stx-chip warn">Visible to nobody</span>{' '}</>}
                      {hint.text}
                    </span>
                  )}
                </>
              ) : undefined
              return (
                <ControlRow key={key} title={label} desc={desc} status={statusOf(key)}>
                  <select className="field" aria-label={label + ' visibility'} value={value}
                    onChange={e => setLevel(key, e.target.value)}>
                    {VISIBILITY_LEVELS.map(l => (
                      <option key={l} value={l}>{VISIBILITY_LABELS[l] || l}</option>
                    ))}
                  </select>
                </ControlRow>
              )
            })}
            {levels.has('CLOSE_FRIENDS') && (
              <SeeAlso to="/settings/audience#close-friends">Manage your close friends list</SeeAlso>
            )}
            {levels.has('CUSTOM') && (
              <SeeAlso to="/settings/audience#lists">Manage your custom audiences</SeeAlso>
            )}
          </SetCard>
        )
      })}
    </div>
  )
}
