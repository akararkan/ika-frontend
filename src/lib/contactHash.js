/* =========================================================
   contactHash — the client half of contact matching
   ---------------------------------------------------------
   The server NEVER sees an address book. It stores only
   SHA-256 hashes, and matching is a hash join against other
   users' identity hashes — so the hashing contract is not an
   implementation detail, it IS the interoperability surface:
   a normalisation that differs by one space or one uppercase
   letter produces a hash that can never match anything, and
   the failure is silent (zero suggestions, no error).

   The contract, verbatim from the API doc:

     email → sha256(lowercase(trim(email)))      hex
     phone → sha256(E.164 digits, no '+')        hex

   Two consequences worth stating:

   · `crypto.subtle` is only available in a SECURE CONTEXT
     (https, or localhost). On plain http over a LAN it is
     undefined — so this module reports that as a real,
     nameable error rather than uploading nothing and letting
     the user believe their contacts synced.
   · Nothing here ever keeps the raw values. The caller hands
     over strings, gets hashes back, and the originals are
     garbage the moment the call returns.
   ========================================================= */

/** Max hashes the server accepts in one sync (documented). */
export const MAX_HASHES_PER_SYNC = 5000

export class InsecureContextError extends Error {
  constructor() {
    super('Contact hashing needs a secure context (https or localhost).')
    this.name = 'InsecureContextError'
  }
}

const subtle = () => (typeof crypto !== 'undefined' ? crypto.subtle : undefined)

/** true when hashing is possible here — gate the UI on this, not on a try/catch. */
export function canHashContacts() {
  return !!subtle()
}

async function sha256Hex(input) {
  const api = subtle()
  if (!api) throw new InsecureContextError()
  const bytes = new TextEncoder().encode(input)
  const digest = await api.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** `  Amina@Example.COM ` → `amina@example.com`, or '' when it isn't an email. */
export function normalizeEmail(raw) {
  const v = String(raw || '').trim().toLowerCase()
  // Deliberately permissive — the server does the real matching. This only
  // rejects entries that are obviously not addresses, so they don't burn
  // slots against the 5000 cap.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : ''
}

/** `+964 (750) 123-4567` → `9647501234567`, or '' when too short to be a number.
 *  E.164 digits, no '+' — punctuation, spaces and the leading plus all go. */
export function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D+/g, '')
  return digits.length >= 7 ? digits : ''
}

/**
 * Hash a mixed list of address-book entries.
 *
 * Each entry may be a string (sniffed as email-or-phone) or
 * `{ email, phone }` — a single contact card contributes BOTH hashes, which is
 * what makes a person matchable by either identity.
 *
 * @returns {Promise<{hashes: string[], skipped: number, emails: number, phones: number}>}
 *          `hashes` is deduped and capped at MAX_HASHES_PER_SYNC.
 */
export async function hashContacts(entries = []) {
  if (!canHashContacts()) throw new InsecureContextError()

  const values = []          // [kind, normalised]
  let skipped = 0
  for (const entry of entries) {
    if (!entry) { skipped++; continue }
    const candidates = typeof entry === 'string'
      ? [entry.includes('@') ? ['email', entry] : ['phone', entry]]
      : [['email', entry.email], ['phone', entry.phone]]
    let took = 0
    for (const [kind, raw] of candidates) {
      if (!raw) continue
      const v = kind === 'email' ? normalizeEmail(raw) : normalizePhone(raw)
      if (v) { values.push([kind, v]); took++ }
    }
    if (!took) skipped++
  }

  // Dedupe BEFORE hashing: an address book repeats the same address across
  // cards constantly, and each duplicate would otherwise cost a digest and a
  // slot against the cap.
  const seen = new Set()
  const unique = values.filter(([kind, v]) => {
    const key = kind + ':' + v
    if (seen.has(key)) return false
    seen.add(key); return true
  })

  const capped = unique.slice(0, MAX_HASHES_PER_SYNC)
  const hashes = await Promise.all(capped.map(([, v]) => sha256Hex(v)))

  return {
    hashes,
    skipped: skipped + (unique.length - capped.length),
    emails: capped.filter(([k]) => k === 'email').length,
    phones: capped.filter(([k]) => k === 'phone').length,
  }
}

/**
 * Parse a pasted / imported contact blob into entries `hashContacts` accepts.
 * Handles the two formats a person can actually produce without tooling:
 * one-per-line text, and a vCard export (`.vcf`, the format every phone and
 * mail client exports) — from which only EMAIL/TEL lines are read and
 * everything else (names, addresses, photos) is ignored outright.
 */
export function parseContactBlob(text) {
  const src = String(text || '')
  if (/BEGIN:VCARD/i.test(src)) {
    const out = []
    for (const line of src.split(/\r?\n/)) {
      const m = /^(EMAIL|TEL)[^:]*:(.+)$/i.exec(line.trim())
      if (!m) continue
      out.push(m[1].toUpperCase() === 'EMAIL' ? { email: m[2] } : { phone: m[2] })
    }
    return out
  }
  return src.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean)
}
