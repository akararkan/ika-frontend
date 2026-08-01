/* =========================================================
   Shared photo viewer — the one full-screen surface for the
   pictures that live OUTSIDE a post: profile photos, profile
   covers, channel art, group medallions.

   PostCard keeps its own gallery Lightbox (it pages through a
   post's images with the arrow keys); this one shows a single
   photo, so the two share the `.lightbox` / `.lb-*` CSS
   vocabulary rather than the code.

   `useImageViewer()` is how a page wires it up:

     const { openable, viewer } = useImageViewer()
     <div {...openable(u.coverImage, { className:'prof-cover-grad', label:'View cover photo' })}/>
     …
     {viewer}

   `openable` returns the WHOLE hit area — click, Enter/Space,
   an aria-label — so the entire plate opens, not a hotspot in
   the middle of it. With no image it returns just the class
   name, leaving the element inert (no pointer, no tab stop).
   ========================================================= */
import React from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './ui.jsx'

export function ImageLightbox({ src, caption, onClose }) {
  const closeRef = React.useRef(null)

  /* CAPTURE phase, on window: the chat details sheet (and other panels)
     close themselves on a bubbling Escape at `document`. Capturing first
     and stopping propagation means one Escape closes the photo only —
     it does not also tear down the panel the photo was opened from. */
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose?.()
    }
    window.addEventListener('keydown', onKey, true)
    closeRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  if (!src) return null

  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={caption || 'Photo'}
      onClick={onClose}>
      <button ref={closeRef} type="button" className="lb-close" onClick={onClose} aria-label="Close (Esc)">
        <Icon name="close"/>
      </button>
      {/* Stop the click on the photo itself: only the backdrop closes. */}
      <img className="lb-img" src={src} alt={caption || ''} onClick={e => e.stopPropagation()}/>
      {caption && <div className="lb-count" dir="auto">{caption}</div>}
    </div>,
    document.body
  )
}

export function useImageViewer() {
  const [shot, setShot] = React.useState(null)   // { src, caption } | null

  const open = React.useCallback((src, caption) => { if (src) setShot({ src, caption }) }, [])
  const close = React.useCallback(() => setShot(null), [])

  const openable = React.useCallback((src, opts = {}) => {
    const { caption, label = 'View photo', className = '' } = opts
    if (!src) return className ? { className } : {}
    const fire = (e) => { e.stopPropagation(); open(src, caption) }
    return {
      className: (className + ' img-openable').trim(),
      role: 'button',
      tabIndex: 0,
      'aria-label': label,
      title: label,
      onClick: fire,
      onKeyDown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(e) }
      },
    }
  }, [open])

  const viewer = shot ? <ImageLightbox src={shot.src} caption={shot.caption} onClose={close}/> : null
  return { open, close, openable, viewer }
}
