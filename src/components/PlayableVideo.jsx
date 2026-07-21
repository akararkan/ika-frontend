import React from 'react'
import { createPortal } from 'react-dom'

function isDirectVideoUrl(src) {
  if (!src) return false
  if (/^(data|blob):/i.test(src)) return true
  const lower = String(src).toLowerCase()
  return /\.(mp4|webm|ogg|ogv|m4v|mov|avi|mkv|3gp|3g2)([?#].*)?$/i.test(lower)
    || /video\/(mp4|webm|ogg|quicktime|x-matroska)/i.test(lower)
}

function getEmbedUrl(src) {
  if (!src) return null
  try {
    const u = new URL(src)
    const host = (u.hostname || '').replace(/^www\./, '')
    const path = u.pathname || ''
    const parts = path.split('/').filter(Boolean)

    if (['youtube.com', 'm.youtube.com', 'youtube-nocookie.com'].includes(host)) {
      const id = u.searchParams.get('v')
      if (id) return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}`
    }
    if (host === 'youtu.be') {
      const id = parts[0]
      if (id) return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}`
    }
    if (['vimeo.com', 'player.vimeo.com'].includes(host)) {
      const id = host === 'player.vimeo.com' ? parts[1] : parts[0]
      if (id) return `https://player.vimeo.com/video/${encodeURIComponent(id)}`
    }
    if (host === 'twitter.com' || host === 'x.com') {
      const match = path.match(/status\/(\d+)/)
      if (match) return `https://platform.twitter.com/widgets/tweet.html?dnt=true&url=${encodeURIComponent(src)}`
    }
    if (host === 'instagram.com' || host === 'www.instagram.com') {
      if (parts[0] === 'p' || parts[0] === 'reel') {
        return `https://www.instagram.com/p/${parts[1]}/embed/`
      }
    }
  } catch {
    return null
  }
  return null
}

export function PlayableVideo({
  src,
  poster,
  className = '',
  wrapperClassName = '',
  style,
  controls = true,
  autoPlay = false,
  muted = false,
  loop = false,
  playsInline = true,
  preload = 'metadata',
  onError,
  onEnded,
  onCanPlay,
  onTimeUpdate,
  videoRef,          /* optional: exposes the underlying <video> to the parent */
  allowFullscreen = true,
  title = 'Video',
  fallbackHref,
  children,
  modal = false,
}) {
  const embedUrl = React.useMemo(() => getEmbedUrl(src), [src])
  const [fullScreen, setFullScreen] = React.useState(false)
  const [hovered, setHovered] = React.useState(false)

  if (!src) return null

  const renderViewer = (isModal = false) => {
    if (embedUrl) {
      return (
        <div className={['media-video-shell', wrapperClassName].filter(Boolean).join(' ')} style={{ position:'relative', width:'100%', height:'100%', overflow:'hidden', background:'#000', borderRadius: isModal ? 0 : 12, ...style }}>
          <div style={{ position:'absolute', inset:0, background:'linear-gradient(145deg, rgba(255,255,255,.08), rgba(0,0,0,.38))', zIndex:1, pointerEvents:'none' }} />
          <iframe
            src={embedUrl}
            title={title}
            allow="autoplay; fullscreen; picture-in-picture"
            allowFullScreen={allowFullscreen}
            loading="lazy"
            style={{ width:'100%', height:'100%', border:0, display:'block', position:'relative', zIndex:0 }}
          />
          <div style={{ position:'absolute', inset:'0 auto auto 0', zIndex:2, padding:12, pointerEvents:'none' }}>
            <div style={{ display:'inline-flex', alignItems:'center', gap:8, padding:'8px 10px', borderRadius:999, background:'rgba(0,0,0,.62)', color:'#fff', fontSize:12, fontWeight:700, backdropFilter:'blur(8px)' }}>
              <span style={{ width:8, height:8, borderRadius:'50%', background:'#ff675c', display:'inline-block' }} />
              {title}
            </div>
          </div>
          {fallbackHref && (
            <a href={fallbackHref} target="_blank" rel="noreferrer" style={{ position:'absolute', right:10, bottom:10, zIndex:2, padding:'7px 10px', borderRadius:999, background:'rgba(0,0,0,.72)', color:'#fff', fontSize:12, textDecoration:'none', backdropFilter:'blur(8px)' }}>
              Open link
            </a>
          )}
          {children}
        </div>
      )
    }

    return (
      <div className={['media-video-shell', wrapperClassName].filter(Boolean).join(' ')} style={{ position:'relative', width:'100%', height:'100%', overflow:'hidden', background:'#000', borderRadius: isModal ? 0 : 12, ...style }}>
        {!poster && !isDirectVideoUrl(src) ? (
          <div style={{ position:'absolute', inset:0, display:'grid', placeItems:'center', background:'linear-gradient(135deg,#1a1714,#0e0b09)', color:'#fff', zIndex:1 }}>
            <div style={{ textAlign:'center', padding:'16px 18px', borderRadius:16, background:'rgba(255,255,255,.08)', backdropFilter:'blur(8px)' }}>
              <div style={{ width:54, height:54, borderRadius:'50%', display:'grid', placeItems:'center', margin:'0 auto 10px', background:'rgba(255,255,255,.16)' }}>
                <span style={{ width:0, height:0, borderLeft:'14px solid white', borderTop:'9px solid transparent', borderBottom:'9px solid transparent', marginLeft:4 }} />
              </div>
              <div style={{ fontSize:13, fontWeight:700 }}>Preview ready</div>
            </div>
          </div>
        ) : null}
        <video
          ref={videoRef}
          className={className}
          src={src}
          poster={poster || undefined}
          controls={controls}
          autoPlay={autoPlay}
          muted={muted}
          loop={loop}
          playsInline={playsInline}
          preload={preload}
          onError={onError}
          onEnded={onEnded}
          onCanPlay={onCanPlay}
          onTimeUpdate={onTimeUpdate}
          style={{ width:'100%', height:'100%', objectFit:'cover', display:'block', background:'#000', position:'relative', zIndex:0 }}
        />
        {controls && !poster ? (
          <div style={{ position:'absolute', inset:0, display:'grid', placeItems:'center', pointerEvents:'none', zIndex:2 }}>
            <div style={{ width:64, height:64, borderRadius:'50%', display:'grid', placeItems:'center', background:'rgba(0,0,0,.56)', boxShadow:'0 12px 34px rgba(0,0,0,.34)', backdropFilter:'blur(10px)', transform: hovered ? 'scale(1.06)' : 'scale(1)', transition:'transform .16s ease' }}>
              <span style={{ width:0, height:0, borderLeft:'22px solid white', borderTop:'13px solid transparent', borderBottom:'13px solid transparent', marginLeft:'6px' }} />
            </div>
          </div>
        ) : null}
        {children}
      </div>
    )
  }

  if (modal) {
    return (
      <>
        <div onClick={() => setFullScreen(true)} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} style={{ width:'100%', height:'100%', cursor:'zoom-in' }}>
          {renderViewer(false)}
        </div>
        {/* Portaled to <body>: ancestors with transform/contain (post cards)
            would otherwise become the containing block and clip this fixed
            overlay inside the card. */}
        {fullScreen && createPortal(
          <div style={{ position:'fixed', inset:0, zIndex:200, background:'rgba(7,7,7,.95)', display:'grid', placeItems:'center', padding:20 }} onClick={() => setFullScreen(false)}>
            <button onClick={(e) => { e.stopPropagation(); setFullScreen(false) }} style={{ position:'absolute', top:18, right:18, width:42, height:42, borderRadius:'50%', border:'none', background:'rgba(255,255,255,.16)', color:'#fff', display:'grid', placeItems:'center', cursor:'pointer' }} aria-label="Close video">✕</button>
            <div style={{ width:'min(1100px,100%)', height:'min(70vh,700px)', maxHeight:'90vh' }} onClick={(e) => e.stopPropagation()}>
              {renderViewer(true)}
            </div>
          </div>,
          document.body
        )}
      </>
    )
  }

  return (
    <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} style={{ width:'100%', height:'100%' }}>
      {renderViewer(false)}
    </div>
  )
}