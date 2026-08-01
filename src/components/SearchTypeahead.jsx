/* =========================================================
   Topbar typeahead — the shell's entry into unified search
   (SEARCH: global-search.md)
   ---------------------------------------------------------
   The ranking stack already carries a `match_phrase_prefix`
   layer (×1.5) whose entire purpose is the word still being
   typed — "ramad" reaching "ramadan", "ilm" reaching @ilmhub.
   Nothing in the app was using it: the header field only ever
   navigated on Enter. This is that layer's surface.

   Every row renders from the EXPANDED hit alone (titlePreview /
   authorUsername / authorName), so opening this list costs one
   request and zero hydration calls — the documented typeahead
   pattern.

   It lives in the app shell, so it is deliberately frugal: no
   request until two characters, one in-flight call at a time
   (aborted on every keystroke), nothing fetched on mount, and
   nothing fetched at all while the field is unfocused.

   Tags ride ALONGSIDE the entity hits rather than inside them —
   /tags/search is a Cassandra prefix scan over usage counters,
   not a BM25 ranking, so merging the two lists would imply a
   comparable score that does not exist.
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from './ui.jsx'
import { api, hitHref } from '../api/index.js'

const KIND = {
  POST:     { icon:'feed',      label:'Post' },
  REEL:     { icon:'reels',     label:'Reel' },
  QUESTION: { icon:'qna',       label:'Question' },
  ANSWER:   { icon:'comment',   label:'Answer' },
  RESEARCH: { icon:'research',  label:'Research' },
  USER:     { icon:'user',      label:'Person' },
  CHANNEL:  { icon:'broadcast', label:'Channel' },
  SOUND:    { icon:'music',     label:'Sound' },
}
const kindOf = (t) => KIND[t] || { icon:'feed', label: t || 'Result' }

/* A hit's secondary line, which is NOT uniform across types: a channel's
   `authorUsername` is its own @handle, a sound's `authorName` is the artist,
   and a person's handle is their own — none of these is "posted by". */
function subtitleOf(hit) {
  const handle = hit.authorUsername ? `@${hit.authorUsername}` : ''
  switch (hit.contentType) {
    case 'USER':    return handle || 'Member'
    case 'CHANNEL': return handle || 'Public channel'
    case 'SOUND':   return hit.authorName || 'Sound'
    default:        return [hit.authorName || handle, hit.time].filter(Boolean).join(' · ')
  }
}

export function SearchTypeahead() {
  const navigate = useNavigate()
  const [q, setQ] = React.useState('')
  const [open, setOpen] = React.useState(false)
  const [hits, setHits] = React.useState([])
  const [tags, setTags] = React.useState([])
  const [active, setActive] = React.useState(-1)          // -1 = "search for this" row
  const [busy, setBusy] = React.useState(false)
  const [degraded, setDegraded] = React.useState(false)   // ES unreachable — say so, don't imply "nothing found"
  const inflight = React.useRef(null)
  const boxRef = React.useRef(null)

  const term = q.trim()

  React.useEffect(() => {
    /* Deleting back below the threshold must also KILL the request already on
       the wire — clearing the lists alone lets the abandoned term's response
       land a moment later and refill them under a one-character box. */
    if (!open || term.length < 2) {
      inflight.current?.abort(); inflight.current = null
      setHits([]); setTags([]); setBusy(false)
      return
    }
    const t = setTimeout(async () => {
      inflight.current?.abort()
      const ctl = new AbortController()
      inflight.current = ctl
      setBusy(true)
      try {
        const [res, tagRows] = await Promise.all([
          api.search.stream(term, { size: 8, signal: ctl.signal }),
          api.tags.search({ prefix: term.replace(/^#/, ''), limit: 3 }).catch(() => []),
        ])
        if (ctl.signal.aborted) return
        setHits(res.results)
        setTags(tagRows)
        setDegraded(res.degraded)
        setActive(-1)
      } catch (e) {
        if (e?.name !== 'AbortError') { setHits([]); setTags([]) }
      } finally {
        if (inflight.current === ctl) { inflight.current = null; setBusy(false) }
      }
    }, 200)
    return () => clearTimeout(t)
  }, [term, open])

  // Close when the pointer goes anywhere else — a shell dropdown that survives
  // a click on the page underneath reads as stuck.
  React.useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (!boxRef.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const goAll = () => {
    if (!term) return
    setOpen(false)
    navigate('/explore?q=' + encodeURIComponent(term))
  }
  const openHit = (hit) => {
    setOpen(false)
    /* A sound has no page of its own — Explore resolves ?sound= into a
       preview card, which is where hitHref points it. */
    const href = hitHref(hit)
    if (href) navigate(href)
    else goAll()
  }
  const openTag = (tag) => { setOpen(false); navigate(`/tags/${encodeURIComponent(tag)}`) }

  /* One flat list for the keyboard: -1 is the "search everything" row, then
     the entity hits, then the tags. Keeping it flat is what makes ↓↓↓ feel
     like one list instead of three. */
  const rows = [...hits.map(h => ({ kind:'hit', hit:h })), ...tags.map(t => ({ kind:'tag', tag:t }))]
  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const row = rows[active]
      if (!row) return goAll()
      return row.kind === 'hit' ? openHit(row.hit) : openTag(row.tag.tag)
    }
    if (e.key === 'Escape') { setOpen(false); e.currentTarget.blur(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, rows.length - 1)) }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(i => Math.max(i - 1, -1)) }
  }

  const showPop = open && term.length >= 2

  return (
    <div className="tb-search" ref={boxRef}>
      <Icon name="search"/>
      <input
        value={q}
        onChange={e => { setQ(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        placeholder="Search posts, research, scholars, sounds…"
        role="combobox"
        aria-expanded={showPop}
        aria-controls="tb-search-pop"
        aria-autocomplete="list"
      />
      {showPop && (
        <div className="tb-pop" id="tb-search-pop" role="listbox">
          <button
            type="button"
            className={'tb-pop-all' + (active === -1 ? ' on' : '')}
            onMouseDown={e => e.preventDefault()}
            onMouseEnter={() => setActive(-1)}
            onClick={goAll}>
            <Icon name="search" className="xs"/>
            <span>Search everything for “<b>{term}</b>”</span>
            {busy && <i className="tb-pop-busy" aria-hidden="true"/>}
          </button>

          {rows.map((row, i) => row.kind === 'hit' ? (
            <button
              key={`${row.hit.contentType}:${row.hit.contentId}`}
              type="button"
              role="option"
              aria-selected={active === i}
              className={'tb-pop-row' + (active === i ? ' on' : '')}
              onMouseDown={e => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => openHit(row.hit)}>
              <span className="tb-pop-ic"><Icon name={kindOf(row.hit.contentType).icon} className="xs"/></span>
              <span className="tb-pop-tx">
                <b dir="auto">{row.hit.titlePreview || kindOf(row.hit.contentType).label}</b>
                <small className="muted">{subtitleOf(row.hit)}</small>
              </span>
              <span className="tb-pop-kind">{kindOf(row.hit.contentType).label}</span>
            </button>
          ) : (
            <button
              key={`tag:${row.tag.tag}`}
              type="button"
              role="option"
              aria-selected={active === i}
              className={'tb-pop-row' + (active === i ? ' on' : '')}
              onMouseDown={e => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => openTag(row.tag.tag)}>
              <span className="tb-pop-ic"><Icon name="hash" className="xs"/></span>
              <span className="tb-pop-tx">
                <b>#{row.tag.tag}</b>
                <small className="muted">{row.tag.usageCount} uses</small>
              </span>
              <span className="tb-pop-kind">Tag</span>
            </button>
          ))}

          {/* An empty list because the index is DOWN is not the same statement
              as an empty list because nothing matched — never say the second
              when the server told us the first. */}
          {!busy && !rows.length && (
            <div className="tb-pop-note muted text-xs">
              {degraded
                ? 'Search is temporarily degraded — results may be missing. Try again in a moment.'
                : 'No quick matches — press Enter to search everything.'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
