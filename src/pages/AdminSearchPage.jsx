/* =========================================================
   Admin — search-index maintenance
   POST /api/v1/admin/search/{corpus}/reindex   (ROLE_ADMIN)
   (SEARCH: indexing-and-reindex.md — mirrored in src/api/admin.js)
   ---------------------------------------------------------
   An operator page, so it is written to be HONEST rather than
   reassuring. Three facts shape every decision below:

   1. A reindex is SYNCHRONOUS. The counts in the response are
      the only receipt that the walk finished, and they arrive
      on the request this page is holding open — which is why a
      run gets a live elapsed clock, why the tab is guarded on
      unload, and why nothing here pretends to be a background
      job with a progress bar it cannot actually observe.
   2. `drop=true` (the default, and the mode that actually
      repairs anything) DELETES the index first. For the length
      of the walk that corpus is missing from search. The
      confirm says exactly that, in those words.
   3. The endpoint is ROLE_ADMIN-only. The route gate lives
      outside this page, so the one failure that gets bespoke
      copy is 401/403: it is about WHO is signed in, never
      about the corpus or the cluster.

   Every other failure keeps the server's own message — the
   person reading it is debugging Elasticsearch and wants the
   real text, not a euphemism.

   There is deliberately no chat-messages corpus; the page says
   so out loud at the bottom rather than leaving a gap someone
   files a bug about.
   ========================================================= */
import React from 'react'
import { Icon, showToast } from '../components/ui.jsx'
import { Loader, EmptyState } from '../components/states.jsx'
import { uiConfirm } from '../components/Dialog.jsx'
import { api, REINDEX_CORPORA } from '../api/index.js'

/* One glyph per corpus so a row is identifiable before it is read.
   Falls back to `doc` — a corpus added to REINDEX_CORPORA must still render. */
const CORPUS_ICON = {
  posts: 'feed', questions: 'qna', answers: 'comment', research: 'research',
  users: 'users', channels: 'broadcast', sounds: 'music',
}

/* Exact counts, never abbreviated. `fmt()` from ui.jsx would turn 12,431 into
   "12.4k", and the entire point of the response is that the operator can
   compare it against what the canonical store is known to hold. */
const count = (n) => Number(n || 0).toLocaleString()

/** ms → the coarsest unit that still reads precisely. A real corpus walk is
 *  measured in minutes; "184032 ms" is a number nobody can parse at a glance. */
function fmtMs(ms) {
  const n = Math.max(0, Math.round(Number(ms) || 0))
  if (n < 1000) return `${n} ms`
  const secs = n / 1000
  if (secs < 60) return `${secs.toFixed(secs < 10 ? 2 : 1)} s`
  const total = Math.round(secs)
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60
  const pad = (v) => String(v).padStart(2, '0')
  return h ? `${h}h ${pad(m)}m ${pad(s)}s` : `${m}m ${pad(s)}s`
}

/** Wall-clock for a run still in flight — ticks once a second, so seconds
 *  precision only (fmtMs's 2-decimal form would jitter for no information). */
function fmtElapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

const DENIED_COPY = 'This account is not a platform administrator — the reindex endpoints are ROLE_ADMIN only.'

/* ApiError carries `.status` / `.code` / `.message` (see src/api/http.js).
   401 and 403 are one situation to the reader: the signed-in account cannot
   do this. Note 401 reaches us only AFTER the http layer's refresh-and-retry
   has already failed, so it is never a merely-expired token. */
const isDenied = (e) => e?.status === 401 || e?.status === 403
const errorCopy = (e) => (isDenied(e) ? DENIED_COPY : (e?.message || e?.code || 'The reindex failed.'))

/* ---------------------------------------------------------
   One corpus row: what it walks, what it costs, and the run.
   Split out so the result panel can sit BETWEEN rows as a
   sibling — nesting it inside a wrapper would make every
   .rail-row a :first-child and silently drop the separators.
   --------------------------------------------------------- */
function CorpusRow({ row, run, now, onRun }) {
  const running = run?.phase === 'running'
  const res = run?.phase === 'done' ? run.result : null
  const err = run?.phase === 'error' ? run.error : null

  return (
    <>
      <div className="rail-row">
        <span className="pa-ic"><Icon name={CORPUS_ICON[row.key] || 'doc'} className="xs"/></span>
        <div className="rail-info">
          <div className="rail-name">
            <b>{row.label}</b>
            <span className="muted text-xs" style={{ fontWeight: 400 }}>{row.key}</span>
            {running && <span className="pill dot" style={{ color: 'var(--brass)' }}>Running {fmtElapsed(now - run.startedAt)}</span>}
            {res && <span className="pill dot" style={{ color: 'var(--emerald)' }}>Done</span>}
            {err && <span className="pill dot" style={{ color: 'var(--danger)' }}>Failed</span>}
          </div>
          <div className="rail-sub">{row.store} · {row.note}</div>
        </div>
        {/* Disabled for the length of the walk: the run is one long request, and
            a second one for the same corpus would fight the first over the same
            index. Other corpora stay clickable — those are independent walks. */}
        <button type="button" className={'btn btn-sm ' + (running ? 'btn-secondary' : 'btn-primary')}
          disabled={running} onClick={() => onRun(row)}>
          <Icon name="refresh" className="xs"/>{running ? 'Reindexing…' : 'Reindex'}
        </button>
      </div>

      {run && (
        <div className="text-sm" aria-live="polite"
          style={{ paddingInlineStart: 41, paddingBottom: 12, marginTop: -2 }}>
          {running && (
            <p className="muted">
              Walking {row.store} — {fmtElapsed(now - run.startedAt)} elapsed.{' '}
              {run.drop
                ? <b style={{ color: 'var(--danger)' }}>This corpus is missing from search until it finishes.</b>
                : 'Search stays available; document values are refreshed in place.'}
            </p>
          )}

          {res && (
            <>
              <div className="flex gap-16" style={{ flexWrap: 'wrap' }}>
                <span><b>{count(res.documentsIndexed)}</b> <span className="muted">documents</span></span>
                <span><b>{count(res.pages)}</b> <span className="muted">pages</span></span>
                <span><b>{fmtMs(res.durationMs)}</b> <span className="muted">on the server</span></span>
                <span className="muted">{res.indexDropped ? 'Index dropped and recreated from the mapping' : 'Mapping untouched'}</span>
              </div>
              {/* Per-page failures are logged and SKIPPED server-side — a partial
                  reindex beats zero — so a low or empty count is the only signal
                  the caller ever gets that something went wrong mid-walk. */}
              {res.documentsIndexed === 0 && (
                <p className="text-xs" style={{ color: 'var(--danger)', marginTop: 4 }}>
                  Nothing was indexed. Either the store holds no eligible rows, or every page failed and was skipped — check the server log before trusting search on this corpus.
                </p>
              )}
              {run.drop && !res.indexDropped && (
                <p className="text-xs" style={{ color: 'var(--danger)', marginTop: 4 }}>
                  A drop was requested but the server reports the index was not dropped — the mapping was NOT recreated, so a mapping repair did not happen.
                </p>
              )}
              {res.note && <p className="muted text-xs" style={{ marginTop: 4 }}>{res.note}</p>}
            </>
          )}

          {err && (
            <>
              <p style={{ color: 'var(--danger)' }}>{errorCopy(err)}</p>
              {/* Raw status + code stay visible even for the friendly 403 copy:
                  this reader is the one person who wants them. */}
              <p className="muted text-xs" style={{ marginTop: 2 }}>
                {err?.status ? `HTTP ${err.status}` : 'No response'}{err?.code ? ` · ${err.code}` : ''}
              </p>
            </>
          )}
        </div>
      )}
    </>
  )
}

export function AdminSearchPage() {
  /* drop defaults to TRUE — it matches the API default and it is the only mode
     that lands new fields or repairs a mapping. The value is captured into the
     run record at click time, so toggling it mid-run never relabels a run that
     is already in flight. */
  const [drop, setDrop] = React.useState(true)
  const [runs, setRuns] = React.useState({})            // corpus key → { phase, drop, startedAt, result?, error? }
  const [, setTick] = React.useState(0)                 // drives the live elapsed clocks

  /* The overlap guard is a REF, not the runs state: the confirm dialog is
     awaited, so two fast clicks can both pass the state check before either
     re-render lands. The ref is written synchronously and is the real lock. */
  const inFlight = React.useRef(new Set())

  const anyRunning = Object.values(runs).some(r => r.phase === 'running')
  const denied = Object.values(runs).some(r => r.phase === 'error' && isDenied(r.error))
  const runningCount = Object.values(runs).filter(r => r.phase === 'running').length
  const now = Date.now()

  // Only tick while something is actually running — no idle re-render loop.
  React.useEffect(() => {
    if (!anyRunning) return undefined
    const t = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [anyRunning])

  /* Closing the tab does not stop the server, but it DOES throw away the
     response — and the counts are the only confirmation the walk completed.
     Worse, on a drop-run the operator would leave not knowing whether the
     index was ever refilled. So: ask before leaving. */
  React.useEffect(() => {
    if (!anyRunning) return undefined
    const warn = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [anyRunning])

  const start = async (row) => {
    if (inFlight.current.has(row.key)) return
    const dropping = drop
    if (dropping) {
      const ok = await uiConfirm({
        title: `Drop and rebuild “${row.label}”?`,
        message: `The ${row.key} index is deleted first, so ${row.label.toLowerCase()} will be MISSING from search until the walk finishes. ${row.note} The run is synchronous — keep this tab open until it reports back.`,
        confirmLabel: 'Drop and rebuild',
        danger: true,
        icon: 'trash',
      })
      if (!ok) return
      if (inFlight.current.has(row.key)) return          // someone started it while the dialog was open
    }

    inFlight.current.add(row.key)
    const startedAt = Date.now()
    setRuns(r => ({ ...r, [row.key]: { phase: 'running', drop: dropping, startedAt } }))
    try {
      const result = await api.admin.reindex(row.key, { drop: dropping })
      setRuns(r => ({ ...r, [row.key]: { phase: 'done', drop: dropping, startedAt, result } }))
      showToast(`${row.label}: ${count(result.documentsIndexed)} documents indexed`)
    } catch (e) {
      setRuns(r => ({ ...r, [row.key]: { phase: 'error', drop: dropping, startedAt, error: e } }))
      showToast(isDenied(e) ? 'Not a platform administrator' : `${row.label}: reindex failed`)
    } finally {
      inFlight.current.delete(row.key)
    }
  }

  return (
    <div className="main center">
      <div className="col-main">
        <div className="phead">
          <div>
            <h1>Search index <span className="phead-ar" lang="ar" dir="rtl">فهرسة البحث</span></h1>
            <p className="sub">Rebuild a search corpus from its canonical store. Administrators only — every run is synchronous and can take a long time.</p>
          </div>
        </div>

        {/* The unmistakable "you are not an admin" state. It replaces nothing —
            the rows stay usable, because the fix may be signing in elsewhere
            and retrying — but it is impossible to miss. */}
        {denied && (
          <div className="card card-pad" style={{ borderColor: 'var(--danger)', marginBottom: 16 }}>
            <h3 className="title" style={{ color: 'var(--danger)' }}><Icon name="lock" className="sm"/>Not a platform administrator</h3>
            <p className="text-sm">
              The server refused with <b>401/403</b>. These endpoints require <b>ROLE_ADMIN</b>; nothing on this page will run for the account currently signed in.
            </p>
            <p className="muted text-sm" style={{ marginTop: 6 }}>
              Sign in with an administrator account and run it again. No index was touched.
            </p>
          </div>
        )}

        {anyRunning && (
          <div style={{ marginBottom: 16 }}>
            <Loader label={`Reindexing ${runningCount} ${runningCount === 1 ? 'corpus' : 'corpora'} — keep this tab open`}/>
          </div>
        )}

        {/* ---------- the drop control ---------- */}
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <h3 className="title"><Icon name="settings" className="sm"/>Rebuild mode</h3>
          <div className="set-toggle">
            <div>
              <b>Drop and recreate the index</b>
              <small className="muted">
                <b>drop = true</b> — deletes the index, then explicitly recreates it from the entity mapping before re-emitting every document. This is the mode that lands new fields.
              </small>
            </div>
            <button type="button" className={'sw ' + (drop ? 'on' : '')} aria-pressed={drop}
              aria-label="Drop and recreate the index" onClick={() => setDrop(v => !v)}/>
          </div>
          <p className="muted text-sm" style={{ marginTop: 4 }}>
            <b>drop = false</b> — refreshes document values in place without touching the mapping. Search keeps working throughout; a broken mapping stays broken.
          </p>

          {drop ? (
            <p className="text-sm" style={{ marginTop: 12, padding: '10px 12px', borderRadius: 8, background: 'var(--card-2)', borderInlineStart: '3px solid var(--danger)', color: 'var(--ink-2)' }}>
              While a drop-reindex runs, <b>that corpus is missing from search entirely</b> — the index is deleted before the first document is written back. Nothing else is at risk: every index is a rebuildable projection of Postgres or Cassandra, and the canonical rows are never touched.
            </p>
          ) : (
            <p className="text-sm" style={{ marginTop: 12, padding: '10px 12px', borderRadius: 8, background: 'var(--card-2)', borderInlineStart: '3px solid var(--line)', color: 'var(--ink-2)' }}>
              Values only. Use this to catch an index up after a bad deploy or a dropped event — not to fix a field that is typed wrong.
            </p>
          )}

          {/* The reason drop=true exists at all — worth stating where the toggle
              is, because the symptom (a filter that silently stops filtering)
              never looks like an indexing problem from the outside. */}
          <p className="muted text-xs" style={{ marginTop: 12 }}>
            <b>The dynamic-mapping trap:</b> an index auto-created by its first document write maps every string as <b>text</b>, including the lifecycle keywords <b>visibility</b>, <b>status</b> and <b>postType</b>. An exact <b>term</b> filter never matches analysed text, so privacy and status filters quietly stop filtering instead of failing. If a filter is mysteriously letting everything through, check <b>GET {'{index}'}/_mapping</b> for keyword fields typed <b>text</b>, then reindex that corpus with drop = true.
          </p>
        </div>

        {/* ---------- the seven corpora ---------- */}
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <h3 className="title"><Icon name="search" className="sm"/>Corpora</h3>
          <p className="muted text-sm" style={{ marginBottom: 14 }}>
            Each row walks its canonical store and re-emits every eligible document. Runs of <i>different</i> corpora can overlap; a corpus already running is locked until it reports back. Pages that fail are logged and skipped server-side — a partial reindex beats none.
          </p>
          {REINDEX_CORPORA.length ? (
            <div className="rail-list">
              {REINDEX_CORPORA.map(row => (
                <CorpusRow key={row.key} row={row} run={runs[row.key]} now={now} onRun={start}/>
              ))}
            </div>
          ) : (
            <EmptyState icon="search" title="No corpora defined" sub="REINDEX_CORPORA is empty — nothing on this build can be reindexed."/>
          )}
        </div>

        {/* ---------- the deliberate omission ---------- */}
        <div className="card card-pad">
          <h3 className="title"><Icon name="chat" className="sm"/>Chat messages are not here — on purpose</h3>
          <p className="muted text-sm">
            There is deliberately <b>no chat-messages reindex</b>. That store is partitioned per conversation, so there is no efficient full scan to walk — and none is needed: the message index self-heals per message on send, edit and delete. An absent corpus here is the design, not a missing feature.
          </p>
        </div>
      </div>
    </div>
  )
}
