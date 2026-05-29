/* =========================================================
   Small helpers for rendering users without any mock data.
   ========================================================= */
import { adapters } from '../api/index.js'

const FALLBACK = {
  full: 'Member', handle: 'member', initials: '··',
  avc: 'linear-gradient(135deg,#159a76,#0a4a3c)', verified: false, role: 'MEMBER', profileImage: null,
}

/** Resolve the author object attached to an entity by the adapters. */
export function authorOf(entity) {
  if (!entity) return FALLBACK
  return entity._author || entity._user || (entity.full ? entity : null) || FALLBACK
}

/** Build an author object from an AuthorSummary-ish payload. */
export function asAuthor(a) {
  return adapters.authorFrom(a)
}
