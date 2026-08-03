/* =========================================================
   Settings — Presence & Discovery panels.
   PresencePanel: who sees your online status / last seen
   (PresencePolicy segs, merge-style PUT). DiscoveryPanel:
   the five find-me switches plus the profile QR code
   (render + copy + rotate) and the inbound half — opening
   someone else's code. Both optimistic with revert.

   Two wire truths this file is built around:

   1. ONE last-seen switch, TWO writers. PresenceService (the
      only thing that enforces last seen) reads
      ChatUserSettings.lastSeenVisible, and
      PresencePolicyService.update() mirrors
      lastSeenVisible = (lastSeenPolicy != NOBODY) after EVERY
      presence PUT — including one that only touches
      onlineStatusPolicy. So a presence write can silently
      undo the Chat-privacy switch. This panel reads the chat
      boolean, shows the EFFECTIVE state, and never writes
      presence without deciding what happens to it.

   2. The QR code the backend hands out (`irc://u/<token>`) is
      unopenable — no protocol handler exists for a web app.
      What we paint is the https link to /qr/:opaque, which
      this app already routes; irc:// stays visible as the
      secondary app link. See lib/qrToken.js.
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import QRCode from 'qrcode'
import { Icon, showToast } from '../ui.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { ErrorState, Loader } from '../states.jsx'
import { api, PRESENCE_POLICIES } from '../../api/index.js'
import { extractQrToken, qrWebLink } from '../../lib/qrToken.js'
import { SetCard, SubHead, SeeAlso, ToggleRow, Seg, ControlRow, useWriteStatus, fmtWhen, copyText, humanEnum } from './shared.jsx'

/* ---------- online presence ---------- */

/* PRESENCE_POLICIES labels the middle value "Friends"; the backend means a
   MUTUAL follow (PresencePolicyService.mutualFollow), and this app has no
   separate friends graph. Same wire values, honest label. */
const LAST_SEEN_POLICIES = [['EVERYONE', 'Everyone'], ['FRIENDS', 'Mutual follows'], ['NOBODY', 'Nobody']]

/** The visible name of a stored policy value (a value the server may hold that
 *  this build does not label still reads as words, never as SCREAMING_CASE). */
function labelFor(value) {
  const row = LAST_SEEN_POLICIES.find(([v]) => v === value)
  return row ? row[1] : humanEnum(value)
}

/** The last seen that is actually in force. ChatUserSettings.lastSeenVisible is
 *  the only value PresenceService reads, so it beats the stored policy BOTH
 *  ways: false hides last seen whatever the policy says, and true means it is
 *  visible even against a stored NOBODY — Chat privacy writes the boolean
 *  without ever touching the policy. Never render the reassuring value. */
function effectiveLastSeen(pol, chat) {
  const policy = pol?.lastSeenPolicy ?? 'EVERYONE'
  if (chat?.lastSeenVisible === false) return 'NOBODY'
  if (chat?.lastSeenVisible === true && policy === 'NOBODY') return 'EVERYONE'
  return policy
}

export function PresencePanel() {
  const [pol, setPol] = React.useState(null)
  /* The chat-side half of the same switch (ChatUserSettings.lastSeenVisible).
     null = not answered yet; chatErr = we will never know, so the panel falls
     back to showing the policy alone rather than guessing. */
  const [chat, setChat] = React.useState(null)
  const [chatErr, setChatErr] = React.useState(false)
  const [error, setError] = React.useState(false)
  const [tick, setTick] = React.useState(0)
  const { statusOf, track } = useWriteStatus()
  /* Mirrors of the latest values, so setPolicy can read the previous state
     WITHOUT doing work inside a setState updater — updaters must stay pure
     (StrictMode double-invokes them, which would fire every PUT twice). */
  const polRef = React.useRef(null)
  const chatRef = React.useRef(null)

  React.useEffect(() => {
    let alive = true
    polRef.current = null; chatRef.current = null
    setPol(null); setChat(null); setChatErr(false); setError(false)
    api.settings.presence.get()
      .then(p => { if (alive) { polRef.current = p || {}; setPol(p || {}) } })
      .catch(() => { if (alive) setError(true) })
    api.chat.settings.get()
      .then(s => { if (alive) { chatRef.current = s || {}; setChat(s || {}) } })
      .catch(() => { if (alive) setChatErr(true) })
    return () => { alive = false }
  }, [tick])

  /* What the Seg must SHOW for last seen: the effective state, not the stored
     policy. The boolean wins in BOTH directions, so neither disagreement may
     be rendered as the reassuring value — see effectiveLastSeen. */
  const shownOf = React.useCallback((key) => {
    if (key === 'lastSeenPolicy') return effectiveLastSeen(polRef.current, chatRef.current)
    return polRef.current?.[key] ?? 'EVERYONE'
  }, [])

  /* Merge-style PUT: send only the keys this change owns. Optimistic; revert
     on failure. Async because a presence write can need a confirmation first.
     `force` exists for the reconcile buttons below: Seg never emits a change
     for the value already on screen (see shared.jsx), so writing the SHOWN
     last seen back into the stored policy needs a caller that skips the
     no-op guard. */
  const setPolicy = async (key, value, { force = false } = {}) => {
    if (!force && shownOf(key) === value) return
    const prevPol = polRef.current || {}
    const prevChat = chatRef.current || {}
    const body = { [key]: value }

    /* The trap: any presence PUT re-mirrors lastSeenVisible from the STORED
       lastSeenPolicy, so changing the online-status seg alone would switch a
       Chat-hidden last seen back on. Carry lastSeenPolicy=NOBODY along so the
       mirror writes false — but say so first; it is a second setting moving. */
    const wouldUnhide = key === 'onlineStatusPolicy'
      && prevChat.lastSeenVisible === false
      && (prevPol.lastSeenPolicy ?? 'EVERYONE') !== 'NOBODY'
    if (wouldUnhide) {
      const ok = await uiConfirm({
        title: 'This also settles your last seen',
        message: 'Your last seen is hidden from Chat privacy in Messages, and saving an online-status change rewrites that switch. Last seen will be set to “Nobody” here too, so it stays hidden.',
        confirmLabel: 'Save, keep last seen hidden',
        icon: 'alert',
      })
      if (!ok) return
      body.lastSeenPolicy = 'NOBODY'
    }

    /* The value the backend mirror will land on for this write. */
    const wantVisible = (body.lastSeenPolicy ?? prevPol.lastSeenPolicy ?? 'EVERYONE') !== 'NOBODY'
    const optPol = { ...prevPol, ...body }
    const optChat = { ...prevChat, lastSeenVisible: wantVisible }
    polRef.current = optPol; setPol(optPol)                     // pure updater
    if (!chatErr) { chatRef.current = optChat; setChat(optChat) }

    track(key, api.settings.presence.update(body)
      .then(async () => {
        /* Belt and braces: the presence mirror is best-effort server-side (it
           swallows its own failures), so the explicit last-seen write is the
           one that is guaranteed — and it answers with the authoritative row. */
        if (key !== 'lastSeenPolicy' || chatErr) return
        const s = await api.chat.settings.update({ lastSeenVisible: wantVisible }).catch(() => null)
        if (!s) return
        chatRef.current = s; setChat(s)
      })
      .catch(() => {
        /* Revert ONLY while this write's optimistic objects are still the ones
           showing. Otherwise a slow failure would stomp a newer edit that
           already succeeded. */
        if (polRef.current === optPol) { polRef.current = prevPol; setPol(prevPol) }
        if (chatRef.current === optChat) { chatRef.current = prevChat; setChat(prevChat) }
        throw new Error('presence write failed')                // the row says "Not saved"
      })).catch(() => {})
  }

  if (error) return (
    <SetCard id="presence" icon="eye" title="Online presence">
      <ErrorState message="Could not load presence settings" onRetry={() => setTick(t => t + 1)}/>
    </SetCard>
  )
  /* Wait for the chat boolean too: showing "Everyone" for a beat on a last
     seen that is actually hidden is the one flicker worth blocking on. */
  if (pol === null || (chat === null && !chatErr)) return (
    <SetCard id="presence" icon="eye" title="Online presence"><Loader label="Loading presence…"/></SetCard>
  )

  const lastSeenShown = effectiveLastSeen(pol, chat)
  const policy = pol.lastSeenPolicy ?? 'EVERYONE'
  const hiddenFromChat = chat?.lastSeenVisible === false && policy !== 'NOBODY'
  const shownFromChat = chat?.lastSeenVisible === true && policy === 'NOBODY'

  return (
    <SetCard id="presence" icon="eye" title="Online presence" sub="Control who can tell when you are here.">
      <ControlRow title="Online status" status={statusOf('onlineStatusPolicy')}
        desc="Who can see the green dot while you are active. Today the dot is hidden only from people you have blocked — the rest of this choice is saved for when per-audience presence lands.">
        <Seg ariaLabel="Online status" options={PRESENCE_POLICIES}
          value={pol.onlineStatusPolicy ?? 'EVERYONE'}
          onChange={v => setPolicy('onlineStatusPolicy', v)}/>
      </ControlRow>
      <ControlRow title="Last seen" status={statusOf('lastSeenPolicy')}
        desc="Who can see when you were last active.">
        <Seg ariaLabel="Last seen" options={LAST_SEEN_POLICIES}
          value={lastSeenShown}
          onChange={v => setPolicy('lastSeenPolicy', v)}/>
      </ControlRow>

      {/* The two ways the boolean and the stored policy can disagree. Each gets
          the write that ends the disagreement, because the control above cannot:
          Seg fires nothing when you pick the value it is already showing. */}
      {hiddenFromChat && (
        <div className="stx-note warn">
          <Icon name="alert"/>
          <span>
            Your last seen is currently hidden by <b>Chat privacy</b> in Messages, so the control above
            shows what is in force — “Nobody”. This card still has “{labelFor(policy)}” saved, and the
            next thing you save here would use it.
            <span className="flex gap-8" style={{ marginTop: 8 }}>
              <button type="button" className="btn btn-secondary btn-sm"
                onClick={() => setPolicy('lastSeenPolicy', 'NOBODY', { force: true })}>
                Save “Nobody” here too
              </button>
            </span>
          </span>
        </div>
      )}
      {shownFromChat && (
        <div className="stx-note warn">
          <Icon name="alert"/>
          <span>
            <b>Chat privacy</b> in Messages has last seen switched back on, so it is visible right now
            even though “Nobody” is what this card has saved. The control above shows what is in force.
            <span className="flex gap-8" style={{ marginTop: 8 }}>
              <button type="button" className="btn btn-secondary btn-sm"
                onClick={() => setPolicy('lastSeenPolicy', 'NOBODY', { force: true })}>
                Hide it everywhere
              </button>
              <button type="button" className="btn btn-ghost btn-sm"
                onClick={() => setPolicy('lastSeenPolicy', 'EVERYONE', { force: true })}>
                Keep it visible
              </button>
            </span>
          </span>
        </div>
      )}
      <div className="stx-note info">
        <Icon name="info"/>
        <span>
          Last seen works both ways — if you hide yours, you will not see anyone else’s either.
          Of the three choices only <b>Nobody</b> changes anything today: it is the one that actually
          hides your last seen. <b>Everyone</b> and <b>Mutual follows</b> behave the same for now.
        </span>
      </div>
      <SeeAlso to="/chat">The same last-seen switch lives in Messages, under the lock in the chat header</SeeAlso>
    </SetCard>
  )
}

/* ---------- search & discovery + QR ---------- */

const DISCOVERY_ROWS = [
  ['byUsername', true, 'Find me by username',
    'People can find your profile by searching for your exact username.'],
  ['byPhone', false, 'Find me by phone number',
    'People who already have your number can find you. Only works once a phone number is verified in Security.'],
  ['byEmail', false, 'Find me by email',
    'People who already have your email address can find you.'],
  /* Do NOT promise that this blocks scans: resolving a QR token does not check
     this flag on the backend, so a code already out in the world keeps working.
     Only Rotate invalidates one. Keep the copy to what is actually enforced —
     what this switch does do is hide the code below. */
  ['byQr', true, 'Offer my QR code for sharing',
    'When off, your code is hidden here and anywhere IKA would offer it. A code you already shared or printed keeps opening your profile — rotating it is what stops that.'],
  ['indexable', true, 'Allow search engines to index my public profile',
    'When off, search engines are asked not to list your profile. Existing results can take a while to disappear.'],
]

export function DiscoveryPanel() {
  const [disc, setDisc] = React.useState(null)
  const [error, setError] = React.useState(false)
  const [tick, setTick] = React.useState(0)
  const { statusOf, track } = useWriteStatus()
  /* Same mirror trick as PresencePanel: previous value read outside the
     updater, because StrictMode double-invokes updaters. */
  const discRef = React.useRef(null)

  React.useEffect(() => {
    let alive = true
    discRef.current = null
    setDisc(null); setError(false)
    api.settings.discovery.get()
      .then(d => { if (alive) { discRef.current = d || {}; setDisc(d || {}) } })
      .catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [tick])

  /* Merge-style PUT — one key per write. Optimistic; revert on failure. */
  const toggle = (key, fallback) => {
    const prev = discRef.current || {}
    const next = !(prev[key] ?? fallback)
    const opt = { ...prev, [key]: next }
    discRef.current = opt; setDisc(opt)
    track(key, api.settings.discovery.update({ [key]: next })
      .catch((e) => {
        /* Revert ONLY while this write's optimistic object is still the one
           showing, so a slow failure cannot stomp a newer edit that already
           succeeded. Identity, not value — same test as PresencePanel. */
        if (discRef.current === opt) { discRef.current = prev; setDisc(prev) }
        throw e                                                 // the row says "Not saved"
      })).catch(() => {})
  }

  /* The QR card is deliberately absent until the flags land: byQr decides
     whether the code may be painted at all, and "hidden" copy shown while we
     are merely still loading would be a lie. */
  if (error) return (
    <SetCard id="discovery" icon="globe" title="Search & discovery">
      <ErrorState message="Could not load discovery settings" onRetry={() => setTick(t => t + 1)}/>
    </SetCard>
  )
  if (disc === null) return (
    <SetCard id="discovery" icon="globe" title="Search & discovery"><Loader label="Loading discovery…"/></SetCard>
  )

  return (
    <>
      <SetCard id="discovery" icon="globe" title="Search & discovery" sub="Choose how people can find your profile.">
        {DISCOVERY_ROWS.map(([key, fallback, title, desc]) => (
          <ToggleRow key={key} title={title} desc={desc}
            on={disc[key] ?? fallback}
            status={statusOf(key)}
            onToggle={() => toggle(key, fallback)}/>
        ))}
        {/* Honest about the seam: DiscoverabilityService exposes isDiscoverableBy
            / isIndexable, but nothing outside the settings package calls either
            yet (search, contact matching and QR resolve all ignore them), so
            these are stored choices rather than live filters. The QR switch is
            the exception — this app honours it on the card below. */}
        <div className="stx-note info">
          <Icon name="info"/>
          <span>
            These choices are saved to your account and will apply as each way of finding
            people starts reading them. Today the one that already changes something is the
            QR switch, which hides your code below.
          </span>
        </div>
      </SetCard>
      <QrCard shown={disc.byQr ?? true}/>
    </>
  )
}

/* ---------- the QR card: your code out, someone else's code in ---------- */

function QrCard({ shown }) {
  const [qr, setQr] = React.useState(null)
  const [qrError, setQrError] = React.useState(false)
  const [tick, setTick] = React.useState(0)
  const canvasRef = React.useRef(null)
  const uriRef = React.useRef(null)

  React.useEffect(() => {
    let alive = true
    setQr(null); setQrError(false)
    api.settings.discovery.qr()
      .then(q => { if (alive) setQr(q || null) })
      .catch(() => { if (alive) setQrError(true) })
    return () => { alive = false }
  }, [tick])

  /* What a camera actually gets: the https landing route, NOT the irc:// uri
     the backend composes (nothing on this platform can open that scheme). */
  const webUri = qr?.opaqueToken ? qrWebLink(qr.opaqueToken) : null

  const paintQr = React.useCallback(() => {
    const node = canvasRef.current
    if (!node || !uriRef.current) return
    QRCode.toCanvas(node, uriRef.current, {
      width: 296, margin: 1,
      color: { dark: '#002147', light: '#FFFFFF' },
    }).then(() => {
      /* qrcode writes `style="width:296px;height:296px"` onto the canvas, and an
         inline style beats the stylesheet — the code rendered at full bitmap
         size and spilled out of .stx-qr-box across the text beside it. Drop the
         inline sizing and let the box govern the DISPLAY size; the bitmap stays
         296px, which is what keeps it crisp on a retina screen. */
      node.style.width = ''
      node.style.height = ''
    }).catch(() => {})
  }, [])

  /* The canvas only exists once the code has landed AND byQr is on, so a
     uri-keyed effect alone misses the "canvas mounts later" ordering (canvas
     still null on its one run). Painting from the callback ref covers that;
     the effect below covers "uri arrives/rotates while already mounted". */
  const attachCanvas = React.useCallback(node => {
    canvasRef.current = node
    if (node) paintQr()
  }, [paintQr])

  React.useEffect(() => {
    uriRef.current = webUri
    paintQr()
  }, [webUri, paintQr])

  const rotate = async () => {
    const ok = await uiConfirm({
      title: 'Rotate your QR code?',
      message: 'A new code replaces this one immediately. Any code you already shared, printed, or screenshotted will stop working.',
      confirmLabel: 'Rotate code',
      icon: 'refresh',
    })
    if (!ok) return
    try {
      const next = await api.settings.discovery.rotateQr()
      setQr(next)
      showToast('QR code rotated')
    } catch {
      showToast('Could not rotate the code', 'err')
    }
  }

  return (
    <SetCard id="qr" icon="camera" title="Your QR code" sub="Let someone scan this to open your profile without searching.">
      {qrError ? (
        <ErrorState message="Could not load your QR code" onRetry={() => setTick(t => t + 1)}/>
      ) : qr === null ? (
        <Loader label="Loading your code…"/>
      ) : (
        <div className="stx-qr">
          {/* The canvas carries no text of its own — name it; the same link is
              in the copy plate beside it for anyone not scanning. */}
          {shown && (
            <div className="stx-qr-box">
              <canvas ref={attachCanvas} role="img"
                aria-label="QR code for your profile link, shown as text beside it"/>
            </div>
          )}
          <div className="stx-qr-side">
            {shown ? (
              <>
                <div className="stx-plate">
                  <code>{webUri || qr.uri}</code>
                  <button type="button" className="btn btn-ghost btn-sm"
                    onClick={() => copyText(webUri || qr.uri, 'Link copied')}>
                    <Icon name="copy" className="xs"/>Copy
                  </button>
                </div>
                {/* Kept for a native client that registers the scheme; it is not
                    what the code encodes, because a phone camera cannot open it. */}
                <p className="muted text-xs" style={{ marginTop: 8 }}>
                  App link: <code>{qr.uri}</code>
                </p>
              </>
            ) : (
              <p className="muted text-sm">
                Your code is hidden while “Offer my QR code for sharing” is off. You can still rotate it,
                which is what stops a code you already handed out.
              </p>
            )}
            <div className="set-actions" style={{ marginTop: 10 }}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={rotate}>
                <Icon name="refresh" className="xs"/>Rotate
              </button>
            </div>
            <p className="muted text-xs" style={{ marginTop: 8 }}>Rotated {fmtWhen(qr.rotatedAt)}. Rotating invalidates every copy of the old code.</p>
          </div>
        </div>
      )}

      <SubHead>Open someone else’s code</SubHead>
      <CodeOpener/>
    </SetCard>
  )
}

/* Can this browser read a code from the camera? Chrome/Android ship
   BarcodeDetector; Safari and Firefox do not, and there is no polyfill
   without a new dependency — so the paste field is the path that always
   works and the camera is the bonus. */
const CAN_SCAN = typeof window !== 'undefined'
  && 'BarcodeDetector' in window
  && !!navigator.mediaDevices?.getUserMedia

function CodeOpener() {
  const navigate = useNavigate()
  const inputId = React.useId()
  const [value, setValue] = React.useState('')
  const [bad, setBad] = React.useState(false)
  const [cam, setCam] = React.useState(false)
  const videoRef = React.useRef(null)

  const open = React.useCallback((raw) => {
    const token = extractQrToken(raw)
    if (!token) { setBad(true); return false }
    setBad(false)
    navigate(`/qr/${token}`)
    return true
  }, [navigate])

  /* Camera pass: grab the rear camera, poll the detector a few times a second
     (rAF would run the detector 60×/s for no gain) and hand every hit to the
     same parser, so a code minted by another build still resolves. */
  React.useEffect(() => {
    if (!cam) return undefined
    let alive = true
    let stream = null
    let timer = null
    const detector = new window.BarcodeDetector({ formats: ['qr_code'] })
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(async s => {
        if (!alive) { s.getTracks().forEach(t => t.stop()); return }
        stream = s
        if (videoRef.current) { videoRef.current.srcObject = s; await videoRef.current.play().catch(() => {}) }
        /* Re-check: play() is awaited, so the cleanup may already have run —
           an interval started after it would never be cleared and would keep
           navigating from an unmounted panel. */
        if (!alive) return
        timer = setInterval(async () => {
          if (!videoRef.current) return
          const hits = await detector.detect(videoRef.current).catch(() => [])
          for (const h of hits) {
            if (open(h.rawValue)) { setCam(false); return }
          }
        }, 350)
      })
      .catch(() => {
        if (!alive) return
        showToast('Could not open the camera', 'err')
        setCam(false)
      })
    return () => {
      alive = false
      clearInterval(timer)
      stream?.getTracks().forEach(t => t.stop())
    }
  }, [cam, open])

  return (
    <div>
      <p className="muted text-sm">
        Someone showed you their code? Scan it, or paste the link they sent — <code>irc://u/…</code>,
        a <code>/qr/…</code> link, or the code itself.
      </p>
      <form onSubmit={e => { e.preventDefault(); open(value) }}>
        {/* A visible label rather than aria-label: the field sits in a row with
            two buttons, so the association has to be spelled out. */}
        <label className="field-label" htmlFor={inputId} style={{ marginTop: 10 }}>Their code or link</label>
        <div className="flex gap-8" style={{ marginTop: 6, flexWrap: 'wrap' }}>
          <input id={inputId} className="field" style={{ flex: '1 1 220px', minWidth: 0 }}
            value={value}
            aria-invalid={bad || undefined}
            aria-describedby={bad ? `${inputId}-e` : undefined}
            placeholder="Paste a code or link…"
            onChange={e => { setValue(e.target.value); setBad(false) }}/>
          <button type="submit" className="btn btn-secondary btn-sm" disabled={!value.trim()}>
            <Icon name="search" className="xs"/>Open
          </button>
          {CAN_SCAN && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCam(c => !c)}>
              <Icon name="camera" className="xs"/>{cam ? 'Stop camera' : 'Scan'}
            </button>
          )}
        </div>
      </form>
      {bad && <p className="stx-hint" id={`${inputId}-e`} role="alert" style={{ marginTop: 6 }}>That doesn’t look like an IKA code.</p>}
      {cam && (
        <div className="stx-qr-box" style={{ width: '100%', maxWidth: 280, height: 'auto', marginTop: 10 }}>
          {/* muted+playsInline or iOS refuses to autoplay the preview */}
          <video ref={videoRef} muted playsInline style={{ width: '100%', borderRadius: 10 }}/>
        </div>
      )}
    </div>
  )
}
