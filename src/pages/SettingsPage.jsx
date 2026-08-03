/* =========================================================
   Settings — /settings/:tab (deep-linkable)
   The full settings surface over the backend Settings module:
   profile & cosmetics, the privacy resolver, audiences, muted
   & keywords, presence, discovery/QR, the notification matrix
   + DND, messages & media cosmetics, storage, security (2FA,
   sessions, login history), data export & deletion, the
   Safety Center, and app policies. The side nav is grouped;
   each tab is a stack of cards. Panels for the new module
   live in ../components/settings/*; the pre-module panels
   (profile, close friends, email prefs…) remain below.
   ========================================================= */
import React from 'react'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import { Icon, Avatar, showToast } from '../components/ui.jsx'
import { uiConfirm } from '../components/Dialog.jsx'
import { EmptyState, Loader } from '../components/states.jsx'
import { useImageViewer } from '../components/ImageLightbox.jsx'
import { SpecializationPicker, MadhhabSelect } from '../components/Taxonomy.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { api } from '../api/index.js'
import { SetCard, ToggleRow, Field } from '../components/settings/shared.jsx'
import { SettingsSearch } from '../components/settings/SettingsSearch.jsx'
import { OverviewPanel } from '../components/settings/OverviewPanel.jsx'
import { AppearancePanel, AccessibilityPanel } from '../components/settings/AppearancePanel.jsx'
import { PrivacyPanel } from '../components/settings/PrivacyPanel.jsx'
import { AudiencePanel } from '../components/settings/AudiencePanel.jsx'
import { MutedPanel, KeywordsPanel } from '../components/settings/MutedPanel.jsx'
import { PresencePanel, DiscoveryPanel } from '../components/settings/PresencePanel.jsx'
import { NotificationsMatrixPanel, DndPanel, PushTokensPanel } from '../components/settings/NotificationsPanel.jsx'
import { MessagesPanel } from '../components/settings/MessagesPanel.jsx'
import { MediaPanel, StoragePanel } from '../components/settings/MediaStoragePanel.jsx'
import { TwoFactorPanel, PhonePanel, SecurityScorePanel } from '../components/settings/SecurityExtraPanel.jsx'
import { SessionsPanel, LoginHistoryPanel } from '../components/settings/SessionsPanel.jsx'
import { DataExportPanel, DangerZonePanel } from '../components/settings/DataPanel.jsx'
import { SafetyReportsPanel, StrikesPanel } from '../components/settings/SafetyPanel.jsx'
import { AboutPanel } from '../components/settings/AboutPanel.jsx'
import { ConsentPanel } from '../components/settings/ConsentPanel.jsx'
import { MediaLabPanel } from '../components/settings/MediaLabPanel.jsx'

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
  // Knowledge taxonomy (TAXONOMY_API §3): an ORDERED topic list + one school.
  const [specs, setSpecs] = React.useState(() => me.specializations || [])
  const [madhhabId, setMadhhabId] = React.useState(me.madhhabId ?? null)
  const [busy, setBusy] = React.useState(false)
  const avatarRef = React.useRef(null); const coverRef = React.useRef(null)
  const { openable, viewer } = useImageViewer()   // the thumbnails here open full-size too

  const pickAvatar = (e) => { const f = e.target.files?.[0]; e.target.value=''; if (!f) return; api.users.uploadAvatar(f).then(() => { showToast('Photo updated'); refreshUser() }).catch(() => showToast('Could not upload photo')) }   // §10.4
  const pickCover  = (e) => { const f = e.target.files?.[0]; e.target.value=''; if (!f) return; api.users.uploadCover(f).then(() => { showToast('Cover updated'); refreshUser() }).catch(() => showToast('Could not upload cover')) }   // §10.6

  // Ids in order — the list is ordered, so a reorder IS a change (§3.1).
  const specKey = (list) => (list || []).map(s => s.id).join(',')
  const specsChanged = specKey(specs) !== specKey(me.specializations)

  /* Sign-in caches the user WITHOUT a profile, so `me.specializations` can
     arrive a beat after this panel mounts. Every other field here would just
     re-save the same string, but this one saves with REPLACE-ALL semantics —
     a stale empty copy would wipe the list. So keep it in step with the
     profile until the person actually edits it. */
  const taxonomyTouched = React.useRef(false)
  React.useEffect(() => {
    if (taxonomyTouched.current) return
    setSpecs(me.specializations || [])
    setMadhhabId(me.madhhabId ?? null)
  }, [me.specializations, me.madhhabId])
  const editSpecs = (next) => { taxonomyTouched.current = true; setSpecs(next) }
  const editMadhhab = (next) => { taxonomyTouched.current = true; setMadhhabId(next) }

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
        madhhabId,                                                                                  // TAXONOMY §3.2 — null clears it
      }).catch(e => {
        // The madhhab is the one field here validated against a vocabulary.
        if (e?.status === 404) { api.madhhabs.forget(); throw new Error('That school is no longer in the list — pick another.') }
        throw e
      })
      /* Specializations are their own REPLACE-ALL endpoint (TAXONOMY §3.1) and
         are audit-logged, so they are only written when the list actually
         changed — reordering counts, which is why ids are compared in order. */
      if (specsChanged) {
        await api.users.updateSpecializations(specs).catch(e => {
          if (e?.status === 404) { api.topics.forget(); throw new Error('One of those topics no longer exists — reopen the list and pick again.') }
          throw e
        })
      }
      await refreshUser()
      showToast('Profile saved')
    } catch (e) {
      showToast(e?.code === 'USERNAME_ALREADY_EXISTS' ? 'That handle is taken' : (e?.message || 'Could not save'))
    } finally { setBusy(false) }
  }

  return (
    <SetCard id="profile" icon="user" title="Public profile">
      <div className="set-avatar-row">
        <span {...openable(me.profileImage, { className:'flex', label:'View your profile photo' })}>
          <Avatar initials={me.initials} color={me.avc} size={72} src={me.profileImage}/>
        </span>
        <div><b className="text-md">Profile picture</b><p className="muted text-xs">JPG, PNG or WebP. Square images work best.</p></div>
        <input ref={avatarRef} type="file" hidden accept="image/*" onChange={pickAvatar}/>
        <input ref={coverRef} type="file" hidden accept="image/*" onChange={pickCover}/>
        <div className="flex gap-8" style={{ marginLeft:'auto' }}>
          <button className="btn btn-secondary btn-sm" onClick={() => coverRef.current?.click()}><Icon name="image" className="xs"/>Cover</button>
          <button className="btn btn-secondary btn-sm" onClick={() => avatarRef.current?.click()}><Icon name="upload" className="xs"/>Upload</button>
        </div>
      </div>
      <div className="set-grid">
        <Field label="Full name"><input className="field" value={full} onChange={e => setFull(e.target.value)}/></Field>
        <Field label="Handle"><input className="field" value={'@'+handle.replace(/^@/, '')} onChange={e => setHandle(e.target.value)}/></Field>
        <div style={{gridColumn:'1/-1'}}><Field label="Tagline"><input className="field" value={tagline} onChange={e => setTagline(e.target.value)} placeholder="Scholar · Author · Researcher"/></Field></div>
        <div style={{gridColumn:'1/-1'}}><Field label="Bio"><textarea className="field" value={bio} onChange={e => setBio(e.target.value)}/></Field></div>
        <Field label="Academic title"><input className="field" value={field} onChange={e => setField(e.target.value)} placeholder="e.g. Professor of Fiqh"/></Field>
        <Field label="Institution"><input className="field" value={institution} onChange={e => setInstitution(e.target.value)} placeholder="e.g. Salahaddin University"/></Field>
        {/* Madhhab — chosen from the platform's fixed vocabulary, not typed
            (TAXONOMY §2 / §3.2). Saved as `madhhabId`; "Not specified" sends null. */}
        <div><label className="field-label">School of jurisprudence</label><MadhhabSelect value={madhhabId} onChange={editMadhhab} disabled={busy}/></div>
        <Field label="Location"><input className="field" placeholder="City, Country" value={location} onChange={e => setLocation(e.target.value)}/></Field>
        <Field label="Content language"><select className="field" value={lang} onChange={e => setLang(e.target.value)}>{LANGUAGES.map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Website"><input className="field" value={website} onChange={e => setWebsite(e.target.value)} placeholder="https://…"/></Field>
        <Field label="ORCID iD" hint="Your 16-digit researcher identifier."><input className="field" value={orcid} onChange={e => setOrcid(e.target.value)} placeholder="0000-0002-1825-0097"/></Field>
        {/* Specializations — the ordered topic list shown on the profile
            (TAXONOMY §3.1). Replace-all: what is here IS the new list. */}
        <div style={{gridColumn:'1/-1'}}>
          <label className="field-label">Specializations</label>
          <SpecializationPicker value={specs} onChange={editSpecs} disabled={busy}/>
        </div>
      </div>
      <ToggleRow title="Available for hire" desc="Show an “Available for hire” badge on your profile."
        on={forHire} onToggle={() => setForHire(v => !v)}/>
      <ToggleRow title="Private profile" desc="Only followers can see your posts and research."
        on={priv} onToggle={() => setPriv(v => !v)}/>
      <div className="set-actions">
        <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button>
      </div>
      {viewer}
    </SetCard>
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
    <SetCard id="links" icon="link" title="Links"
      sub="External profiles — ORCID, GitHub, your site. Shown publicly on your profile.">
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
        <Field label="Platform"><select className="field" value={platform} onChange={e => setPlatform(e.target.value)}>{LINK_PLATFORMS.map(p => <option key={p} value={p}>{platformLabel(p)}</option>)}</select></Field>
        <Field label="Label (optional)"><input className="field" value={desc} onChange={e => setDesc(e.target.value)} placeholder="e.g. My research profile"/></Field>
        <div style={{gridColumn:'1/-1'}}><Field label="URL"><input className="field" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" onKeyDown={e => { if (e.key==='Enter') add() }}/></Field></div>
      </div>
      <div className="set-actions"><button className="btn btn-primary btn-sm" disabled={!url.trim()} onClick={add}><Icon name="follow" className="xs"/>Add link</button></div>
    </SetCard>
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
    <SetCard id="contacts" icon="at" title="Contacts"
      sub="Direct-message handles. Private by default — toggle public to show one on your profile.">
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
        <Field label="Platform"><select className="field" value={platform} onChange={e => setPlatform(e.target.value)}>{CONTACT_PLATFORMS.map(p => <option key={p} value={p}>{platformLabel(p)}</option>)}</select></Field>
        <Field label="Handle / address"><input className="field" value={value} onChange={e => setValue(e.target.value)} placeholder="@handle or address" onKeyDown={e => { if (e.key==='Enter') add() }}/></Field>
      </div>
      <ToggleRow title="Show publicly" desc="Off keeps this visible only to you."
        on={pub} onToggle={() => setPub(v => !v)}/>
      <div className="set-actions"><button className="btn btn-primary btn-sm" disabled={!value.trim()} onClick={add}><Icon name="follow" className="xs"/>Add contact</button></div>
    </SetCard>
  )
}

function CloseFriendsPanel() {
  const [list, setList] = React.useState([])
  const [q, setQ] = React.useState('')
  const [results, setResults] = React.useState([])
  const ids = new Set(list.map(u => u.id))
  React.useEffect(() => { api.closeFriends.list().then(r => setList(r || [])).catch(() => {}) }, [])
  const searchUsers = (term) => { setQ(term); if (term.trim()) api.users.searchList(term, { size: 6 }).then(setResults).catch(() => {}); else setResults([]) }
  const add = (u) => { setList(l => [...l, u]); api.closeFriends.add(u.id).then(() => showToast(`Added ${u.full.split(' ')[0]}`)).catch(() => showToast('They must be following you first')) }
  const remove = (u) => { setList(l => l.filter(x => x.id !== u.id)); api.closeFriends.remove(u.id).catch(() => {}); showToast('Removed') }
  return (
    <SetCard id="close-friends" icon="users" title="Close friends"
      sub="Your inner circle. Stories set to Close friends are shown only to people on this list.">
      {/* `.stx-search`, not the chat `.cmt-box`: at ≤720px the responsive
          sheet pins a `.card-pad > .cmt-box` to the bottom of the viewport as
          a composer bar, which detached this field from its card. */}
      <div className="stx-search">
        <input className="field" type="search" aria-label="Search people to add"
          placeholder="Search people to add…" value={q} onChange={e => searchUsers(e.target.value)}/>
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
    </SetCard>
  )
}

function BlockedPanel() {
  const [list, setList] = React.useState(null)
  React.useEffect(() => { api.users.blocked().then(setList).catch(() => setList([])) }, [])
  const unblock = (u) => { setList(l => l.filter(x => x.id !== u.id)); api.users.unblock(u.id).catch(() => {}); showToast('Unblocked') }
  const sub = 'Blocked people can’t see your posts, follow you, or message you. Blocking is mutual and severs any follows in both directions.'
  if (list === null) return <SetCard id="blocked" icon="block" title="Blocked people" sub={sub}><Loader/></SetCard>
  return (
    <SetCard id="blocked" icon="block" title="Blocked people" sub={sub}>
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
    </SetCard>
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
  if (!prefs) return <SetCard id="emails" icon="mail" title="Email preferences"><Loader/></SetCard>
  const rows = [
    ['master', 'All emails', 'Master switch — turn off to stop all outbound emails.'],
    ['social', 'Social', 'Follows, blocks, and other social interactions.'],
    ['mentions', 'Mentions', 'When someone @mentions you.'],
    ['system', 'System', 'Announcements and account warnings.'],
    ['trending', 'Trending digest', 'Daily roundup of what scholars and researchers are talking about.'],
  ]
  const test = () => api.users.testEmail().then(r => showToast(r?.queued ? `Test email sent to ${r.to}` : (r?.reason || 'No email on file'))).catch(() => showToast('Could not send'))   // §16.3
  const unsub = () => api.users.unsubscribeAll().then(() => { showToast('Unsubscribed from all emails'); setPrefs(p => ({ ...p, master:false })) }).catch(() => showToast('Could not unsubscribe', 'err'))   // §16.4
  return (
    <SetCard id="emails" icon="mail" title="Email preferences"
      sub="Which emails IKA may send you. These five categories are the mail switch; the per-event grid in Notifications covers in-app and push.">
      {rows.map(([k, title, desc]) => (
        <ToggleRow key={k} title={title} desc={desc} on={!!prefs[k]} onToggle={() => toggle(k)}/>
      ))}
      <div className="set-actions" style={{ marginTop:8 }}>
        <button className="btn btn-secondary btn-sm" onClick={test}><Icon name="bell" className="xs"/>Send test email</button>
        <button className="btn btn-danger btn-sm" onClick={unsub}>Unsubscribe from all</button>
      </div>
    </SetCard>
  )
}

function RestrictedPanel() {
  const [list, setList] = React.useState(null)
  React.useEffect(() => { api.users.restricted().then(setList).catch(() => setList([])) }, [])   // §11.10
  const unrestrict = (u) => { setList(l => l.filter(x => x.id !== u.id)); api.users.unrestrict(u.id).catch(() => {}); showToast('Restriction removed') }
  const sub = 'Restricted people can still see your content, but their comments are visible only to themselves. They are never told.'
  if (list === null) return <SetCard id="restricted" icon="eye" title="Restricted people" sub={sub}><Loader/></SetCard>
  return (
    <SetCard id="restricted" icon="eye" title="Restricted people" sub={sub}>
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
      ) : <EmptyState icon="eye" title="No restricted people"/>}
    </SetCard>
  )
}

function SecurityPanel() {
  const { logoutEverywhere } = useAuth()
  const [cur, setCur] = React.useState(''); const [next, setNext] = React.useState(''); const [busy, setBusy] = React.useState(false)
  const change = async () => {
    if (next.length < 8) { showToast('New password must be at least 8 characters', 'err'); return }
    setBusy(true)
    try { await api.auth.changePassword(cur, next); setCur(''); setNext(''); showToast('Password updated') }   // §8.6
    catch (e) { showToast(e?.code === 'INVALID_CREDENTIALS' ? 'Current password is wrong' : (e?.message || 'Could not update password'), 'err') }
    finally { setBusy(false) }
  }
  /* §8.5. The confirm used to promise "You stay signed in here" — the backend
     revokes every refresh token including this one, and logoutEverywhere()
     clears the local session too, so the copy now says what actually happens. */
  const logoutAll = async () => {
    const ok = await uiConfirm({
      title: 'Sign out everywhere?',
      message: 'Every active session ends immediately — on every browser, phone and tablet, including this one. You will need to sign in again.',
      confirmLabel: 'Sign out everywhere', danger: true, icon: 'logout',
    })
    if (ok) logoutEverywhere()
  }
  return (
    <SetCard id="password" icon="lock" title="Password">
      <div className="set-grid">
        <Field label="Current password"><input className="field" type="password" autoComplete="current-password" value={cur} onChange={e => setCur(e.target.value)} placeholder="••••••••"/></Field>
        <Field label="New password" hint="At least 8 characters."><input className="field" type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} placeholder="At least 8 characters"/></Field>
      </div>
      <p className="muted text-xs" style={{ marginTop:6 }}>Changing your password signs out every other device.</p>
      <div className="set-actions"><button className="btn btn-primary" disabled={busy || !cur || !next} onClick={change}>{busy ? 'Updating…' : 'Update password'}</button></div>
      <div className="set-toggle" style={{ marginTop:8 }}>
        <div><b>Sign out everywhere</b><small className="muted">Ends every session, including this one.</small></div>
        <button className="btn btn-danger btn-sm" onClick={logoutAll}><Icon name="logout" className="xs"/>Sign out all</button>
      </div>
    </SetCard>
  )
}

/* Contact matching — the PRIVACY half of the friend-suggestion CONTACTS
   signal. Deliberately NOT the same thing as the "Contacts" card in the
   Profile tab: that one publishes contact methods ON your profile
   (/users/me/contacts), this one is the hashed address book you uploaded to
   find people (/users/contacts). The copy says so, because the two words are
   identical and the consequences are opposite.

   Uploading lives on /people, where the matches it produces are visible.
   What lives HERE is the control someone comes to settings looking for: the
   delete. It is unconditional — there is no "do you have any?" read endpoint,
   and gating a privacy erase behind a status check would make it fail closed
   for exactly the user who most wants it. */
function ContactMatchingPanel() {
  const [busy, setBusy] = React.useState(false)
  /* The consent ledger's answer for this scope (§14). It is evidence, not a
     gate — the delete below stays unconditional either way. */
  const [granted, setGranted] = React.useState(null)
  React.useEffect(() => {
    let alive = true
    api.settings.consent.state('CONTACTS')
      .then(s => { if (alive) setGranted(!!s?.granted) })
      .catch(() => { if (alive) setGranted(null) })
    return () => { alive = false }
  }, [])

  const wipe = async () => {
    const ok = await uiConfirm({
      title: 'Delete uploaded contacts?',
      message: 'Every contact hash you uploaded is erased from the server and your suggestions are rebuilt without them. Your own profile and contact methods are untouched.',
      confirmLabel: 'Delete', danger: true, icon: 'trash',
    })
    if (!ok) return
    setBusy(true)
    /* The spec-named alias (DELETE /api/v1/contacts/sync) — same purge as the
       older /users/contacts route, but it also writes the consent-withdrawal
       event, which is the whole point of having a consent ledger. */
    try { await api.settings.contactsSync.clear(); setGranted(false); showToast('Uploaded contacts deleted') }
    catch { showToast('Could not delete uploaded contacts', 'err') }
    finally { setBusy(false) }
  }
  return (
    <SetCard id="contact-matching" icon="users" title="Contact matching"
      sub="If you upload your address book on the People page, it is hashed on your device with SHA-256 before it is sent — the server stores one-way hashes and never sees a name, an email address or a phone number. They are used only to suggest people you may already know.">
      <p className="muted text-xs" style={{ marginTop:-8 }}>
        This is separate from the <b>Contacts</b> card in the Profile tab, which lists contact
        methods you choose to show on your public profile.
      </p>
      {granted !== null && (
        <div className="stx-row" style={{ marginTop:8 }}>
          <div><b>Consent on record</b><small>What the server has logged for contact matching.</small></div>
          <span className={'stx-chip ' + (granted ? 'ok' : 'plain')}>
            <Icon name={granted ? 'check' : 'close'}/>{granted ? 'Granted' : 'Not granted'}
          </span>
        </div>
      )}
      <div className="set-toggle" style={{ marginTop:10 }}>
        <div><b>Delete uploaded contacts</b><small className="muted">Erase every hash you have uploaded and rebuild suggestions without them.</small></div>
        <button className="btn btn-danger btn-sm" disabled={busy} onClick={wipe}>
          <Icon name="trash" className="xs"/>{busy ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </SetCard>
  )
}

/* ---------- the grouped, routed shell ---------- */

const NAV = [
  { group: 'Account', items: [
    ['overview', 'grid', 'Overview'],
    ['profile', 'user', 'Profile'],
    ['appearance', 'sparkle', 'Appearance'],
  ]},
  { group: 'Privacy', items: [
    ['privacy', 'lock', 'Privacy'],
    ['audience', 'users', 'Audiences'],
    ['muted', 'mute', 'Muted & hidden'],
    ['blocked', 'block', 'Blocked'],
    ['presence', 'eye', 'Presence'],
    ['discovery', 'globe', 'Discovery'],
    ['consent', 'checks', 'Permissions'],
  ]},
  { group: 'Notifications', items: [
    ['notifications', 'bell', 'Notifications'],
    ['emails', 'mail', 'Emails'],
  ]},
  { group: 'Chat & media', items: [
    ['messages', 'message', 'Messages'],
    ['media', 'image', 'Media & storage'],
  ]},
  { group: 'Security', items: [
    ['security', 'shield', 'Security'],
    ['sessions', 'clock', 'Sessions'],
  ]},
  { group: 'Data & support', items: [
    ['data', 'download', 'Your data'],
    ['safety', 'flag', 'Safety Center'],
    ['about', 'info', 'About'],
  ]},
]
const SLUGS = new Set(NAV.flatMap(g => g.items.map(([slug]) => slug)))
/** slug → {group, label, icon}, for the tab heading and the breadcrumb. */
const NAV_BY_SLUG = Object.fromEntries(
  NAV.flatMap(g => g.items.map(([slug, icon, label]) => [slug, { group: g.group, icon, label }])),
)

/** Deep links address a CARD, not just a tab: /settings/security#two-factor
 *  scrolls it into view, moves focus to it (so a keyboard user lands where the
 *  link pointed) and flashes its outline once so the eye finds it too. */
function useCardAnchor(tab) {
  const { hash } = useLocation()
  React.useEffect(() => {
    if (!hash || hash.length < 2) return undefined
    const id = decodeURIComponent(hash.slice(1))
    /* The panel may still be fetching; retry across a few frames rather than
       failing silently on the first paint. */
    let tries = 0
    let raf = 0
    let timer = 0
    const find = () => {
      const el = document.getElementById(id)
      if (!el) {
        if (tries++ < 40) raf = requestAnimationFrame(find)
        return
      }
      el.scrollIntoView({ block: 'start', behavior: 'smooth' })
      el.focus({ preventScroll: true })
      el.classList.add('stx-flash')
      timer = setTimeout(() => el.classList.remove('stx-flash'), 1600)
    }
    raf = requestAnimationFrame(find)
    return () => { cancelAnimationFrame(raf); clearTimeout(timer) }
  }, [hash, tab])
}

export function SettingsPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { tab: rawTab } = useParams()
  const { hash } = useLocation()
  const known = SLUGS.has(rawTab)
  const tab = known ? rawTab : 'overview'
  const meta = NAV_BY_SLUG[tab]
  const railRef = React.useRef(null)
  const headRef = React.useRef(null)

  /* URL, highlight and content must agree: a bare /settings or a typo like
     /settings/securty used to render the profile editor while the address bar
     said something else. */
  React.useEffect(() => {
    if (!known) navigate('/settings/overview', { replace: true })
  }, [known, navigate])

  /* On a phone the nav is one horizontal rail of 20 pills; deep-linking to the
     last one would otherwise show it scrolled hard left, apparently on an
     unrelated tab. */
  React.useEffect(() => {
    const rail = railRef.current
    const on = rail?.querySelector('.set-item.on')
    if (on && rail.scrollWidth > rail.clientWidth + 4) {
      on.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
    }
  }, [tab])

  /* Changing tab is a navigation: name the page, move the reader to the new
     heading, and start at the top — unless a #card anchor owns the scroll. */
  React.useEffect(() => {
    document.title = meta ? `${meta.label} · Settings · IKA` : 'Settings · IKA'
    if (hash) return
    window.scrollTo({ top: 0 })
    headRef.current?.focus({ preventScroll: true })
  }, [tab, meta, hash])

  useCardAnchor(tab)

  // Hook-phase placeholder only — the render below is guarded on `user`.
  const me = user || { initials:'', avc:'' }

  // No invented "@you" identity on the corrupt-cache race — loader instead.
  if (!user) {
    return <div className="main center"><div className="col-main"><Loader label="Loading settings…"/></div></div>
  }

  const body = {
    overview: <OverviewPanel/>,
    profile: <div className="set-stack"><ProfilePanel me={me}/><LinksPanel me={me}/><ContactsPanel me={me}/></div>,
    appearance: <div className="set-stack"><AppearancePanel/><AccessibilityPanel/></div>,
    privacy: <PrivacyPanel/>,
    audience: <div className="set-stack"><CloseFriendsPanel/><AudiencePanel/></div>,
    muted: <div className="set-stack"><MutedPanel/><KeywordsPanel/><RestrictedPanel/></div>,
    blocked: <BlockedPanel/>,
    presence: <PresencePanel/>,
    discovery: <div className="set-stack"><DiscoveryPanel/><ContactMatchingPanel/></div>,
    consent: <ConsentPanel/>,
    notifications: <div className="set-stack"><NotificationsMatrixPanel/><DndPanel/><PushTokensPanel/></div>,
    emails: <EmailPrefsPanel/>,
    messages: <MessagesPanel/>,
    media: <div className="set-stack"><MediaPanel/><MediaLabPanel/><StoragePanel/></div>,
    security: <div className="set-stack"><SecurityScorePanel/><TwoFactorPanel/><SecurityPanel/><PhonePanel/></div>,
    sessions: <div className="set-stack"><SessionsPanel/><LoginHistoryPanel/></div>,
    data: <div className="set-stack"><DataExportPanel/><DangerZonePanel/></div>,
    safety: <div className="set-stack"><SafetyReportsPanel/><StrikesPanel/></div>,
    about: <AboutPanel/>,
  }[tab]

  return (
    <div className="main center">
      <div className="col-main">
        <div className="phead">
          <div><h1>Settings <span className="phead-ar" lang="ar" dir="rtl">الإعدادات</span></h1><p className="sub">Manage your account, privacy, notifications, and security.</p></div>
          <SettingsSearch/>
        </div>

        <div className="settings-shell">
          <nav className="set-side" ref={railRef} aria-label="Settings sections">
            {NAV.map(({ group, items }) => (
              <React.Fragment key={group}>
                <div className="set-group">{group}</div>
                {items.map(([slug, ic, lab]) => (
                  <button key={slug} type="button"
                    className={'set-item ' + (tab === slug ? 'on' : '')}
                    aria-current={tab === slug ? 'page' : undefined}
                    onClick={() => navigate(`/settings/${slug}`)}>
                    <Icon name={ic} className="sm"/>{lab}
                  </button>
                ))}
              </React.Fragment>
            ))}
          </nav>

          <div>
            {meta && (
              <h2 className="stx-tabhead" ref={headRef} tabIndex={-1}>
                <Icon name={meta.icon} className="sm"/>{meta.label}
                <span className="stx-crumb">{meta.group}</span>
              </h2>
            )}
            {body}
          </div>
        </div>
      </div>
    </div>
  )
}
