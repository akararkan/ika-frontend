/* =========================================================
   ProfileDetails — the full public profile detail panel shared
   by /profile (own) and /u/:id (others). Surfaces every
   ProfileResponse field the backend exposes (USER_MODEL_API §1.2):
   academic title, institution, madhhab, location, website, ORCID,
   join date, profile views, specializations, links, contacts,
   attachments. Empty sections are omitted. Non-public links /
   contacts are already filtered server-side on public profiles.
   ========================================================= */
import React from 'react'
import { Icon, fmt } from './ui.jsx'
import { useTaxonomyLang } from './Taxonomy.jsx'
import { api, taxonomyName } from '../api/index.js'

const fmtBytes = (n) => {
  if (!n || n < 0) return ''
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']; let i = -1; let v = n
  do { v /= 1024; i++ } while (v >= 1024 && i < units.length - 1)
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}
const hostOf = (url) => url.replace(/^https?:\/\//, '').replace(/\/$/, '')

/* The profile carries the madhhab's ENGLISH name only; the Arabic and Kurdish
   ones live in the vocabulary, which TAXONOMY §3.2 tells clients to resolve
   against GET /madhhabs (cheap, cached for the session). English readers never
   pay for the lookup — and if it fails, the English name still shows. */
function useMadhhabLabel(u, lang) {
  const [row, setRow] = React.useState(null)
  const id = u?.madhhabId ?? null
  React.useEffect(() => {
    setRow(null)
    if (id === null || id === undefined || lang === 'EN') return
    let alive = true
    api.madhhabs.byId(id).then(r => { if (alive) setRow(r) }).catch(() => {})
    return () => { alive = false }
  }, [id, lang])
  return (row && taxonomyName(row, lang)) || u?.madhhab || ''
}

export function ProfileDetails({ u }) {
  const lang = useTaxonomyLang()
  const madhhab = useMadhhabLabel(u, lang)
  const facts = [
    u.academicTitle && { icon: 'scholar', text: u.academicTitle },
    u.institution   && { icon: 'users',   text: u.institution },
    madhhab         && { icon: 'book',    text: madhhab },
    u.location      && { icon: 'pin',     text: u.location },
    u.joinedAt      && { icon: 'star',    text: `Joined ${u.joinedAt}` },
    (u.profileViews > 0) && { icon: 'eye', text: `${fmt(u.profileViews)} profile views` },
  ].filter(Boolean)

  const specs = u.specializations || []
  const links = u.links || []
  const contacts = u.contacts || []
  const files = u.attachments || []
  const hasFactRow = facts.length || u.website || u.orcid
  if (!hasFactRow && !specs.length && !links.length && !contacts.length && !files.length) return null

  return (
    <section className="prof-about">
      {hasFactRow > 0 && (
        <div className="pa-facts">
          {facts.map((f, i) => <span key={i} className="pa-fact"><Icon name={f.icon} className="xs"/>{f.text}</span>)}
          {u.website && <a className="pa-fact lk" href={u.website} target="_blank" rel="noreferrer"><Icon name="globe" className="xs"/>{hostOf(u.website)}</a>}
          {u.orcid && <a className="pa-fact lk" href={`https://orcid.org/${u.orcid}`} target="_blank" rel="noreferrer"><Icon name="link" className="xs"/>ORCID {u.orcid}</a>}
        </div>
      )}

      {specs.length > 0 && (
        <div className="pa-block">
          <h4 className="pa-h">Specializations</h4>
          {/* Order is the author's (displayOrder, already sorted by the
              adapter); the name is the reader's language, with dir="auto" so
              an Arabic or Kurdish term is not laid out as English. */}
          <div className="pa-chips">
            {specs.map(s => <span key={s.id} className="pa-chip" dir="auto">{taxonomyName(s, lang)}</span>)}
          </div>
        </div>
      )}

      {links.length > 0 && (
        <div className="pa-block">
          <h4 className="pa-h">Links</h4>
          <ul className="pa-list">
            {links.map(l => (
              <li key={l.id}>
                <a href={l.url} target="_blank" rel="noreferrer">
                  <span className="pa-ic"><Icon name="link" className="xs"/></span>
                  <span className="pa-tx"><b>{l.label}</b><small className="muted">{hostOf(l.url)}</small></span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {contacts.length > 0 && (
        <div className="pa-block">
          <h4 className="pa-h">Contacts</h4>
          <ul className="pa-list">
            {contacts.map(c => (
              <li key={c.id}>
                <span className="pa-row">
                  <span className="pa-ic"><Icon name="at" className="xs"/></span>
                  <span className="pa-tx"><b>{c.label}</b><small className="muted">{c.value}</small></span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {files.length > 0 && (
        <div className="pa-block">
          <h4 className="pa-h">Attachments</h4>
          <ul className="pa-list">
            {files.map(a => (
              <li key={a.id}>
                <a href={a.url} target="_blank" rel="noreferrer" download={a.name}>
                  <span className="pa-ic"><Icon name="doc" className="xs"/></span>
                  <span className="pa-tx"><b>{a.name}</b><small className="muted">{[a.description, fmtBytes(a.size)].filter(Boolean).join(' · ')}</small></span>
                  <Icon name="download" className="xs"/>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
