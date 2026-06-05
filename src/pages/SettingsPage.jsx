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

/* Platform enums (USER_API §5.3-5.4) + a label helper shared by the link/contact editors. */
const LINK_PLATFORMS = ['PERSONAL_WEBSITE','TWITTER','GITHUB','LINKEDIN','ORCID','GOOGLE_SCHOLAR','RESEARCHGATE','YOUTUBE','FACEBOOK','INSTAGRAM','TELEGRAM','OTHER']
const CONTACT_PLATFORMS = ['EMAIL','TELEGRAM','WHATSAPP','PHONE','VIBER','SIGNAL','SKYPE','OTHER']
const LANGUAGES = [['EN','English'],['AR','العربية'],['KU','کوردی']]
const platformLabel = (p) => !p ? 'Link' : String(p).toLowerCase().split('_').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ')

function ProfilePanel({ me }) {
  const { refreshUser } = useAuth()
  const [full, setFull] = React.useState(me.full || '')
  const [handle, setHandle] = React.useState(me.handle || '')
  const [tagline, setTagline] = React.useState(me.selfDescriber || '')
  const [bio, setBio] = React.useState(me.bio || '')
  const [field, setField] = React.useState(me.academicTitle || me.field || '')
  const [institution, setInstitution] = React.useState(me.institution || '')
  const [location, setLocation] = React.useState(me.location || '')
  const [website, setWebsite] = React.useState(me.website || '')
  const [orcid, setOrcid] = React.useState(me.orcid || '')
  const [lang, setLang] = React.useState(me.contentLanguage || 'EN')
  const [forHire, setForHire] = React.useState(!!me.isForHire)
  const [priv, setPriv] = React.useState(!!me.profileLocked)
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
      await api.users.updateIdentity({                                                               // §9.5 — User-side identity
        fname, lname,
        ...(uname && uname !== me.handle ? { username: uname } : {}),
        orcidId: orcid.trim(),
        preferredLanguage: lang,
      })
      await api.users.updateProfile({                                                                // §10.3 — UserProfile-side
        displayName: full.trim(), profileBio: bio, selfDescriber: tagline,
        academicTitle: field, institutionName: institution, location,
        websiteUrl: website.trim(), contentLanguage: lang,
        isForHire: forHire, isProfileLocked: priv,
      })
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
        <div style={{gridColumn:'1/-1'}}><label className="field-label">Tagline</label><input className="field" value={tagline} onChange={e => setTagline(e.target.value)} placeholder="Scholar · Author · Researcher"/></div>
        <div style={{gridColumn:'1/-1'}}><label className="field-label">Bio</label><textarea className="field" value={bio} onChange={e => setBio(e.target.value)}/></div>
        <div><label className="field-label">Academic title</label><input className="field" value={field} onChange={e => setField(e.target.value)} placeholder="e.g. Professor of Fiqh"/></div>
        <div><label className="field-label">Institution</label><input className="field" value={institution} onChange={e => setInstitution(e.target.value)} placeholder="e.g. Salahaddin University"/></div>
        <div><label className="field-label">Location</label><input className="field" placeholder="City, Country" value={location} onChange={e => setLocation(e.target.value)}/></div>
        <div><label className="field-label">Content language</label><select className="field" value={lang} onChange={e => setLang(e.target.value)}>{LANGUAGES.map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        <div><label className="field-label">Website</label><input className="field" value={website} onChange={e => setWebsite(e.target.value)} placeholder="https://…"/></div>
        <div><label className="field-label">ORCID iD</label><input className="field" value={orcid} onChange={e => setOrcid(e.target.value)} placeholder="0000-0002-1825-0097"/></div>
      </div>
      <div className="set-toggle" style={{ marginTop:14 }}>
        <div><b>Available for hire</b><small className="muted">Show an “Available for hire” badge on your profile.</small></div>
        <button className={'sw ' + (forHire ? 'on' : '')} onClick={() => setForHire(v => !v)}/>
      </div>
      <div className="set-toggle">
        <div><b>Private profile</b><small className="muted">Only followers can see your posts and research.</small></div>
        <button className={'sw ' + (priv ? 'on' : '')} onClick={() => setPriv(v => !v)}/>
      </div>
      <div className="set-actions">
        <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button>
      </div>
    </div>
  )
}

/* External links manager — POST/DELETE /users/me/links (§9.7-9.9). */
function LinksPanel({ me }) {
  const { refreshUser } = useAuth()
  const [links, setLinks] = React.useState(() => me.links || [])
  const [platform, setPlatform] = React.useState('PERSONAL_WEBSITE')
  const [url, setUrl] = React.useState('')
  const [desc, setDesc] = React.useState('')
  React.useEffect(() => { if (me.id && me.id !== 'me') api.users.profile(me.id).then(u => setLinks(u.links || [])).catch(() => {}) }, [me.id])
  const add = () => {
    const u = url.trim(); if (!u) return
    const label = desc.trim() || platformLabel(platform)
    api.users.addLink({ platform, url: u, description: label, isPublic: true, displayOrder: links.length })
      .then(l => { setLinks(ls => [...ls, { id: l?.id || u, platform, url: u, label }]); setUrl(''); setDesc(''); showToast('Link added'); refreshUser?.() })
      .catch(() => showToast('Could not add link'))
  }
  const remove = (id) => { setLinks(ls => ls.filter(l => l.id !== id)); api.users.removeLink(id).then(() => refreshUser?.()).catch(() => {}); showToast('Link removed') }
  return (
    <div className="card card-pad">
      <h3 className="title"><Icon name="link" className="sm"/>Links</h3>
      <p className="muted text-sm" style={{marginBottom:14}}>External profiles — ORCID, GitHub, your site. Shown publicly on your profile.</p>
      {links.length > 0 && (
        <div className="rail-list" style={{ marginBottom:12 }}>
          {links.map(l => (
            <div key={l.id} className="rail-row">
              <span className="pa-ic"><Icon name="link" className="xs"/></span>
              <div className="rail-info"><div className="rail-name"><b>{l.label || platformLabel(l.platform)}</b></div><div className="rail-sub">{(l.url || '').replace(/^https?:\/\//, '')}</div></div>
              <button className="btn btn-secondary btn-sm" onClick={() => remove(l.id)}>Remove</button>
            </div>
          ))}
        </div>
      )}
      <div className="set-grid">
        <div><label className="field-label">Platform</label><select className="field" value={platform} onChange={e => setPlatform(e.target.value)}>{LINK_PLATFORMS.map(p => <option key={p} value={p}>{platformLabel(p)}</option>)}</select></div>
        <div><label className="field-label">Label (optional)</label><input className="field" value={desc} onChange={e => setDesc(e.target.value)} placeholder="e.g. My research profile"/></div>
        <div style={{gridColumn:'1/-1'}}><label className="field-label">URL</label><input className="field" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" onKeyDown={e => { if (e.key==='Enter') add() }}/></div>
      </div>
      <div className="set-actions"><button className="btn btn-primary btn-sm" disabled={!url.trim()} onClick={add}><Icon name="follow" className="xs"/>Add link</button></div>
    </div>
  )
}

/* Contact handles manager — POST/DELETE /users/me/contacts (§9.10-9.12). Default-private. */
function ContactsPanel({ me }) {
  const { refreshUser } = useAuth()
  const [contacts, setContacts] = React.useState(() => me.contacts || [])
  const [platform, setPlatform] = React.useState('EMAIL')
  const [value, setValue] = React.useState('')
  const [pub, setPub] = React.useState(false)
  React.useEffect(() => { if (me.id && me.id !== 'me') api.users.profile(me.id).then(u => setContacts(u.contacts || [])).catch(() => {}) }, [me.id])
  const add = () => {
    const v = value.trim(); if (!v) return
    api.users.addContact({ platform, value: v, isPublic: pub })
      .then(c => { setContacts(cs => [...cs, { id: c?.id || v, platform, label: platformLabel(platform), value: v }]); setValue(''); showToast('Contact added'); refreshUser?.() })
      .catch(() => showToast('Could not add contact'))
  }
  const remove = (id) => { setContacts(cs => cs.filter(c => c.id !== id)); api.users.removeContact(id).then(() => refreshUser?.()).catch(() => {}); showToast('Contact removed') }
  return (
    <div className="card card-pad">
      <h3 className="title"><Icon name="at" className="sm"/>Contacts</h3>
      <p className="muted text-sm" style={{marginBottom:14}}>Direct-message handles. <b>Private by default</b> — toggle public to show one on your profile.</p>
      {contacts.length > 0 && (
        <div className="rail-list" style={{ marginBottom:12 }}>
          {contacts.map(c => (
            <div key={c.id} className="rail-row">
              <span className="pa-ic"><Icon name="at" className="xs"/></span>
              <div className="rail-info"><div className="rail-name"><b>{c.label || platformLabel(c.platform)}</b></div><div className="rail-sub">{c.value}</div></div>
              <button className="btn btn-secondary btn-sm" onClick={() => remove(c.id)}>Remove</button>
            </div>
          ))}
        </div>
      )}
      <div className="set-grid">
        <div><label className="field-label">Platform</label><select className="field" value={platform} onChange={e => setPlatform(e.target.value)}>{CONTACT_PLATFORMS.map(p => <option key={p} value={p}>{platformLabel(p)}</option>)}</select></div>
        <div><label className="field-label">Handle / address</label><input className="field" value={value} onChange={e => setValue(e.target.value)} placeholder="@handle or address" onKeyDown={e => { if (e.key==='Enter') add() }}/></div>
      </div>
      <div className="set-toggle" style={{ marginTop:4 }}>
        <div><b>Show publicly</b><small className="muted">Off keeps this visible only to you.</small></div>
        <button className={'sw ' + (pub ? 'on' : '')} onClick={() => setPub(v => !v)}/>
      </div>
      <div className="set-actions"><button className="btn btn-primary btn-sm" disabled={!value.trim()} onClick={add}><Icon name="follow" className="xs"/>Add contact</button></div>
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
  React.useEffect(() => { api.users.emailPrefs().then(setPrefs).catch(() => setPrefs({ master:true, social:true, mentions:true, system:true, trending:true })) }, [])
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
    ['trending', 'Trending digest', 'Daily roundup of what scholars and researchers are talking about.'],
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
              ['CLOSE_FRIENDS','users','Close friends'],
              ['NOTIFICATIONS','bell','Emails'],
              ['BLOCKED','block','Blocked users'],
              ['RESTRICTED','eye','Restricted'],
              ['SECURITY','shield','Security'],
            ].map(([k,ic,lab]) => (
              <button key={k} className={'set-item ' + (tab===k?'on':'')} onClick={() => setTab(k)}><Icon name={ic} className="sm"/>{lab}</button>
            ))}
          </aside>

          <div>
            {tab==='PROFILE' && (
              <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
                <ProfilePanel me={me}/>
                <LinksPanel me={me}/>
                <ContactsPanel me={me}/>
              </div>
            )}
            {tab==='CLOSE_FRIENDS' && <CloseFriendsPanel/>}
            {tab==='NOTIFICATIONS' && <EmailPrefsPanel/>}
            {tab==='BLOCKED' && <BlockedPanel/>}
            {tab==='RESTRICTED' && <RestrictedPanel/>}
            {tab==='SECURITY' && <SecurityPanel/>}
          </div>
        </div>
      </div>
    </div>
  )
}
