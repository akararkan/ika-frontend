/* =========================================================
   Followers / Following list — a single modal that lists the
   people who follow a user (§11.3) or whom they follow (§11.4),
   with avatar, name, handle and an inline Follow toggle.

     <FollowListModal userId={id} mode="followers" title="Followers" onClose={…}/>

   `mode` is 'followers' | 'following'. Rows link to /u/:id and
   carry their real follow state (UserResponse.isFollowing) so the
   button reconciles optimistically against §11.1 / §11.2.
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, Avatar, fmt, showToast } from './ui.jsx'
import { Loader, EmptyState } from './states.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { api } from '../api/index.js'

export function FollowListModal({ userId, mode = 'followers', title, onClose }) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [rows, setRows] = React.useState(null)            // null = loading
  const [follows, setFollows] = React.useState({})        // id → isFollowing

  React.useEffect(() => {
    let alive = true
    const fetch = mode === 'following' ? api.users.following : api.users.followers
    fetch(userId, { size: 50 })
      .then(list => {
        if (!alive) return
        const arr = list || []
        setRows(arr)
        setFollows(Object.fromEntries(arr.map(u => [u.id, u.isFollowing])))
      })
      .catch(() => { if (alive) setRows([]) })
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => { alive = false; window.removeEventListener('keydown', onKey) }
  }, [userId, mode, onClose])

  const toggleFollow = (id) => {
    const now = !follows[id]
    setFollows(f => ({ ...f, [id]: now }))
    ;(now ? api.users.follow(id) : api.users.unfollow(id)).catch(() => {
      setFollows(f => ({ ...f, [id]: !now }))
      showToast('Could not update follow')
    })
  }

  const go = (id) => { onClose(); navigate(`/u/${id}`) }

  return (
    <div className="dlg-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dlg follow-list" role="dialog" aria-modal="true" aria-labelledby="follow-list-title">
        <div className="dlg-head">
          <div className="dlg-ic"><Icon name="follow"/></div>
          <h3 id="follow-list-title">{title || (mode === 'following' ? 'Following' : 'Followers')}</h3>
          <button type="button" className="dlg-x" onClick={onClose} aria-label="Close"><Icon name="close" className="sm"/></button>
        </div>

        <div className="dlg-body fl-body t-stagger">
          {rows == null ? <Loader/>
            : !rows.length ? <EmptyState icon="follow" title={mode === 'following' ? 'Not following anyone yet' : 'No followers yet'}/>
            : rows.map(u => (
              <div key={u.id} className="fl-row">
                <button type="button" className="fl-who" onClick={() => go(u.id)}>
                  <Avatar initials={u.initials} color={u.avc} size={44} src={u.profileImage}/>
                  <div className="fl-id">
                    <b>{u.full}</b>
                    <small>@{u.handle}{typeof u.followers === 'number' ? ` · ${fmt(u.followers)} followers` : ''}</small>
                  </div>
                </button>
                {user?.id !== u.id && (
                  <button type="button" className={'btn btn-sm ' + (follows[u.id] ? 'btn-secondary is-following' : 'btn-primary')} onClick={() => toggleFollow(u.id)}>
                    <Icon name={follows[u.id] ? 'followed' : 'follow'} className="sm"/>{follows[u.id] ? 'Following' : 'Follow'}
                  </button>
                )}
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}
