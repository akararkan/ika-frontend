/* =========================================================
   liveStage — the TikTok-style live stage: split screen,
   camera-off profile plates, reactions and gifts
   ---------------------------------------------------------
   Multi-guest live is SEVERAL publishers sharing one canvas.
   When the host is alone the stage is their full picture;
   every guest who comes up SPLITS the screen — 2 side by side,
   then a 2×2, then a 3-wide grid — exactly the TikTok "go live
   together" layout. Each cell is one publisher: the host cell
   is the room's main <video> (host preview, or WHEP/HLS for a
   viewer), my own cell is my local camera, every other guest is
   a WHEP subscription.

   A cell whose camera is off shows the person's PROFILE PLATE
   (avatar on a tinted backdrop) instead of a black rectangle.
   For my own cells that is local knowledge; for remote ones
   there is no wire signal — a disabled WebRTC track still sends
   encoded black frames — so `useVideoPresence` samples each
   video's luma on a canvas and calls black black.

   State lives in StreamRoom (it owns the SSE subscription);
   this file renders, plus the two genuinely stateful hooks:
   useStageVideos (WHEP-per-guest, diffed, self-redialling) and
   useVideoPresence (the camera-off detector).
   ========================================================= */
import React from 'react'
import { Icon, Avatar } from './ui.jsx'
import { playWhep } from '../lib/liveWebrtc.js'

/* The reaction set (StreamReactionType). Unknown types render as the heart —
   a server that grows a new reaction must not break old clients. */
export const REACTIONS = [
  { type: 'LIKE', emoji: '❤️', label: 'Heart' },
  { type: 'LOVE', emoji: '😍', label: 'Love' },
  { type: 'CLAP', emoji: '👏', label: 'Applause' },
  { type: 'FIRE', emoji: '🔥', label: 'Fire' },
  { type: 'WOW',  emoji: '😮', label: 'Wow' },
]
const REACTION_EMOJI = Object.fromEntries(REACTIONS.map(r => [r.type, r.emoji]))
export const emojiOfReaction = (type) => REACTION_EMOJI[type] || '❤️'

/* iconKey → glyph for the 8-entry catalog the backend serves (probed:
   rose/heart/clap/star/crown/rocket/diamond/trophy). The fallback covers a
   catalog entry added server-side before this map learns about it. */
const GIFT_EMOJI = {
  rose: '🌹', heart: '💖', clap: '👏', star: '⭐',
  crown: '👑', rocket: '🚀', diamond: '💎', trophy: '🏆',
}
export const emojiOfGift = (iconKey) => GIFT_EMOJI[String(iconKey || '').toLowerCase()] || '🎁'

const connKeyOf = (m) => `${m.userId}|${m.whepUrl}`

/**
 * Keep one WHEP connection per REMOTE guest, in lockstep with the roster.
 *
 * Diff-based on purpose: a `stream.stage` frame replaces the whole roster, and
 * tearing every tile down to re-dial it would blink every guest's video each
 * time anyone joins or leaves. So: open a connection only for an entry we don't
 * have, close only the ones that left, and on EVERY pass re-apply the mute
 * flag — that line IS the receive side of host-mute (there is no server-side
 * track mute; every client silencing the guest locally is the mechanism).
 *
 * Keyed by userId AND whepUrl: a guest who steps down and comes back up gets a
 * freshly-minted media path, and a connection keyed by user alone would keep
 * dialling the dead one forever.
 *
 * Dialling retries while the entry exists (the roster frame routinely beats
 * the guest's first publish, so WHEP 404s for a beat), and a connection that
 * FAILS after it was up re-dials too — a network blip must not leave a
 * permanently black cell.
 *
 * The host and myself are excluded by the caller: the host's media is the main
 * video (a second WHEP to the same path would double their audio), and my own
 * cell is my local camera preview, not a round trip.
 */
export function useStageVideos(members) {
  const conns = React.useRef(new Map())   // connKey -> { el, handle, dead, timer, userId }
  const [, force] = React.useReducer(x => x + 1, 0)

  React.useEffect(() => {
    const want = new Map((members || []).filter(m => m.whepUrl).map(m => [connKeyOf(m), m]))

    // Entries that left (or re-keyed): stop dialling, close, drop the element.
    for (const [key, c] of conns.current) {
      if (!want.has(key)) {
        c.dead = true
        clearTimeout(c.timer)
        c.handle?.stop?.()
        try { c.el.remove() } catch { /* not mounted */ }
        conns.current.delete(key)
      }
    }

    let created = false
    want.forEach((m, key) => {
      let c = conns.current.get(key)
      if (!c) {
        const el = document.createElement('video')
        el.autoplay = true
        el.playsInline = true
        c = { el, handle: null, dead: false, timer: null, userId: String(m.userId) }
        conns.current.set(key, c)
        created = true
        const redial = (delay) => {
          if (c.dead) return
          clearTimeout(c.timer)
          c.timer = setTimeout(dial, delay)
        }
        const dial = async () => {
          if (c.dead || c.handle) return
          try {
            const h = await playWhep(m.whepUrl, el, {
              onState: (st) => {
                if (c.dead) return
                if (st === 'failed' || st === 'disconnected' || st === 'closed') {
                  c.handle?.stop?.()
                  c.handle = null
                  redial(1500)         // the publisher may just be re-negotiating
                }
              },
            })
            if (c.dead) { h.stop(); return }
            c.handle = h
            el.play?.().catch(() => { /* muted playback is managed below */ })
          } catch {
            redial(1500)
          }
        }
        dial()
      }
      /* Mute enforcement, every pass — the flag rides every roster frame. */
      c.el.muted = !!m.muted
    })
    if (created) force()   // new els exist → let the cells mount them
  }, [members])

  // Unmount: stop everything. The dial loops see `dead` and exit.
  React.useEffect(() => () => {
    conns.current.forEach(c => { c.dead = true; clearTimeout(c.timer); c.handle?.stop?.() })
    conns.current.clear()
  }, [])

  /* The REF, not its contents: reading `.current` during render is forbidden
     (the map only matters inside DOM ref callbacks and hooks, where it is
     allowed). */
  return conns
}

/**
 * The camera-off detector. A remote publisher disabling their video track
 * still SENDS frames — black ones — so "camera off" is invisible on the wire.
 * Sample each cell's video onto a 12×12 canvas every 1.5s and read the mean
 * luma; two consecutive black samples → that cell wears the profile plate.
 * (Two, not one: a dark scene cut or a starting keyframe must not flash the
 * plate over a live picture.) `readyState < 2` means no frames at all yet —
 * reported separately so cells can say "joining" instead of "camera off".
 *
 * Returns { [userId]: 'connecting' | 'on' | 'off', '@host': … }.
 */
export function useVideoPresence({ connsRef, idsKey, mainRef, watchMain }) {
  const [presence, setPresence] = React.useState({})
  const prevBlackRef = React.useRef({})   // key -> was the LAST sample black?

  React.useEffect(() => {
    if (!idsKey && !watchMain) {
      setPresence(p => (Object.keys(p).length ? {} : p))
      return undefined
    }
    const canvas = document.createElement('canvas')
    canvas.width = 12; canvas.height = 12
    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    const sample = (el, key) => {
      if (!el || el.readyState < 2 || !el.videoWidth) { prevBlackRef.current[key] = false; return 'connecting' }
      try {
        ctx.drawImage(el, 0, 0, 12, 12)
        const d = ctx.getImageData(0, 0, 12, 12).data
        let sum = 0
        for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114
        const black = (sum / (d.length / 4)) < 16
        const off = black && prevBlackRef.current[key]   // two consecutive black samples
        prevBlackRef.current[key] = black
        return off ? 'off' : 'on'
      } catch {
        return 'on'   // sampling failed → assume the picture is fine
      }
    }

    const tick = () => {
      const next = {}
      connsRef.current.forEach(c => { next[c.userId] = sample(c.el, c.userId) })
      if (watchMain) next['@host'] = sample(mainRef.current, '@host')
      setPresence(prev => {
        const pk = Object.keys(prev), nk = Object.keys(next)
        if (pk.length === nk.length && nk.every(k => prev[k] === next[k])) return prev
        return next
      })
    }
    tick()
    const t = setInterval(tick, 1500)
    return () => clearInterval(t)
  }, [connsRef, idsKey, mainRef, watchMain])

  return presence
}

/* ---------- the split-screen stage grid ---------- */

/* NAMESPACE NOTE: every class in this file is `stg-*`. The obvious `lv-*`
   prefix is ALREADY TAKEN twice over — `.lv-grid` is the live DIRECTORY's
   card grid and `.lv-cell` is the following-rail's 74px avatar cell — and the
   first version of this file collided with both: rail rules squeezed stage
   cells into face-slivers, and the stage rules clobbered the directory. */

/** A cell's profile plate — what a camera-off (or still-joining) person looks
 *  like: their face and name on a soft tinted backdrop, TikTok-style, never a
 *  black rectangle. */
function CellPlate({ name, card, avatarUrl, note }) {
  return (
    <div className="stg-plate">
      {(card?.profileImage || avatarUrl) && (
        <span className="stg-plate-bg" style={{ backgroundImage: `url("${encodeURI(card?.profileImage || avatarUrl)}")` }} aria-hidden="true"/>
      )}
      <Avatar size={52} src={card?.profileImage || avatarUrl || null}
        initials={card?.initials || (name[0] || '·')} color={card?.avc}/>
      <span className="stg-plate-name" dir="auto"><bdi>{name}</bdi></span>
      {note && <span className="stg-plate-note">{note}</span>}
    </div>
  )
}

/**
 * The whole stage as an adaptive grid: 1 → the host full-bleed, 2 → split
 * side by side, 3-4 → 2×2, 5+ → 3-wide. The host cell wraps `hostSlot` — the
 * room's ONE main <video> element, passed in as JSX so its identity (and the
 * attach effects pointed at it) survive every layout change.
 */
export function StageGrid({
  hostSlot, stream, stage, myId, isHost,
  hostCamOff, presence, connsRef, cardOf, busyId,
  meOnStage, attachMyTile, guestMicOn, guestCamOn, myMuted,
  onToggleGuestMic, onToggleGuestCam, onStepDown,
  onMute, onUnmute, onRemove,
}) {
  const guests = (stage?.members || []).filter(m => !m.isHost)
  const remotes = guests.filter(m => String(m.userId) !== String(myId))
  const n = 1 + (meOnStage ? 1 : 0) + remotes.length

  const hostCard = cardOf?.(stream?.hostId)
  const hostName = stream?.hostDisplayName || hostCard?.full
    || (stream?.hostHandle ? '@' + stream.hostHandle : 'Host')

  const nameOf = (m, card) => m.displayName || card?.full || (m.handle ? '@' + m.handle : 'Guest')

  /* TikTok cell chrome: a compact glass NAME PILL top-left, round glass
     CONTROLS bottom-right. No full-width bars — the picture is the surface. */
  const tag = (children) => <span className="stg-tag">{children}</span>

  return (
    <div className="stg-grid" data-n={Math.min(n, 9)}>
      {/* ---- the host's cell — the main video lives here ---- */}
      <figure className="stg-cell host">
        {hostSlot}
        {hostCamOff && (
          <CellPlate name={hostName} card={hostCard} avatarUrl={stream?.hostAvatarUrl}
            note="Camera is off"/>
        )}
        {n > 1 && tag(
          <>
            <Icon name="crown" className="xs" aria-label="Host"/>
            <bdi>{hostName}</bdi>
          </>
        )}
      </figure>

      {/* ---- my cell — local camera preview, my own controls ---- */}
      {meOnStage && (
        <figure className="stg-cell me">
          {/* Muted ALWAYS: hearing your own mic back half a second late is
              unusable. attachMyTile also (re)attaches the captured media, so a
              cell that mounts AFTER capture still gets the picture. */}
          <video ref={attachMyTile} autoPlay playsInline muted/>
          {!guestCamOn && (
            <CellPlate name="You" card={cardOf?.(myId)} note="Your camera is off"/>
          )}
          {tag(
            <>
              <bdi>You</bdi>
              {myMuted && <span className="stg-chip">Muted by host</span>}
              {!myMuted && !guestMicOn && <Icon name="micoff" className="xs" aria-label="Your mic is off"/>}
            </>
          )}
          <span className="stg-ctl">
            <button className="stg-act" onClick={onToggleGuestMic} disabled={myMuted}
              aria-pressed={guestMicOn && !myMuted}
              title={myMuted ? 'The host muted you' : guestMicOn ? 'Mute your mic' : 'Unmute your mic'}>
              <Icon name={guestMicOn && !myMuted ? 'mic' : 'micoff'} className="xs"
                aria-label={guestMicOn && !myMuted ? 'Your mic is on' : 'Your mic is off'}/>
            </button>
            <button className="stg-act" onClick={onToggleGuestCam}
              aria-pressed={guestCamOn}
              title={guestCamOn ? 'Turn your camera off — your profile shows instead' : 'Turn your camera on'}>
              <Icon name={guestCamOn ? 'camera' : 'videooff'} className="xs"
                aria-label={guestCamOn ? 'Your camera is on' : 'Your camera is off'}/>
            </button>
            <button className="stg-act bad" onClick={onStepDown} title="Leave the stage">
              <Icon name="logout" className="xs" aria-label="Leave the stage"/>
            </button>
          </span>
        </figure>
      )}

      {/* ---- every other guest — a WHEP subscription each ---- */}
      {remotes.map(m => {
        const card = cardOf?.(m.userId)
        const name = nameOf(m, card)
        const state = presence?.[String(m.userId)] || 'connecting'
        return (
          <figure className="stg-cell" key={connKeyOf(m)}>
            {/* The WHEP <video> lives in the conns map (created before mount so
                dialling starts immediately); adopt it into the cell. Reading
                the ref HERE is fine — DOM ref callbacks run after render. */}
            <div className="stg-media" ref={node => {
              const c = connsRef.current.get(connKeyOf(m))
              if (node && c && c.el.parentNode !== node) node.appendChild(c.el)
            }}/>
            {state !== 'on' && (
              <CellPlate name={name} card={card} avatarUrl={m.avatarUrl}
                note={state === 'connecting' ? 'Joining…' : 'Camera is off'}/>
            )}
            {tag(
              <>
                <Avatar size={14} src={card?.profileImage || m.avatarUrl || null}
                  initials={card?.initials || (name[0] || '·')} color={card?.avc}/>
                <bdi>{name}</bdi>
                {m.muted && <Icon name="micoff" className="xs" aria-label="Muted by the host"/>}
              </>
            )}
            {isHost && (
              <span className="stg-ctl">
                <button className="stg-act" disabled={busyId === m.userId}
                  onClick={() => (m.muted ? onUnmute(m.userId) : onMute(m.userId))}
                  title={m.muted ? 'Unmute for everyone' : 'Mute for everyone'}>
                  <Icon name={m.muted ? 'micoff' : 'mic'} className="xs"
                    aria-label={m.muted ? 'Unmute for everyone' : 'Mute for everyone'}/>
                </button>
                <button className="stg-act bad" disabled={busyId === m.userId}
                  onClick={() => onRemove(m.userId)} title="Take off the stage">
                  <Icon name="close" className="xs" aria-label="Take off the stage"/>
                </button>
              </span>
            )}
          </figure>
        )
      })}
    </div>
  )
}

/* ---------- floating reactions (the TikTok heart burst) ---------- */

/** Hearts rise from the corner where thumbs tap, swaying as they climb. Two
 *  layers per floater: the outer span rises and fades, the inner one sways —
 *  composed transforms without keyframe math. Pure render; StreamRoom owns
 *  the array and the expiry timers. Decorative → hidden from AT. */
export function FloaterLayer({ floaters }) {
  if (!floaters?.length) return null
  return (
    <div className="lv-floats" aria-hidden="true">
      {floaters.map(f => (
        <span key={f.id} className="lv-float"
          style={{
            insetInlineStart: f.x + '%',
            fontSize: f.size + 'px',
            animationDuration: f.dur + 's',
            '--amp': f.amp + 'px',
          }}>
          <span className="lv-float-sway" style={{ animationDuration: (f.dur / 3) + 's' }}>{f.emoji}</span>
        </span>
      ))}
    </div>
  )
}

/* ---------- gifts ---------- */

/** Center-stage gift moment. One at a time (StreamRoom queues); bigger gifts
 *  linger longer via the hold stamped on the splash at promote time. */
export function GiftSplash({ gift, cardOf }) {
  if (!gift) return null
  const card = cardOf?.(gift.senderId)
  const who = card?.full || gift.senderUsername || 'Someone'
  return (
    <div className="lv-gift-splash" style={{ '--dur': `${(gift._hold || 2000) / 1000}s` }}>
      <span className="lv-gift-glyph" aria-hidden="true">{emojiOfGift(gift.iconKey)}</span>
      <span className="lv-gift-caption" dir="auto">
        <b><bdi>{who}</bdi></b> sent {/^[aeiou]/i.test(gift.giftName) ? 'an' : 'a'} {gift.giftName}
      </span>
    </div>
  )
}

/** The gift picker — a bottom sheet (over the stage on desktop, over the
 *  viewport on phones). Symbolic only: coins are a leaderboard score. */
export function GiftPicker({ open, catalog, busy, onSend, onClose }) {
  const boxRef = React.useRef(null)

  // A dialog must answer Escape and take focus — otherwise a keyboard user is
  // left composing into a page that has a sheet floating over it.
  React.useEffect(() => {
    if (!open) return undefined
    boxRef.current?.focus()
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="lv-gift-sheet" role="dialog" aria-modal="true" aria-label="Send a gift"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="lv-gift-grid" ref={boxRef} tabIndex={-1}>
        <div className="lv-gift-head">
          <b>Send a gift</b>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" className="sm"/></button>
        </div>
        {catalog === null ? (
          <p className="lv-gift-empty">Loading…</p>
        ) : catalog.length === 0 ? (
          <p className="lv-gift-empty">Gifts aren’t available right now.</p>
        ) : (
          <div className="lv-gift-cells">
            {catalog.map(g => (
              <button key={g.id} className="lv-gift-cell" disabled={busy} onClick={() => onSend(g.id)}>
                <span className="lv-gift-ico" aria-hidden="true">{emojiOfGift(g.iconKey)}</span>
                <span className="lv-gift-nm">{g.name}</span>
                <span className="lv-gift-coins">{g.coins} {g.coins === 1 ? 'coin' : 'coins'}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Top supporters — seeded from the persisted tally, kept live off
 *  `senderTotalCoins`. Rendered only when someone has actually given. */
export function SupportersPanel({ board, cardOf }) {
  if (!board?.length) return null
  return (
    <section className="lv-supporters" aria-label="Top supporters">
      <div className="lv-sup-t"><Icon name="crown" className="xs"/>Top supporters</div>
      <ol className="lv-sup-list">
        {board.slice(0, 5).map((s, i) => {
          const card = cardOf?.(s.userId)
          const name = s.displayName || card?.full || (s.handle ? '@' + s.handle : s.username || 'Someone')
          return (
            <li key={s.userId || i} className="lv-sup-row">
              <span className={'lv-sup-rank r' + (i + 1)}>{i + 1}</span>
              <Avatar size={22} src={card?.profileImage || s.avatarUrl || null}
                initials={card?.initials || (name[0] || '·')} color={card?.avc}/>
              <bdi className="lv-sup-name">{name}</bdi>
              <span className="lv-sup-coins">{s.coins.toLocaleString()}</span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

/* ---------- the host's request queue ---------- */

/** Pending hand-raises. Appears only for the host, only while live, only when
 *  someone is actually waiting — an empty admin panel is noise. */
export function RequestQueue({ requests, stageFull, busyId, cardOf, onApprove, onDeny }) {
  if (!requests?.length) return null
  return (
    <section className="lv-queue" aria-label="Requests to join the stage">
      <div className="lv-queue-t">
        <Icon name="mic" className="xs"/>
        Asking to come up
        {stageFull && <span className="lv-queue-full">Stage full</span>}
      </div>
      {requests.map(r => {
        const card = cardOf?.(r.userId)
        const name = r.displayName || card?.full || (r.handle ? '@' + r.handle : 'Someone')
        return (
          <div className="lv-queue-row" key={r.userId}>
            <Avatar size={26} src={card?.profileImage || r.avatarUrl || null}
              initials={card?.initials || (name[0] || '·')} color={card?.avc}/>
            <bdi className="lv-queue-name">{name}</bdi>
            <span className="lv-queue-acts">
              <button className="rq-btn primary" disabled={busyId === r.userId || stageFull}
                onClick={() => onApprove(r.userId)}>
                {stageFull ? 'Full' : 'Bring up'}
              </button>
              <button className="rq-btn" disabled={busyId === r.userId} onClick={() => onDeny(r.userId)}>
                Not now
              </button>
            </span>
          </div>
        )
      })}
    </section>
  )
}

/* ---------- the invite banner (viewer side) ---------- */

/** The host asked YOU up. A banner with the decision, not a toast — a toast
 *  can't carry Accept/Decline. Takes focus when it appears so a keyboard or
 *  screen-reader user actually learns the question is being asked. */
export function InviteBanner({ invite, busy, cardOf, onAccept, onDecline }) {
  const boxRef = React.useRef(null)
  const has = !!invite
  React.useEffect(() => { if (has) boxRef.current?.focus() }, [has])
  if (!invite) return null
  const card = cardOf?.(invite.userId)
  const who = invite.displayName || card?.full || (invite.handle ? '@' + invite.handle : 'The host')
  return (
    <div className="lv-invite" role="alertdialog" aria-label="Invitation to join the stage"
      ref={boxRef} tabIndex={-1}>
      <Icon name="broadcast" className="sm"/>
      <span className="lv-invite-msg" dir="auto">
        <b><bdi>{who}</bdi></b> invited you up on the stage — your camera and mic go live to everyone.
      </span>
      <span className="lv-invite-acts">
        <button className="rq-btn primary" disabled={busy} onClick={onAccept}>{busy ? 'Joining…' : 'Join'}</button>
        <button className="rq-btn" disabled={busy} onClick={onDecline}>Not now</button>
      </span>
    </div>
  )
}
