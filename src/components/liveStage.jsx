/* =========================================================
   liveStage — the multi-guest stage, reactions and gifts UI
   ---------------------------------------------------------
   The TikTok-style "go live together" layer on top of LivePage.

   The one idea (live-multiguest-frontend.md §1): multi-guest live
   is SEVERAL publishers. The host publishes as before and stays
   the big picture; each guest publishes their own camera to their
   own URL; everyone subscribes to every publisher. So the stage is
   a rail of guest tiles under the main video — one tile per active
   guest, each one a WHEP subscription — plus your OWN tile showing
   your local camera while you are up.

   State (roster, queue, invites, floaters, the gift board) lives in
   StreamRoom, which owns the SSE subscription; this file is the
   rendering and the one genuinely stateful piece, useStageVideos —
   the hook that keeps WHEP connections in sync with the roster.
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

/**
 * Keep one WHEP connection per REMOTE guest, in lockstep with the roster.
 *
 * Diff-based on purpose: a `stream.stage` frame replaces the whole roster, and
 * tearing every tile down to re-dial it would blink every guest's video each
 * time anyone joins or leaves. So: open a connection only for a member we don't
 * have, close only the ones whose member left, and on EVERY pass re-apply the
 * mute flag — that last line IS the receive side of host-mute (there is no
 * server-side track mute; every client silencing the guest locally is the
 * mechanism, per live-streaming.md).
 *
 * The host member and myself are excluded by the caller: the host's media is
 * the main <video> (a second WHEP to the same path would double their audio),
 * and my own tile is my local camera preview, not a round-trip.
 *
 * Dialing RETRIES while the tile exists: the roster frame routinely beats the
 * guest's first publish, so WHEP 404s for a beat — give up and that guest is
 * a black tile forever.
 */
export function useStageVideos(members) {
  const conns = React.useRef(new Map())          // userId -> { el, handle, dead, muted }
  const [, force] = React.useReducer(x => x + 1, 0)

  React.useEffect(() => {
    const want = new Map((members || [])
      .filter(m => m.whepUrl)
      .map(m => [String(m.userId), m]))

    // Members who left: stop the dial loop, close the connection, drop the el.
    for (const [uid, c] of conns.current) {
      if (!want.has(uid)) {
        c.dead = true
        c.handle?.stop?.()
        try { c.el.remove() } catch { /* not mounted */ }
        conns.current.delete(uid)
      }
    }

    let created = false
    want.forEach((m, uid) => {
      let c = conns.current.get(uid)
      if (!c) {
        const el = document.createElement('video')
        el.autoplay = true
        el.playsInline = true
        c = { el, handle: null, dead: false }
        conns.current.set(uid, c)
        created = true
        const dial = async () => {
          while (!c.dead && !c.handle) {
            try {
              const h = await playWhep(m.whepUrl, el)
              if (c.dead) { h.stop(); return }
              c.handle = h
              el.play?.().catch(() => { /* autoplay policy — it's muted-managed below */ })
            } catch {
              await new Promise(r => setTimeout(r, 1500))
            }
          }
        }
        dial()
      }
      /* Mute enforcement, every pass — the flag rides every roster frame. */
      c.el.muted = !!m.muted
    })
    if (created) force()   // new els exist → let the tiles mount them
  }, [members])

  // Unmount: stop everything. The dial loops see `dead` and exit.
  React.useEffect(() => () => {
    conns.current.forEach(c => { c.dead = true; c.handle?.stop?.() })
    conns.current.clear()
  }, [])

  /* The REF, not its contents: reading `.current` during render is forbidden
     (and pointless — the map only matters inside the tiles' DOM ref callbacks,
     which run after render, where reading it is allowed). */
  return conns
}

/* ---------- the guest-tile rail ---------- */

/**
 * One tile per guest — mine first (local preview), then each remote guest
 * (WHEP). The HOST is deliberately not here: their picture is the main stage.
 */
export function StageTiles({
  stage, myId, isHost, meOnStage, myTileRef, micOn,
  connsRef, cardOf, busyId,
  onMute, onUnmute, onRemove, onStepDown,
}) {
  const guests = (stage?.members || []).filter(m => !m.isHost)
  const remotes = guests.filter(m => String(m.userId) !== String(myId))
  if (!meOnStage && remotes.length === 0) return null

  const plate = (m) => {
    const card = cardOf?.(m.userId)
    const name = m.displayName || card?.full || (m.handle ? '@' + m.handle : 'Guest')
    return (
      <span className="lv-tile-name" dir="auto">
        <Avatar size={18} src={card?.profileImage || m.avatarUrl || null}
          initials={card?.initials || (name[0] || '·')} color={card?.avc}/>
        <bdi>{name}</bdi>
        {m.muted && <Icon name="micoff" className="xs" aria-label="Muted by the host"/>}
      </span>
    )
  }

  return (
    <div className="lv-tiles" role="group" aria-label="On stage">
      {meOnStage && (
        <figure className="lv-tile me">
          {/* My local camera — attached by goUp's onLocalStream. Muted ALWAYS:
              hearing your own mic back half a second late is unusable. */}
          <video ref={myTileRef} autoPlay playsInline muted/>
          <figcaption className="lv-tile-bar">
            <span className="lv-tile-name">
              <bdi>You</bdi>
              {(!micOn) && <Icon name="micoff" className="xs" aria-label="Your mic is off"/>}
            </span>
            <button className="lv-tile-act" onClick={onStepDown} title="Leave the stage">
              <Icon name="logout" className="xs"/>Step down
            </button>
          </figcaption>
        </figure>
      )}

      {remotes.map(m => (
        <figure className="lv-tile" key={m.userId}>
          {/* The WHEP <video> lives in the conns map (created before mount so
              dialing can start immediately); adopt it into the tile. Reading
              the ref HERE is fine — DOM ref callbacks run after render. */}
          <div className="lv-tile-media" ref={node => {
            const c = connsRef.current.get(String(m.userId))
            if (node && c && c.el.parentNode !== node) node.appendChild(c.el)
          }}/>
          <figcaption className="lv-tile-bar">
            {plate(m)}
            {isHost && (
              <span className="lv-tile-acts">
                <button className="lv-tile-act" disabled={busyId === m.userId}
                  onClick={() => (m.muted ? onUnmute(m.userId) : onMute(m.userId))}
                  title={m.muted ? 'Unmute for everyone' : 'Mute for everyone'}>
                  <Icon name={m.muted ? 'micoff' : 'mic'} className="xs"/>
                </button>
                <button className="lv-tile-act bad" disabled={busyId === m.userId}
                  onClick={() => onRemove(m.userId)} title="Take off the stage">
                  <Icon name="close" className="xs"/>
                </button>
              </span>
            )}
          </figcaption>
        </figure>
      ))}
    </div>
  )
}

/* ---------- floating reactions ---------- */

/** The drifting hearts over the stage. Pure render — StreamRoom owns the array
 *  and the expiry timers. `aria-hidden`: decorative, announced nowhere. */
export function FloaterLayer({ floaters }) {
  if (!floaters?.length) return null
  return (
    <div className="lv-floats" aria-hidden="true">
      {floaters.map(f => (
        <span key={f.id} className="lv-float" style={{ insetInlineStart: f.x + '%' }}>{f.emoji}</span>
      ))}
    </div>
  )
}

/* ---------- gifts ---------- */

/** Center-stage gift moment. One at a time (StreamRoom queues); bigger gifts
 *  linger longer via the animation-duration custom property. */
export function GiftSplash({ gift, cardOf }) {
  if (!gift) return null
  const card = cardOf?.(gift.senderId)
  const who = card?.full || gift.senderUsername || 'Someone'
  return (
    <div className="lv-gift-splash" style={{ '--dur': `${1.8 + Math.min((gift.coins || 1) * 0.06, 2.4)}s` }}>
      <span className="lv-gift-glyph" aria-hidden="true">{emojiOfGift(gift.iconKey)}</span>
      <span className="lv-gift-caption" dir="auto">
        <b><bdi>{who}</bdi></b> sent {/^[aeiou]/i.test(gift.giftName) ? 'an' : 'a'} {gift.giftName}
      </span>
    </div>
  )
}

/** The gift picker — a compact sheet over the stage. Symbolic only: coins are
 *  a leaderboard score, so the coin chip reads as rank weight, not price. */
export function GiftPicker({ open, catalog, busy, onSend, onClose }) {
  if (!open) return null
  return (
    <div className="lv-gift-sheet" role="dialog" aria-label="Send a gift"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="lv-gift-grid">
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
 *  can't carry Accept/Decline, and this is a decision, not a notification. */
export function InviteBanner({ invite, busy, cardOf, onAccept, onDecline }) {
  if (!invite) return null
  const card = cardOf?.(invite.userId)
  const who = invite.displayName || card?.full || (invite.handle ? '@' + invite.handle : 'The host')
  return (
    <div className="lv-invite" role="alertdialog" aria-label="Invitation to join the stage">
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
