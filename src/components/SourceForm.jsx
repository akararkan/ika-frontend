/* =========================================================
   AddSourceForm — type-aware source/reference editor.
   Shared by the Q&A answer composer, the Q&A "Sources & files"
   manage panel, and the Research composer.

   SourceType enum (ak.dev.irc.app.research.enums, shared with Q&A):
     URL        — external web link        → req.url
     ISBN       — book reference           → req.isbn
     MEDIA_FILE — uploaded file (S3)       → file part, uploaded after create
     MANUAL     — free-text citation       → req.citationText
   ========================================================= */
/* eslint-disable react-refresh/only-export-components */
import React from 'react'
import { Icon } from './ui.jsx'

export const SOURCE_TYPES = ['URL', 'ISBN', 'MEDIA_FILE', 'MANUAL']
export const SOURCE_LABEL = { URL:'Web link', ISBN:'ISBN', MEDIA_FILE:'Media file', MANUAL:'Manual citation' }
const REF_PLACEHOLDER = { URL:'https://…', ISBN:'978-…' }

/** Build a CreateSourceRequest from the discrete fields (no file). */
export function buildSourceReq(sourceType, title, citationText, ref) {
  const s = { sourceType, title: (title || '').trim() }
  if (citationText && citationText.trim()) s.citationText = citationText.trim()
  const r = (ref || '').trim()
  if (r) { if (sourceType === 'ISBN') s.isbn = r; else if (sourceType === 'URL') s.url = r }
  return s
}

/**
 * @param onAdd (req, file) => void  — file is the File for MEDIA_FILE, else null
 */
export function AddSourceForm({ onAdd }) {
  const [type, setType] = React.useState('URL')
  const [title, setTitle] = React.useState('')
  const [citation, setCitation] = React.useState('')
  const [ref, setRef] = React.useState('')
  const [file, setFile] = React.useState(null)
  const fileRef = React.useRef(null)

  const reset = () => { setType('URL'); setTitle(''); setCitation(''); setRef(''); setFile(null) }
  const canAdd = title.trim() && (type !== 'MEDIA_FILE' || file)
  const submit = () => {
    if (!canAdd) return
    onAdd(buildSourceReq(type, title, citation, ref), type === 'MEDIA_FILE' ? file : null)
    reset()
  }

  return (
    <div style={{ display:'grid', gap:8 }}>
      <div className="flex gap-8">
        <select className="field" style={{ maxWidth:150 }} value={type} onChange={e => setType(e.target.value)}>
          {SOURCE_TYPES.map(t => <option key={t} value={t}>{SOURCE_LABEL[t]}</option>)}
        </select>
        <input className="field" placeholder="Title" value={title} onChange={e => setTitle(e.target.value)}/>
      </div>

      {(type === 'URL' || type === 'ISBN') &&
        <input className="field" placeholder={REF_PLACEHOLDER[type]} value={ref} onChange={e => setRef(e.target.value)}/>}

      {type === 'MANUAL'
        ? <input className="field" placeholder="Full citation text" value={citation} onChange={e => setCitation(e.target.value)}/>
        : type !== 'MEDIA_FILE' && <input className="field" placeholder="Citation text (optional)" value={citation} onChange={e => setCitation(e.target.value)}/>}

      {type === 'MEDIA_FILE' && (
        <>
          <input ref={fileRef} type="file" hidden accept=".pdf,.doc,.docx,image/*,audio/*,video/*"
            onChange={e => { const f = e.target.files?.[0]; if (f) { setFile(f); if (!title.trim()) setTitle(f.name) } e.target.value = '' }}/>
          <button className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()}>
            <Icon name="upload" className="xs"/>{file ? file.name : 'Choose a file — PDF, image, audio, video'}
          </button>
        </>
      )}

      <button className="btn btn-secondary btn-sm" disabled={!canAdd} onClick={submit}><Icon name="compose" className="xs"/>Add source</button>
    </div>
  )
}
