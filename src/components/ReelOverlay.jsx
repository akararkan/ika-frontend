/* =========================================================
   The overlay layer — what the author put ON the reel.

   Drawn live over the clip rather than baked into it, so a
   moving sticker actually moves. Three rules keep it honest:

   1. IT SITS ON THE MEDIA, not the card. The rect is recomputed
      from the element's real size and the media's intrinsics
      (see mediaRect), on resize and on loadedmetadata, so the
      same overlay lands identically on a 9:16 desktop plate and
      a 9:19.5 phone, `cover` or `contain`.
   2. IT MOVES WITH PLAYBACK. Animations are paused whenever the
      reel is — `--rov-play` — so nothing bounces over a frozen
      frame, and they restart when the clip loops.
   3. IT IS NOT IN THE WAY. `pointer-events:none` throughout:
      tap-to-pause, double-tap-to-like and the vertical swipe all
      belong to the clip underneath. It is aria-hidden too — the
      words are announced once, in the caption region, instead of
      being interleaved with the author row.
   ========================================================= */
import React from 'react'
import { ALIGNS, COLORS, FONTS, mediaRect } from '../lib/reelOverlay.js'

/** Track the box the overlay is drawn into. */
function useBox(ref) {
  const [box, setBox] = React.useState({ width: 0, height: 0 })
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      const r = el.getBoundingClientRect()
      setBox(b => (Math.abs(b.width - r.width) < .5 && Math.abs(b.height - r.height) < .5 ? b : { width: r.width, height: r.height }))
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    window.addEventListener('orientationchange', read)
    return () => { ro.disconnect(); window.removeEventListener('orientationchange', read) }
  }, [ref])
  return box
}

/**
 * @param doc      parsed overlay ({fit, items})
 * @param media    {w, h} the media's intrinsic size (0 until known)
 * @param playing  false → every motion holds still
 * @param drift    true on a photo reel, whose image is slowly panning: the
 *                 layer takes the SAME animation so the two never separate
 */
export function ReelOverlay({ doc, media, playing = true, drift = false }) {
  const hostRef = React.useRef(null)
  const box = useBox(hostRef)
  if (!doc?.items?.length) return <div ref={hostRef} className="rv-ov" aria-hidden="true"/>

  const rect = mediaRect(box, media?.w, media?.h, doc.fit)

  return (
    <div ref={hostRef} className={'rv-ov' + (drift ? ' is-drift' : '')} aria-hidden="true"
      style={{ '--rov-play': playing ? 'running' : 'paused' }}>
      <div className="rv-ov-fit" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
        {doc.items.map((it, i) => {
          const font = FONTS[it.f] || FONTS[0]
          const size = rect.width * it.s
          /* Every value here is a clamped number or a table lookup — nothing
             from the document is ever concatenated into a style string. */
          const style = {
            left: `${it.x * 100}%`,
            top: `${it.y * 100}%`,
            transform: `translate(-50%,-50%) rotate(${it.r}deg)`,
            fontSize: `${size}px`,
            color: COLORS[it.c] || COLORS[0],
            fontFamily: it.k === 't' ? font.css : undefined,
            fontWeight: it.k === 't' ? font.weight : undefined,
            textAlign: ALIGNS[it.a] || 'center',
          }
          const cls = 'rv-ov-item' + (it.k === 't' ? ' is-text' : ' is-glyph') + (it.bg ? ' has-bg' : '')
          return <span key={i} className={cls} data-m={it.m || undefined} style={style} dir="auto">{it.text}</span>
        })}
      </div>
    </div>
  )
}
