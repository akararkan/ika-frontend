/* =========================================================
   Public user profile — /u/:id
   Live profile + follow / block via the social-graph API.
   ========================================================= */
import React from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Icon, Avatar, Verify, Badges, fmt, showToast } from '../components/ui.jsx'
import { ProfileDetails } from '../components/ProfileDetails.jsx'
import { PostCard } from '../components/PostCard.jsx'
import { Loader, EmptyState } from '../components/states.jsx'
import { FollowListModal } from '../components/FollowListModal.jsx'
import { useImageViewer } from '../components/ImageLightbox.jsx'
import { useImageRatio, coverStyle } from '../lib/useImageRatio.js'
import { useAuth } from '../context/AuthContext.jsx'
import { api } from '../api/index.js'

export function UserProfilePage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user: me } = useAuth()
  const [u, setU] = React.useState(null)
  const [status, setStatus] = React.useState(null)
  const [posts, setPosts] = React.useState([])
  const [tab, setTab] = React.useState('POSTS')
  const [research, setResearch] = React.useState([])
  const [reels, setReels] = React.useState([])      // reel-only list (§17.2 by-author)
  const [stats, setStats] = React.useState(null)   // §9.14
  const [followList, setFollowList] = React.useState(null)   // {mode} → followers/following list modal
  const [loading, setLoading] = React.useState(true)
  const { openable, viewer } = useImageViewer()   // cover + portrait open full-screen
  const coverAr = useImageRatio(u?.coverImage)    // the plate takes the cover's own shape

  const isMe = me?.id === id

  React.useEffect(() => {
    let alive = true
    setLoading(true)
    api.users.profile(id).then(x => { if (alive) setU(x) }).catch(() => { if (alive) setU(false) }).finally(() => { if (alive) setLoading(false) })
    if (!isMe) api.users.socialStatus(id).then(s => { if (alive) setStatus(s) }).catch(() => {})
    api.users.stats(id).then(s => { if (alive) setStats(s) }).catch(() => {})
    api.posts.byAuthor(id).then(p => { if (alive) setPosts(p || []) }).catch(() => {})
    api.research.byResearcher(id).then(r => { if (alive) setResearch(r || []) }).catch(() => {})
    api.reels.byAuthor(id).then(rl => { if (alive) setReels(rl || []) }).catch(() => {})
    return () => { alive = false }
  }, [id, isMe])

  if (isMe) { navigate('/profile', { replace: true }); return null }
  if (loading) return <div className="main center"><div className="col-main"><Loader label="Loading profile…"/></div></div>
  if (!u) return <div className="main center"><div className="col-main"><EmptyState icon="user" title="User not found"/></div></div>

  /* Open (or reuse) the DM with this person. `createDirect` is get-or-create on
     the backend — a deterministic direct_key means tapping Message twice can
     never fork the thread — so we just route to whatever id comes back. */
  const message = async () => {
    try {
      const convo = await api.chat.conversations.createDirect(id)
      if (convo?.id) navigate(`/chat/${convo.id}`)
    } catch (e) {
      showToast(e?.code === 'BLOCKED' ? 'You can’t message this account.' : (e?.message || 'Could not open the chat'))
    }
  }

  const following = status?.isFollowing
  const toggleFollow = () => {
    const was = following
    // optimistic flip + count nudge
    setStatus(s => ({ ...s, isFollowing: !was, followerCount: Math.max(0, (s?.followerCount ?? stats?.followers ?? 0) + (was ? -1 : 1)) }))
    ;(was ? api.users.unfollow(id) : api.users.follow(id))
      .then(res => {
        showToast(was ? 'Unfollowed' : 'Following')
        const us = res?.updatedStatus                                   // §18.5 — bind authoritative flags + counts, don't recount
        if (us) { setStatus(s => ({ ...s, ...us })); setStats(st => st ? { ...st, followers: us.followerCount ?? st.followers } : st) }
      })
      .catch(e => {
        if (e?.code === 'ALREADY_FOLLOWING') { setStatus(s => ({ ...s, isFollowing: true })); return }   // §18.9 — reconcile, treat as success
        if (e?.code === 'NOT_FOLLOWING')     { setStatus(s => ({ ...s, isFollowing: false })); return }
        setStatus(s => ({ ...s, isFollowing: was, followerCount: Math.max(0, (s?.followerCount ?? 0) + (was ? 1 : -1)) }))   // roll back
        showToast('Could not update — please try again')
      })
  }
  const block = () => { api.users.block(id).then(() => { showToast('User blocked'); navigate(-1) }).catch(() => {}) }
  const restricting = status?.isRestricting
  const toggleRestrict = () => {
    setStatus(s => ({ ...s, isRestricting: !restricting }))
    ;(restricting ? api.users.unrestrict(id) : api.users.restrict(id)).then(() => showToast(restricting ? 'Restriction removed' : 'User restricted')).catch(() => setStatus(s => ({ ...s, isRestricting: restricting })))
  }
  const blockedByThem = status?.isBlockedByThem
  const onlyPosts = posts.filter(p => p.type !== 'REEL')   // reels come from the dedicated §17.2 list

  return (
    <div className="main center">
      <div className="col-main">
        <button className="back-btn" onClick={() => navigate(-1)}><Icon name="chevleft" className="sm"/>Back</button>

        {/* The photo and its shape ride on the PLATE (as custom properties), so
            the stylesheet owns how a cover is fitted — see warm/user.css. */}
        <div className={'prof-cover' + (u.coverImage ? ' has-img' : '')} style={coverStyle(u.coverImage, coverAr)}>
          <div {...openable(u.coverImage, { className:'prof-cover-grad', label:`Cover photo of ${u.full || u.handle}` })}/>
          {!u.coverImage && <div className="prof-cover-pattern"/>}
        </div>
        <div className="prof-head">
          <span {...openable(u.profileImage, { className:'t-ring', label:`Profile photo of ${u.full || u.handle}` })}>
            <Avatar initials={u.initials} color={u.avc} size={132} className="prof-avatar" src={u.profileImage}/>
          </span>
          <div className="prof-actions">
            {blockedByThem ? (
              <span className="btn btn-secondary" style={{ cursor:'default' }}><Icon name="block" className="sm"/>Unavailable</span>
            ) : (
              <button className={'btn ' + (following ? 'btn-secondary is-following' : 'btn-primary')} onClick={toggleFollow}>
                <Icon name={following ? 'followed' : 'follow'} className="sm"/>{following ? 'Following' : 'Follow'}
              </button>
            )}
            {!blockedByThem && (
              <button className="btn btn-secondary" onClick={message} title="Send a direct message">
                <Icon name="chat" className="sm"/>Message
              </button>
            )}
            <button className={'btn btn-secondary' + (restricting ? ' on-brass' : '')} onClick={toggleRestrict} title="Restrict — their comments show only to them"><Icon name="eye" className="sm"/>{restricting ? 'Restricted' : 'Restrict'}</button>
            <button className="btn btn-secondary" onClick={block}><Icon name="block" className="sm"/>Block</button>
          </div>
        </div>
        <div className="prof-meta">
          <h1>{u.full} {u.badges?.length ? <Badges items={u.badges}/> : (u.verified && <Verify scholar={u.role==='SCHOLAR'}/>)}</h1>
          <div className="prof-handle">@{u.handle} · <span className="pill role">{(u.role||'member').toLowerCase()}</span>{u.isForHire && <span className="pill hire"><Icon name="award" className="xs"/>Available for hire</span>}{u.profileLocked && <span className="pill locked"><Icon name="lock" className="xs"/>Private</span>}</div>
          {u.selfDescriber && <p className="prof-tagline">{u.selfDescriber}</p>}
          {u.bio && <p className="prof-bio">{u.bio}</p>}
          <div className="prof-counts">
            <button onClick={() => setTab('POSTS')}><b>{fmt(stats?.posts ?? onlyPosts.length)}</b><small>POSTS</small></button>
            <button onClick={() => setTab('REELS')}><b>{fmt(stats?.reels ?? reels.length)}</b><small>REELS</small></button>
            <button onClick={() => setTab('RESEARCH')}><b>{fmt(stats?.research ?? research.length)}</b><small>RESEARCH</small></button>
            <button><b>{fmt(stats?.questions ?? 0)}</b><small>QUESTIONS</small></button>
            <button onClick={() => setFollowList({ mode:'followers' })}><b>{fmt(status?.followerCount ?? stats?.followers ?? u.followers)}</b><small>FOLLOWERS</small></button>
            <button onClick={() => setFollowList({ mode:'following' })}><b>{fmt(stats?.following ?? u.following)}</b><small>FOLLOWING</small></button>
          </div>
        </div>

        <ProfileDetails u={u}/>

        <div className="tabs">
          {['POSTS','REELS','RESEARCH'].map(t => <button key={t} className={'tab ' + (tab===t?'on':'')} onClick={() => setTab(t)}>{t[0]+t.slice(1).toLowerCase()}</button>)}
        </div>

        {tab==='POSTS' && (onlyPosts.length ? <div className="feed-list">{onlyPosts.map((p,i)=><PostCard key={p.id} post={p} index={i} onOpenComments={() => navigate(`/posts/${p.id}`)}/>)}</div> : <EmptyState icon="feed" title="No posts yet"/>)}
        {tab==='REELS' && (reels.length ? <div className="feed-list">{reels.map((p,i)=><PostCard key={p.id} post={p} index={i} onOpenComments={() => navigate(`/posts/${p.id}`)}/>)}</div> : <EmptyState icon="reels" title="No reels yet"/>)}
        {tab==='RESEARCH' && (research.length ? <div className="r-list">{research.map(r => (
          <article key={r.id} className="r-card" onClick={() => navigate(`/research/${r.id}`)}>
            <div className="r-cover" style={{ background:r.cover }}><span className="r-irc font-mono">{r.irc}</span></div>
            <div className="r-body"><h3>{r.title}</h3><p className="r-abs">{r.abstract}</p></div>
          </article>
        ))}</div> : <EmptyState icon="research" title="No research yet"/>)}
      </div>
      {followList && <FollowListModal userId={id} mode={followList.mode} onClose={() => setFollowList(null)}/>}
      {viewer}
    </div>
  )
}
