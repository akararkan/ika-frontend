/* =========================================================
   Settings v2 — Safety Center: automatic checks, your reports
   & account standing.
   ContentModerationCard: the explainer for the automated
   moderation every text-bearing write goes through, and the
   honest account of what can be appealed and what cannot.
   SafetyReportsPanel: paged list of reports you filed, showing
   only the coarse outcome (the action taken on someone else's
   account is never disclosed) with a one-shot appeal from
   ACTIONED/DISMISSED. StrikesPanel: active strikes (each
   expires 90 days after issue) or a good-standing note.
   ========================================================= */
import React from 'react'
import { Link } from 'react-router-dom'
import { Icon, showToast } from '../ui.jsx'
import { uiConfirm } from '../Dialog.jsx'
import { EmptyState, ErrorState, Loader } from '../states.jsx'
import { ModerationBadge } from '../Moderation.jsx'
import { api, REPORT_REASONS, REPORT_OUTCOME_LABELS } from '../../api/index.js'
import { HOLD_CEILING_MS, ENTITY_LABEL } from '../../lib/moderation.js'
import { SetCard, SubHead, Skeleton, fmtWhen, fmtDate } from './shared.jsx'

const PAGE_SIZE = 15
const REASON_LABELS = Object.fromEntries(REPORT_REASONS)
const OUTCOME_CHIP = { UNDER_REVIEW: 'info', ACTION_TAKEN: 'ok', NO_ACTION: 'plain', APPEAL_UNDER_REVIEW: 'warn' }
const APPEALABLE_STATES = new Set(['ACTIONED', 'DISMISSED'])

/* ReportResponse gives back targetType + targetId, so a report can point at
   what it was about. Only the types that have a page of their own get a link
   (routes checked against App.jsx); COMMENT / ANSWER / MESSAGE / STORY have no
   standalone route, so they stay a plain word rather than a dead one. */
const TARGET_ROUTE = {
  POST: '/posts/', RESEARCH: '/research/', QUESTION: '/qna/',
  USER: '/u/', CHANNEL: '/channels/',
}

/* 'HATE_SPEECH' → 'Hate speech' for values outside the label maps. */
const humanise = (s) => !s ? '—' : String(s).toLowerCase().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())

/* Nothing in the stylesheet reaches a link inside .stx-sess-info b — the only
   rule that applies is the global `a{color:inherit;text-decoration:none}` — so
   without this the link reads as ordinary bold text. Underlined as well as
   coloured, because state must never be carried by colour alone. */
const TARGET_LINK = { color: 'var(--ox-blue-link)', textDecoration: 'underline' }

/** What a report was about — a link back to the item where one exists.
 *  Deleted targets still resolve to a route; the page's own not-found state
 *  handles that better than hiding the link would. */
function TargetRef({ row }) {
  const word = (row.targetType || '').toLowerCase() || 'item'
  const route = TARGET_ROUTE[row.targetType]
  if (!route || !row.targetId) return <>{word}</>
  /* The visible word is just "post" / "account"; the accessible name says what
     following it does, since a screen reader may read the link out of context. */
  return (
    <Link to={route + row.targetId} style={TARGET_LINK} aria-label={`Open the reported ${word}`}>
      {word}
    </Link>
  )
}

/* The kinds worth listing: the five a person actually writes into all day.
   Times come from HOLD_CEILING_MS and the nouns from ENTITY_LABEL (the same
   words the server puts in its notification bodies) so this table can never
   drift from the contract in lib/moderation.js — if a ceiling moves, it moves
   here too. */
const CEILING_ROWS = ['POST', 'POST_COMMENT', 'STORY', 'RESEARCH', 'CHAT_MESSAGE']

/**
 * What automatic moderation does, in the four outcomes a person can actually
 * experience — plus the one thing they came here to do, answered honestly.
 *
 * THE APPEAL GAP, stated here because this is the card most likely to be
 * "fixed" by adding a button: there is NO user-facing API for appealing a
 * moderation decision. The only appeal endpoint on the whole safety surface is
 * POST /api/v1/safety/reports/{id}/appeal, and it re-opens a REPORT THE USER
 * FILED about someone else — it takes a report id, which a moderation
 * notification could never supply (those rows carry no ids at all). There is no
 * /moderation/appeals, no case number and no support address anywhere in the
 * API. So this card links to the routes that do work and says plainly that an
 * automatic decision cannot be appealed from the app yet. Do not add a button
 * for it: it would 404, and a dead appeal button is crueller than an honest
 * sentence.
 */
function ContentModerationCard() {
  const sub = 'Everything you write — posts, comments, messages, stories, papers — is checked '
    + 'automatically before anyone else can see it. Almost all of it clears instantly and you '
    + 'never hear about the check at all.'
  return (
    <SetCard id="moderation" icon="shield" title="Content & moderation" sub={sub}>
      <div className="stx-row">
        <div>
          <b>It clears</b>
          <small>The ordinary case. Your post appears for everyone straight away and nothing is shown to you.</small>
        </div>
        <span className="stx-chip ok"><Icon name="check"/>Posted</span>
      </div>
      <div className="stx-row">
        <div>
          <b>It is being checked</b>
          <small>
            Held for a moment. You still see it wherever it normally appears; nobody else does,
            and it goes live for everyone the instant it clears.
          </small>
        </div>
        {/* A LEGEND, not live state: these three are the actual <ModerationBadge/>
            an author sees on their own held item, rendered here so the chip is
            recognised in the wild rather than re-drawn as a lookalike. Nothing on
            this card inspects any content — it cannot, and must not guess. */}
        <ModerationBadge state="checking"/>
      </div>
      <div className="stx-row">
        <div>
          <b>A moderator is reading it</b>
          <small>
            When the automatic check cannot decide in time, a person takes over. It stays visible
            to you alone until they finish, and you are told either way.
          </small>
        </div>
        <ModerationBadge state="review"/>
      </div>
      <div className="stx-row">
        <div>
          <b>It is refused</b>
          <small>
            Nothing was saved and nobody else ever saw it. Your text stays in the box so you can
            edit it, and the reason you were given at the time is the whole reason there is.
          </small>
        </div>
        <ModerationBadge state="removed"/>
      </div>

      <SubHead>How long a check can take</SubHead>
      <div className="stx-scroll">
        <table className="stx-table">
          <thead>
            <tr><th>What you wrote</th><th>Decided within</th></tr>
          </thead>
          <tbody>
            {CEILING_ROWS.map(kind => (
              <tr key={kind}>
                <td>{humanise(ENTITY_LABEL[kind])}</td>
                <td>{Math.round(HOLD_CEILING_MS[kind] / 1000)} seconds</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="stx-mnote">
        These are ceilings, not waits — most content clears in well under a second, and past the
        ceiling a person owns the decision instead. Not every surface can show you that a check is
        running: a held comment, message or answer looks completely normal to you while it waits.
        Nobody else sees it either way.
      </p>

      <div className="stx-note info">
        <Icon name="info"/>
        <span>
          <b>Followed an “Appeal” link here?</b> An automatic decision has no appeal form in the app
          yet. What does work: read the <Link to="/settings/about#policies">Community Guidelines</Link>,
          then write the thing again in your own words — and check{' '}
          <Link to="/settings/safety#strikes">Account standing</Link> below, where a confirmed
          violation would show up as a strike. The <b>Appeal</b> button in{' '}
          <Link to="/settings/safety#reports">Your reports</Link> re-opens a report you filed about
          someone else; it does not reach a check made on your own content.
        </span>
      </div>
    </SetCard>
  )
}

export function SafetyReportsPanel() {
  const [items, setItems] = React.useState(null)
  const [hasMore, setHasMore] = React.useState(false)
  const [error, setError] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [appealingId, setAppealingId] = React.useState(null)
  const pageRef = React.useRef(0)

  const loadFirst = React.useCallback(() => {
    setError(false); setItems(null)
    let alive = true
    api.settings.safety.myReports({ page: 0, size: PAGE_SIZE })
      .then(r => { if (alive) { pageRef.current = 0; setItems(r.items); setHasMore(r.hasMore) } })
      .catch(() => { if (alive) { setError(true); setItems([]) } })
    return () => { alive = false }
  }, [])
  React.useEffect(loadFirst, [loadFirst])

  const loadMore = () => {
    if (busy) return
    setBusy(true)
    const next = pageRef.current + 1
    api.settings.safety.myReports({ page: next, size: PAGE_SIZE })
      .then(r => { pageRef.current = next; setItems(cur => [...cur, ...r.items]); setHasMore(r.hasMore) })
      .catch(() => showToast('Could not load more reports', 'err'))
      .finally(() => setBusy(false))
  }

  const appeal = async (row) => {
    const ok = await uiConfirm({
      title: 'Appeal this decision?',
      message: 'A reviewer will take a fresh look at this report. Each decision can be appealed once.',
      confirmLabel: 'Submit appeal',
      icon: 'flag',
    })
    if (!ok) return
    setAppealingId(row.id)
    try {
      const updated = await api.settings.safety.appeal(row.id)
      setItems(cur => cur.map(r => r.id === row.id ? { ...r, ...updated } : r))
      showToast('Appeal submitted')
    } catch (e) {
      if (e?.code === 'REPORT_NOT_APPEALABLE' || e?.status === 409) {
        showToast('This report can no longer be appealed', 'warn')
        loadFirst()
      } else {
        showToast('Could not submit the appeal', 'err')
      }
    } finally {
      setAppealingId(null)
    }
  }

  const sub = 'Reports you have filed and their outcome. To protect everyone’s privacy, the specific action taken on someone else’s account is never disclosed.'

  /* The moderation explainer rides with this panel instead of being mounted on
     its own: SettingsPage builds the safety tab as exactly
     `<div className="set-stack"><SafetyReportsPanel/><StrikesPanel/></div>`,
     and .set-stack is a plain flex column — so a fragment drops the card into
     the stack ahead of "Your reports", which is the order the two read in
     (what the checks do → what you can actually do about a decision). It is
     also why the loading branch became a ternary rather than an early return:
     the card must not blink out while the report list is fetching. */
  return (
    <>
      <ContentModerationCard/>
      <SetCard id="reports" icon="flag" title="Your reports" sub={sub}>
        {items === null ? (
          <Skeleton rows={3}/>
        ) : error ? (
          <ErrorState message="Could not load your reports" onRetry={loadFirst}/>
        ) : items.length === 0 ? (
          <EmptyState icon="flag" title="No reports filed" sub="Reports you file about content or people appear here."/>
        ) : (
          <>
            {items.map(row => {
              const outcomeLabel = row.coarseOutcome ? (REPORT_OUTCOME_LABELS[row.coarseOutcome] || humanise(row.coarseOutcome)) : null
              return (
                <div key={row.id} className="stx-sess">
                  <div className="stx-sess-ic"><Icon name="flag"/></div>
                  <div className="stx-sess-info">
                    <b>{(REASON_LABELS[row.reason] || humanise(row.reason)) + ' · '}<TargetRef row={row}/></b>
                    <small>{fmtWhen(row.createdAt)}</small>
                  </div>
                  <div className="flex gap-8" style={{ alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {outcomeLabel && (
                      <span className={'stx-chip ' + (OUTCOME_CHIP[row.coarseOutcome] || 'plain')}>{outcomeLabel}</span>
                    )}
                    {APPEALABLE_STATES.has(row.state) && (
                      <button type="button" className="btn btn-secondary btn-sm"
                        disabled={appealingId === row.id}
                        onClick={() => appeal(row)}>
                        {appealingId === row.id ? 'Appealing…' : 'Appeal'}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
            {hasMore && (
              <div className="set-actions" style={{ marginTop: 12 }}>
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={loadMore}>
                  {busy ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </SetCard>
    </>
  )
}

export function StrikesPanel() {
  const [rows, setRows] = React.useState(null)
  const [error, setError] = React.useState(false)

  const load = React.useCallback(() => {
    setError(false); setRows(null)
    let alive = true
    api.settings.safety.strikes()
      .then(list => { if (alive) setRows(list || []) })
      .catch(() => { if (alive) { setError(true); setRows([]) } })
    return () => { alive = false }
  }, [])
  React.useEffect(load, [load])

  const sub = 'Strikes are issued for confirmed violations of the community guidelines. Each strike expires 90 days after it is issued; repeated strikes can limit what your account can do.'

  if (rows === null) {
    return (
      <SetCard id="strikes" icon="alert" title="Account standing" sub={sub}>
        <Loader/>
      </SetCard>
    )
  }
  return (
    <SetCard id="strikes" icon="alert" title="Account standing" sub={sub}>
      {error ? (
        <ErrorState message="Could not load your account standing" onRetry={load}/>
      ) : rows.length === 0 ? (
        <div className="stx-note ok">
          <Icon name="check"/>
          <span>No active strikes — your account is in good standing.</span>
        </div>
      ) : (
        <>
          <div className="stx-note warn">
            <Icon name="alert"/>
            <span>
              {rows.length === 1
                ? 'You have 1 active strike on your account.'
                : `You have ${rows.length} active strikes on your account.`}
              {' '}Each one expires 90 days after it was issued.
            </span>
          </div>
          {rows.map(row => (
            <div key={row.id} className="stx-sess">
              <div className="stx-sess-ic"><Icon name="alert"/></div>
              <div className="stx-sess-info">
                <b>{REASON_LABELS[row.reason] || humanise(row.reason)}</b>
                <small>{'issued ' + fmtDate(row.issuedAt) + ' · expires ' + fmtDate(row.expiresAt)}</small>
              </div>
            </div>
          ))}
        </>
      )}
    </SetCard>
  )
}
