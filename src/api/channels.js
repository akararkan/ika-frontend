/* =========================================================
   Channels service — /api/v1/channels/… and the channel-shaped
   slices of /conversations/…
   ---------------------------------------------------------
   The one fact that shapes this module: a channel IS a
   conversation. `ChannelResponse.id` is the conversationId, so
   posting, reading, search, media and realtime all go through
   chat.js untouched. What lives HERE is everything a plain
   conversation has no concept of:

     · identity      — photo, cover, verified badge, category
     · access        — granular admin rights, parallel invite
                       links, join requests and their approval
     · reach         — per-post view/forward counters, stats
     · conversation  — a LINKED discussion group whose messages
                       are the channel's comments
     · presence      — channel stories, highlights, the tray

   Two id families cross this file and they are NOT the same:
   channel/conversation/user/story ids are UUIDs (plain strings),
   while a POST id is a 64-bit Snowflake that does not survive a
   JS double. Every post id therefore goes through `mid()` and is
   compared with the ./ids.js helpers — never `-`, `>=` or
   Math.max. See the header of chat.js.

   Circular import, on purpose: chat.js pulls `channels` in to
   hang it off `api.chat.channels` (the name every existing call
   site uses), and this file pulls `msgFrom`/`convoFrom`/
   `channelFrom` back out of chat.js. All three are hoisted
   `function` declarations, so the partial module chat.js exposes
   mid-evaluation already has them — nothing here reads a chat.js
   `const` at module scope, which is the rule that keeps the
   cycle safe.
   ========================================================= */
import { http } from './http.js'
import { assetUrl } from './config.js'
import { authorFrom, handleOf, timeAgo } from './adapters.js'
import { msgFrom, convoFrom, channelFrom } from './chat.js'
import { mid } from './ids.js'

/** Spring `Page` → the list shape the rest of the app uses. */
const pageOf = (res, map) => ({
  items: (res?.content || res || []).map(map).filter(Boolean),
  total: res?.totalElements ?? null,
  hasMore: res ? !res.last : false,
  page: res?.number ?? 0,
})

const clampLimit = (n, dflt = 30) => Math.min(100, Math.max(1, Number(n) || dflt))

const bare = (h) => String(h || '').replace(/^@/, '')

/* =========================================================
   Admin rights
   ---------------------------------------------------------
   The wire contract has a trap in it: on the REQUEST side every
   flag is nullable and **null means true**, so a partial body can
   only ever REMOVE capability. Sending `{}` therefore grants full
   rights rather than none. `rightsFrom` reads a response (where a
   null RIGHTS OBJECT — legacy admins and the owner — means full
   rights), and `rightsTo` writes a request with every flag
   explicit, so an unchecked box in the editor is transmitted as
   `false` instead of vanishing into the null-means-true default.
   ========================================================= */

/** Every gate, in the order the editor renders them. */
export const RIGHT_KEYS = [
  'canPostMessages',
  'canEditMessages',
  'canDeleteMessages',
  'canPinMessages',
  'canInviteUsers',
  'canApproveJoinRequests',
  'canChangeInfo',
  'canAddAdmins',
  'canManageLive',
  'canManageStories',
]

/** Label + one-line explanation for each right — the editor's copy. */
export const RIGHT_LABELS = {
  canPostMessages:        ['Post messages', 'Publish new posts to the channel.'],
  canEditMessages:        ['Edit posts', 'Edit any post, and close polls.'],
  canDeleteMessages:      ['Delete posts', 'Delete any post, including other admins’.'],
  canPinMessages:         ['Pin posts', 'Pin and unpin posts to the top.'],
  canInviteUsers:         ['Invite people', 'Create invite links and add subscribers.'],
  canApproveJoinRequests: ['Approve requests', 'Approve or reject join requests.'],
  canChangeInfo:          ['Change info', 'Title, photo, cover, settings, discussion group.'],
  canAddAdmins:           ['Add admins', 'Promote, edit and demote other admins.'],
  canManageLive:          ['Manage live', 'Start and manage live streams and video chats.'],
  canManageStories:       ['Manage stories', 'Post and delete stories and highlights.'],
}

/** AdminRights → a fully-populated flags object. `null` = full rights. */
export function rightsFrom(r) {
  const full = r == null
  const out = {}
  for (const k of RIGHT_KEYS) out[k] = full ? true : (r[k] ?? true)
  out.customTitle = full ? '' : (r.customTitle || '')
  return out
}

/** Flags object → ChannelAdminRequest with every flag EXPLICIT (see above). */
export function rightsTo(flags = {}) {
  const body = {}
  for (const k of RIGHT_KEYS) body[k] = flags[k] !== false
  const title = String(flags.customTitle || '').trim()
  body.customTitle = title ? title.slice(0, 32) : null
  return body
}

/** `true` when the member may do `key` — the OWNER always may. */
export function can(member, key) {
  if (!member) return false
  if (member.role === 'OWNER') return true
  if (member.role !== 'ADMIN') return false
  return member.rights?.[key] !== false
}

/** ChannelAdminResponse → view row. */
export function adminFrom(dto) {
  if (!dto) return null
  const _author = authorFrom({ id: dto.userId, username: dto.username, fullName: dto.fullName })
  const rights = rightsFrom(dto.rights)
  return {
    userId: dto.userId,
    username: dto.username || '',
    handle: handleOf(dto.username),
    fullName: dto.fullName || _author.full,
    role: dto.role || 'ADMIN',
    isOwner: dto.role === 'OWNER',
    rights,
    customTitle: rights.customTitle,
    since: dto.since || null,
    time: timeAgo(dto.since),
    _author,
  }
}

/* =========================================================
   Invite links
   ---------------------------------------------------------
   Many links can be live at once, each independently revocable.
   The plaintext token comes back EXACTLY ONCE on create (only a
   hash is stored), which is why `create` returns a different
   shape from `list` and why the UI must show the new link
   immediately rather than re-fetching the list to display it.
   ========================================================= */

/** InviteLinkResponse (create) → view row, token included. */
export function inviteFrom(dto) {
  if (!dto) return null
  return {
    id: dto.id || null,
    conversationId: dto.conversationId || null,
    token: dto.token || null,                     // plaintext, unrecoverable afterward
    shareUrl: dto.shareUrl || null,
    expiresAt: dto.expiresAt || null,
    maxUses: dto.maxUses ?? null,
    useCount: dto.useCount ?? 0,
    revoked: !!dto.revoked,
    requiresApproval: !!dto.requiresApproval,
    permanent: dto.permanent ?? (!dto.expiresAt && dto.maxUses == null),
    createdBy: dto.createdBy || null,
    createdAt: dto.createdAt || null,
    time: timeAgo(dto.createdAt),
    /* Derived, because "revoked" is not the only way a link dies and the row
       has to say which one happened. */
    expired: !!dto.expiresAt && new Date(dto.expiresAt).getTime() < Date.now(),
    exhausted: dto.maxUses != null && (dto.useCount ?? 0) >= dto.maxUses,
  }
}

/** JoinRequestResponse → view row. */
export function joinRequestFrom(dto) {
  if (!dto) return null
  const _author = authorFrom({ id: dto.userId, username: dto.username, fullName: dto.fullName })
  return {
    id: dto.id,
    conversationId: dto.conversationId || null,
    userId: dto.userId,
    username: dto.username || '',
    handle: handleOf(dto.username),
    fullName: dto.fullName || _author.full,
    status: dto.status || 'PENDING',
    pending: (dto.status || 'PENDING') === 'PENDING',
    requestedAt: dto.requestedAt || null,
    decidedBy: dto.decidedBy || null,
    decidedAt: dto.decidedAt || null,
    time: timeAgo(dto.requestedAt),
    _author,
  }
}

/* =========================================================
   Statistics
   ---------------------------------------------------------
   Honesty matters here: member-derived numbers are exact
   (Postgres), while postsByType / totalViews / totalForwards /
   topPosts are best-effort Redis aggregates maintained on the hot
   paths. The adapter keeps them in separate buckets so the panel
   can label the second group instead of presenting every figure
   with the same authority.
   ========================================================= */

const numMap = (m) => {
  const out = []
  for (const [k, v] of Object.entries(m || {})) out.push({ key: k, value: Number(v) || 0 })
  return out.sort((a, b) => b.value - a.value)
}

/** ChannelStatsResponse → view stats. */
export function statsFrom(dto) {
  if (!dto) return null
  const joinsByDay = Object.entries(dto.joinsByDay || {})
    .map(([date, n]) => ({ date, value: Number(n) || 0 }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
  return {
    subscriberCount: dto.subscriberCount ?? 0,
    onlineSubscribers: dto.onlineSubscribers ?? 0,
    joinedLast7Days: dto.joinedLast7Days ?? 0,
    joinedLast30Days: dto.joinedLast30Days ?? 0,
    leftLast30Days: dto.leftLast30Days ?? 0,
    mutedCount: dto.mutedCount ?? 0,
    notificationsEnabledCount: dto.notificationsEnabledCount ?? 0,
    postCount: dto.postCount ?? 0,
    // ---- best-effort (Redis) ----
    postsByType: numMap(dto.postsByType),
    totalViews: dto.totalViews ?? 0,
    totalForwards: dto.totalForwards ?? 0,
    topPosts: (dto.topPosts || []).map(msgFrom).filter(Boolean),
    // ---- exact (Postgres) ----
    joinsByDay,
    joinsBySource: numMap(dto.joinsBySource),
    /* Net growth over the window the API actually reports, so the panel never
       has to subtract two numbers whose windows differ (7d vs 30d). */
    net30: (dto.joinedLast30Days ?? 0) - (dto.leftLast30Days ?? 0),
  }
}

/** Human label for a join source (stats + the member roster). */
export const JOIN_SOURCE_LABELS = {
  OWNER: 'Creator',
  DISCOVERY: 'Found it',
  INVITE_LINK: 'Invite link',
  JOIN_REQUEST: 'Approved request',
  ADDED_BY_ADMIN: 'Added by an admin',
  COMMENT: 'Commented on a post',
  UNKNOWN: 'Unknown',
}

/* =========================================================
   Stories & highlights
   ---------------------------------------------------------
   A channel story is an ORDINARY story whose author id is the
   CHANNEL's id and whose visibility is "CHANNEL" — TTL, view
   logs, polls and the tray SSE are the user-story machinery
   unchanged. Highlights SNAPSHOT a story, so the archive
   survives the source expiring; that is why the snapshot row
   carries its own media rather than a story id to dereference.
   ========================================================= */

/** StoryByAuthorEntity → view story. `authorId` IS the channel id. */
export function channelStoryFrom(dto) {
  if (!dto) return null
  const expiresAt = dto.expiresAt || null
  return {
    storyId: dto.storyId,
    channelId: dto.authorId || null,
    authorId: dto.authorId || null,
    storyType: dto.storyType || 'IMAGE',
    visibility: dto.visibility || 'CHANNEL',
    mediaUrl: assetUrl(dto.mediaUrl || null),
    thumbnailUrl: assetUrl(dto.thumbnailUrl || null),
    textContent: dto.textContent || '',
    createdAt: dto.createdAt || null,
    expiresAt,
    time: timeAgo(dto.createdAt),
    expired: !!expiresAt && new Date(expiresAt).getTime() < Date.now(),
  }
}

/** HighlightByAuthorEntity → view highlight. */
export function channelHighlightFrom(dto) {
  if (!dto) return null
  return {
    highlightId: dto.highlightId,
    channelId: dto.authorId || null,
    title: dto.title || 'Highlight',
    coverUrl: assetUrl(dto.coverUrl || null),
    displayOrder: dto.displayOrder ?? 0,
    createdAt: dto.createdAt || null,
  }
}

/** StoryInHighlightEntity → view snapshot (self-contained by design). */
export function highlightStoryFrom(dto) {
  if (!dto) return null
  return {
    highlightId: dto.highlightId,
    storyId: dto.storyId,
    channelId: dto.authorId || null,
    storyType: dto.storyType || 'IMAGE',
    mediaUrl: assetUrl(dto.mediaUrl || null),
    thumbnailUrl: assetUrl(dto.thumbnailUrl || null),
    textContent: dto.textContent || '',
    createdAt: dto.createdAt || null,
  }
}

/** ChannelStoryTrayItem → view tray row. */
export function trayItemFrom(dto) {
  if (!dto) return null
  return {
    channelId: dto.channelId,
    handle: bare(dto.handle),
    title: dto.title || 'Channel',
    avatarUrl: assetUrl(dto.avatarUrl || null),
    verified: !!dto.verified,
    stories: (dto.stories || []).map(channelStoryFrom).filter(Boolean),
  }
}

/** StoryPollEntity → view A/B poll (distinct from an in-post POLL message). */
export function storyPollFrom(dto) {
  if (!dto) return null
  return {
    pollId: dto.pollId,
    storyId: dto.storyId,
    question: dto.question || '',
    optionA: dto.optionA || 'A',
    optionB: dto.optionB || 'B',
    authorId: dto.authorId || null,
    createdAt: dto.createdAt || null,
  }
}

/* =========================================================
   The service
   ========================================================= */

export const channels = {
  /* ---------- lifecycle ---------- */

  async create({ title, description, handle, publicChannel = true, category, settings } = {}) {
    return channelFrom(await http.post('/api/v1/channels', {
      title,
      description: description || undefined,
      handle: handle ? bare(handle) : undefined,
      publicChannel: !!publicChannel,
      category: category || undefined,
      settings: settings || undefined,
    }))
  },

  async get(id) { return channelFrom(await http.get(`/api/v1/channels/${id}`)) },

  async byHandle(handle) {
    return channelFrom(await http.get(`/api/v1/channels/by-handle/${encodeURIComponent(bare(handle))}`))
  },

  /** Public channels, most-subscribed first. Both filters optional. */
  async discover(q, { category } = {}, opts) {
    const rows = await http.get('/api/v1/channels/discover', {
      q: q || undefined, category: category || undefined,
    }, opts)
    return (rows || []).map(channelFrom).filter(Boolean)
  },

  /** Requires `canChangeInfo`. Null fields are left unchanged; `settings` is a
   *  WHOLE-OBJECT replacement — send the full blob or knobs silently reset. */
  async update(id, patch) { return channelFrom(await http.patch(`/api/v1/channels/${id}`, patch || {})) },

  async subscribe(id)  { return channelFrom(await http.post(`/api/v1/channels/${id}/subscribe`, {})) },  // idempotent
  unsubscribe(id)      { return http.del(`/api/v1/channels/${id}/subscribe`) },                          // 204

  /* ---------- identity: photo, cover, verified ---------- */

  async photo(id, file) {
    const fd = new FormData(); fd.append('file', file)
    return channelFrom(await http.upload(`/api/v1/channels/${id}/photo`, fd))
  },
  removePhoto(id) { return http.del(`/api/v1/channels/${id}/photo`) },                                // 204

  async cover(id, file) {
    const fd = new FormData(); fd.append('file', file)
    return channelFrom(await http.upload(`/api/v1/channels/${id}/cover`, fd))
  },
  removeCover(id) { return http.del(`/api/v1/channels/${id}/cover`) },                                // 204

  /** PLATFORM ROLE_ADMIN only — not the channel owner. 403 for everyone else. */
  async setVerified(id, verified) {
    return channelFrom(await http.put(`/api/v1/channels/${id}/verified`, undefined, { query: { verified: !!verified } }))
  },

  /* ---------- admins & rights ---------- */

  admins: {
    /** Owner + every admin with EFFECTIVE rights. Any member may read it. */
    async list(id) {
      const rows = await http.get(`/api/v1/channels/${id}/admins`)
      return (rows || []).map(adminFrom).filter(Boolean)
    },
    /** Promote an active subscriber, or edit an existing admin's rights.
     *  Every flag is sent explicitly — see the note above `rightsTo`. */
    async set(id, userId, flags) {
      return adminFrom(await http.put(`/api/v1/channels/${id}/admins/${userId}`, rightsTo(flags)))
    },
    /** A bare PUT grants FULL rights — the documented shortcut. */
    async promote(id, userId) {
      return adminFrom(await http.put(`/api/v1/channels/${id}/admins/${userId}`, {}))
    },
    demote(id, userId) { return http.del(`/api/v1/channels/${id}/admins/${userId}`) },                // 204
  },

  /* ---------- invite links (many, independently revocable) ---------- */

  invites: {
    async create(convId, { expiresInHours, maxUses, requiresApproval } = {}) {
      return inviteFrom(await http.post(`/api/v1/conversations/${convId}/invite-links`, {
        expiresInHours: expiresInHours ?? undefined,
        maxUses: maxUses ?? undefined,
        requiresApproval: requiresApproval ? true : undefined,
      }))
    },
    /** Metadata only — the plaintext token is NEVER returned again. */
    async list(convId) {
      const rows = await http.get(`/api/v1/conversations/${convId}/invite-links`)
      return (rows || []).map(inviteFrom).filter(Boolean)
    },
    revoke(convId, inviteId) { return http.del(`/api/v1/conversations/${convId}/invite-links/${inviteId}`) },  // 204

    /** Redeem. Resolves to { status, conversation } — `PENDING_APPROVAL`
     *  consumes the use and files a join request, and `conversation` is null
     *  in that arm, so callers must branch on `status` and not on the body. */
    async redeem(token) {
      const res = await http.post('/api/v1/conversations/join', { token })
      const status = res?.status || (res?.conversation ? 'JOINED' : 'JOINED')
      return {
        status,
        pending: status === 'PENDING_APPROVAL',
        conversation: res?.conversation ? convoFrom(res.conversation) : null,
      }
    },
  },

  /* ---------- join requests ---------- */

  requests: {
    /** Approvers only (`canApproveJoinRequests`). Spring Page. */
    async list(id, { status = 'PENDING', page = 0, size = 50 } = {}) {
      return pageOf(await http.get(`/api/v1/channels/${id}/join-requests`, {
        status: status || undefined, page, size: clampLimit(size, 50),
      }), joinRequestFrom)
    },
    async approve(id, userId) {
      return joinRequestFrom(await http.post(`/api/v1/channels/${id}/join-requests/${userId}/approve`, {}))
    },
    /** A rejected user may re-request — the row flips back to PENDING. */
    async reject(id, userId) {
      return joinRequestFrom(await http.post(`/api/v1/channels/${id}/join-requests/${userId}/reject`, {}))
    },
  },

  /* ---------- reach: view markers, stats ---------- */

  /** Batch view marker. Each (post, viewer) counts ONCE server-side (Redis
   *  HyperLogLog), so re-reporting is free — the client never has to remember
   *  what it already sent across reloads. Max 100 ids per call. */
  async markViews(id, messageIds) {
    const ids = (messageIds || []).map(String).filter(Boolean).slice(0, 100)
    if (!ids.length) return []
    const res = await http.post(`/api/v1/channels/${id}/posts/views`, { messageIds: ids })
    return (res?.counted || []).map(mid)
  },

  async stats(id) { return statsFrom(await http.get(`/api/v1/channels/${id}/stats`)) },

  /* ---------- discussion group & comments ---------- */

  discussion: {
    /** Caller needs `canChangeInfo` on the channel AND admin on the group; a
     *  group can serve exactly one channel. */
    link(id, groupId)  { return http.put(`/api/v1/channels/${id}/discussion-group/${groupId}`) },     // 204
    unlink(id)         { return http.del(`/api/v1/channels/${id}/discussion-group`) },                // 204

    /** Comment on a post. The caller is AUTO-JOINED into the discussion group
     *  on their first comment (join-source COMMENT) and `replyToId` is stamped
     *  server-side — the returned message belongs to the GROUP, not the
     *  channel, so never merge it into the channel timeline. */
    async add(id, postId, { clientNonce, type = 'TEXT', body, media } = {}) {
      return msgFrom(await http.post(`/api/v1/channels/${id}/posts/${postId}/comments`, {
        clientNonce, type, body, media: media || undefined,
      }))
    },
    /** Newest first, `before={commentId}` cursor. */
    async list(id, postId, { before, limit = 30 } = {}) {
      const rows = await http.get(`/api/v1/channels/${id}/posts/${postId}/comments`, {
        before: before || undefined, limit: clampLimit(limit, 30),
      })
      return (rows || []).map(msgFrom).filter(Boolean)
    },
  },

  /* ---------- stories (posted AS the channel) ---------- */

  stories: {
    /** JSON create — `mediaUrl` must already be uploaded. Needs at least one
     *  of mediaUrl / textContent. `lifetimeHours` is 8 | 16 | 24. */
    async create(id, { storyType, textContent, mediaUrl, thumbnailUrl, lifetimeHours = 24 } = {}) {
      return channelStoryFrom(await http.post(`/api/v1/channels/${id}/stories`, {
        storyType: storyType || undefined,
        textContent: textContent || undefined,
        mediaUrl: mediaUrl || undefined,
        thumbnailUrl: thumbnailUrl || undefined,
        lifetimeHours,
      }))
    },
    /** Multipart create — uploads through R2 first; type auto-detects. */
    async upload(id, { media, thumbnail, storyType, textContent, lifetimeHours = 24 } = {}) {
      const fd = new FormData()
      if (media) fd.append('media', media)
      if (thumbnail) fd.append('thumbnail', thumbnail)
      if (storyType) fd.append('storyType', storyType)
      if (textContent) fd.append('textContent', textContent)
      fd.append('lifetimeHours', String(lifetimeHours))
      return channelStoryFrom(await http.upload(`/api/v1/channels/${id}/stories`, fd))
    },
    /** Live stories, newest first. Public → anyone; private → subscribers. */
    async list(id) {
      const rows = await http.get(`/api/v1/channels/${id}/stories`)
      return (rows || []).map(channelStoryFrom).filter(Boolean)
    },
    remove(id, storyId) { return http.del(`/api/v1/channels/${id}/stories/${storyId}`) },             // 204

    /* Views reuse the SHARED story endpoints — a channel story is a story. */
    recordView(storyId) { return http.post(`/api/v1/stories/${storyId}/views`, {}) },                 // 202
    /** Owner/admins only; a plain subscriber is refused. Newest first. */
    async viewers(storyId) {
      const rows = await http.get(`/api/v1/stories/${storyId}/views`)
      return (rows || []).map(v => ({
        storyId: v?.storyId, viewerId: v?.viewerId, viewedAt: v?.viewedAt || null,
        time: timeAgo(v?.viewedAt),
      }))
    },

    /* A/B story poll — NOT the in-post POLL message type. */
    async attachPoll(id, storyId, { question, optionA, optionB } = {}) {
      return storyPollFrom(await http.post(`/api/v1/channels/${id}/stories/${storyId}/poll`, {
        question, optionA, optionB,
      }))
    },
    vote(pollId, choice)  { return http.post(`/api/v1/polls/${pollId}/vote`, {}, { query: { choice } }) },
    results(pollId)       { return http.get(`/api/v1/polls/${pollId}/results`) },
    myVote(pollId)        { return http.get(`/api/v1/polls/${pollId}/vote/me`) },

    /** My subscribed channels that currently have live stories. */
    async tray() {
      const rows = await http.get('/api/v1/channels/stories/tray')
      return (rows || []).map(trayItemFrom).filter(t => t && t.stories.length)
    },
  },

  /* ---------- highlights (permanent profile rail) ---------- */

  highlights: {
    async list(id) {
      const rows = await http.get(`/api/v1/channels/${id}/highlights`)
      return (rows || []).map(channelHighlightFrom).filter(Boolean)
        .sort((a, b) => a.displayOrder - b.displayOrder)
    },
    async create(id, { title, coverUrl } = {}) {
      return channelHighlightFrom(await http.post(`/api/v1/channels/${id}/highlights`, {
        title, coverUrl: coverUrl || null,
      }))
    },
    /** Snapshot a LIVE story — archive it before the TTL fires or this 404s. */
    async addStory(id, highlightId, storyId) {
      return highlightStoryFrom(await http.post(`/api/v1/channels/${id}/highlights/${highlightId}/stories/${storyId}`, {}))
    },
    async stories(id, highlightId) {
      const rows = await http.get(`/api/v1/channels/${id}/highlights/${highlightId}/stories`)
      return (rows || []).map(highlightStoryFrom).filter(Boolean)
    },
    removeStory(id, highlightId, storyId) {
      return http.del(`/api/v1/channels/${id}/highlights/${highlightId}/stories/${storyId}`)          // 204
    },
    remove(id, highlightId) { return http.del(`/api/v1/channels/${id}/highlights/${highlightId}`) },  // 204
    /** Full left-to-right id list; foreign ids are skipped server-side. */
    async reorder(id, order) {
      const rows = await http.patch(`/api/v1/channels/${id}/highlights/order`, { order })
      return (rows || []).map(channelHighlightFrom).filter(Boolean)
    },
  },
}
