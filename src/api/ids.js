/* =========================================================
   Snowflake ids — exact decimal strings, never numbers
   ---------------------------------------------------------
   Conversations are UUIDs; MESSAGES are Snowflake longs, ~18
   digits (355456387759665152 today). That is far past
   Number.MAX_SAFE_INTEGER, so a message id can never live in a
   JS number: the double rounds, and `String(n)` then prints a
   DIFFERENT integer, which every /messages/{id}/… endpoint
   answers with a 404.

   So ids stay strings — http.js keeps them exact at parse time —
   and everything that used to be `a.id - b.id`, `>=` or
   `Math.max` goes through the comparators here. They compare
   numerically (shorter number = smaller, then lexicographic),
   which is exact for arbitrarily long digit strings.

   Optimistic (unsent) messages get a `t<seq>` id: unmistakably
   not a Snowflake, and sorted last by `cmpId` because a pending
   bubble is always the newest thing in the thread.
   ========================================================= */

/** DTO long → exact decimal string. Empty/absent → null.
 *  `0` is the backend's "nothing yet" for lastRead/lastDelivered/lastMessage —
 *  never a real Snowflake — so it folds to null and stays falsy, the way the
 *  numeric adapter it replaced behaved. */
export function mid(v) {
  if (v === null || v === undefined || v === '') return null
  const s = String(v).trim()
  if (!/^-?\d+$/.test(s)) return null
  return /^-?0+$/.test(s) ? null : s
}

let TMP_SEQ = 0
/** A local-only id for an optimistic bubble (never sent to the server). */
export const newTmpId = () => `t${++TMP_SEQ}`

/** Is this a local optimistic id rather than a server Snowflake? */
export const isTmpId = (id) => typeof id === 'string' && id.charCodeAt(0) === 116 /* 't' */

/**
 * Order two ids. Temp ids sort AFTER every real id (and among themselves by
 * creation order); real ids compare as unbounded decimal integers.
 * Null/undefined sort first, so a missing marker is "nothing read yet".
 */
export function cmpId(a, b) {
  if (a === b) return 0
  const at = isTmpId(a), bt = isTmpId(b)
  if (at || bt) {
    if (at && bt) return Number(a.slice(1)) - Number(b.slice(1))
    return at ? 1 : -1
  }
  if (a === null || a === undefined || a === '') return (b === null || b === undefined || b === '') ? 0 : -1
  if (b === null || b === undefined || b === '') return 1
  const x = String(a), y = String(b)
  if (x.length !== y.length) return x.length < y.length ? -1 : 1
  return x < y ? -1 : x > y ? 1 : 0
}

/** The later of two ids (either may be null). */
export const maxId = (a, b) => (cmpId(a, b) >= 0 ? a : b)

/** a >= b, for high-water marks (read/delivered receipts). */
export const gteId = (a, b) => cmpId(a, b) >= 0

/** a > b. */
export const gtId = (a, b) => cmpId(a, b) > 0
