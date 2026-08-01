/* =========================================================
   Admin — search index maintenance
   POST /api/v1/admin/search/{corpus}/reindex   (ROLE_ADMIN)
   (SEARCH: indexing-and-reindex.md)
   ---------------------------------------------------------
   Every ES index is a REBUILDABLE PROJECTION — the canonical store
   is always Postgres or Cassandra — so a reindex is a repair tool,
   not a migration. Runs are SYNCHRONOUS: the response carries the
   final counts, which is the whole point (the caller learns it
   finished). Per-page failures are logged and skipped server-side:
   a partial reindex beats zero.

   `drop=true` (the default) deletes the index and EXPLICITLY
   recreates it from the entity mapping before re-emitting. That is
   the repair for the dynamic-mapping trap: an index auto-created by
   its first document write maps every string as `text`, including
   the lifecycle keywords (`visibility`, `status`, `postType`) — and
   an exact `term` filter silently never matches analysed text, so
   the privacy and status filters quietly stop filtering. If a term
   filter is mysteriously not filtering, check `GET {index}/_mapping`
   for keyword fields typed `text`, then reindex that corpus with
   drop=true. `drop=false` refreshes values without touching mapping.

   There is deliberately NO chat-messages corpus: that store is
   partitioned per conversation (no efficient full scan) and the
   index self-heals per message on send/edit/delete.
   ========================================================= */
import { http } from './http.js'

/** The seven rebuildable corpora, with what each walk actually costs — the
 *  operator is about to block on it, so the UI can say so. */
export const REINDEX_CORPORA = [
  { key: 'posts',     label: 'Posts & reels', store: 'Cassandra posts_by_id', note: 'Driver-paged walk; nothing held in memory.' },
  { key: 'questions', label: 'Questions',     store: 'Postgres questions',    note: 'Live questions, 100 per page.' },
  { key: 'answers',   label: 'Answers',       store: 'Postgres answers',      note: 'Live answers including reanswers, 100 per page.' },
  { key: 'research',  label: 'Research',      store: 'Postgres researches',   note: 'PUBLISHED only, 100 per page.' },
  { key: 'users',     label: 'People',        store: 'Postgres users',        note: 'Active accounts; recomputes followerCount per user.' },
  { key: 'channels',  label: 'Channels',      store: 'Postgres conversations', note: 'Live PUBLIC channels only, 100 per page.' },
  { key: 'sounds',    label: 'Sounds',        store: 'Cassandra sounds_by_id', note: 'Full library walk plus counter reads.' },
]

const CORPUS_KEYS = REINDEX_CORPORA.map(c => c.key)

export const admin = {
  REINDEX_CORPORA,

  /** Rebuild one corpus. Synchronous by design — await the counts. */
  async reindex(corpus, { drop = true } = {}) {
    if (!CORPUS_KEYS.includes(corpus)) throw new Error(`Unknown corpus "${corpus}"`)
    const res = await http.post(`/api/v1/admin/search/${corpus}/reindex?drop=${drop ? 'true' : 'false'}`, {})
    return {
      corpus,
      indexDropped: !!res?.indexDropped,
      documentsIndexed: res?.documentsIndexed ?? 0,
      pages: res?.pages ?? 0,
      durationMs: res?.durationMs ?? 0,
      note: res?.note || '',
    }
  },
}
