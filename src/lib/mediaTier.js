/* =========================================================
   Upload quality — the client half of MediaSettings.uploadQuality.
   ---------------------------------------------------------
   The backend's MediaTier is explicit that this is "a hint that
   saves the user's bandwidth — the client may pre-compress to
   it". Until now nothing did: the tier reached only the settings
   Upload-check demo, so a person who chose "Data saver" uploaded
   the untouched original everywhere — avatars, covers, chat
   attachments, research figures. This module is what makes the
   setting real.

   What it does NOT do:
   - It never upscales. A 900 px photo at the HIGH cap stays 900 px.
   - It leaves GIF and SVG alone (re-encoding an animation to a
     still is worse than sending the original) and never touches
     video: browser-side transcode is a different order of cost,
     and the server owns the 1080 px hard cap anyway.
   - It fails OPEN. Any decode/encode error returns the original
     file — a compression helper must never be the reason an
     upload cannot happen.
   ========================================================= */
import { api } from '../api/index.js'
import { PREFS_EVENT } from './prefs.js'

/** Long-edge caps, mirroring MediaTier.imageLongEdge() on the server. */
export const TIER_EDGE = { DATA_SAVER: 1080, STANDARD: 1440, HIGH: 1920 }
const DEFAULT_TIER = 'HIGH'
const CACHE_KEY = 'ika_media_tier'
const JPEG_QUALITY = 0.82        // matches media.image.jpeg-quality server-side

/* Re-encoding these is a downgrade, not a saving. */
const SKIP_MIME = /^image\/(gif|svg\+xml|avif|heic|heif)$/i

let cached = null
let inflight = null

function readCache() {
  if (cached) return cached
  try {
    const v = localStorage.getItem(CACHE_KEY)
    if (v && TIER_EDGE[v]) { cached = v; return v }
  } catch { /* private mode */ }
  return null
}

function writeCache(tier) {
  cached = tier
  try { localStorage.setItem(CACHE_KEY, tier) } catch { /* ignore */ }
}

/* A cosmetic write anywhere in Settings dispatches PREFS_EVENT; the tier may
   have been one of them, so drop the memo and re-read on next use. */
if (typeof window !== 'undefined') {
  window.addEventListener(PREFS_EVENT, () => { cached = null; inflight = null })
}

/** The user's chosen tier. Resolves from cache when possible so an upload
 *  never waits on a settings round trip; falls back to HIGH (the server's own
 *  fallback for a missing/garbage header). */
export async function getTier() {
  const memo = readCache()
  if (memo) return memo
  if (!inflight) {
    inflight = api.settings.section('media')
      .then(b => {
        const t = b?.uploadQuality
        const tier = TIER_EDGE[t] ? t : DEFAULT_TIER
        writeCache(tier)
        return tier
      })
      .catch(() => DEFAULT_TIER)
      .finally(() => { inflight = null })
  }
  return inflight
}

/** Synchronous best guess, for call sites that cannot await (render paths). */
export function getTierSync() { return readCache() || DEFAULT_TIER }

function canvasToFile(canvas, file) {
  return new Promise((resolve) => {
    if (!canvas.toBlob) { resolve(file); return }
    canvas.toBlob((blob) => {
      if (!blob || blob.size >= file.size) { resolve(file); return }   // no saving → keep the original
      const name = file.name ? file.name.replace(/\.[^.]+$/, '') + '.jpg' : 'upload.jpg'
      resolve(new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified || Date.now() }))
    }, 'image/jpeg', JPEG_QUALITY)
  })
}

/** Downscale an image File to the tier's long-edge cap. Returns the ORIGINAL
 *  file whenever compressing would not help or is not possible. */
export async function compressToTier(file, tier) {
  if (!file || !file.type || !file.type.startsWith('image/') || SKIP_MIME.test(file.type)) return file
  const cap = TIER_EDGE[tier] || TIER_EDGE[DEFAULT_TIER]
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file

  let bmp
  try {
    // imageOrientation:'from-image' bakes the EXIF rotation into the pixels,
    // so the re-encode cannot silently un-rotate a phone photo.
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return file
  }
  try {
    const long = Math.max(bmp.width, bmp.height)
    if (!long || long <= cap) return file                    // never upscale
    const scale = cap / long
    const w = Math.max(1, Math.round(bmp.width * scale))
    const h = Math.max(1, Math.round(bmp.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, 0, 0, w, h)
    return await canvasToFile(canvas, file)
  } catch {
    return file
  } finally {
    bmp.close?.()
  }
}

/** The one call an upload path needs: resolve the tier and pre-compress. */
export async function prepareUpload(file) {
  try { return await compressToTier(file, await getTier()) }
  catch { return file }
}

/** Same, for a list of files (chat attachments, research figures). */
export async function prepareUploads(files) {
  const tier = await getTier()
  return Promise.all(Array.from(files || []).map(f => compressToTier(f, tier).catch(() => f)))
}
