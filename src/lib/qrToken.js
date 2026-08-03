/* =========================================================
   qrToken — reading an IKA profile code back out of whatever
   the user pasted, and building the payload we actually paint.
   ---------------------------------------------------------
   The backend mints ONE thing, an opaque rotatable token
   (QrDtos.QrTokenResponse.opaqueToken, 32 URL-safe base64
   chars), and offers a convenience `uri` of `irc://u/<token>`.
   That scheme is unopenable here: IKA is a web app, no
   protocol handler is registered, and a phone camera scanning
   an irc:// code just shows an inert string. So the SCANNED
   payload is an https link to this app's own /qr/:opaque
   route, and irc:// is kept only as a secondary "app link"
   for a native client that may register the scheme later.

   Inbound, a code can arrive in any of four shapes — a
   forwarded https link, the irc:// URI, a path fragment, or
   the bare token someone typed off a printed card — so one
   parser accepts them all rather than each entry point
   guessing.
   ========================================================= */

/* URL-safe base64. The server mints 32 chars today; the range is loose so a
   length change on the backend does not silently reject every code. */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/

/** Pull the opaque token out of `irc://u/<t>`, `https://host/qr/<t>`,
 *  `/qr/<t>`, or a bare `<t>`. Returns null when it is not a code. */
export function extractQrToken(input) {
  const s = String(input ?? '').trim()
  if (!s) return null
  /* Drop query/hash noise — chat apps and scanners love appending trackers. */
  const clean = s.split(/[?#\s]/)[0].replace(/\/+$/, '')
  const m = /(?:^irc:\/\/u\/|\/qr\/)([A-Za-z0-9_-]+)$/i.exec(clean)
  const token = m ? m[1] : clean
  return TOKEN_RE.test(token) ? token : null
}

/** The scannable payload for a token: an https link into /qr/:opaque on this
 *  origin, which every camera app can open. */
export function qrWebLink(token) {
  if (!token) return null
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  return `${origin}/qr/${token}`
}
