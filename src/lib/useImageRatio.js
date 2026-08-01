/* =========================================================
   useImageRatio — the picture's own proportions, so a cover
   plate can take the SHAPE of what was uploaded instead of
   cropping it into a fixed strip.

   Why JS at all: covers are painted as `background-image` (a
   deliberate choice — the plate layers the photo OVER the
   derived gradient so a failed load degrades to the channel's
   own art rather than a bare box), and CSS cannot read the
   intrinsic size of a background. So the image is decoded once,
   off-DOM, and its ratio handed back for `aspect-ratio`.

   Returns null until it is known — the stylesheet keeps its
   banner-shaped default until then, so nothing jumps for the
   ordinary wide cover.
   ========================================================= */
import React from 'react'

export function useImageRatio(url) {
  const [ratio, setRatio] = React.useState(null)

  React.useEffect(() => {
    setRatio(null)
    if (!url) return
    let alive = true
    const img = new Image()
    img.onload = () => {
      if (!alive) return
      const { naturalWidth: w, naturalHeight: h } = img
      if (w > 0 && h > 0) setRatio(w / h)
    }
    img.src = url                       // cached: the plate is painting the same URL
    return () => { alive = false; img.onload = null }
  }, [url])

  return ratio
}

/* The style object a cover plate needs: the image itself plus its shape.
   `--cover-ar` is simply absent until the decode lands, and the stylesheet's
   own fallback covers that frame. */
export function coverStyle(url, ratio, extra) {
  if (!url) return extra
  return {
    '--cover': `url("${encodeURI(url)}")`,
    ...(ratio ? { '--cover-ar': String(ratio) } : null),
    ...extra,
  }
}
