/* =========================================================
   Settings page — /settings
   Profile / Account / Privacy / Close friends (live) /
   Notifications / Blocked / Security / Verification.
   ========================================================= */
import React from 'react'
import { Icon, Avatar, showToast } from '../components/ui.jsx'
import { uiConfirm } from '../components/Dialog.jsx'
import { EmptyState } from '../components/states.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { api } from '../api/index.js'

function Toggle({ title, desc, on: initial }) {
  const [on, setOn] = React.useState(initial)
  return (
    <div className="set-toggle">
      <div><b>{title}</b><small className="muted">{desc}</small></div>
      <button className={'sw ' + (on ? 'on' : '')} onClick={() => setOn(v => !v)}/>
    </div>
  )
}

function ProfilePanel({ me }) {
  const { refreshUser } = useAuth()
  const [full, setFull] = React.useState(me.full || '')
  const [handle, setHandle] = React.useState(me.handle || '')
  const [bio, setBio] = React.useState(me.bio || '')
  const [field, setField] = React.useState(me.field || '')
  const [location, setLocation] = React.useState(me.location || '')
  const [busy, setBusy] = React.useState(false)
  const avatarRef = React.useRef(null); const coverRef = React.useRef(null)

  const pickAvatar = (e) => { const f = e.target.files?.[0]; e.target.value=''; if (!f) return; api.users.uploadAvatar(f).then(() => { showToast('Photo updated'); refreshUser() }).catch(() => showToast('Could not upload photo')) }   // §10.4
  const pickCover  = (e) => { const f = e.target.files?.[0]; e.target.value=''; if (!f) return; api.users.uploadCover(f).then(() => { showToast('Cover updated'); refreshUser() }).catch(() => showToast('Could not upload cover')) }   // §10.6

  const save = async () => {
    setBusy(true)
    try {
      const parts = full.trim().split(/\s+/)
      const fname = parts[0] || '', lname = parts.slice(1).join(' ') || parts[0] || ''
      const uname = handle.replace(/^@/, '').split('@')[0].trim()   // username is never an email (§8.1 charset)
      await api.users.updateIdentity({ fname, lname, ...(uname && uname !== me.handle ? { username: uname } : {}) })   // §9.5
      await api.users.updateProfile({ displayName: full.trim(), profileBio: bio, academicTitle: field, location })    // §10.3
      await refreshUser()
      showToast('Profile saved')
    } catch (e) {
      showToast(e?.code === 'USERNAME_ALREADY_EXISTS' ? 'That handle is taken' : (e?.message || 'Could not save'))
    } finally { setBusy(false) }
  }

  return (
    <div className="card card-pad">
      <h3 className="title">Public profile</h3>
      <div className="set-avatar-row">
        <Avatar initials={me.initials} color={me.avc} size={72} src={me.profileImage}/>
        <div><b className="text-md">Profile picture</b><p className="muted text-xs">JPG, PNG or WebP. Square images work best.</p></div>
        <input ref={avatarRef} type="file" hidden accept="image/*" onChange={pickAvatar}/>
        <input ref={coverRef} type="file" hidden accept="image/*" onChange={pickCover}/>
        <div className="flex gap-8" style={{ marginLeft:'auto' }}>
          <button className="btn btn-secondary btn-sm" onClick={() => coverRef.current?.click()}><Icon name="image" className="xs"/>Cover</button>
          <button className="btn btn-secondary btn-sm" onClick={() => avatarRef.current?.click()}><Icon name="upload" className="xs"/>Upload</button>
        </div>
      </div>
      <div className="set-grid">
        <div><label className="field-label">Full name</label><input className="field" value={full} onChange={e => setFull(e.target.value)}/></div>
        <div><label className="field-label">Handle</label><input className="field" value={'@'+handle.replace(/^@/, '')} onChange={e => setHandle(e.target.value)}/></div>
        <div style={{gridColumn:'1/-1'}}><label className="field-label">Bio</label><textarea className="field" value={bio} onChange={e => setBio(e.target.value)}/></div>
        <div><label className="field-label">Field of study</label><input className="field" value={field} onChange={e => setField(e.target.value)}/></div>
        <div><label className="field-label">Location</label><input className="field" placeholder="City, Country" value={location} onChange={e => setLocation(e.target.value)}/></div>
      </div>
      <div className="set-actions">
        <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button>
      </div>
    </div>
  )
}

function CloseFriendsPanel() {
  const [list, setList] = React.useState([])
  const [q, setQ] = React.useState('')
  const [results, setResults] = React.useState([])
  const ids = new Set(list.map(u => u.id))
  React.useEffect(() => { api.closeFriends.list().then(r => setList(r || [])).catch(() => {}) }, [])
  const searchUsers = (term) => { setQ(term); if (term.trim()) api.users.search(term, { size: 6 }).then(setResults).catch(() => {}); else setResults([]) }
  const add = (u) => { setList(l => [...l, u]); api.closeFriends.add(u.id).then(() => showToast(`Added ${u.full.split(' ')[0]}`)).catch(() => showToast('They must be following you first')) }
  const remove = (u) => { setList(l => l.filter(x => x.id !== u.id)); api.closeFriends.remove(u.id).catch(() => {}); showToast('Removed') }
  return (
    <div className="card card-pad">
      <h3 className="title"><Icon name="users" className="sm"/>Close friends</h3>
      <p className="muted text-sm" style={{marginBottom:14}}>Your inner circle. Stories set to <b>Close friends</b> are shown only to people on this list.</p>
      <div className="cmt-box" style={{ marginTop:0, marginBottom:12 }}>
        <input className="field" placeholder="Search people to add…" value={q} onChange={e => searchUsers(e.target.value)}/>
      </div>
      {q && results.length > 0 && (
        <div className="rail-list" style={{ marginBottom:12 }}>
          {results.filter(u => !ids.has(u.id)).map(u => (
            <div key={u.id} className="rail-row">
              <Avatar initials={u.initials} color={u.avc} size={36} src={u.profileImage}/>
              <div className="rail-info"><div className="rail-name"><b>{u.full}</b></div><div className="rail-sub">@{u.handle}</div></div>
              <button className="btn btn-primary btn-sm" onClick={() => add(u)}><Icon name="follow" className="xs"/>Add</button>
            </div>
          ))}
        </div>
      )}
      {list.length ? (
        <div className="rail-list">
          {list.map(u => (
            <div key={u.id} className="rail-row">
              <Avatar initials={u.initials} color={u.avc} size={40} src={u.profileImage}/>
              <div className="rail-info"><div className="rail-name"><b>{u.full}</b></div><div className="rail-sub">@{u.handle}</div></div>
              <button className="btn btn-secondary btn-sm" onClick={() => remove(u)}>Remove</button>
            </div>
          ))}
        </div>
      ) : <EmptyState icon="users" title="No close friends yet" sub="Add people to share close-friends stories with."/>}
    </div>
  )
}

function BlockedPanel() {
  const [list, setList] = React.useState(null)
  React.useEffect(() => { api.users.blocked().then(setList).catch(() => setList([])) }, [])
  const unblock = (u) => { setList(l => l.filter(x => x.id !== u.id)); api.users.unblock(u.id).catch(() => {}); showToast('Unblocked') }
  if (list === null) return <div className="card card-pad"><h3 className="title">Blocked users</h3><p className="muted text-sm">Loading…</p></div>
  return (
    <div className="card card-pad">
      <h3 className="title">Blocked users</h3>
      <p className="muted text-sm" style={{marginBottom:14}}>Blocked people can’t see your posts, follow you, or message you.</p>
      {list.length ? (
        <div className="rail-list">
          {list.map(u => (
            <div key={u.id} className="rail-row">
              <Avatar initials={u.initials} color={u.avc} size={40} src={u.profileImage}/>
              <div className="rail-info"><div className="rail-name"><b>{u.full}</b></div><div className="rail-sub">@{u.handle}</div></div>
              <button className="btn btn-secondary btn-sm" onClick={() => unblock(u)}>Unblock</button>
            </div>
          ))}
        </div>
      ) : <EmptyState icon="block" title="You haven’t blocked anyone"/>}
    </div>
  )
}

function EmailPrefsPanel() {
  const [prefs, setPrefs] = React.useState(null)
  React.useEffect(() => { api.users.emailPrefs().then(setPrefs).catch(() => setPrefs({ master:true, social:true, mentions:true, system:true })) }, [])
  const toggle = (key) => {
    setPrefs(p => {
      const next = { ...p, [key]: !p[key] }
      api.users.updateEmailPrefs({ [key]: next[key] }).catch(() => {})
      return next
    })
  }
  if (!prefs) return <div className="card card-pad"><h3 className="title">Email preferences</h3><p className="muted text-sm">Loading…</p></div>
  const rows = [
    ['master', 'All emails', 'Master switch — turn off to stop all outbound emails.'],
    ['social', 'Social', 'Follows, blocks, and other social interactions.'],
    ['mentions', 'Mentions', 'When someone @mentions you.'],
    ['system', 'System', 'Announcements and account warnings.'],
  ]
  const test = () => api.users.testEmail().then(r => showToast(r?.queued ? `Test email sent to ${r.to}` : (r?.reason || 'No email on file'))).catch(() => showToast('Could not send'))   // §16.3
  const unsub = () => api.users.unsubscribeAll().then(() => { showToast('Unsubscribed from all emails'); setPrefs(p => ({ ...p, master:false })) }).catch(() => {})   // §16.4
  return (
    <div className="card card-pad">
      <h3 className="title">Email preferences</h3>
      {rows.map(([k, title, desc]) => (
        <div key={k} className="set-toggle">
          <div><b>{title}</b><small className="muted">{desc}</small></div>
          <button className={'sw ' + (prefs[k] ? 'on' : '')} onClick={() => toggle(k)}/>
        </div>
      ))}
      <div className="set-actions" style={{ marginTop:8 }}>
        <button className="btn btn-secondary btn-sm" onClick={test}><Icon name="bell" className="xs"/>Send test email</button>
        <button className="btn btn-secondary btn-sm" onClick={unsub}>Unsubscribe from all</button>
      </div>
    </div>
  )
}

function RestrictedPanel() {
  const [list, setList] = React.useState(null)
  React.useEffect(() => { api.users.restricted().then(setList).catch(() => setList([])) }, [])   // §11.10
  const unrestrict = (u) => { setList(l => l.filter(x => x.id !== u.id)); api.users.unrestrict(u.id).catch(() => {}); showToast('Restriction removed') }
  if (list === null) return <div className="card card-pad"><h3 className="title">Restricted users</h3><p className="muted text-sm">Loading…</p></div>
  return (
    <div className="card card-pad">
      <h3 className="title">Restricted users</h3>
      <p className="muted text-sm" style={{marginBottom:14}}>Restricted people can still see your content, but their comments are visible only to themselves.</p>
      {list.length ? (
        <div className="rail-list">
          {list.map(u => (
            <div key={u.id} className="rail-row">
              <Avatar initials={u.initials} color={u.avc} size={40} src={u.profileImage}/>
              <div className="rail-info"><div className="rail-name"><b>{u.full}</b></div><div className="rail-sub">@{u.handle}</div></div>
              <button className="btn btn-secondary btn-sm" onClick={() => unrestrict(u)}>Unrestrict</button>
            </div>
          ))}
        </div>
      ) : <EmptyState icon="eye" title="No restricted users"/>}
    </div>
  )
}

function SecurityPanel() {
  const { logoutEverywhere } = useAuth()
  const [cur, setCur] = React.useState(''); const [next, setNext] = React.useState(''); const [busy, setBusy] = React.useState(false)
  const change = async () => {
    if (next.length < 8) { showToast('New password must be at least 8 characters'); return }
    setBusy(true)
    try { await api.auth.changePassword(cur, next); setCur(''); setNext(''); showToast('Password updated') }   // §8.6
    catch (e) { showToast(e?.code === 'INVALID_CREDENTIALS' ? 'Current password is wrong' : (e?.message || 'Could not update password')) }
    finally { setBusy(false) }
  }
  const logoutAll = async () => {                                                                  // §8.5
    const ok = await uiConfirm({ title:'Sign out everywhere?', message:'Your active sessions on every other browser, phone, and tablet will end immediately. You stay signed in here.', confirmLabel:'Sign out everywhere', icon:'logout' })
    if (ok) logoutEverywhere()
  }
  return (
    <div className="card card-pad"><h3 className="title">Security</h3>
      <div className="set-grid">
        <div><label className="field-label">Current password</label><input className="field" type="password" value={cur} onChange={e => setCur(e.target.value)} placeholder="••••••••"/></div>
        <div><label className="field-label">New password</label><input className="field" type="password" value={next} onChange={e => setNext(e.target.value)} placeholder="At least 8 characters"/></div>
      </div>
      <p className="muted text-xs" style={{ marginTop:6 }}>Changing your password signs out every other device.</p>
      <div className="set-actions"><button className="btn btn-primary" disabled={busy || !cur || !next} onClick={change}>{busy ? 'Updating…' : 'Update password'}</button></div>
      <div className="set-toggle" style={{ marginTop:8 }}>
        <div><b>Log out everywhere</b><small className="muted">Revoke every active session on all devices.</small></div>
        <button className="btn btn-secondary btn-sm" onClick={logoutAll}><Icon name="logout" className="xs"/>Log out all</button>
      </div>
    </div>
  )
}

export function SettingsPage() {
  const { user } = useAuth()
  const me = user || { full:'You', handle:'you', initials:'Y', avc:'linear-gradient(135deg,#159a76,#0a4a3c)', bio:'', field:'' }
  const [tab, setTab] = React.useState('PROFILE')

  return (
    <div className="main center">
      <div className="col-main">
        <div className="phead"><div><h1>Settings</h1><p className="sub">Manage your account, privacy, notifications, and security.</p></div></div>

        <div className="settings-shell">
          <aside className="set-side">
            {[
              ['PROFILE','user','Profile'],
              ['ACCOUNT','settings','Account'],
              ['PRIVACY','lock','Privacy'],
              ['CLOSE_FRIENDS','users','Close friends'],
              ['NOTIFICATIONS','bell','Emails'],
              ['BLOCKED','block','Blocked users'],
              ['RESTRICTED','eye','Restricted'],
              ['SECURITY','shield','Security'],
              ['VERIFICATION','award','Verification'],
            ].map(([k,ic,lab]) => (
              <button key={k} className={'set-item ' + (tab===k?'on':'')} onClick={() => setTab(k)}><Icon name={ic} className="sm"/>{lab}</button>
            ))}
          </aside>

          <div>
            {tab==='PROFILE' && <ProfilePanel me={me}/>}
            {tab==='ACCOUNT' && (
              <div className="card card-pad"><h3 className="title">Account</h3>
                <div className="set-grid">
                  <div><label className="field-label">Email</label><input className="field" placeholder="you@example.com"/></div>
                  <div><label className="field-label">Phone</label><input className="field" placeholder="+964 …"/></div>
                  <div><label className="field-label">Language</label><select className="field"><option>English</option><option>العربية</option><option>کوردی</option></select></div>
                  <div><label className="field-label">Time zone</label><select className="field"><option>Asia/Baghdad (GMT+3)</option></select></div>
                </div>
                <div className="set-actions"><button className="btn btn-primary" onClick={() => showToast('Saved')}>Save</button></div>
              </div>
            )}
            {tab==='PRIVACY' && (
              <div className="card card-pad"><h3 className="title">Privacy</h3>
                <Toggle title="Make profile public" desc="Anyone can see your posts and research." on={true}/>
                <Toggle title="Show activity status" desc="Let others see when you were last active." on={true}/>
                <Toggle title="Index in search engines" desc="Allow others to surface your profile." on={true}/>
              </div>
            )}
            {tab==='CLOSE_FRIENDS' && <CloseFriendsPanel/>}
            {tab==='NOTIFICATIONS' && <EmailPrefsPanel/>}
            {tab==='BLOCKED' && <BlockedPanel/>}
            {tab==='RESTRICTED' && <RestrictedPanel/>}
            {tab==='SECURITY' && <SecurityPanel/>}
            {tab==='VERIFICATION' && (
              <div className="card card-pad"><h3 className="title">Verification</h3>
                <p className="text-sm">IKA verifies scholars and researchers via their institutional affiliation. Submit your credentials and our review team will respond within 5–7 working days.</p>
                <div className="ver-step ver-current"><span className="ver-num">1</span><div><b>Account in good standing</b><small className="muted">Your account meets minimum requirements.</small></div><Icon name="check" className="sm" style={{color:'var(--emerald)',marginLeft:'auto'}}/></div>
                <div className="ver-step"><span className="ver-num">2</span><div><b>Submit credentials</b><small className="muted">Upload your ijaza, degree certificate, or institutional ID.</small></div><button className="btn btn-primary btn-sm" style={{marginLeft:'auto'}} onClick={() => showToast('Submitted for review')}>Submit</button></div>
                <div className="ver-step"><span className="ver-num">3</span><div><b>Review</b><small className="muted">Our scholars panel reviews submissions weekly.</small></div></div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
