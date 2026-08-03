/* =========================================================
   Mock-mode badge.
   ---------------------------------------------------------
   The single most dangerous thing about fixture mode is
   forgetting you are in it — reading a number off a demo and
   reporting it, or filing a bug against data that was never in
   the database. So while mock mode is on the app says so,
   permanently, on every screen.

   It is also the switch: click it to change fixture language or
   drop back to the live API. Both write the localStorage keys
   that flag.js reads, then reload — Vite only reads .env at
   startup, so a reload is the honest way to apply either.
   ========================================================= */
import React from 'react'
import { Icon } from './ui.jsx'
import { mockEnabled, mockLang } from '../mock/flag.js'

const LANGS = [
  ['en', 'English'],
  ['ar', 'العربية'],
  ['ku', 'کوردی'],
  ['tr', 'Türkçe'],
]

export function MockBadge() {
  const [open, setOpen] = React.useState(false)
  const on = mockEnabled()
  const lang = mockLang()
  if (!on) return null

  const setLang = (v) => {
    try { localStorage.setItem('ika_mock_lang', v) } catch { /* private mode */ }
    window.location.reload()
  }
  const goLive = () => {
    try { localStorage.setItem('ika_mock', 'off') } catch { /* private mode */ }
    window.location.reload()
  }

  return (
    <div className={'mockbadge' + (open ? ' open' : '')}>
      <button type="button" className="mockbadge-pill" onClick={() => setOpen(o => !o)}
        aria-expanded={open} aria-label="Mock data is on — open mock controls">
        <Icon name="alert" className="xs"/>
        <b>Mock data</b>
        <span className="mockbadge-lang">{lang.toUpperCase()}</span>
      </button>

      {open && (
        <div className="mockbadge-pop" role="dialog" aria-label="Mock mode">
          <p>
            Every screen is being served from <code>src/mock/data.json</code>.
            Nothing here came from the database, and nothing you change is saved.
          </p>
          <div className="mockbadge-langs">
            {LANGS.map(([v, label]) => (
              <button key={v} type="button"
                className={'mockbadge-lbtn' + (v === lang ? ' on' : '')}
                onClick={() => v !== lang && setLang(v)}>
                {label}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={goLive}>
            <Icon name="globe" className="xs"/>Switch to real data
          </button>
          <small>Reloads the page. To come back, set <code>localStorage.ika_mock = &apos;on&apos;</code>.</small>
        </div>
      )}
    </div>
  )
}
