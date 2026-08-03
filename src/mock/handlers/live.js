/* =========================================================
   Live streaming — /api/v1/streams/*
   ---------------------------------------------------------
   The one surface the first mock pass missed. It is unusual in
   two ways worth stating up front:

   1. THE VIDEO IS REAL. `playbackUrl` is a ~4 KB `data:video/mp4`
      URI held once in the fixture (`db.live.sampleVideo`). The
      player at LivePage.jsx:1035 only reaches for hls.js when
      the URL ends in `.m3u8`; anything else goes down the native
      branch and is assigned straight to `el.src`. A data: URI
      therefore plays with no network and no media server. For
      that path to be taken, `whepUrl` MUST stay null — a
      non-null whepUrl makes the page probe WebRTC first and sit
      in `probing` until it times out.

   2. MOST OF IT IS EPHEMERAL ON THE REAL BACKEND. Live chat,
      reactions and gift events are broadcast over SSE and never
      persisted, so a real late joiner sees none of the backlog.
      The fixture keeps a few rows anyway, purely so the rail is
      not empty the moment you arrive — that is a demo
      affordance, not a claim about the backend.

   Route order is load-bearing: `/streams/live`, `/streams/mine`
   and `/streams/gifts/catalog` are all literal paths that would
   otherwise be swallowed by `/streams/{id}`, so every literal
   sits above the id pattern.
   ========================================================= */
import { page, paging, agoIso, mockError, NO_CONTENT } from '../util.js'

/* ---------- helpers ---------- */

const meId = (db) => db.me?.userId || db.me?.id || 'u-amina'
const userOf = (db, id) => (db.users || []).find(u => u.id === id) || null

function displayName(u) {
  if (!u) return ''
  return u.profile?.displayName || [u.fname, u.lname].filter(Boolean).join(' ') || u.username || ''
}
const avatarOf = (u) => u?.profile?.avatarUrl || u?.avatarUrl || null

/** LiveStreamResponse. `viewer` false = the host's own view, which is the only
 *  one that carries the publish-side secrets (whipUrl / ingestUrl). */
function streamDto(db, s, { viewer = true } = {}) {
  if (!s) return null
  const host = userOf(db, s.hostId)
  const live = s.status === 'LIVE'
  const owned = s.hostId === meId(db)
  const recAvailable = s.recordingStatus === 'AVAILABLE'
  return {
    id: s.id,
    hostId: s.hostId,
    hostUsername: host?.username || null,
    hostDisplayName: displayName(host) || null,
    hostAvatarUrl: avatarOf(host),
    title: s.title,
    description: s.description || '',
    status: s.status,
    /* Native branch: not an .m3u8, so LivePage assigns it to el.src directly. */
    playbackUrl: live ? db.live.sampleVideo : null,
    whepUrl: null,                                   // see the header note
    whipUrl: !viewer && live ? `whip://mock.local/${s.id}` : null,
    ingestUrl: !viewer && live ? `rtmp://mock.local/live/${s.id}` : null,
    shareUrl: `${typeof window === 'undefined' ? '' : window.location.origin}/live/${s.id}`,
    viewerCount: s.viewerCount ?? 0,
    startedAt: s.startedAgoMin != null ? agoIso(s.startedAgoMin) : null,
    endedAt: s.endedAgoMin != null ? agoIso(s.endedAgoMin) : null,
    recordingStatus: owned ? (s.recordingStatus || null) : null,
    recordingAvailable: owned && recAvailable,
    recordingDownloadUrl: owned && recAvailable ? `/api/v1/streams/${s.id}/recording/download` : null,
  }
}

function memberDto(db, streamId, m, { self = false } = {}) {
  const u = userOf(db, m.userId)
  const secret = self || m.userId === meId(db)
  return {
    streamId,
    userId: m.userId,
    username: u?.username || '',
    displayName: displayName(u),
    avatarUrl: avatarOf(u),
    role: m.role || 'GUEST',
    status: m.status || 'ACTIVE',
    muted: !!m.muted,
    /* NULL on purpose. A guest tile is a live WebRTC peer — liveStage.jsx:81
       filters on `m.whepUrl` and hands anything non-null to playWhep(), which
       performs a real SDP exchange over fetch(). A fake scheme there produces
       "URL scheme whep: is not supported" on every frame; a fake https URL
       would produce a failed negotiation instead. Null is the truthful answer
       for a fixture — the tile renders its camera-off/avatar state, which is
       what a guest who has not published yet looks like anyway. */
    whepUrl: null,
    /* SECRET — the real backend only ever puts these on YOUR OWN member row. */
    whipUrl: secret ? `whip://mock.local/${streamId}/${m.userId}` : null,
    publishKey: secret ? `mock-key-${m.userId}` : null,
    joinedAt: m.joinedAgoMin != null ? agoIso(m.joinedAgoMin) : null,
  }
}

function stageOf(db, id) {
  if (!db.live.stages[id]) db.live.stages[id] = { maxGuests: 6, members: [], requests: [] }
  return db.live.stages[id]
}

function stageDto(db, id) {
  const st = stageOf(db, id)
  const s = findStream(db, id)
  const active = st.members.filter(m => m.status === 'ACTIVE')
  return {
    streamId: id,
    hostId: s?.hostId || null,
    members: active.map(m => memberDto(db, id, m)),
    guestCount: active.filter(m => m.role !== 'HOST').length,
    maxGuests: st.maxGuests ?? 6,
  }
}

const findStream = (db, id) => (db.live.streams || []).find(s => s.id === id) || null

function requireStream(db, id) {
  const s = findStream(db, id)
  if (!s) throw mockError(404, 'STREAM_NOT_FOUND', 'That stream no longer exists.')
  return s
}

function requireHost(db, s) {
  if (s.hostId !== meId(db)) throw mockError(403, 'NOT_STREAM_HOST', 'Only the host can do that.')
}

function giftDto(db, streamId, g, senderId, total) {
  const u = userOf(db, senderId)
  return {
    streamId,
    senderId,
    senderUsername: u?.username || '',
    senderAvatarUrl: avatarOf(u),
    giftId: g.id,
    giftName: g.name,
    iconKey: g.iconKey,
    coins: g.coins,
    senderTotalCoins: total,
    sentAt: agoIso(0),
  }
}

/* ---------- routes ---------- */

export const routes = [
  /* ---- literals BEFORE /streams/{id} ---- */
  {
    m: 'GET', p: /^\/api\/v1\/streams\/live\/following$/,
    fn: (db) => {
      const following = new Set((db.follows || [])
        .filter(f => (f.followerId || f.from) === meId(db))
        .map(f => f.followeeId || f.to))
      return (db.live.streams || [])
        .filter(s => s.status === 'LIVE' && following.has(s.hostId))
        .map(s => streamDto(db, s))
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/streams\/live$/,
    fn: (db) => (db.live.streams || [])
      .filter(s => s.status === 'LIVE')
      .sort((a, b) => (b.viewerCount ?? 0) - (a.viewerCount ?? 0))
      .map(s => streamDto(db, s)),
  },
  {
    m: 'GET', p: /^\/api\/v1\/streams\/mine$/,
    fn: (db, { query }) => {
      const mine = (db.live.streams || [])
        .filter(s => s.hostId === meId(db))
        .sort((a, b) => (a.startedAgoMin ?? 0) - (b.startedAgoMin ?? 0))
        .map(s => streamDto(db, s, { viewer: false }))
      return page(mine, paging(query))
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/streams\/gifts\/catalog$/,
    fn: (db) => (db.live.gifts || []).map(g => ({ id: g.id, name: g.name, iconKey: g.iconKey, coins: g.coins })),
  },
  /* The live rail on the home feed reads the same LiveStreamResponse. */
  {
    m: 'GET', p: /^\/api\/v1\/posts\/feed\/live-now$/,
    fn: (db) => (db.live.streams || [])
      .filter(s => s.status === 'LIVE')
      .sort((a, b) => (b.viewerCount ?? 0) - (a.viewerCount ?? 0))
      .slice(0, 10)
      .map(s => streamDto(db, s)),
  },

  /* ---- go live ---- */
  {
    m: 'POST', p: /^\/api\/v1\/streams$/,
    fn: (db, { body }) => {
      const id = `s-mock-${(db.live.streams || []).length + 1}`
      const s = {
        id, hostId: meId(db), status: 'LIVE', viewerCount: 1, startedAgoMin: 0,
        record: !!body?.record,
        recordingStatus: body?.record ? 'RECORDING' : 'DISABLED',
        title: body?.title || 'Live',
        description: body?.description || '',
      }
      db.live.streams.unshift(s)
      db.live.stages[id] = {
        maxGuests: 6,
        members: [{ userId: s.hostId, role: 'HOST', status: 'ACTIVE', muted: false, joinedAgoMin: 0 }],
        requests: [],
      }
      db.live.chat[id] = []
      db.live.supporters[id] = []
      return streamDto(db, s, { viewer: false })
    },
  },

  /* ---- stage (multi-guest) — all BEFORE the /streams/{id} catch-all ---- */
  {
    m: 'GET', p: /^\/api\/v1\/streams\/([^/]+)\/stage$/,
    fn: (db, { params: [id] }) => { requireStream(db, id); return stageDto(db, id) },
  },
  {
    m: 'GET', p: /^\/api\/v1\/streams\/([^/]+)\/stage\/requests$/,
    fn: (db, { params: [id] }) => {
      requireStream(db, id)
      return stageOf(db, id).requests.map(m => memberDto(db, id, m))
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/streams\/([^/]+)\/stage\/requests$/,
    fn: (db, { params: [id] }) => {
      requireStream(db, id)
      const st = stageOf(db, id)
      const me = meId(db)
      let row = st.requests.find(m => m.userId === me)
      if (!row) { row = { userId: me, role: 'GUEST', status: 'REQUESTED', muted: false, joinedAgoMin: 0 }; st.requests.push(row) }
      return memberDto(db, id, row, { self: true })
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/streams\/([^/]+)\/stage\/requests\/([^/]+)\/approve$/,
    fn: (db, { params: [id, userId] }) => {
      const s = requireStream(db, id); requireHost(db, s)
      const st = stageOf(db, id)
      const i = st.requests.findIndex(m => m.userId === userId)
      if (i < 0) throw mockError(404, 'REQUEST_NOT_FOUND', 'No such stage request.')
      const active = st.members.filter(m => m.status === 'ACTIVE' && m.role !== 'HOST')
      if (active.length >= (st.maxGuests ?? 6)) throw mockError(409, 'STAGE_FULL', 'The stage is full.')
      const [row] = st.requests.splice(i, 1)
      row.status = 'ACTIVE'; row.joinedAgoMin = 0
      st.members.push(row)
      return memberDto(db, id, row)
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/streams\/([^/]+)\/stage\/requests\/([^/]+)\/deny$/,
    fn: (db, { params: [id, userId] }) => {
      const s = requireStream(db, id); requireHost(db, s)
      const st = stageOf(db, id)
      st.requests = st.requests.filter(m => m.userId !== userId)
      return NO_CONTENT
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/streams\/([^/]+)\/stage\/invites\/([^/]+)$/,
    fn: (db, { params: [id, userId] }) => {
      const s = requireStream(db, id); requireHost(db, s)
      const st = stageOf(db, id)
      if (!st.requests.some(m => m.userId === userId)) {
        st.requests.push({ userId, role: 'GUEST', status: 'INVITED', muted: false, joinedAgoMin: 0 })
      }
      return NO_CONTENT
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/streams\/([^/]+)\/stage\/accept$/,
    fn: (db, { params: [id] }) => {
      requireStream(db, id)
      const st = stageOf(db, id)
      const me = meId(db)
      const i = st.requests.findIndex(m => m.userId === me)
      const row = i >= 0 ? st.requests.splice(i, 1)[0]
        : { userId: me, role: 'GUEST', muted: false }
      row.status = 'ACTIVE'; row.joinedAgoMin = 0
      st.members.push(row)
      return memberDto(db, id, row, { self: true })
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/streams\/([^/]+)\/stage\/decline$/,
    fn: (db, { params: [id] }) => {
      requireStream(db, id)
      const st = stageOf(db, id)
      st.requests = st.requests.filter(m => m.userId !== meId(db))
      return NO_CONTENT
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/streams\/([^/]+)\/stage\/leave$/,
    fn: (db, { params: [id] }) => {
      requireStream(db, id)
      const st = stageOf(db, id)
      st.members = st.members.filter(m => m.userId !== meId(db) || m.role === 'HOST')
      return NO_CONTENT
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/streams\/([^/]+)\/stage\/([^/]+)\/mute$/,
    fn: (db, { params: [id, userId] }) => {
      const s = requireStream(db, id); requireHost(db, s)
      const m = stageOf(db, id).members.find(x => x.userId === userId)
      if (m) m.muted = true
      return NO_CONTENT
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/streams\/([^/]+)\/stage\/([^/]+)\/unmute$/,
    fn: (db, { params: [id, userId] }) => {
      const s = requireStream(db, id); requireHost(db, s)
      const m = stageOf(db, id).members.find(x => x.userId === userId)
      if (m) m.muted = false
      return NO_CONTENT
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/streams\/([^/]+)\/stage\/([^/]+)$/,
    fn: (db, { params: [id, userId] }) => {
      const s = requireStream(db, id); requireHost(db, s)
      const st = stageOf(db, id)
      st.members = st.members.filter(m => m.userId !== userId || m.role === 'HOST')
      return NO_CONTENT
    },
  },

  /* ---- gifts ---- */
  {
    m: 'GET', p: /^\/api\/v1\/streams\/([^/]+)\/gifts\/top$/,
    fn: (db, { params: [id], query }) => {
      const rows = (db.live.supporters[id] || [])
        .slice()
        .sort((a, b) => b.coins - a.coins)
        .slice(0, Number(query.limit || 10))
      return rows.map(r => {
        const u = userOf(db, r.userId)
        return {
          userId: r.userId,
          username: u?.username || '',
          displayName: displayName(u),
          avatarUrl: avatarOf(u),
          coins: r.coins,
          giftCount: r.giftCount,
        }
      })
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/streams\/([^/]+)\/gifts$/,
    fn: (db, { params: [id], body }) => {
      requireStream(db, id)
      const g = (db.live.gifts || []).find(x => x.id === body?.giftId)
      if (!g) throw mockError(404, 'GIFT_NOT_FOUND', 'No such gift.')
      if ((db.live.coinBalance ?? 0) < g.coins) throw mockError(402, 'INSUFFICIENT_COINS', 'Not enough coins.')
      db.live.coinBalance -= g.coins
      const me = meId(db)
      if (!db.live.supporters[id]) db.live.supporters[id] = []
      let row = db.live.supporters[id].find(r => r.userId === me)
      if (!row) { row = { userId: me, coins: 0, giftCount: 0 }; db.live.supporters[id].push(row) }
      row.coins += g.coins
      row.giftCount += 1
      return giftDto(db, id, g, me, row.coins)
    },
  },

  /* ---- reactions (broadcast-only) ---- */
  {
    m: 'POST', p: /^\/api\/v1\/streams\/([^/]+)\/reactions$/,
    fn: (db, { params: [id], body }) => {
      requireStream(db, id)
      return { streamId: id, userId: meId(db), type: body?.type || 'LIKE', sentAt: agoIso(0) }
    },
  },

  /* ---- live chat (ephemeral) ---- */
  {
    m: 'POST', p: /^\/api\/v1\/streams\/([^/]+)\/chat$/,
    fn: (db, { params: [id], body }) => {
      requireStream(db, id)
      const me = meId(db)
      const u = userOf(db, me)
      if (!db.live.chat[id]) db.live.chat[id] = []
      db.live.chat[id].push({ userId: me, agoMin: 0, text: body?.text || '' })
      return { streamId: id, userId: me, username: u?.username || '', text: body?.text || '', sentAt: agoIso(0) }
    },
  },

  /* ---- recording (owner-only) ---- */
  {
    m: 'POST', p: /^\/api\/v1\/streams\/([^/]+)\/recording\/start$/,
    fn: (db, { params: [id] }) => {
      const s = requireStream(db, id); requireHost(db, s)
      s.record = true; s.recordingStatus = 'RECORDING'
      return streamDto(db, s, { viewer: false })
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/streams\/([^/]+)\/recording\/stop$/,
    fn: (db, { params: [id] }) => {
      const s = requireStream(db, id); requireHost(db, s)
      /* Takes are joined into one file when the stream ends, so pausing mid
         broadcast leaves the status "recordable", not "available" yet. */
      s.record = false
      s.recordingStatus = s.status === 'ENDED' ? 'AVAILABLE' : 'DISABLED'
      return streamDto(db, s, { viewer: false })
    },
  },
  {
    m: 'GET', p: /^\/api\/v1\/streams\/([^/]+)\/recording$/,
    fn: (db, { params: [id] }) => {
      const s = requireStream(db, id); requireHost(db, s)
      if (s.recordingStatus !== 'AVAILABLE') {
        return { streamId: id, status: s.recordingStatus || 'EMPTY', totalBytes: 0, parts: [] }
      }
      return {
        streamId: id,
        status: 'AVAILABLE',
        totalBytes: 148_922_368,
        parts: [{
          file: `${id}-part-1.mp4`,
          sizeBytes: 148_922_368,
          modifiedAt: agoIso(s.endedAgoMin ?? 60),
          downloadUrl: `/api/v1/streams/${id}/recording/download`,
        }],
      }
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/streams\/([^/]+)\/recording$/,
    fn: (db, { params: [id] }) => {
      const s = requireStream(db, id); requireHost(db, s)
      s.recordingStatus = 'DELETED'
      return NO_CONTENT
    },
  },

  /* ---- lifecycle ---- */
  {
    m: 'POST', p: /^\/api\/v1\/streams\/([^/]+)\/join$/,
    fn: (db, { params: [id] }) => {
      const s = requireStream(db, id)
      if (s.status !== 'LIVE') throw mockError(409, 'STREAM_ENDED', 'That stream has ended.')
      s.viewerCount = (s.viewerCount ?? 0) + 1
      return streamDto(db, s)
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/streams\/([^/]+)\/leave$/,
    fn: (db, { params: [id] }) => {
      const s = findStream(db, id)
      if (s) s.viewerCount = Math.max(0, (s.viewerCount ?? 0) - 1)
      return NO_CONTENT
    },
  },
  {
    m: 'POST', p: /^\/api\/v1\/streams\/([^/]+)\/end$/,
    fn: (db, { params: [id] }) => {
      const s = requireStream(db, id); requireHost(db, s)
      s.status = 'ENDED'
      s.endedAgoMin = 0
      s.viewerCount = 0
      /* Every take is joined on end — that is when a recording becomes real. */
      if (s.record || s.recordingStatus === 'RECORDING') s.recordingStatus = 'AVAILABLE'
      return NO_CONTENT
    },
  },
  {
    m: 'PATCH', p: /^\/api\/v1\/streams\/([^/]+)$/,
    fn: (db, { params: [id], body }) => {
      const s = requireStream(db, id); requireHost(db, s)
      if (body?.title != null) s.title = body.title
      if (body?.description != null) s.description = body.description
      return streamDto(db, s, { viewer: false })
    },
  },
  {
    m: 'DELETE', p: /^\/api\/v1\/streams\/([^/]+)$/,
    fn: (db, { params: [id] }) => {
      const s = requireStream(db, id); requireHost(db, s)
      db.live.streams = db.live.streams.filter(x => x.id !== id)
      delete db.live.stages[id]; delete db.live.chat[id]; delete db.live.supporters[id]
      return NO_CONTENT
    },
  },
  /* The catch-all: MUST stay last among /streams/{id} patterns. */
  {
    m: 'GET', p: /^\/api\/v1\/streams\/([^/]+)$/,
    fn: (db, { params: [id] }) => {
      const s = requireStream(db, id)
      return streamDto(db, s, { viewer: s.hostId !== meId(db) })
    },
  },
]
