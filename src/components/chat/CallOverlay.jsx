/* =========================================================
   CallOverlay — the only visual surface for voice/video calls.
   ---------------------------------------------------------
   Three states in one component, because they are one continuous
   moment for the user and remounting between them would tear
   down the <video> elements mid-negotiation:

     incoming  → the ringer card (Accept / Decline)
     outgoing  → "Ringing…" with the same frame already in place
     active    → the tiles + control bar

   It is rendered once, app-wide, from <Layout/> — a call must be
   answerable from the feed, not only from /chat.

   Streams are attached IMPERATIVELY (`el.srcObject = stream`).
   A MediaStream is not serialisable, so it cannot ride a `src`
   attribute; React has no prop for it and re-assigning the same
   object restarts playback, hence the identity check in the
   effect.

   What the surface adds on top of the streams, and why:
   · SPEAKING RINGS. In any call past two people, "who is talking"
     is the only thing the layout cannot show by itself. The level
     comes from CallContext's meters, not from the wire.
   · A MUTED-BUT-TALKING HINT. The single most universal call
     mistake. We can detect it exactly — the local meter keeps
     reading while the track is disabled — so we say it.
   · RECONNECTING PER TILE. A frozen tile with no caption is
     indistinguishable from a peer who stopped moving.
   · AUTO-HIDING CHROME on video calls only. On a voice call there
     is nothing underneath to reveal, so hiding the controls would
     be a puzzle rather than a courtesy.
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, Avatar } from '../ui.jsx'
import { useCall } from '../../context/CallContext.jsx'
import { useChat } from '../../context/ChatContext.jsx'
import { Popover } from './Popover.jsx'

/** seconds → "4:07" / "1:02:11". */
function clock(secs) {
  const s = Math.max(0, Math.floor(secs))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`
}

/** Idle time before the control bar fades out on a video call. */
const HIDE_MS = 3400

/** One <video> bound to a MediaStream. `muted` is mandatory on the local
 *  preview — an unmuted self-view is an instant feedback loop. */
function StreamTile({
  stream, muted, mirrored, label, avatar, initials, avc,
  level = 0, speaking = false, state, compact,
}) {
  const ref = React.useRef(null)
  const [hasVideo, setHasVideo] = React.useState(false)

  React.useEffect(() => {
    const el = ref.current
    if (!el || !stream) return undefined
    if (el.srcObject !== stream) el.srcObject = stream       // identity check: re-assigning restarts playback
    el.play?.().catch(() => { /* autoplay policy — the controls still work */ })

    const sync = () => setHasVideo(stream.getVideoTracks().some(t => t.enabled && t.readyState === 'live'))
    sync()
    // A peer can mute their camera mid-call; the track stays but goes disabled.
    stream.addEventListener?.('addtrack', sync)
    stream.addEventListener?.('removetrack', sync)
    const iv = setInterval(sync, 1000)
    return () => {
      clearInterval(iv)
      stream.removeEventListener?.('addtrack', sync)
      stream.removeEventListener?.('removetrack', sync)
    }
  }, [stream])

  const reconnecting = state === 'disconnected' || state === 'failed'

  return (
    <div
      className={
        'cl-tile'
        + (speaking ? ' speaking' : '')
        + (hasVideo ? '' : ' audio-only')
        + (compact ? ' compact' : '')
        + (reconnecting ? ' unstable' : '')
      }
      /* The ring scales with the actual loudness rather than snapping on and
         off at the threshold — that is what makes it read as a voice and not
         as a blinking light. */
      style={{ '--lvl': Math.min(1, level) }}
    >
      <video
        ref={ref}
        className={'cl-video' + (mirrored ? ' mirrored' : '')}
        playsInline
        autoPlay
        muted={!!muted}
      />
      {!hasVideo && (
        <div className="cl-tile-fallback">
          <span className="cl-halo" aria-hidden="true"/>
          <Avatar size={compact ? 54 : 84} src={avatar || null} initials={initials || '·'} color={avc}/>
        </div>
      )}
      {reconnecting && (
        <div className="cl-tile-state" role="status">
          <Icon name="refresh" className="sm"/>Reconnecting<span className="ch-ell" aria-hidden="true"/>
        </div>
      )}
      {label && (
        <div className="cl-tile-label" dir="auto">
          {speaking && <span className="cl-tile-eq" aria-hidden="true"><i/><i/><i/></span>}
          {label}
        </div>
      )}
    </div>
  )
}

export function CallOverlay() {
  const navigate = useNavigate()
  const {
    call, phase, convo, peerParticipant, localStream, remotes,
    micOn, camOn, screenOn, startedAt, minimized, setMinimized,
    acceptCall, declineCall, hangUp, toggleMic, toggleCam, toggleScreen,
    levels, speakingOf, peerStates, quality, devices, switchInput,
  } = useCall()
  const { userOf, watchUsers, enrichAuthor } = useChat()
  const [elapsed, setElapsed] = React.useState(0)
  const [chrome, setChrome] = React.useState(true)
  const [devOpen, setDevOpen] = React.useState(false)
  const devBtnRef = React.useRef(null)
  const hideRef = React.useRef(null)
  // Read inside the hide timer, which must not close over a stale `devOpen`
  // and must not do its checking inside a state updater (StrictMode invokes
  // updaters twice, and a side effect there fires twice with it).
  const devOpenRef = React.useRef(false)
  React.useEffect(() => { devOpenRef.current = devOpen }, [devOpen])

  const peerId = peerParticipant?.userId || null
  React.useEffect(() => { if (peerId) watchUsers([peerId]) }, [peerId, watchUsers])
  // Group calls: every tile needs a name and a face of its own.
  const remoteIds = remotes.map(r => String(r.userId)).join(',')
  React.useEffect(() => {
    if (remoteIds) watchUsers(remoteIds.split(','))
  }, [remoteIds, watchUsers])

  React.useEffect(() => {
    if (!startedAt) { setElapsed(0); return undefined }
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(iv)
  }, [startedAt])

  const isVideo = !!call?.video
  /* Auto-hide is video-only: on a voice call the frame under the bar is a
     static avatar, so hiding the controls reveals nothing and costs a gesture
     to get them back. Any pointer movement, any focus, and any open menu
     keeps them up. */
  const wake = React.useCallback(() => {
    setChrome(true)
    clearTimeout(hideRef.current)
    if (!isVideo) return
    hideRef.current = setTimeout(() => { if (!devOpenRef.current) setChrome(false) }, HIDE_MS)
  }, [isVideo])

  React.useEffect(() => { wake(); return () => clearTimeout(hideRef.current) }, [wake, phase])

  /* Escape must not hang up — a mis-keyed dismissal would drop a live call.
     It only collapses the surface to the floating pill. The rest are the
     shortcuts every conferencing tool shares, so muscle memory carries over. */
  React.useEffect(() => {
    if (phase !== 'active') return undefined
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '')
        || document.activeElement?.isContentEditable
      if (typing) return
      if (e.key === 'Escape') { setMinimized(true); return }
      if (e.key === 'm' || e.key === 'M') { e.preventDefault(); toggleMic(); wake() }
      if ((e.key === 'v' || e.key === 'V') && isVideo) { e.preventDefault(); toggleCam(); wake() }
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); toggleScreen(); wake() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, setMinimized, toggleMic, toggleCam, toggleScreen, isVideo, wake])

  if (phase === 'idle' || !call) return null

  const card = userOf(peerId)
  const peerAuthor = convo && !convo.isGroup ? enrichAuthor(convo.peer, peerId) : null
  const title = convo?.isGroup
    ? (convo.displayTitle || 'Group call')
    : (peerAuthor?.full || card?.full || convo?.displayTitle || 'Call')
  const avatar = peerAuthor?.profileImage || card?.profileImage || null
  const initials = peerAuthor?.initials || card?.initials || '·'
  const avc = peerAuthor?.avc || card?.avc

  const status = phase === 'incoming'
    ? `Incoming ${isVideo ? 'video' : 'voice'} call`
    : phase === 'outgoing'
      ? 'Ringing…'
      : clock(elapsed)

  const myLevel = levels?.me || 0
  const talkingWhileMuted = phase === 'active' && !micOn && myLevel >= 0.14

  /* ----- collapsed: a pill that keeps the call audible ----- */
  if (minimized && phase === 'active') {
    return (
      <div className="cl-pill" role="status">
        {/* The remote audio has to stay mounted or the call goes silent —
            these tiles are 1px, not unmounted. */}
        <div className="cl-pill-audio" aria-hidden="true">
          {remotes.map(r => (
            <StreamTile key={r.userId} stream={r.stream} muted={false}/>
          ))}
        </div>
        <button type="button" className="cl-pill-main" onClick={() => setMinimized(false)}>
          <span className={'cl-pill-dot' + (remotes.some(r => speakingOf(r.userId)) ? ' live' : '')} aria-hidden="true"/>
          <span className="cl-pill-nm" dir="auto">{title}</span>
          <span className="cl-pill-t">{clock(elapsed)}</span>
        </button>
        <button type="button" className={'cl-pill-ic' + (micOn ? '' : ' off')} onClick={toggleMic}
          aria-label={micOn ? 'Mute microphone' : 'Unmute microphone'} title={micOn ? 'Mute' : 'Unmute'}>
          <Icon name={micOn ? 'mic' : 'micoff'} className="sm"/>
        </button>
        <button type="button" className="cl-pill-x" onClick={hangUp} aria-label="End call" title="End call">
          <Icon name="phoneoff" className="sm"/>
        </button>
      </div>
    )
  }

  const ringing = phase === 'incoming' || phase === 'outgoing'
  const tiles = remotes.length
  const audioDevices = devices?.audio || []
  const videoDevices = devices?.video || []

  return (
    <div
      className={
        'cl-overlay'
        + (ringing ? ' ringing' : '')
        + (isVideo ? ' video' : ' voice')
        + (chrome ? ' chrome' : '')
      }
      role="dialog"
      aria-modal="true"
      aria-label={ringing ? status : `Call with ${title}`}
      onPointerMove={wake}
      onPointerDown={wake}
    >
      <div className="cl-frame">
        <header className="cl-head">
          <div className="cl-head-id">
            <b dir="auto">{title}</b>
            <small className={ringing ? 'live' : ''}>
              {status}
              {ringing && <span className="ch-ell" aria-hidden="true"/>}
              {phase === 'active' && (
                <span className={'cl-q ' + quality} title={
                  quality === 'good' ? 'Good connection'
                    : quality === 'fair' ? 'Unstable connection'
                      : 'Poor connection'
                }>
                  <Icon name="signal" aria-hidden="true"/>
                  <span className="sr-only">
                    {quality === 'good' ? 'Good connection' : quality === 'fair' ? 'Unstable connection' : 'Poor connection'}
                  </span>
                </span>
              )}
            </small>
          </div>
          <div className="cl-head-acts">
            {convo?.id && (
              <button type="button" className="icon-btn" title="Open the conversation"
                aria-label="Open the conversation"
                onClick={() => { setMinimized(true); navigate(`/chat/${convo.id}`) }}>
                <Icon name="chat"/>
              </button>
            )}
            {phase === 'active' && (
              <button type="button" className="icon-btn" onClick={() => setMinimized(true)}
                aria-label="Collapse the call" title="Collapse (Esc)">
                <Icon name="minimize"/>
              </button>
            )}
          </div>
        </header>

        <div className={'cl-stage n-' + Math.min(4, Math.max(1, tiles || 1)) + (tiles > 4 ? ' many' : '')}>
          {tiles === 0 ? (
            <div className="cl-await">
              <div className={'cl-await-av' + (ringing ? ' ringing' : '')}>
                <span className="cl-ring r1" aria-hidden="true"/>
                <span className="cl-ring r2" aria-hidden="true"/>
                <Avatar size={120} src={avatar} initials={initials} color={avc}/>
              </div>
              <div className="cl-await-nm" dir="auto">{title}</div>
              <div className="cl-await-sub">
                {status}{ringing && <span className="ch-ell" aria-hidden="true"/>}
              </div>
              {phase === 'incoming' && (
                <div className="cl-await-hint">
                  {isVideo ? 'Your camera will turn on when you answer.' : 'Only your microphone will be used.'}
                </div>
              )}
            </div>
          ) : (
            remotes.map(r => {
              const c = userOf(r.userId)
              return (
                <StreamTile
                  key={r.userId}
                  stream={r.stream}
                  muted={false}
                  label={c?.full || c?.handle || 'Participant'}
                  avatar={c?.profileImage}
                  initials={c?.initials || '·'}
                  avc={c?.avc}
                  level={levels?.[String(r.userId)] || 0}
                  speaking={speakingOf(r.userId)}
                  state={peerStates?.[String(r.userId)]}
                  compact={tiles > 2}
                />
              )
            })
          )}

          {(isVideo || screenOn) && localStream && phase === 'active' && (
            <div className="cl-self">
              {/* Mirrored so gestures read the right way round — but never
                  when it is a screen share, where mirroring would render text
                  backwards. Muted so the local mic never loops back. */}
              <StreamTile
                stream={localStream}
                muted
                mirrored={!screenOn}
                label={screenOn ? 'Your screen' : 'You'}
                level={myLevel}
                speaking={speakingOf('me') && micOn}
                compact
              />
            </div>
          )}

          {talkingWhileMuted && (
            <div className="cl-mutedhint" role="status">
              <Icon name="micoff" className="sm"/>You are muted
            </div>
          )}
        </div>

        <footer className="cl-bar">
          {phase === 'incoming' ? (
            <>
              <button type="button" className="cl-btn decline" onClick={declineCall}>
                <Icon name="phoneoff"/><span>Decline</span>
              </button>
              <button type="button" className="cl-btn accept" onClick={acceptCall} autoFocus>
                <Icon name={isVideo ? 'video' : 'phone'}/><span>Answer</span>
              </button>
            </>
          ) : (
            <>
              <button type="button" className={'cl-ctl' + (micOn ? '' : ' off')} onClick={toggleMic}
                aria-pressed={!micOn} aria-label={micOn ? 'Mute microphone' : 'Unmute microphone'}
                title={micOn ? 'Mute (M)' : 'Unmute (M)'}
                style={{ '--lvl': micOn ? Math.min(1, myLevel) : 0 }}>
                <span className="cl-ctl-lvl" aria-hidden="true"/>
                <Icon name={micOn ? 'mic' : 'micoff'}/>
              </button>

              {isVideo && (
                <button type="button" className={'cl-ctl' + (camOn ? '' : ' off')} onClick={toggleCam}
                  aria-pressed={!camOn} aria-label={camOn ? 'Turn the camera off' : 'Turn the camera on'}
                  title={camOn ? 'Camera off (V)' : 'Camera on (V)'}>
                  <Icon name={camOn ? 'video' : 'videooff'}/>
                </button>
              )}

              {phase === 'active' && (
                <button type="button" className={'cl-ctl' + (screenOn ? ' on' : '')} onClick={toggleScreen}
                  aria-pressed={screenOn}
                  aria-label={screenOn ? 'Stop sharing your screen' : 'Share your screen'}
                  title={screenOn ? 'Stop sharing (S)' : 'Share screen (S)'}>
                  <Icon name={screenOn ? 'screenoff' : 'screen'}/>
                </button>
              )}

              {phase === 'active' && (audioDevices.length > 1 || videoDevices.length > 1) && (
                <>
                  <button type="button" className="cl-ctl" ref={devBtnRef}
                    onClick={() => setDevOpen(v => !v)}
                    aria-haspopup="menu" aria-expanded={devOpen}
                    aria-label="Audio and video devices" title="Devices">
                    <Icon name="settings"/>
                  </button>
                  <Popover
                    anchorRef={devBtnRef}
                    open={devOpen}
                    onClose={() => setDevOpen(false)}
                    className="cl-devmenu"
                    ariaLabel="Audio and video devices"
                    prefer="top"
                    align="center"
                  >
                    <div className="cl-devlabel">Microphone</div>
                    {audioDevices.map((d, i) => (
                      <button key={d.deviceId || i} type="button" role="menuitem" className="ch-menu-item"
                        onClick={() => { setDevOpen(false); switchInput('audio', d.deviceId) }}>
                        <Icon name="mic" className="sm"/>
                        <span>{d.label || `Microphone ${i + 1}`}</span>
                      </button>
                    ))}
                    {videoDevices.length > 1 && (
                      <>
                        <div className="ch-menu-sep" role="separator"/>
                        <div className="cl-devlabel">Camera</div>
                        {videoDevices.map((d, i) => (
                          <button key={d.deviceId || i} type="button" role="menuitem" className="ch-menu-item"
                            onClick={() => { setDevOpen(false); switchInput('video', d.deviceId) }}>
                            <Icon name="swapcam" className="sm"/>
                            <span>{d.label || `Camera ${i + 1}`}</span>
                          </button>
                        ))}
                      </>
                    )}
                  </Popover>
                </>
              )}

              <button type="button" className="cl-btn decline wide" onClick={hangUp}>
                <Icon name="phoneoff"/><span>{phase === 'outgoing' ? 'Cancel' : 'End'}</span>
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}

export default CallOverlay
