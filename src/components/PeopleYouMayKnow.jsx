/* =========================================================
   People You May Know
   ---------------------------------------------------------
   The friend-suggestion engine's front end. One data hook,
   three presentations, because the same suggestion has to
   appear in three places at three sizes:

     <PymkCarousel/>  the Facebook card strip — big portrait
                      photo, name, reason, a full-width primary
                      action and a quiet Remove. Injected into
                      the feed.
     <PymkRail/>      the right-column list — 60px plate, name,
                      reason, inline actions.
     <PymkGrid/>      the /people page — the same cards, wrapped
                      instead of scrolled.

   What the engine gives us that a plain "who to follow" list
   cannot, and what the UI therefore owes it:

   · `reason` is the top ≤3 contributing signals, already
     joined ("4 mutual follows · in your contacts · same
     institution"). It is the single most important line on the
     card — a suggestion without a why reads as spam — so it is
     never truncated away in favour of the handle.
   · Dismiss is PERMANENT negative feedback (it writes a
     dismissal row and excludes the person from every future
     recompute), not a "hide for now". So the card removes
     itself optimistically, and an undo is offered for the one
     tap that matters, rather than a confirm dialog on a
     lightweight action.
   · Following someone does NOT remove them client-side. The
     server drops them on the next recompute (already-followed
     filter), and yanking the card out from under the tap that
     just followed loses the person before the user can look at
     them. The button flips to Following instead.
   ========================================================= */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, Avatar, Verify, fmt, showToast } from './ui.jsx'
import { pymkDue, markPymkShown } from '../lib/pymkTimer.js'
import { api } from '../api/index.js'

/* ---------------------------------------------------------
   Data
   --------------------------------------------------------- */

/**
 * Load "people you may know", newest computation first.
 *
 * The detailed endpoint is canonical (hydrated identity + reason). It can be
 * legitimately EMPTY — a cold graph with no contacts, no DMs and no groups
 * produces nothing above the engine's 2.0 threshold — so this falls back to
 * the who-to-follow surface, which is exactly what that surface exists for.
 * The fallback rows carry no `reason`, and the card says so honestly
 * ("Popular on IKA") rather than inventing a mutual count.
 */
export function usePeopleSuggestions({ limit = 12, enabled = true } = {}) {
  const [people, setPeople] = React.useState(null)   // null = loading
  const [error, setError] = React.useState(false)

  const load = React.useCallback(() => {
    // `enabled: false` is the timed-out in-feed strip. It must not fetch —
    // the whole point of the cooldown is that a feed which isn't going to show
    // suggestions doesn't pay for them either.
    if (!enabled) { setPeople([]); return undefined }
    let alive = true
    api.posts.suggestionsDetailed({ limit })
      .then(async rows => {
        if (!alive) return
        if (rows.length) { setPeople(rows); return }
        // Cold graph → the popular/verified fallback, mapped to the same shape.
        const fallback = await api.users.whoToFollow({ limit }).catch(() => [])
        if (!alive) return
        setPeople((fallback || []).map(u => ({
          ...u,
          candidateId: u.id,
          reason: u.reason || '',
          reasons: u.reason ? [u.reason] : [],
          score: 0,
          _fallback: true,
        })))
      })
      .catch(() => { if (alive) { setError(true); setPeople([]) } })
    return () => { alive = false }
  }, [limit, enabled])

  React.useEffect(() => load(), [load])

  /* Follow / unfollow. The row is NOT removed on follow (see the header): the
     server's already-followed filter drops it on the next recompute. */
  const toggleFollow = React.useCallback((id) => {
    let next = null
    setPeople(ps => (ps || []).map(p => {
      if (p.candidateId !== id) return p
      next = !p.isFollowing
      return { ...p, isFollowing: next, _busy: true }
    }))
    if (next === null) return
    const req = next ? api.users.follow(id) : api.users.unfollow(id)
    req
      .catch(() => {
        setPeople(ps => (ps || []).map(p => p.candidateId === id ? { ...p, isFollowing: !next } : p))
        showToast('Could not update following')
      })
      .finally(() => setPeople(ps => (ps || []).map(p => p.candidateId === id ? { ...p, _busy: false } : p)))
  }, [])

  /* Dismiss — permanent. Optimistic removal with an undo that re-inserts the
     row AT ITS ORIGINAL INDEX; appending would silently re-rank the list and
     make the undo look like it did something else. There is no un-dismiss
     endpoint, so undo restores the card locally and a recompute would need to
     re-derive it — which is honest, because the dismissal row is already
     written. Hence the toast wording: it says it is undone here, not there. */
  const dismiss = React.useCallback((id) => {
    let removed = null
    let at = -1
    setPeople(ps => {
      const list = ps || []
      at = list.findIndex(p => p.candidateId === id)
      removed = at >= 0 ? list[at] : null
      return list.filter(p => p.candidateId !== id)
    })
    api.posts.dismissSuggestion(id).catch(() => {
      // Put it back — the dismissal never landed, so the card is still true.
      if (removed) setPeople(ps => { const l = [...(ps || [])]; l.splice(Math.max(0, at), 0, removed); return l })
    })
  }, [])

  return { people, error, loading: people === null, toggleFollow, dismiss, reload: load }
}

/* ---------------------------------------------------------
   Pieces
   --------------------------------------------------------- */

/** The why-line. Falls back to something true rather than to nothing: a card
 *  with a blank second line reads as a rendering bug. */
function ReasonLine({ person, className = 'pymk-why' }) {
  const text = person.reason
    || (person.mutual > 0 ? `${fmt(person.mutual)} mutual ${person.mutual === 1 ? 'connection' : 'connections'}` : '')
    || (person._fallback ? 'Popular on IKA' : `@${person.handle}`)
  return <span className={className} title={text}>{text}</span>
}

/** One Facebook-style card: portrait photo plate, name, why, actions. */
function PymkCard({ person, onFollow, onDismiss, navigate }) {
  const open = () => navigate(`/u/${person.candidateId}`)
  return (
    <article className="pymk-card">
      <button className="pymk-x" aria-label={`Remove ${person.full} from suggestions`}
        onClick={(e) => { e.stopPropagation(); onDismiss(person.candidateId) }}>
        <Icon name="close" className="xs"/>
      </button>

      {/* The photo plate is a square, like Facebook's — a suggestion is a
          person to look at, so the avatar gets the space, not the chrome. */}
      <button className="pymk-photo" onClick={open} aria-label={`View ${person.full}'s profile`}>
        {person.profileImage
          ? <img src={person.profileImage} alt="" loading="lazy"/>
          : <span className="pymk-photo-fb" style={{ background: person.avc }}>{person.initials}</span>}
      </button>

      <div className="pymk-body">
        <button className="pymk-name" onClick={open}>
          <b>{person.full}</b>
          {person.verified && <Verify scholar={person.role === 'SCHOLAR'}/>}
        </button>
        <ReasonLine person={person}/>
      </div>

      <div className="pymk-acts">
        <button
          className={'pymk-btn ' + (person.isFollowing ? 'is-done' : 'is-primary')}
          disabled={person._busy}
          onClick={() => onFollow(person.candidateId)}
        >
          <Icon name={person.isFollowing ? 'followed' : 'follow'} className="xs"/>
          {person.isFollowing ? 'Following' : 'Follow'}
        </button>
        <button className="pymk-btn" onClick={() => onDismiss(person.candidateId)}>Remove</button>
      </div>
    </article>
  )
}

/* ---------------------------------------------------------
   Surfaces
   --------------------------------------------------------- */

/** The feed's horizontal card strip. Renders NOTHING while loading and
 *  nothing when empty — it is an interruption in a timeline, and an empty
 *  interruption is worse than no interruption.
 *
 *  It is also ON A CLOCK (lib/pymkTimer.js): at most one appearance per
 *  cooldown, so the feed is mostly just the feed. Pass `timed={false}` for a
 *  surface where the strip is the point rather than an interruption. */
export function PymkCarousel({ limit = 12, title = 'People you may know', onSeeAll, timed = true }) {
  const navigate = useNavigate()
  /* Decided ONCE, at mount, and frozen for this mount's lifetime — re-reading
     the clock on every render could make the strip vanish under the reader's
     thumb the moment the window closed. */
  const [due] = React.useState(() => (timed ? pymkDue() : true))
  const [hidden, setHidden] = React.useState(false)
  const { people, loading, toggleFollow, dismiss } = usePeopleSuggestions({ limit, enabled: due })
  const stripRef = React.useRef(null)

  const scrollBy = (dir) => {
    const el = stripRef.current
    if (el) el.scrollBy({ left: dir * Math.max(240, el.clientWidth * 0.8), behavior: 'smooth' })
  }

  const shown = due && !hidden && !loading && !!people?.length

  /* The clock starts when the strip is REALLY on screen — not when the feed
     decided to try. A page where the engine returned nobody must not burn the
     window, or an empty moment would cost hours of suggestions. */
  React.useEffect(() => { if (shown && timed) markPymkShown() }, [shown, timed])

  const hideForNow = () => {
    setHidden(true)
    if (timed) markPymkShown()      // "not now" and "seen it" are the same state
  }

  if (!shown) return null
  return (
    <section className="pymk rise" aria-label={title}>
      <header className="pymk-head">
        <h3>{title}</h3>
        <button className="pymk-all" onClick={onSeeAll || (() => navigate('/people'))}>See all</button>
        {timed && (
          <button className="pymk-hide" aria-label="Hide suggestions for now" title="Hide for now" onClick={hideForNow}>
            <Icon name="close" className="xs"/>
          </button>
        )}
      </header>
      <div className="pymk-strip-wrap">
        <button className="pymk-nav prev" aria-label="Scroll back" onClick={() => scrollBy(-1)}><Icon name="chevleft" className="sm"/></button>
        <div className="pymk-strip" ref={stripRef}>
          {people.map(p => (
            <PymkCard key={p.candidateId} person={p} onFollow={toggleFollow} onDismiss={dismiss} navigate={navigate}/>
          ))}
        </div>
        <button className="pymk-nav next" aria-label="Scroll forward" onClick={() => scrollBy(1)}><Icon name="chevright" className="sm"/></button>
      </div>
    </section>
  )
}

/** The right-column list. Compact rows — the reason still gets its own line,
 *  because it is the whole difference between this and a random user list. */
export function PymkRail({ limit = 5, title = 'People you may know' }) {
  const navigate = useNavigate()
  const { people, loading, toggleFollow, dismiss } = usePeopleSuggestions({ limit })
  if (loading || !people?.length) return null
  return (
    <div className="card card-pad">
      <h3 className="title"><Icon name="users" className="sm"/> {title}</h3>
      <div className="pymk-rail t-stagger">
        {people.map(p => (
          <div key={p.candidateId} className="pymk-row">
            <button className="pymk-row-plate" onClick={() => navigate(`/u/${p.candidateId}`)} aria-label={p.full}>
              <Avatar initials={p.initials} color={p.avc} size={56} src={p.profileImage}/>
            </button>
            <div className="pymk-row-body">
              <button className="pymk-name" onClick={() => navigate(`/u/${p.candidateId}`)}>
                <b>{p.full}</b>
                {p.verified && <Verify scholar={p.role === 'SCHOLAR'}/>}
              </button>
              <ReasonLine person={p} className="pymk-why"/>
              <div className="pymk-row-acts">
                <button className={'pymk-btn ' + (p.isFollowing ? 'is-done' : 'is-primary')}
                  disabled={p._busy} onClick={() => toggleFollow(p.candidateId)}>
                  <Icon name={p.isFollowing ? 'followed' : 'follow'} className="xs"/>
                  {p.isFollowing ? 'Following' : 'Follow'}
                </button>
                <button className="pymk-btn" onClick={() => dismiss(p.candidateId)}>Remove</button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <button className="btn btn-secondary btn-sm btn-block mt-12" onClick={() => navigate('/people')}>See all</button>
    </div>
  )
}

/** The /people page grid — same cards, wrapped. Unlike the carousel this one
 *  DOES render its empty and loading states: it is the whole page, and a blank
 *  screen would leave the reader wondering whether it broke. */
export function PymkGrid({ limit = 40 }) {
  const navigate = useNavigate()
  const { people, loading, error, toggleFollow, dismiss, reload } = usePeopleSuggestions({ limit })

  if (loading) return <div className="pymk-grid">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="pymk-card is-skeleton"/>)}</div>
  if (error) return <p className="muted">Couldn’t load suggestions. <button className="pymk-all" onClick={reload}>Try again</button></p>
  if (!people.length) {
    return (
      <div className="pymk-empty">
        <Icon name="users" className="lg"/>
        <b>No suggestions yet</b>
        <p className="muted">Follow a few people, join a group, or sync your contacts — suggestions are built from the connections you already have.</p>
      </div>
    )
  }
  return (
    <div className="pymk-grid">
      {people.map(p => (
        <PymkCard key={p.candidateId} person={p} onFollow={toggleFollow} onDismiss={dismiss} navigate={navigate}/>
      ))}
    </div>
  )
}

export default PymkCarousel
