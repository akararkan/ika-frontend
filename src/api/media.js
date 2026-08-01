/* =========================================================
   Media pipeline — /api/v1/media (settings module §20)
   upload-intent → client PUTs bytes STRAIGHT to storage →
   complete → poll status until READY / FAILED_*.

   Wire truths:
   - `X-Media-Tier` header carries the user's tier; any garbage
     resolves to HIGH server-side, so we just pass it through.
   - sha256 is optional but enables dedup: a hit answers with
     presignedPutUrl:null + status READY — nothing to upload.
   - The presigned PUT binds the Content-Type to the intent's
     mime, and it is a FOREIGN origin: never send the app's
     Authorization header there (hence the bare XHR below).
   - complete/delete answer 202 with empty bodies.
   ========================================================= */
import { http } from './http.js'

export const MEDIA_STATUS_FAILED = new Set(['FAILED_VALIDATION', 'FAILED_MODERATION', 'FAILED_PROCESSING'])

export const media = {
  /* ---- primitives ---- */
  uploadIntent({ mime, sizeBytes, sha256, type = 'IMAGE' }, tier) {
    return http.post('/api/v1/media/upload-intent',
      { mime, sizeBytes, sha256: sha256 || undefined, type },
      { headers: tier ? { 'X-Media-Tier': tier } : {} })
  },
  complete(id) { return http.post(`/api/v1/media/${id}/complete`) },     // 202
  status(id) { return http.get(`/api/v1/media/${id}`) },                 // {mediaId,type,status,width,height,durationMs,blurhash,storedBytes,errorMessage,renditions[]}
  remove(id) { return http.del(`/api/v1/media/${id}`) },                 // 202; hard delete, second call 404

  /** SHA-256 hex of a File/Blob via WebCrypto. Returns null when the digest
   *  isn't available (non-secure context) — the hash is optional anyway. */
  async sha256Of(file) {
    try {
      if (!crypto?.subtle?.digest) return null
      const buf = await file.arrayBuffer()
      const hash = await crypto.subtle.digest('SHA-256', buf)
      return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('')
    } catch { return null }
  },

  /** The whole pipeline in one call.
   *  upload(file, { type, tier, onProgress, signal }) → final MediaStatusResponse.
   *  onProgress(fraction 0..1) covers the byte transfer only; after that the
   *  poll loop runs until READY or a FAILED_* status (which rejects with an
   *  Error carrying .status = the failed state). */
  async upload(file, { type = 'IMAGE', tier, onProgress, signal, pollMs = 1200, maxPolls = 150 } = {}) {
    const sha256 = await media.sha256Of(file)
    const intent = await media.uploadIntent({ mime: file.type || 'application/octet-stream', sizeBytes: file.size, sha256, type }, tier)

    if (!intent.deduped) {
      await putBytes(intent.presignedPutUrl, file, onProgress, signal)
      await media.complete(intent.mediaId)
    } else onProgress?.(1)

    /* Poll until the worker settles. Deduped assets are READY immediately. */
    let last = null
    for (let i = 0; i < maxPolls; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      last = await media.status(intent.mediaId)
      if (last.status === 'READY') return last
      if (MEDIA_STATUS_FAILED.has(last.status)) {
        const err = new Error(last.errorMessage || `Upload failed (${last.status})`)
        err.status = last.status
        throw err
      }
      await new Promise(r => setTimeout(r, pollMs))
    }
    const err = new Error('Timed out waiting for media processing')
    err.status = last?.status || 'TIMEOUT'
    throw err
  },
}

/* Raw PUT to the presigned URL. XHR (not fetch) purely for upload progress
   events; no credentials, no app headers — the URL itself is the auth. */
function putBytes(url, file, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    if (onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total) }
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error(`Storage PUT failed (${xhr.status})`))
    xhr.onerror = () => reject(new Error('Storage PUT failed (network)'))
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'))
    if (signal) {
      if (signal.aborted) { xhr.abort(); return }
      signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }
    xhr.send(file)
  })
}
