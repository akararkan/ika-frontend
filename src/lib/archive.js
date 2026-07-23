/* =========================================================
   Client-side archiving — dependency-free ZIP and TAR.GZ.

   NOTE ON RAR: .rar cannot be produced here (or in any browser).
   RAR is a proprietary, patent-encumbered format with no open
   encoder — only extraction is freely implementable. ZIP is the
   universal equivalent; TAR.GZ is offered for unix-y workflows.

   Compression uses the platform CompressionStream when available
   (deflate-raw for ZIP, gzip for TAR); otherwise ZIP falls back to
   STORE and TAR is emitted uncompressed. Both stay valid archives.
   ========================================================= */

const enc = new TextEncoder()

/* ---------- CRC-32 (ZIP requires it per entry) ---------- */
let CRC_TABLE = null
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[i] = c >>> 0
  }
  return (CRC_TABLE = t)
}
function crc32(buf) {
  const t = crcTable()
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

async function compress(bytes, format) {
  if (typeof CompressionStream === 'undefined') return null
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream(format))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch { return null }
}

function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear())
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((Math.floor(d.getSeconds() / 2)) & 31)
  const date = (((year - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31)
  return { time, date }
}

/** Make an entry name safe: drop control chars, replace path separators and
 *  filesystem-illegal characters with '-'. Done per-character rather than with
 *  a regex so no accidental ranges can eat legitimate characters (a bad class
 *  here once stripped the '.' out of "report.pdf"). */
const ILLEGAL_NAME_CHARS = '/\\<>:"|?*'
export function safeEntryName(name, fallback = 'file') {
  let out = ''
  for (const ch of String(name || '')) {
    const code = ch.codePointAt(0)
    if (code < 0x20 || code === 0x7f) continue                 // control characters
    out += ILLEGAL_NAME_CHARS.includes(ch) ? '-' : ch
  }
  while (out.includes('--')) out = out.replace('--', '-')
  const clean = out.trim()
  return clean || fallback
}

/** De-duplicate entry names in place: "a.pdf", "a (2).pdf", … */
export function uniqueNames(names) {
  const seen = new Map()
  return names.map(n => {
    const count = seen.get(n) || 0
    seen.set(n, count + 1)
    if (!count) return n
    const dot = n.lastIndexOf('.')
    return dot > 0 ? `${n.slice(0, dot)} (${count + 1})${n.slice(dot)}` : `${n} (${count + 1})`
  })
}

/**
 * Build a ZIP.
 * @param {{name:string, bytes:Uint8Array}[]} files
 * @returns {Promise<Blob>} application/zip
 */
export async function makeZip(files, when = new Date()) {
  const { time, date } = dosDateTime(when)
  const local = []      // local headers + names + bodies, in order
  const central = []    // central-directory records
  let offset = 0

  for (const f of files) {
    const nameBytes = enc.encode(f.name)
    const raw = f.bytes
    const crc = crc32(raw)

    // try DEFLATE; keep STORE when it doesn't actually help
    let method = 0
    let body = raw
    const deflated = await compress(raw, 'deflate-raw')
    if (deflated && deflated.length < raw.length) { method = 8; body = deflated }

    const localOffset = offset   // capture BEFORE writing this entry

    const lfh = new DataView(new ArrayBuffer(30))
    lfh.setUint32(0, 0x04034b50, true)
    lfh.setUint16(4, 20, true)        // version needed
    lfh.setUint16(6, 0x0800, true)    // flag bit 11 → UTF-8 filenames
    lfh.setUint16(8, method, true)
    lfh.setUint16(10, time, true)
    lfh.setUint16(12, date, true)
    lfh.setUint32(14, crc, true)
    lfh.setUint32(18, body.length, true)
    lfh.setUint32(22, raw.length, true)
    lfh.setUint16(26, nameBytes.length, true)
    lfh.setUint16(28, 0, true)
    local.push(new Uint8Array(lfh.buffer), nameBytes, body)

    const cdh = new DataView(new ArrayBuffer(46))
    cdh.setUint32(0, 0x02014b50, true)
    cdh.setUint16(4, 20, true)        // version made by
    cdh.setUint16(6, 20, true)        // version needed
    cdh.setUint16(8, 0x0800, true)
    cdh.setUint16(10, method, true)
    cdh.setUint16(12, time, true)
    cdh.setUint16(14, date, true)
    cdh.setUint32(16, crc, true)
    cdh.setUint32(20, body.length, true)
    cdh.setUint32(24, raw.length, true)
    cdh.setUint16(28, nameBytes.length, true)
    cdh.setUint16(30, 0, true)        // extra length
    cdh.setUint16(32, 0, true)        // comment length
    cdh.setUint16(34, 0, true)        // disk number start
    cdh.setUint16(36, 0, true)        // internal attrs
    cdh.setUint32(38, 0, true)        // external attrs
    cdh.setUint32(42, localOffset, true)
    central.push(new Uint8Array(cdh.buffer), nameBytes)

    offset += 30 + nameBytes.length + body.length
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0)
  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054b50, true)
  eocd.setUint16(4, 0, true)
  eocd.setUint16(6, 0, true)
  eocd.setUint16(8, files.length, true)
  eocd.setUint16(10, files.length, true)
  eocd.setUint32(12, cdSize, true)
  eocd.setUint32(16, offset, true)
  eocd.setUint16(20, 0, true)

  return new Blob([...local, ...central, new Uint8Array(eocd.buffer)], { type: 'application/zip' })
}

/* ---------- TAR (ustar) ---------- */
function tarHeader(name, size, when) {
  const h = new Uint8Array(512)
  const put = (str, off, len) => h.set(enc.encode(String(str)).subarray(0, len), off)
  const octal = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0'

  put(name.slice(0, 99), 0, 100)
  put('0000644\0', 100, 8)                                   // mode
  put('0000000\0', 108, 8)                                   // uid
  put('0000000\0', 116, 8)                                   // gid
  put(octal(size, 12), 124, 12)
  put(octal(Math.floor(when.getTime() / 1000), 12), 136, 12) // mtime
  put('        ', 148, 8)                                    // checksum field = spaces while summing
  put('0', 156, 1)                                           // typeflag: regular file
  put('ustar\0', 257, 6)
  put('00', 263, 2)

  let sum = 0
  for (let i = 0; i < 512; i++) sum += h[i]
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return h
}

/**
 * Build a TAR, gzipped when the platform supports it.
 * @returns {Promise<{blob:Blob, ext:string}>} ext is 'tar.gz' or 'tar'
 */
export async function makeTarGz(files, when = new Date()) {
  const parts = []
  for (const f of files) {
    parts.push(tarHeader(f.name, f.bytes.length, when), f.bytes)
    const pad = (512 - (f.bytes.length % 512)) % 512
    if (pad) parts.push(new Uint8Array(pad))
  }
  parts.push(new Uint8Array(1024))   // two zero blocks terminate the archive

  const tar = new Blob(parts, { type: 'application/x-tar' })
  const gz = await compress(new Uint8Array(await tar.arrayBuffer()), 'gzip')
  return gz
    ? { blob: new Blob([gz], { type: 'application/gzip' }), ext: 'tar.gz' }
    : { blob: tar, ext: 'tar' }
}

/** Trigger a browser download for a Blob. */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 8000)
}
