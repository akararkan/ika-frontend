/* =========================================================
   Popover — an anchored menu that cannot be clipped.
   ---------------------------------------------------------
   Every menu in chat opens from inside a scroll container:
   the bubble tools live in `.ch-scroll`, the conversation-row
   menu in `.chat-list`, the roster menu in `.ci-body`. All three
   are `overflow-y:auto`, and per CSS a non-visible value on one
   axis computes the other to `auto` too — so BOTH axes clip.
   An absolutely-positioned menu near the edge of any of them was
   getting sliced off, and near the bottom it also extended the
   scrollable area, which made the list jump.

   The fix is to take the menu out of the scroller entirely:
   render it in a portal on <body> with `position:fixed`, placed
   from the trigger's viewport rect. Fixed positioning ignores
   ancestor overflow, so nothing can crop it.

   It flips (below → above) when there isn't room, clamps to the
   viewport on both axes, and re-measures on scroll/resize so it
   stays glued to its trigger. Escape and outside-pointer close it.

   Caveat worth knowing: `position:fixed` resolves against the
   nearest ancestor with a transform/filter/perspective if one
   exists. The portal target is <body>, so there is none —
   which is precisely why this renders through a portal rather
   than in place.
   ========================================================= */
import React from 'react'
import { createPortal } from 'react-dom'

const MARGIN = 8        // gap between the trigger and the menu
const EDGE = 8          // keep this far from the viewport edge

/**
 * @param anchorRef  ref to the trigger element
 * @param align      'start' | 'end' | 'center' — how to line up with the trigger
 * @param prefer     'bottom' | 'top' — first choice, flipped when it doesn't fit
 */
export function Popover({
  anchorRef,
  open,
  onClose,
  children,
  className = '',
  role = 'menu',
  ariaLabel,
  align = 'start',
  prefer = 'bottom',
}) {
  const boxRef = React.useRef(null)
  const [pos, setPos] = React.useState(null)

  const place = React.useCallback(() => {
    const a = anchorRef?.current
    const box = boxRef.current
    if (!a) return
    const r = a.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    // Measure the menu if it is already mounted; fall back to a sane guess on
    // the very first frame, then correct on the next.
    const w = box?.offsetWidth || 200
    const h = box?.offsetHeight || 200

    const spaceBelow = vh - r.bottom - MARGIN
    const spaceAbove = r.top - MARGIN
    const below = prefer === 'bottom'
      ? (spaceBelow >= h || spaceBelow >= spaceAbove)
      : (spaceAbove < h && spaceBelow > spaceAbove)

    let top = below ? r.bottom + MARGIN : r.top - MARGIN - h
    top = Math.max(EDGE, Math.min(top, vh - h - EDGE))

    // `end` aligns the menu's end edge with the trigger's — the natural
    // direction for a menu hanging off a right-hand action button. `center`
    // is for a control that sits in a centred bar (the call controls), where
    // either edge alignment throws the menu off to one side of its button.
    let left = align === 'end' ? r.right - w
      : align === 'center' ? r.left + (r.width - w) / 2
        : r.left
    left = Math.max(EDGE, Math.min(left, vw - w - EDGE))

    setPos({ top, left })
  }, [anchorRef, align, prefer])

  // Place on open, then again after the box has real dimensions.
  React.useLayoutEffect(() => {
    if (!open) { setPos(null); return undefined }
    place()
    const raf = requestAnimationFrame(place)
    return () => cancelAnimationFrame(raf)
  }, [open, place])

  // Track the trigger while anything scrolls (capture catches inner scrollers).
  React.useEffect(() => {
    if (!open) return undefined
    let raf = 0
    const onMove = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(place)
    }
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open, place])

  // Dismiss on outside pointer or Escape. Pointerdown (not click) so the menu
  // closes before a click lands on whatever is underneath.
  React.useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (boxRef.current?.contains(e.target)) return
      if (anchorRef?.current?.contains(e.target)) return   // the trigger toggles itself
      onClose?.()
    }
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.() } }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, anchorRef])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={boxRef}
      className={'ch-pop ' + className}
      role={role}
      aria-label={ariaLabel}
      style={{
        position: 'fixed',
        top: pos ? `${pos.top}px` : '-9999px',
        left: pos ? `${pos.left}px` : '-9999px',
        // Hidden until measured so it never flashes at the wrong spot.
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  )
}

export default Popover
