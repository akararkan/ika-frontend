/* =========================================================
   PostComposer — the message types a textarea can't express
   ---------------------------------------------------------
   POLL, LOCATION and CONTACT each carry a structured payload
   that must MATCH the message type exactly: a `location` on a
   TEXT, or a LOCATION with no `location`, is a 400. So the modal
   builds one payload at a time and the send helper attaches only
   the field belonging to the chosen type — there is no shared
   "extras" object that could leak a stale poll onto a location.

   Quiz mode is the sharp edge. A quiz has exactly one correct
   option, forbids multiple answers, and its answers are FINAL —
   the voter cannot change or retract. That is not something to
   discover after publishing, so the form states it, and turning
   quiz on visibly turns multi-answer off rather than silently
   ignoring it at send time.
   ========================================================= */
import React from 'react'
import { Icon, showToast } from '../ui.jsx'
import { api } from '../../api/index.js'
import { chatError } from './chatErrors.js'

const KINDS = [
  ['POLL',     'Poll',     'qna',   'A question with options people vote on.'],
  ['LOCATION', 'Location', 'pin',   'A point on the map, with an optional name.'],
  ['CONTACT',  'Contact',  'user',  'Someone’s name and number.'],
]

const MAX_OPTIONS = 10

export function PostComposer({ conversationId, replyToId, onClose, onSent }) {
  const [kind, setKind] = React.useState('POLL')
  const [busy, setBusy] = React.useState(false)

  // poll
  const [question, setQuestion] = React.useState('')
  const [options, setOptions] = React.useState(['', ''])
  const [multi, setMulti] = React.useState(false)
  const [anonymous, setAnonymous] = React.useState(true)
  const [quiz, setQuiz] = React.useState(false)
  const [correct, setCorrect] = React.useState(0)
  const [explanation, setExplanation] = React.useState('')

  // location
  const [loc, setLoc] = React.useState({ latitude: '', longitude: '', name: '', address: '' })
  const [locating, setLocating] = React.useState(false)

  // contact
  const [contact, setContact] = React.useState({ firstName: '', lastName: '', phone: '' })

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose?.() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const cleanOptions = options.map(o => o.trim()).filter(Boolean)
  const ready = {
    POLL: question.trim() && cleanOptions.length >= 2,
    LOCATION: loc.latitude !== '' && loc.longitude !== ''
      && Math.abs(Number(loc.latitude)) <= 90 && Math.abs(Number(loc.longitude)) <= 180,
    CONTACT: contact.phone.trim() || contact.firstName.trim(),
  }[kind]

  const locate = () => {
    if (!navigator.geolocation) { showToast('This browser cannot find your location'); return }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLoc(l => ({
          ...l,
          latitude: pos.coords.latitude.toFixed(6),
          longitude: pos.coords.longitude.toFixed(6),
        }))
        setLocating(false)
      },
      () => { setLocating(false); showToast('Could not read your location') },
      { enableHighAccuracy: true, timeout: 8000 },
    )
  }

  const send = async () => {
    if (!ready || busy) return
    setBusy(true)
    try {
      const base = { clientNonce: api.chat.newNonce(), type: kind, replyToId: replyToId ?? undefined }
      const payload =
        kind === 'POLL' ? {
          ...base,
          poll: {
            question: question.trim(),
            options: cleanOptions,
            // A quiz forbids multiple answers — send the truth, not the toggle.
            allowsMultipleAnswers: quiz ? false : multi,
            anonymous,
            quiz,
            correctOptionIndex: quiz ? Math.min(correct, cleanOptions.length - 1) : null,
            explanation: quiz && explanation.trim() ? explanation.trim() : null,
          },
        }
        : kind === 'LOCATION' ? {
          ...base,
          location: {
            latitude: Number(loc.latitude), longitude: Number(loc.longitude),
            name: loc.name.trim() || undefined, address: loc.address.trim() || undefined,
            live: false,
          },
        }
        : {
          ...base,
          contact: {
            phone: contact.phone.trim() || undefined,
            firstName: contact.firstName.trim() || undefined,
            lastName: contact.lastName.trim() || undefined,
          },
        }

      const msg = await api.chat.messages.send(conversationId, payload)
      onSent?.(msg)
      onClose?.()
    } catch (e) {
      showToast(chatError(e, 'Could not send that'))
    } finally { setBusy(false) }
  }

  return (
    <div className="ch-modal-overlay" role="dialog" aria-modal="true" aria-label="Send a poll, location or contact"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose?.() }}>
      <div className="ch-modal cn-modal">
        <div className="ch-modal-head">
          <h3><Icon name="compose" className="sm"/>Send something else</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close" disabled={busy}>
            <Icon name="close" className="sm"/>
          </button>
        </div>

        <div className="ch-modal-body cn-modal-body single">
          <div className="pc-kinds" role="tablist" aria-label="What to send">
            {KINDS.map(([k, label, icon, hint]) => (
              <button key={k} role="tab" aria-selected={kind === k}
                className={'pc-kind' + (kind === k ? ' on' : '')} onClick={() => setKind(k)}>
                <Icon name={icon} className="sm"/>
                <span className="pc-kind-l">{label}</span>
                <span className="pc-kind-h">{hint}</span>
              </button>
            ))}
          </div>

          {kind === 'POLL' && (
            <div className="cn-form">
              <label className="cn-field">
                <span>Question</span>
                <input className="field" maxLength={300} value={question} dir="auto" autoFocus
                  onChange={e => setQuestion(e.target.value)} placeholder="What should we read next?"/>
              </label>

              <div className="cn-field">
                <span>Options <small>2 to {MAX_OPTIONS}</small></span>
                {options.map((o, i) => (
                  <div className="pc-opt" key={i}>
                    {quiz && (
                      <button type="button"
                        className={'pc-correct' + (correct === i ? ' on' : '')}
                        onClick={() => setCorrect(i)}
                        aria-label={`Mark option ${i + 1} as the correct answer`}
                        aria-pressed={correct === i}>
                        <Icon name="check" className="xs"/>
                      </button>
                    )}
                    <input className="field" maxLength={100} value={o} dir="auto"
                      placeholder={`Option ${i + 1}`}
                      onChange={e => setOptions(prev => prev.map((x, j) => (j === i ? e.target.value : x)))}/>
                    {options.length > 2 && (
                      <button type="button" className="icon-btn"
                        aria-label={`Remove option ${i + 1}`}
                        onClick={() => setOptions(prev => {
                          const next = prev.filter((_, j) => j !== i)
                          // Keep the correct-answer pointer on the option it
                          // was on, not on whatever slid into that index.
                          setCorrect(c => (c === i ? 0 : c > i ? c - 1 : c))
                          return next
                        })}>
                        <Icon name="close" className="xs"/>
                      </button>
                    )}
                  </div>
                ))}
                {options.length < MAX_OPTIONS && (
                  <button type="button" className="cn-btn" onClick={() => setOptions(prev => [...prev, ''])}>
                    <Icon name="compose" className="xs"/>Add option
                  </button>
                )}
              </div>

              <div className="ci-row">
                <Icon name="award"/>
                <div className="ci-row-body">
                  <div className="ci-row-title">Quiz</div>
                  <div className="ci-row-sub">
                    One correct answer, and answers are <b>final</b> — nobody can change or retract a quiz vote.
                  </div>
                </div>
                <button type="button" className={'ci-switch' + (quiz ? ' on' : '')}
                  role="switch" aria-checked={quiz} aria-label="Quiz mode"
                  onClick={() => { setQuiz(v => !v); if (!quiz) setMulti(false) }}/>
              </div>

              {!quiz && (
                <div className="ci-row">
                  <Icon name="checks"/>
                  <div className="ci-row-body">
                    <div className="ci-row-title">Allow several answers</div>
                    <div className="ci-row-sub">Voters can pick more than one option.</div>
                  </div>
                  <button type="button" className={'ci-switch' + (multi ? ' on' : '')}
                    role="switch" aria-checked={multi} aria-label="Allow several answers"
                    onClick={() => setMulti(v => !v)}/>
                </div>
              )}

              <div className="ci-row">
                <Icon name="eyeoff"/>
                <div className="ci-row-body">
                  <div className="ci-row-title">Anonymous</div>
                  <div className="ci-row-sub">Hide who voted for what.</div>
                </div>
                <button type="button" className={'ci-switch' + (anonymous ? ' on' : '')}
                  role="switch" aria-checked={anonymous} aria-label="Anonymous"
                  onClick={() => setAnonymous(v => !v)}/>
              </div>

              {quiz && (
                <label className="cn-field">
                  <span>Explanation <small>shown after answering</small></span>
                  <textarea className="field" rows={2} maxLength={200} value={explanation} dir="auto"
                    onChange={e => setExplanation(e.target.value)}
                    placeholder="Why that is the right answer…"/>
                </label>
              )}
            </div>
          )}

          {kind === 'LOCATION' && (
            <div className="cn-form">
              <button className="btn" onClick={locate} disabled={locating}>
                <Icon name="pin" className="xs"/>{locating ? 'Finding you…' : 'Use my location'}
              </button>
              <div className="pc-two">
                <label className="cn-field">
                  <span>Latitude</span>
                  <input className="field" inputMode="decimal" value={loc.latitude}
                    onChange={e => setLoc(l => ({ ...l, latitude: e.target.value }))} placeholder="36.19"/>
                </label>
                <label className="cn-field">
                  <span>Longitude</span>
                  <input className="field" inputMode="decimal" value={loc.longitude}
                    onChange={e => setLoc(l => ({ ...l, longitude: e.target.value }))} placeholder="44.01"/>
                </label>
              </div>
              <label className="cn-field">
                <span>Name <small>optional</small></span>
                <input className="field" maxLength={120} value={loc.name} dir="auto"
                  onChange={e => setLoc(l => ({ ...l, name: e.target.value }))} placeholder="Erbil Citadel"/>
              </label>
              <label className="cn-field">
                <span>Address <small>optional</small></span>
                <input className="field" maxLength={200} value={loc.address} dir="auto"
                  onChange={e => setLoc(l => ({ ...l, address: e.target.value }))}/>
              </label>
            </div>
          )}

          {kind === 'CONTACT' && (
            <div className="cn-form">
              <div className="pc-two">
                <label className="cn-field">
                  <span>First name</span>
                  <input className="field" maxLength={80} value={contact.firstName} dir="auto" autoFocus
                    onChange={e => setContact(c => ({ ...c, firstName: e.target.value }))}/>
                </label>
                <label className="cn-field">
                  <span>Last name</span>
                  <input className="field" maxLength={80} value={contact.lastName} dir="auto"
                    onChange={e => setContact(c => ({ ...c, lastName: e.target.value }))}/>
                </label>
              </div>
              <label className="cn-field">
                <span>Phone</span>
                <input className="field" type="tel" maxLength={32} value={contact.phone}
                  onChange={e => setContact(c => ({ ...c, phone: e.target.value }))} placeholder="+964…"/>
              </label>
            </div>
          )}
        </div>

        <div className="ch-modal-foot">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" disabled={!ready || busy} onClick={send}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default PostComposer
