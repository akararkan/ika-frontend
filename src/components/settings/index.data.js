/* =========================================================
   The settings index — one row per control the user can reach.
   ---------------------------------------------------------
   This is what makes Settings searchable: 20 tabs is more than
   anyone can hold, and the controls people actually come looking
   for ("dark mode", "quiet hours", "delete my account", "clear
   search history") mostly live in cards whose title does not
   contain the word they typed. Each row therefore carries
   `keywords` — the words a person uses, not the ones we chose.

   Contract:
     tab     the /settings/:tab slug
     anchor  a SetCard `id` that EXISTS in that tab (the search
             navigates to /settings/{tab}#{anchor}, which the
             shell scrolls, focuses and flashes)
     title   the control, as it reads on screen
     card    the card it sits in (shown as the breadcrumb tail)

   When you add a card, add its row here — an un-indexed control
   is an unreachable one.
   ========================================================= */

export const SETTINGS_INDEX = [
  /* ---- overview ---- */
  { tab: 'overview', anchor: 'overview', card: 'Overview', title: 'Account overview', keywords: ['summary', 'status', 'at a glance', 'home'] },

  /* ---- profile ---- */
  { tab: 'profile', anchor: 'profile', card: 'Public profile', title: 'Name, handle and bio', keywords: ['username', 'display name', 'about me', 'tagline', 'avatar', 'profile picture', 'cover photo'] },
  { tab: 'profile', anchor: 'profile', card: 'Public profile', title: 'Specializations and school', keywords: ['topics', 'madhhab', 'jurisprudence', 'expertise', 'field'] },
  { tab: 'profile', anchor: 'profile', card: 'Public profile', title: 'Private profile', keywords: ['lock account', 'followers only', 'make account private'] },
  { tab: 'profile', anchor: 'profile', card: 'Public profile', title: 'Available for hire', keywords: ['open to work', 'hire badge'] },
  { tab: 'profile', anchor: 'links', card: 'Links', title: 'External links', keywords: ['orcid', 'github', 'website', 'social links', 'scholar'] },
  { tab: 'profile', anchor: 'contacts', card: 'Contacts', title: 'Contact handles', keywords: ['email address', 'telegram', 'whatsapp', 'how to reach me'] },

  /* ---- appearance ---- */
  { tab: 'appearance', anchor: 'appearance', card: 'Appearance', title: 'Theme', keywords: ['dark mode', 'light mode', 'night mode', 'colour scheme', 'color scheme'] },
  { tab: 'appearance', anchor: 'appearance', card: 'Appearance', title: 'Text size', keywords: ['font size', 'bigger text', 'zoom', 'interface scale'] },
  { tab: 'appearance', anchor: 'appearance', card: 'Appearance', title: 'Density', keywords: ['compact', 'comfortable', 'spacing'] },
  { tab: 'appearance', anchor: 'accessibility', card: 'Accessibility', title: 'High contrast', keywords: ['contrast', 'low vision', 'readability'] },
  { tab: 'appearance', anchor: 'accessibility', card: 'Accessibility', title: 'Reduce motion', keywords: ['animations', 'motion sickness', 'vestibular'] },
  { tab: 'appearance', anchor: 'accessibility', card: 'Accessibility', title: 'Captions', keywords: ['subtitles', 'closed captions', 'cc', 'deaf', 'hard of hearing'] },
  { tab: 'appearance', anchor: 'accessibility', card: 'Accessibility', title: 'Haptic feedback', keywords: ['vibration', 'buzz', 'taptic'] },

  /* ---- privacy ---- */
  { tab: 'privacy', anchor: 'privacy', card: 'Profile fields', title: 'Profile field visibility', keywords: ['bio', 'birthday', 'email visibility', 'phone visibility', 'location', 'hide my'] },
  { tab: 'privacy', anchor: 'privacy-who', card: 'Who can…', title: 'Who can message you', keywords: ['dm', 'direct message', 'stop messages', 'who can follow', 'who can tag', 'mention permissions', 'friend request'] },
  { tab: 'privacy', anchor: 'privacy-content', card: 'Content', title: 'Posts, stories and photos visibility', keywords: ['hide posts', 'story privacy', 'photos', 'videos', 'research visibility'] },
  { tab: 'privacy', anchor: 'privacy-connections', card: 'Connections', title: 'Followers and following visibility', keywords: ['followers list', 'following list', 'friends list', 'hide followers'] },

  /* ---- audiences ---- */
  { tab: 'audience', anchor: 'close-friends', card: 'Close friends', title: 'Close friends list', keywords: ['inner circle', 'story close friends', 'green list'] },
  { tab: 'audience', anchor: 'lists', card: 'Custom audiences', title: 'Custom lists', keywords: ['audience', 'group of people', 'share with only'] },

  /* ---- muted & hidden ---- */
  { tab: 'muted', anchor: 'muted', card: 'Muted people', title: 'Mute someone', keywords: ['silence', 'hide their posts', 'unmute', 'stop seeing'] },
  { tab: 'muted', anchor: 'keywords', card: 'Hidden words', title: 'Hidden keywords', keywords: ['mute words', 'filter', 'block words', 'content filter'] },
  { tab: 'muted', anchor: 'restricted', card: 'Restricted people', title: 'Restricted accounts', keywords: ['quarantine comments', 'limit'] },

  /* ---- blocked ---- */
  { tab: 'blocked', anchor: 'blocked', card: 'Blocked people', title: 'Blocked accounts', keywords: ['unblock', 'ban', 'stop contact'] },

  /* ---- presence ---- */
  { tab: 'presence', anchor: 'presence', card: 'Presence', title: 'Last seen', keywords: ['online status', 'active now', 'hide when i am online', 'green dot'] },

  /* ---- discovery ---- */
  { tab: 'discovery', anchor: 'discovery', card: 'Find me', title: 'Discoverability', keywords: ['find me by email', 'find me by phone', 'search engine', 'indexable', 'seo'] },
  { tab: 'discovery', anchor: 'qr', card: 'Your QR code', title: 'QR code', keywords: ['scan', 'share profile', 'rotate code', 'business card'] },
  { tab: 'discovery', anchor: 'contact-matching', card: 'Contact matching', title: 'Delete uploaded contacts', keywords: ['address book', 'phone contacts', 'erase contacts', 'sync'] },

  /* ---- permissions / consent ---- */
  { tab: 'consent', anchor: 'consent', card: 'Permissions', title: 'Device permissions', keywords: ['camera', 'microphone', 'location permission', 'notifications permission'] },
  { tab: 'consent', anchor: 'consent-history', card: 'Consent log', title: 'Consent history', keywords: ['gdpr', 'what did i agree to', 'evidence', 'withdrew consent'] },

  /* ---- notifications ---- */
  { tab: 'notifications', anchor: 'notifications', card: 'Notifications', title: 'Notification types', keywords: ['turn off notifications', 'mentions', 'likes', 'comments', 'matrix', 'push email in-app'] },
  { tab: 'notifications', anchor: 'dnd', card: 'Quiet hours', title: 'Do not disturb', keywords: ['dnd', 'snooze', 'mute notifications', 'night', 'silence'] },
  { tab: 'notifications', anchor: 'push', card: 'Push devices', title: 'Push notifications', keywords: ['browser notifications', 'desktop alerts', 'device'] },

  /* ---- emails ---- */
  { tab: 'emails', anchor: 'emails', card: 'Email preferences', title: 'Email preferences', keywords: ['unsubscribe', 'stop emails', 'digest', 'newsletter'] },

  /* ---- messages ---- */
  { tab: 'messages', anchor: 'messages', card: 'Messages', title: 'Chat appearance', keywords: ['wallpaper', 'chat theme', 'bubble', 'enter to send', 'chat font size'] },

  /* ---- media & storage ---- */
  { tab: 'media', anchor: 'media', card: 'Media', title: 'Upload quality', keywords: ['data saver', 'compression', 'photo quality', 'video quality', 'bandwidth'] },
  { tab: 'media', anchor: 'media', card: 'Media', title: 'Auto-download', keywords: ['mobile data', 'cellular', 'wifi only', 'save data'] },
  { tab: 'media', anchor: 'media', card: 'Media', title: 'Playback quality', keywords: ['video resolution', 'streaming quality'] },
  { tab: 'media', anchor: 'storage', card: 'Storage', title: 'Storage used', keywords: ['space', 'how much', 'usage', 'disk', 'quota'] },
  { tab: 'media', anchor: 'media-lab', card: 'Upload check', title: 'Test an upload', keywords: ['diagnose upload', 'pipeline', 'debug'] },

  /* ---- security ---- */
  { tab: 'security', anchor: 'security-score', card: 'Security checkup', title: 'Security checkup', keywords: ['score', 'how secure', 'recommendations'] },
  { tab: 'security', anchor: 'two-factor', card: 'Two-factor', title: 'Two-factor authentication', keywords: ['2fa', 'totp', 'authenticator', 'otp', 'mfa'] },
  { tab: 'security', anchor: 'two-factor', card: 'Two-factor', title: 'Recovery codes', keywords: ['backup codes', 'lost phone', 'regenerate'] },
  { tab: 'security', anchor: 'password', card: 'Password', title: 'Change password', keywords: ['new password', 'reset password', 'update password'] },
  { tab: 'security', anchor: 'password', card: 'Password', title: 'Sign out everywhere', keywords: ['log out all', 'revoke all devices'] },
  { tab: 'security', anchor: 'phone', card: 'Phone number', title: 'Verify a phone number', keywords: ['sms', 'mobile number', 'otp code'] },

  /* ---- sessions ---- */
  { tab: 'sessions', anchor: 'sessions', card: 'Devices', title: 'Active sessions', keywords: ['devices', 'where am i signed in', 'sign out device', 'trust device'] },
  { tab: 'sessions', anchor: 'login-history', card: 'Login history', title: 'Login history', keywords: ['sign-in history', 'who logged in', 'suspicious login'] },

  /* ---- your data ---- */
  { tab: 'data', anchor: 'export', card: 'Your data', title: 'Download your data', keywords: ['export', 'archive', 'copy of my data', 'zip', 'gdpr'] },
  { tab: 'data', anchor: 'export', card: 'Your data', title: 'Clear search history', keywords: ['erase searches', 'watch history', 'clear history'] },
  { tab: 'data', anchor: 'danger', card: 'Delete account', title: 'Delete your account', keywords: ['close account', 'deactivate', 'remove account', 'quit'] },

  /* ---- safety ---- */
  { tab: 'safety', anchor: 'reports', card: 'Safety Center', title: 'Reports you filed', keywords: ['report someone', 'abuse', 'appeal', 'moderation'] },
  { tab: 'safety', anchor: 'strikes', card: 'Account standing', title: 'Strikes', keywords: ['warnings', 'violations', 'standing', 'penalty'] },

  /* ---- about ---- */
  { tab: 'about', anchor: 'about', card: 'About IKA', title: 'App version', keywords: ['build', 'version', 'update'] },
  { tab: 'about', anchor: 'policies', card: 'Policies', title: 'Privacy Policy and Terms', keywords: ['terms of service', 'guidelines', 'legal', 'agreement'] },
]

/** Rank matches: title prefix > title contains > keyword > card name. */
export function searchSettings(query, limit = 8) {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const scored = []
  for (const row of SETTINGS_INDEX) {
    const title = row.title.toLowerCase()
    const card = row.card.toLowerCase()
    let score = 0
    if (title.startsWith(q)) score = 100
    else if (title.includes(q)) score = 80
    else if (row.keywords?.some(k => k.startsWith(q))) score = 60
    else if (row.keywords?.some(k => k.includes(q))) score = 45
    else if (card.includes(q)) score = 30
    if (score) scored.push({ row, score })
  }
  return scored
    .sort((a, b) => b.score - a.score || a.row.title.length - b.row.title.length)
    .slice(0, limit)
    .map(s => s.row)
}
