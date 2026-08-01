/* =========================================================
   Settings — Presence & Discovery panels.
   PresencePanel: who sees your online status / last seen
   (PresencePolicy segs, merge-style PUT). DiscoveryPanel:
   the five find-me switches plus the profile QR code
   (render + copy + rotate). Both optimistic with revert.
   ========================================================= */
import React from 'react'
import QRCode from 'qrcode'
import { Icon, showToast } from '../ui.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { ErrorState } from '../states.jsx'
import { api, PRESENCE_POLICIES } from '../../api/index.js'
import { SetCard, ToggleRow, Seg, ControlRow, fmtWhen, copyText } from './shared.jsx'

/* ---------- online presence ---------- */

export function PresencePanel() {
  const [pol, setPol] = React.useState(null)
  const [error, setError] = React.useState(false)
  const [tick, setTick] = React.useState(0)
  /* Mirror of the latest policies, so setPolicy can read the previous value
     WITHOUT doing work inside a setState updater — updaters must stay pure
     (StrictMode double-invokes them, which would fire every PUT twice). */
  const polRef = React.useRef(null)

  React.useEffect(() => {
    let alive = true
    polRef.current = null
    setPol(null); setError(false)
    api.settings.presence.get()
      .then(p => { if (alive) { polRef.current = p || {}; setPol(p || {}) } })
      .catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [tick])

  /* Merge-style PUT: send only the changed key. Optimistic; revert on failure. */
  const setPolicy = (key, value) => {
    const prevVal = polRef.current?.[key]
    if (prevVal === value) return
    polRef.current = { ...(polRef.current || {}), [key]: value }
    setPol(cur => ({ ...cur, [key]: value }))                   // pure updater
    api.settings.presence.update({ [key]: value })
      .catch(() => {
        /* Revert ONLY if this write's optimistic value is still the one
           showing. Otherwise a slow failure would stomp a newer edit that
           already succeeded. */
        setPol(cur => {
          if (!cur || cur[key] !== value) return cur
          const reverted = { ...cur, [key]: prevVal }
          polRef.current = reverted
          return reverted
        })
        showToast('Could not save — reverted')
      })
  }

  if (error) return (
    <SetCard icon="eye" title="Online presence">
      <ErrorState message="Could not load presence settings" onRetry={() => setTick(t => t + 1)}/>
    </SetCard>
  )
  if (pol === null) return (
    <SetCard icon="eye" title="Online presence"><p className="muted text-sm">Loading…</p></SetCard>
  )

  return (
    <SetCard icon="eye" title="Online presence" sub="Control who can tell when you are here.">
      <ControlRow title="Online status" desc="Who can see the green dot while you are active.">
        <Seg ariaLabel="Online status" options={PRESENCE_POLICIES}
          value={pol.onlineStatusPolicy ?? 'EVERYONE'}
          onChange={v => setPolicy('onlineStatusPolicy', v)}/>
      </ControlRow>
      <ControlRow title="Last seen" desc="Who can see when you were last active.">
        <Seg ariaLabel="Last seen" options={PRESENCE_POLICIES}
          value={pol.lastSeenPolicy ?? 'EVERYONE'}
          onChange={v => setPolicy('lastSeenPolicy', v)}/>
      </ControlRow>
      <div className="stx-note info">
        <Icon name="info"/>
        <span>This works both ways — if you hide your last seen, you will not see anyone else’s either.</span>
      </div>
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
     Only Rotate invalidates one. Keep the copy to what is actually enforced. */
  ['byQr', true, 'Offer my QR code for sharing',
    'When off, your code is hidden from IKA’s own sharing surfaces. A code you already shared or printed keeps opening your profile — rotating it below is what stops that.'],
  ['indexable', true, 'Allow search engines to index my public profile',
    'When off, search engines are asked not to list your profile. Existing results can take a while to disappear.'],
]

export function DiscoveryPanel() {
  const [disc, setDisc] = React.useState(null)
  const [error, setError] = React.useState(false)
  const [qr, setQr] = React.useState(null)
  const [qrError, setQrError] = React.useState(false)
  const [tick, setTick] = React.useState(0)
  const canvasRef = React.useRef(null)
  const uriRef = React.useRef(null)
  /* Same mirror trick as PresencePanel: previous value read outside the
     updater, because StrictMode double-invokes updaters. */
  const discRef = React.useRef(null)

  React.useEffect(() => {
    let alive = true
    discRef.current = null; uriRef.current = null
    setDisc(null); setError(false); setQr(null); setQrError(false)
    api.settings.discovery.get()
      .then(d => { if (alive) { discRef.current = d || {}; setDisc(d || {}) } })
      .catch(() => { if (alive) setError(true) })
    api.settings.discovery.qr()
      .then(q => { if (alive) setQr(q || null) })
      .catch(() => { if (alive) setQrError(true) })
    return () => { alive = false }
  }, [tick])

  const paintQr = React.useCallback(() => {
    if (!canvasRef.current || !uriRef.current) return
    QRCode.toCanvas(canvasRef.current, uriRef.current, {
      width: 296, margin: 1,
      color: { dark: '#002147', light: '#FFFFFF' },
    }).catch(() => {})
  }, [])

  /* The canvas only exists once the discovery flags have landed, and the two
     fetches race — so a uri-keyed effect alone misses the qr-first ordering
     (canvas still null on its one run). Painting from the callback ref covers
     "canvas mounts after the uri arrived"; the effect below covers "uri
     arrives/rotates while the canvas is already mounted". */
  const attachCanvas = React.useCallback(node => {
    canvasRef.current = node
    if (node) paintQr()
  }, [paintQr])

  React.useEffect(() => {
    uriRef.current = qr?.uri || null
    paintQr()
  }, [qr?.uri, paintQr])

  /* Merge-style PUT — one key per write. Optimistic; revert on failure. */
  const toggle = (key, fallback) => {
    const prevVal = discRef.current?.[key]
    const next = !(prevVal ?? fallback)
    discRef.current = { ...(discRef.current || {}), [key]: next }
    setDisc(cur => ({ ...cur, [key]: next }))                   // pure updater
    api.settings.discovery.update({ [key]: next })
      .catch(() => {
        /* Revert ONLY while this write's optimistic value is still showing, so
           a slow failure cannot stomp a newer edit that already succeeded. */
        setDisc(cur => {
          if (!cur || cur[key] !== next) return cur
          const reverted = { ...cur, [key]: prevVal }
          discRef.current = reverted
          return reverted
        })
        showToast('Could not save — reverted')
      })
  }

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
      showToast('Could not rotate the code')
    }
  }

  if (error) return (
    <SetCard icon="globe" title="Search & discovery">
      <ErrorState message="Could not load discovery settings" onRetry={() => setTick(t => t + 1)}/>
    </SetCard>
  )
  if (disc === null) return (
    <SetCard icon="globe" title="Search & discovery"><p className="muted text-sm">Loading…</p></SetCard>
  )

  return (
    <SetCard icon="globe" title="Search & discovery" sub="Choose how people can find your profile.">
      {DISCOVERY_ROWS.map(([key, fallback, title, desc]) => (
        <ToggleRow key={key} title={title} desc={desc}
          on={disc[key] ?? fallback}
          onToggle={() => toggle(key, fallback)}/>
      ))}

      <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--line-soft)' }}>
        <h3 className="title">Your QR code</h3>
        <p className="muted text-sm">Let someone scan this to open your profile without searching.</p>
        {qrError ? (
          <p className="muted text-sm" style={{ marginTop: 10 }}>Could not load your QR code.</p>
        ) : qr === null ? (
          <p className="muted text-sm" style={{ marginTop: 10 }}>Loading…</p>
        ) : (
          <div className="stx-qr">
            <div className="stx-qr-box"><canvas ref={attachCanvas}/></div>
            <div className="stx-qr-side">
              <div className="stx-plate">
                <code>{qr.uri}</code>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => copyText(qr.uri, 'Link copied')}>
                  <Icon name="copy" className="xs"/>Copy
                </button>
              </div>
              <div className="set-actions" style={{ marginTop: 10 }}>
                <button type="button" className="btn btn-secondary btn-sm" onClick={rotate}>
                  <Icon name="refresh" className="xs"/>Rotate
                </button>
              </div>
              <p className="muted text-xs" style={{ marginTop: 8 }}>Rotated {fmtWhen(qr.rotatedAt)}. Rotating invalidates every copy of the old code.</p>
            </div>
          </div>
        )}
      </div>
    </SetCard>
  )
}
