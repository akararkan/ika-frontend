/* =========================================================
   People page — /people
   ---------------------------------------------------------
   The full "People you may know" surface, plus the one control
   that makes it dramatically better: contact matching.

   Contact sync is the strongest cold-start signal the engine
   has (+12, more than four mutual follows) and the most
   sensitive thing this app ever asks for, so the panel is
   built around the property that makes it safe rather than
   burying it in a privacy policy:

     the hashing happens HERE, on the device, and the server
     receives 64-character hashes it cannot reverse.

   That is stated where the button is, the raw text never
   leaves the component, and "Delete uploaded contacts" sits
   next to the upload rather than three screens away — a
   privacy control the user cannot find is not a privacy
   control.
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, showToast } from '../components/ui.jsx'
import { uiConfirm } from '../components/Dialog.jsx'
import { PymkGrid } from '../components/PeopleYouMayKnow.jsx'
import { hashContacts, parseContactBlob, canHashContacts, MAX_HASHES_PER_SYNC } from '../lib/contactHash.js'
import { api } from '../api/index.js'

/* Stamped onto the consent event the sync records, so a withdrawal dispute can
   be answered with "which build asked". */
const APP_VERSION = import.meta.env.VITE_APP_VERSION || '1.0.0'

function ContactSync({ onSynced }) {
  const [open, setOpen] = React.useState(false)
  const [text, setText] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState(null)   // { stored, matched, skipped }
  const fileRef = React.useRef(null)
  const secure = canHashContacts()

  const readFile = (file) => {
    if (!file) return
    const fr = new FileReader()
    fr.onload = () => setText(String(fr.result || ''))
    fr.onerror = () => showToast('Could not read that file')
    fr.readAsText(file)
  }

  const sync = async () => {
    const entries = parseContactBlob(text)
    if (!entries.length) { showToast('Add some emails or phone numbers first'); return }
    setBusy(true)
    try {
      const { hashes, skipped } = await hashContacts(entries)
      if (!hashes.length) { showToast('Nothing in that list looked like an email or phone number'); return }
      /* The spec-named alias (POST /api/v1/contacts/sync): same hash-join as
         the older /users/contacts/sync, but it also records the CONTACTS
         consent event and enforces the 3-per-24h limit that stops the upload
         path being used to enumerate the user base. */
      const res = await api.settings.contactsSync.sync(hashes, APP_VERSION)
      setResult({ ...res, skipped })
      setText('')                                   // the raw list has done its job — drop it
      /* The recompute is async server-side, so re-reading immediately would
         return the PREVIOUS rows and look like the sync did nothing. Give it a
         beat, then refresh. */
      setTimeout(() => onSynced?.(), 1500)
    } catch (e) {
      showToast(e?.name === 'InsecureContextError'
        ? 'Contact matching needs a secure (https) connection'
        // 429 already toasts globally with the server's cooldown — don't double up.
        : e?.status === 429 ? 'Contact sync is limited to three uploads a day'
        : 'Could not sync contacts')
    } finally {
      setBusy(false)
    }
  }

  const wipe = async () => {
    const ok = await uiConfirm({
      title: 'Delete uploaded contacts?',
      message: 'Your uploaded contact hashes are erased from the server and suggestions are rebuilt without them. You can upload again at any time.',
      confirmLabel: 'Delete', danger: true, icon: 'trash',
    })
    if (!ok) return
    try {
      await api.settings.contactsSync.clear()   // also writes the consent withdrawal (§14)
      setResult(null)
      showToast('Uploaded contacts deleted')
      setTimeout(() => onSynced?.(), 1500)
    } catch { showToast('Could not delete contacts') }
  }

  return (
    <section className="csync card">
      <header className="csync-head">
        <span className="csync-ic"><Icon name="users"/></span>
        <div className="csync-hd">
          <h3>Find people you already know</h3>
          <p>Match your address book against IKA. Contacts are hashed on your device — the server only ever receives one-way SHA-256 hashes, never names, emails or numbers.</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => setOpen(o => !o)} aria-expanded={open}>
          {open ? 'Close' : 'Upload contacts'}
        </button>
      </header>

      {open && (
        <div className="csync-body">
          {!secure && (
            <p className="csync-warn">
              <Icon name="alert" className="xs"/>
              Hashing needs a secure connection (https or localhost). Open this page over https to use contact matching.
            </p>
          )}

          <div className="csync-drop">
            <input ref={fileRef} type="file" accept=".vcf,text/vcard,text/plain,.csv,.txt" hidden
              onChange={e => readFile(e.target.files?.[0])}/>
            <button className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()} disabled={!secure}>
              <Icon name="upload" className="xs"/> Choose a .vcf export
            </button>
            <span className="muted text-sm">or paste addresses below — one per line</span>
          </div>

          <textarea
            className="field csync-area"
            rows={5}
            placeholder={'amina@example.com\n+964 750 123 4567\n…'}
            value={text}
            disabled={!secure}
            onChange={e => setText(e.target.value)}
          />

          <div className="csync-foot">
            <span className="muted text-sm">Up to {MAX_HASHES_PER_SYNC.toLocaleString()} per upload · each upload replaces the last one</span>
            <div className="csync-btns">
              <button className="btn btn-secondary btn-sm" onClick={wipe}>Delete uploaded contacts</button>
              <button className="btn btn-primary btn-sm" disabled={busy || !secure || !text.trim()} onClick={sync}>
                {busy ? 'Hashing…' : 'Find matches'}
              </button>
            </div>
          </div>

          {result && (
            <p className="csync-result">
              <Icon name="check" className="xs"/>
              Uploaded {result.stored.toLocaleString()} hashed contacts — <b>{result.matched.toLocaleString()} already on IKA</b>.
              {result.skipped > 0 && <span className="muted"> ({result.skipped.toLocaleString()} entries skipped.)</span>}
              {' '}Suggestions are rebuilding.
            </p>
          )}
        </div>
      )}
    </section>
  )
}

export function PeoplePage() {
  const navigate = useNavigate()
  /* Remounts the grid after a contact sync or a manual recompute — both are
     async server-side, so this is a re-READ, not a promise the caller awaited. */
  const [epoch, setEpoch] = React.useState(0)
  const [recomputing, setRecomputing] = React.useState(false)

  const recompute = () => {
    setRecomputing(true)
    api.posts.recomputeSuggestions()
      .then(() => { showToast('Rebuilding your suggestions…'); setTimeout(() => setEpoch(n => n + 1), 2000) })
      .catch(() => showToast('Could not rebuild suggestions'))
      .finally(() => setTimeout(() => setRecomputing(false), 2000))
  }

  /* `wide`, not the feed's two-column grid: this page has no right rail, and
     a card grid squeezed into the timeline column would show three cards a row
     with a third of the viewport empty beside it. */
  return (
    <div className="main wide">
      <div className="col-main">
        <div className="folio rise">
          <span className="folio-d">People</span>
          <span className="folio-ar" lang="ar" dir="rtl">أشخاص قد تعرفهم</span>
        </div>

        <header className="ppl-head rise">
          <div>
            <h1>People you may know</h1>
            <p className="muted">Built from mutual follows, shared groups, people you message, accounts you engage with, your institution and your contacts.</p>
          </div>
          <button className="btn btn-secondary btn-sm" disabled={recomputing} onClick={recompute}>
            <Icon name="settings" className="xs"/> {recomputing ? 'Rebuilding…' : 'Refresh'}
          </button>
        </header>

        <ContactSync onSynced={() => setEpoch(n => n + 1)}/>

        <PymkGrid key={epoch} limit={40}/>

        <button className="btn btn-secondary btn-block mt-12" onClick={() => navigate('/explore')}>
          Explore topics and creators instead
        </button>
      </div>
    </div>
  )
}

export default PeoplePage
