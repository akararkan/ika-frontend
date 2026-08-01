/* =========================================================
   Knowledge taxonomy — /api/v1/topics + /api/v1/madhhabs
   (TAXONOMY_API §1-2)
   ---------------------------------------------------------
   Two fixed, trilingual reference vocabularies (English /
   Arabic / Central Kurdish):

     · topics    → the specializations a scholar shows on their
                   profile        (PATCH …/profile/specializations)
     · madhhabs  → the single school a user selects
                   (`madhhabId` on PATCH …/me/profile)

   Both reads are PUBLIC — no token, usable during onboarding,
   same policy as /tags/* reads.

   There is deliberately NO write API: the rows are operator-
   managed reference data, maintained directly in Postgres. So
   this module only ever reads, and because the ids are stable
   Integers the whole vocabulary is cached for the session (the
   doc explicitly blesses this) — a picker then filters without
   touching the network at all.

   Trilingual matching mirrors the server: a case-insensitive
   CONTAINS across all three name columns, so `fiqh`, `الفقه`
   and the Kurdish spelling resolve the same row. Unicode is
   matched as-is — the platform never transliterates (the same
   rule the tag subsystem lives by).
   ========================================================= */
import { http } from './http.js'

/* ---------- shape ---------- */

/** Topic / Madhhab row → view row keeping ALL THREE names.
 *  `TopicDto` (as embedded in a profile) says `topicId`; the vocabulary
 *  endpoints say `id`. One row shape covers both so a specialization and a
 *  picker entry are the same thing to the UI. */
export function taxonomyRowFrom(dto) {
  if (!dto) return null
  const id = dto.id ?? dto.topicId ?? dto.madhhabId ?? null
  if (id === null || id === undefined) return null
  return {
    id: Number(id),
    nameEn: dto.nameEn || dto.topicName || dto.madhhabName || dto.name || '',
    nameAr: dto.nameAr || '',
    nameCkb: dto.nameCkb || '',
  }
}

/* The app stores a content language as EN | AR | KU; the vocabulary column for
   Central Kurdish is `nameCkb`. Anything unknown reads as English. */
const NAME_KEY = { EN: 'nameEn', AR: 'nameAr', KU: 'nameCkb', CKB: 'nameCkb', KRD: 'nameCkb' }

/** The display name for a UI language, falling back through the other two —
 *  a vocabulary row with a gap in one column still renders as a word rather
 *  than an empty chip. */
export function taxonomyName(row, lang) {
  if (!row) return ''
  const key = NAME_KEY[String(lang || 'EN').toUpperCase()] || 'nameEn'
  return row[key] || row.nameEn || row.nameAr || row.nameCkb || row.name || ''
}

/** Direction for one row's rendered name — Arabic and Kurdish are RTL. Chips
 *  carry dir="auto" anyway; this is for the cases auto cannot see (an empty
 *  name, a name that starts with a digit). */
export function taxonomyDir(row, lang) {
  const key = NAME_KEY[String(lang || 'EN').toUpperCase()] || 'nameEn'
  if (key === 'nameEn') return 'ltr'
  return row?.[key] ? 'rtl' : 'ltr'
}

/** The server's match rule, mirrored: case-insensitive contains across all
 *  three name columns. Blank query → everything (the picker case). */
export function taxonomyFilter(rows, q) {
  const needle = String(q || '').trim().toLowerCase()
  if (!needle) return rows || []
  return (rows || []).filter(r =>
    (r.nameEn || '').toLowerCase().includes(needle)
    || (r.nameAr || '').toLowerCase().includes(needle)
    || (r.nameCkb || '').toLowerCase().includes(needle))
}

/* ---------- the two endpoints ---------- */

/* Session cache, one in-flight promise per vocabulary: every picker mount
   would otherwise re-read a table that cannot change without a deploy. A
   FAILED read is dropped from the cache so the next mount retries. */
const full = { topics: null, madhhabs: null }

function vocabulary(kind, path) {
  const list = async ({ q } = {}) => {
    const rows = await http.get(path, { q: q || undefined })
    return (rows || []).map(taxonomyRowFrom).filter(Boolean)
  }

  return {
    /** The endpoint, verbatim: blank `q` → the full vocabulary, non-blank →
     *  the server's trilingual contains match. Bypasses the cache. */
    list,

    /** The full vocabulary, read once per session. */
    all() {
      if (!full[kind]) {
        full[kind] = list().catch(err => { full[kind] = null; throw err })
      }
      return full[kind]
    },

    /** What a picker calls. Warm cache → filtered in memory by the same rule
     *  the server uses (no round-trip per keystroke). Cold cache → the
     *  documented `?q=` search answers now, while the full list warms up
     *  behind it for the next keystroke. */
    async search(q) {
      const term = String(q || '').trim()
      if (full[kind]) return taxonomyFilter(await full[kind], term)
      // A blank query IS the full vocabulary — take the cacheable read, not an
      // identical uncached one.
      if (!term) return this.all()
      const rows = await list({ q: term })
      this.all().catch(() => {})
      return rows
    },

    /** One row by id — for rendering a stored `madhhabId` / `topicId` in the
     *  reader's own language (the profile response carries only the English
     *  name, and the doc points here for the other two). */
    async byId(id) {
      if (id === null || id === undefined || id === '') return null
      const rows = await this.all()
      return rows.find(r => r.id === Number(id)) || null
    },

    /** Drop the cached vocabulary — for a manual "refresh the list" after an
     *  operator adds rows, without a page reload. */
    forget() { full[kind] = null },
  }
}

export const topics = vocabulary('topics', '/api/v1/topics')
export const madhhabs = vocabulary('madhhabs', '/api/v1/madhhabs')

/** Profile specializations → the PATCH body (TAXONOMY_API §3.1).
 *  Replace-all semantics: this is the COMPLETE new list, position IS the
 *  displayOrder, and `[]` clears. Accepts ids or row objects. */
export function specializationsTo(list) {
  return (list || [])
    .map(s => (typeof s === 'object' ? (s.topicId ?? s.id) : s))
    .filter(id => id !== null && id !== undefined && id !== '')
    .map(Number)
    .filter(id => Number.isInteger(id))
    .filter((id, i, arr) => arr.indexOf(id) === i)      // a topic cannot be listed twice
    .map((topicId, i) => ({ topicId, displayOrder: i }))
}
