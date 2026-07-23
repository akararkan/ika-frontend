/* =========================================================
   StarredPanel — my bookmarked messages, across every chat.
   ---------------------------------------------------------
   A star is PRIVATE: nobody else can see it, it survives edits,
   and it is dropped when the message is deleted for everyone.
   The list is Postgres-paged but the endpoint returns a bare
   List (no `Page` envelope, no `hasMore`), so "is there another
   page?" is inferred the only way available — a full page came
   back. Ask for one more than we show and the inference is
   exact, but the API caps `size`, so a full page it is.

   Rows route through the same `onJump(messageId, conversationId)`
   contract the search panel uses, which is why a hit in another
   conversation navigates first and defers the jump.
   ========================================================= */
import React from 'react'
import { Icon, Avatar } from '../ui.jsx'
import { Loader, EmptyState, ErrorState } from '../states.jsx'
import { useChat } from '../../context/ChatContext.jsx'
import { api } from '../../api/index.js'

const PAGE = 30

const shortDate = (iso) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

const previewOf = (m) => m.body
  || { IMAGE: 'Photo', VIDEO: 'Video', VOICE: 'Voice message', FILE: 'File' }[m.media?.[0]?.kind]
  || 'Message'

export function StarredPanel({ onClose, onJump }) {
  const { getConvo, enrichAuthor, watchUsers } = useChat()
  const [rows, setRows] = React.useState([])
  const [state, setState] = React.useState('loading')   // loading | ready | error
  const [page, setPage] = React.useState(0)
  const [hasMore, setHasMore] = React.useState(false)
  const [more, setMore] = React.useState(false)

  const load = React.useCallback(async (p) => {
    try {
      const res = await api.chat.messages.starred({ page: p, size: PAGE })
      setRows(prev => {
        if (p === 0) return res
        const seen = new Set(prev.map(m => m.id))
        return [...prev, ...res.filter(m => !seen.has(m.id))]
      })
      setHasMore(res.length >= PAGE)
      setPage(p)
      setState('ready')
    } catch {
      if (p === 0) setState('error')
    } finally {
      setMore(false)
    }
  }, [])

  React.useEffect(() => { load(0) }, [load])

  // Chat DTOs carry no avatar — resolve the senders through the directory.
  React.useEffect(() => {
    const ids = rows.map(m => m.senderId).filter(Boolean)
    if (ids.length) watchUsers(ids)
  }, [rows, watchUsers])

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="ch-search ch-starred" role="region" aria-label="Starred messages">
      <div className="ch-search-head">
        <h3><Icon name="star" className="sm"/>Starred</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Close starred messages" title="Close">
          <Icon name="close" className="sm"/>
        </button>
      </div>

      <div className="ch-search-body">
        {state === 'loading' && <Loader label="Loading starred…"/>}
        {state === 'error' && (
          <ErrorState message="Starred messages are unavailable right now." onRetry={() => { setState('loading'); load(0) }}/>
        )}
        {state === 'ready' && rows.length === 0 && (
          <EmptyState
            icon="star"
            title="Nothing starred yet"
            sub="Star a message from its menu to keep it here. Only you can see your stars."
          />
        )}

        {state === 'ready' && rows.map(m => {
          const where = getConvo(m.conversationId)
          const who = enrichAuthor(m.sender, m.senderId)
          return (
            <button key={m.id} className="ch-hitrow" onClick={() => onJump?.(m.id, m.conversationId)}>
              <Avatar initials={who?.initials || '·'} color={who?.avc} size={32} src={who?.profileImage}/>
              <span className="ch-hitrow-main">
                <span className="ch-hitrow-top">
                  <b dir="auto">{who?.full || who?.handle || 'Member'}</b>
                  {where && <span className="ch-hitrow-in" dir="auto">in {where.displayTitle}</span>}
                  <span className="ch-hitrow-date">{shortDate(m.createdAt)}</span>
                </span>
                <span className="ch-hitrow-body" dir="auto">{previewOf(m)}</span>
              </span>
            </button>
          )
        })}

        {state === 'ready' && hasMore && (
          <div className="cv-more">
            <button type="button" className="ch-older-btn" disabled={more}
              onClick={() => { setMore(true); load(page + 1) }}>
              {more ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default StarredPanel
