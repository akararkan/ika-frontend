/* =========================================================
   Chat search — a slide-over panel with two scopes:
     "This chat"  → GET /conversations/{id}/messages/search
     "All chats"  → GET /messaging/search  (membership-scoped
                    server-side, so it can only ever return
                    conversations you are actually in)
   ---------------------------------------------------------
   TWO ENTRY POINTS, opening on different scopes:
   · the thread header, with a conversation open → "This chat"
   · the messages-list header, with or without one → "All chats"
   The second one is not a convenience. Chat messages are
   deliberately EXCLUDED from the site-wide /search endpoint —
   they are membership-scoped and live behind this API — so this
   panel is the only way to search them anywhere in the product,
   and while the global scope could only be reached from inside
   an already-open conversation it was, in practice, unreachable.
   `initialScope` / `initialQuery` only SEED state; the tabs and
   the field below own both from then on. ChatPage keys the
   element per entry point, which is what re-seeds them when you
   arrive from the other button.
   ---------------------------------------------------------
   Things worth knowing:
   · The two scopes DEGRADE DIFFERENTLY, and the empty state has
     to say so. In-conversation falls back to a bounded
     Cassandra scan when the index is cold, so `[]` there really
     does mean "nothing matched". Cross-conversation is
     Elasticsearch-ONLY — no scan fallback, because an
     all-conversations scan would be unbounded — and it returns
     `[]` rather than erroring when the index is unavailable. So
     on "All chats", empty can also mean "not indexed yet".
   · Indexing is async and best-effort on send/edit, and SYSTEM
     plus empty-body (pure-media) messages are never indexed at
     all. A photo with no caption is permanently unsearchable;
     the empty state names that rather than implying the query
     was wrong.
   · Results are BM25-ranked, NOT chronological, so the dates run
     out of order by design — which reads as a sorting bug unless
     the ordering is labelled.
   · Errors are real answers, not just outages: in-conversation
     can return NOT_A_MEMBER / CONVERSATION_NOT_FOUND, so the
     failure goes through the shared error catalog instead of a
     blanket "unavailable".
   · The match highlight is built by SPLITTING on an escaped
     regex and rendering <mark> nodes. Never innerHTML — the
     query is user input and the body is other users' text.
   ========================================================= */
import React from 'react'
import { Icon, Avatar } from '../ui.jsx'
import { Loader, EmptyState, ErrorState } from '../states.jsx'
import { useChat } from '../../context/ChatContext.jsx'
import { chatError } from './chatErrors.js'
import { api } from '../../api/index.js'

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Split `text` around every case-insensitive hit of `q` into React nodes. */
function highlight(text, q) {
  const body = text || ''
  const needle = q.trim()
  if (!needle) return body
  let re
  try { re = new RegExp(`(${escapeRe(needle)})`, 'ig') } catch { return body }
  return body.split(re).map((part, i) => (
    part.toLowerCase() === needle.toLowerCase()
      ? <mark key={i} className="ch-hit">{part}</mark>
      : <React.Fragment key={i}>{part}</React.Fragment>
  ))
}

const shortDate = (iso) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export function ChatSearchPanel({ convo, initialScope, initialQuery, onClose, onJump }) {
  const { getConvo, enrichAuthor, watchUsers } = useChat()
  const canScopeLocal = !!convo
  /* "All chats" is the floor, not just the default: asking for the local
     scope without a conversation would leave the panel holding an endpoint
     it has no id for, so a missing `convo` overrules the caller. */
  const [scope, setScope] = React.useState(
    canScopeLocal && initialScope !== 'global' ? 'local' : 'global',
  )
  const [q, setQ] = React.useState(initialQuery || '')
  const [rows, setRows] = React.useState([])
  const [state, setState] = React.useState('idle')      // idle | loading | ready | error
  /* The failure itself, not just the fact of one. In-conversation search can
     answer `NOT_A_MEMBER` / `CONVERSATION_NOT_FOUND`, and "Search is
     unavailable right now" is the wrong sentence for both — one is a
     permission answer, not an outage. */
  const [err, setErr] = React.useState(null)
  // Bumping this re-runs the query effect without touching `q` — appending an
  // empty string to `q` produced an Object.is-equal value, so React bailed out
  // of the render entirely and "Try again" did nothing at all.
  const [retry, setRetry] = React.useState(0)
  const inputRef = React.useRef(null)

  React.useEffect(() => { inputRef.current?.focus() }, [])

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /* The ID, never the row object. `convo` is an inbox row, and the context
     re-creates it on every message, receipt and typing patch — depending on
     the object re-ran the query (aborting the in-flight one) on traffic that
     has nothing to do with the search. Only the id is ever sent. */
  const convoId = convo?.id || null

  // Debounced query. The AbortController stops a slow earlier request from
  // landing after a newer one and clobbering the results.
  React.useEffect(() => {
    const needle = q.trim()
    if (!needle) { setRows([]); setState('idle'); return }
    const ctl = new AbortController()
    setState('loading')
    const t = setTimeout(() => {
      const run = scope === 'local' && convoId
        ? api.chat.messages.search(convoId, needle, 30, { signal: ctl.signal })
        : api.chat.searchAll(needle, 30, { signal: ctl.signal })
      Promise.resolve(run)
        .then(res => { if (!ctl.signal.aborted) { setRows(res || []); setErr(null); setState('ready') } })
        .catch(e => { if (!ctl.signal.aborted && e?.name !== 'AbortError') { setErr(e); setState('error') } })
    }, 350)
    return () => { clearTimeout(t); ctl.abort() }
  }, [q, scope, convoId, retry])

  /* Chat DTOs carry senderId / senderUsername / senderFullName and nothing
     else — no avatar, no verified flag — so the sender has to be resolved
     through the context's user directory, exactly as the rail and the
     bubbles do. It matters most here: a cross-conversation result list is
     people from rooms you are not currently looking at, and a column of
     initials is the one thing that makes them unrecognisable. */
  React.useEffect(() => {
    const ids = rows.map(m => m.senderId).filter(Boolean)
    if (ids.length) watchUsers(ids)
  }, [rows, watchUsers])

  return (
    <div className="ch-search" role="search" aria-label="Search messages">
      <div className="ch-search-head">
        <h3>Search</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Close search" title="Close">
          <Icon name="close" className="sm"/>
        </button>
      </div>

      {canScopeLocal && (
        <div className="tabs ch-search-tabs" role="tablist">
          <button role="tab" aria-selected={scope === 'local'}
            className={'tab' + (scope === 'local' ? ' on' : '')}
            onClick={() => setScope('local')}>This chat</button>
          <button role="tab" aria-selected={scope === 'global'}
            className={'tab' + (scope === 'global' ? ' on' : '')}
            onClick={() => setScope('global')}>All chats</button>
        </div>
      )}

      <div className="ch-search-field">
        <Icon name="search" className="sm"/>
        <input ref={inputRef} className="field" value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search messages…" aria-label="Search messages"/>
        {q && (
          <button className="icon-btn ch-search-clear" onClick={() => setQ('')}
            aria-label="Clear search" title="Clear">
            <Icon name="close" className="xs"/>
          </button>
        )}
      </div>

      <div className="ch-search-body">
        {state === 'idle' && (
          <p className="ch-search-hint">
            Type to search {scope === 'local' ? 'this conversation' : 'all your conversations'}.
          </p>
        )}
        {state === 'loading' && <Loader label="Searching…"/>}
        {state === 'error' && (
          <ErrorState message={chatError(err, 'Search is unavailable right now.')}
            onRetry={() => setRetry(n => n + 1)}/>
        )}
        {/* "No matches" is only the whole truth for ONE of these scopes.
            In-conversation has a bounded Cassandra-scan fallback, so an empty
            result really does mean nothing matched. Cross-conversation is
            Elasticsearch-ONLY and returns `[]` — not an error — when the index
            is unavailable or a message is too recent to have been indexed
            (indexing is async and best-effort on send). Either way, photos and
            voice notes with no caption are never indexed at all, so "search
            found nothing" and "that content is unsearchable" look identical
            unless the copy separates them. */}
        {state === 'ready' && rows.length === 0 && (
          <EmptyState
            icon="search"
            title="No matches"
            sub={scope === 'global'
              ? 'Try a different word. Messages sent moments ago may not be searchable yet, and photos or voice notes without a caption are never indexed.'
              : 'Try a different word. Photos and voice notes without a caption aren’t searchable.'}
          />
        )}

        {/* Results are BM25-ranked, not chronological — so the dates jump
            around, which reads as a bug unless the ordering is named. (The
            in-conversation scan fallback is the exception: when the index is
            cold it returns newest-first instead, and nothing on the wire tells
            us which path served the request.) */}
        {state === 'ready' && rows.length > 0 && (
          <p className="ch-search-order">
            <Icon name="trending" className="xs"/>
            {rows.length} result{rows.length === 1 ? '' : 's'}, best match first
          </p>
        )}

        {state === 'ready' && rows.map(m => {
          /* Which room a hit came from is the only context a global result
             has — and with no conversation on screen there is nothing else
             to orient by at all, so the label is rendered for every global
             hit rather than only the ones we can name. `getConvo` reads the
             inbox AND the archived list, but a thread that has not been
             paged into either yet resolves to nothing; the fallback keeps
             the row honest instead of silently dropping the line. The jump
             is unaffected — ChatPage routes by id and the page fetches
             whatever row it lands on. */
          const other = scope === 'global' ? getConvo(m.conversationId) : null
          const who = enrichAuthor(m.sender, m.senderId)
          return (
            <button key={m.id} className="ch-hitrow"
              onClick={() => onJump?.(m.id, m.conversationId)}>
              <Avatar initials={who?.initials} color={who?.avc} size={32} src={who?.profileImage}/>
              <span className="ch-hitrow-main">
                <span className="ch-hitrow-top">
                  <b dir="auto">{who?.full || who?.handle || 'Member'}</b>
                  {scope === 'global' && (
                    <span className="ch-hitrow-in" dir="auto">
                      in {other?.displayTitle || 'another conversation'}
                    </span>
                  )}
                  <span className="ch-hitrow-date">{shortDate(m.createdAt)}</span>
                </span>
                <span className="ch-hitrow-body" dir="auto">{highlight(m.body, q)}</span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default ChatSearchPanel
