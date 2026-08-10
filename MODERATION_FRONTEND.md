# Moderation — frontend module guide

The client's half of the automated text-moderation contract. Backend design lives
in `~/Desktop/irc/docs/moderation/`; this file is what a person editing **this**
repo needs, and where it disagrees with the backend docs, this file is right —
every claim below was checked against the Java source or the running API, and the
published docs are wrong in several places (§6).

---

## 1. The shape of the thing

Every text-bearing create/edit is scored before anyone but its author can see it.
Three outcomes:

| Outcome | Wire | What the UI must do |
|---|---|---|
| **Clean** | ordinary 2xx | nothing — this is ~everything |
| **Blocked** | `400 CONTENT_REJECTED`, nothing persisted | show the server message verbatim, **keep the draft**, no retry button |
| **Held** | usually a normal 2xx, entity hidden from everyone but its author | badge it, suppress engagement, re-check until it clears |

Plus one variant: four surfaces answer a *hold* with `400 CONTENT_UNDER_REVIEW`
instead of a 2xx (§3). That one **does** get a retry — it means "not yet", not "no".

### The two rules

1. **Never decorate a rejection.** No label, no score, no highlighted phrase, no
   "your text contained…". The server's vagueness is deliberate: a precise error
   is a working oracle for probing the classifier until something gets through.
   Re-adding detail on the client hands back exactly what the backend withheld.
2. **Never branch on message text.** Branch on `ApiError.code`. There is exactly
   one sanctioned exception, it is forced by a backend bug, and it is quarantined
   inside `isBlocked()` — see §6.1.

---

## 2. The modules

| File | Role |
|---|---|
| `src/lib/moderation.js` | the whole vocabulary: codes, the four states, copy, hold ceilings, `isBlocked` / `isUnderReview` / `moderationState` / `heldPublish` / `recheckDelays`. Pure, no React. |
| `src/components/Moderation.jsx` | `<ModerationBadge/>` `<ModerationNotice/>` `<ModerationAlert/>` and `useHeldWatch()` |
| `src/styles/warm/moderation.css` | the `.mod-*` author-facing layer |
| `src/styles/warm/moderation-admin.css` | the `.mdq-*` staff console layer |
| `src/api/moderation.js` | the `/api/v1/admin/moderation/**` client |
| `src/pages/AdminModerationPage.jsx` + `src/components/admin/Moderation*Panel.jsx` | the console |

The four render states are `live` · `checking` · `review` · `removed`.
`checking` is the automatic pass (seconds); `review` means a human now owns it.

### Re-checking

Nothing pushes. There is **no realtime moderation event anywhere on the
platform**, and the "your content is live" notification fires *only* for content
that actually waited — anything clearing inline is silent by design. So a held
item re-fetches itself via `useHeldWatch(active, kind, check)`, on a front-loaded
back-off that ends at the server's hard ceiling for that entity type. The
back-off matters: when the model is unreachable, *everything* is held at once,
which is precisely the moment a tight poll turns one outage into two.

---

## 3. Wire truth, per surface

Verified against the Java source (2026-08). "Held marker" is what the client can
actually *see*.

| Surface | Block | Held marker |
|---|---|---|
| Post create (JSON) | 400 `CONTENT_REJECTED` | `status: "PENDING_REVIEW"` |
| Post create (multipart) | **500 `{"error":"post_create_failed"}`** — no code (§6.1) | same |
| Post edit | 400; original text stays live | `status → PENDING_REVIEW`, new text already applied |
| Comments / replies | 400 | **none** — a held comment is byte-identical to a clean one |
| Story create | 400 | `moderationStatus: "PENDING" \| "IN_REVIEW"` |
| Story poll · highlight title · share caption | 400 on *any* non-approved verdict | **no held state at all** |
| Research publish | 400 (also 400 `CONTENT_UNDER_REVIEW`) | 200 whose `status` stayed `"DRAFT"` |
| Research edit of a live paper | 400; paper unchanged | flips back to `DRAFT` — it leaves the readers' view |
| Research comments · Q&A questions · answers | 400 | **none** |
| Chat message send / forward | 400 | **none** for the sender; recipients simply don't get the row |
| Chat message edit | 400; old body intact | `message.edited` SSE with the `body` key **absent** |
| Channel / group / stream **update** | 400 | **400 `CONTENT_UNDER_REVIEW`** — change never applies |
| Channel / group / stream **create** | 400, fully rolled back | non-members see `title: null` |
| Live-stream chat line | — | **silently dropped**, 200 empty body, no error, ever |

Three consequences worth internalising:

- **"No held marker" is common.** Do not fake a badge where the wire cannot tell
  you. Guessing wrong marks clean content as "checking", which is worse than no
  badge. The author keeps seeing their own held content either way, because the
  server's read filters carve the author out.
- **The instant-refuse surfaces are noisier than the rest.** Story polls,
  highlight titles, share captions and every caption/source/contributor-note
  sub-surface call `submitOrRefuse`, which 400s on a *borderline* verdict and on
  the classifier merely being unreachable. Copy there must not imply the author
  wrote something terrible.
- **A held post is invisible to its own author in every list** (§6.3), so the
  composer has to hand its created post to the feed optimistically — it will not
  come back from a refetch. And because that optimistic card only exists on an
  already-mounted feed, publishing a held post from any *other* page navigates
  to `/posts/{id}` instead of `/` (Layout.onPublished): the post page is the one
  read that serves the author their held post, and it owns the notice + watch.
- **`removed` is legend-only today.** No read endpoint in the table above ever
  returns `REJECTED` to the client (a rejected create persists nothing; an
  admin takedown deletes), so `moderationState() === 'removed'` renders only in
  the Safety-panel legend. The state stays implemented because the wire could
  start carrying it without notice — do not go hunting for its live surface.
- **When a watched hold clears, say so.** The bell only rings for content that
  waited on a human; an automatic clear is silent by design, so the
  `useHeldWatch` clear branch is the single place the author can be told. Every
  watcher now fires a quiet "…is live — everyone can see it now" toast
  (PostCard, Reels, StoriesRail, ResearchPage, ResearchDetailPage).

---

## 4. Notifications

Moderation reuses the plain `SYSTEM_MESSAGE` type — no new notification kind, no
entity id, no deep link, no case id. Only a title and a body:

- `Your content was removed`
- `Your content is being reviewed`
- `Your content is live` (deferred approvals only)

Matching on the exact title is therefore the *only* way to give these rows their
own icon — a documented exception, kept to those three strings, with unmatched
system messages rendering exactly as before.

An inline block **also** fires the "removed" bell, so a user who just saw the
composer refusal gets a notification too. That is intended, not a duplicate bug.

---

## 5. Mock mode

`VITE_USE_MOCK=true` (or `localStorage.ika_mock='on'`) runs the whole feature
with no backend and no classifier: text containing `blockme` is refused, text
containing `holdme` is held and clears ~6s later (`MOCK_HOLD_MS`), and the admin
console is served from an inline fixture. That is the fastest way to review any
of this — see `src/mock/handlers/moderation.js`.

Coverage, per surface (2026-08-08 pass — every gate imports `fakeVerdict` /
`blockedError` from the moderation fragment):

| Mock surface | `blockme` | `holdme` |
|---|---|---|
| Post create (JSON + multipart, incl. the 500 quirk) / edit | 400 / 500 | `status: PENDING_REVIEW`, settles on read |
| Post comments / replies / edits · reel comments | 400 | — (no wire marker; deliberately unobservable) |
| Story create | 400 | `moderationStatus: PENDING`, settles |
| Story poll attach · highlight title · share caption · Q&A source titles/citations · attachment captions | 400 on **any** non-approved verdict (submitOrRefuse) | same 400 |
| Research publish | 400 | **200 still-DRAFT** (`heldPublish`), settles to PUBLISHED on read; re-publishing meanwhile → 400 `CONTENT_UNDER_REVIEW`, and a retry after the verdict lands **succeeds** |
| Research edit of a live paper | 400, nothing applied | edit applies + flips to DRAFT, settles back |
| Research comments / edits | 400 | — |
| Q&A question create/edit · answers · reanswers · answer edits | 400 | — |
| Chat send / edit | 400 | — |
| Stream create (go live) | 400 | — |
| Stream metadata update | 400, nothing applied | 400 `CONTENT_UNDER_REVIEW`, nothing applied; retry after ~6s applies (rehearses the retry button) |
| Live-stream chat line | **silently dropped** — 200, never appended, no error | same (borderline defaults to not showing) |

Channel and group create/update have **no mock handlers at all** (those routes
fall through to the live API by design), so their `CONTENT_UNDER_REVIEW` arm can
only be rehearsed against a real backend.

---

## 6. Things that are easy to get wrong here

Every one of these was a real defect caught in review after the first pass. They
are listed because each is the kind of thing that reads as correct.

- **A refused edit must revert the optimistic patch.** The server screens
  *before* it writes, so the old wording is still live and nothing will ever
  correct the row — the bubble/card would sit there showing rejected text marked
  "edited". Reverting the row is safe: the text the author is rewriting lives in
  the composer's state, not in the rendered item.
- **Clear the input and bump the counter only after the await** — and add a busy
  flag when you do, because the input-clear used to double as the in-flight guard.
- **A refusal is scoped to one composer.** One `replyErr` serving whichever reply
  box is open must be cleared when that box moves or closes, or A's refusal
  renders under B's empty composer.
- **Sync the parent row when a hold clears.** A card resets its held state on the
  *parent's* status, so a list that never updates leaves it stale — and a second
  hold (a borderline edit) then renders no badge at all.
- **`uiPrompt` destroys the draft.** Anything typed into a prompt (repost caption,
  highlight title) is gone by the time the refusal lands, so those call sites loop
  the prompt pre-filled with the server's sentence above the field.
- **Watching a SET needs a key.** `useHeldWatch` stays `active` while the set's
  membership changes, so a newly held item would join a back-off chain that may
  already have run out. Pass the joined ids — the *ids*, not the state string
  (StoriesRail shipped with `'checking'` as its key, which never changes when a
  second story joins; caught 2026-08-08).
- **A refused poll sticker is not a refused story.** The story is already live
  by the time `attachPoll` 400s. Closing the modal (or toasting) destroys the
  poll draft; re-publishing would post the story twice. So the composer keeps
  the modal open with the sentence inline, parks the story id (`pollTarget`),
  and Publish becomes sticker-only until it lands or the modal is discarded.
- **A refused forward has no composer to land in.** The thread store rethrows
  moderation refusals so the surface can say them; the ForwardPicker is gone by
  then, so the toast carries the server's sentence (via `chatError`, which
  defers to `moderationText`). Swallowing it rendered nothing at all.

## 7. Backend defects and gaps found while building this

Filed here because the frontend has to work around them, and each workaround
should be deleted the day the backend changes.

1. **Multipart post create swallows the block.** `CassandraFeedController` wraps
   `createPost` in `catch (Exception)`, so a `BadRequestException` becomes
   `500 {"error":"post_create_failed","message":"<the moderation copy>"}` with
   **no `errorCode`**. The message is the only signal separating "we blocked you"
   from "the write failed", which forces the single message-sniff in
   `isBlocked()`. Narrowing that catch removes the hack.
2. **Multipart story create leaks media on a block.** The R2 upload happens
   before scoring and is not rolled back (the post path *does* roll back).
3. **Held posts are dropped for their own author.** `PostHydrator.isServable`
   has no author branch, so profile feed, home feed, reels and saves all hide a
   held post from the person who wrote it. Only `GET /posts/{id}` returns it.
   This directly contradicts `docs/moderation/user-behaviour.md` §3 ("render the
   item normally in the author's own feed and profile"). Stories get this right;
   posts do not.
4. **No held marker on comments, Q&A, research comments, chat or channel DTOs.**
   The entities carry `moderationStatus`; no response DTO exposes it. The
   documented "Checking…" badge is impossible on those surfaces until one does.
5. **The documented `note` fields are never sent.**
   `ModerationMessages.NOTE_HELD_FOR_REVIEW` / `NOTE_ESCALATED_TO_REVIEW` are
   referenced by zero call sites, though `user-facing-messages.md` §2 lists them
   as part of the API. The client owns that copy instead.
6. **A held research *reply* is invisible to its own author.**
   `ResearchMapper` filters nested replies on `canViewHidden`, which is
   research-owner only — there is no author carve-out, unlike every sibling query.
7. **Q&A leak:** `getAttachments` / `getSources` do no answer-level moderation
   check, so sources and attachments of a *held* answer are served to anyone who
   knows the answer id.
8. **A held chat message shows in recipients' inboxes as
   `"🕓 Disappearing message"`** even in a non-disappearing chat, and `hasUnread`
   flips true for a message they cannot see. If the verdict is REJECTED that
   placeholder stays as the conversation preview permanently.
9. **The appeal path does not exist.** `CONTENT_REJECTED` tells the user to
   "appeal from your account settings", but there is no user-facing endpoint for
   appealing a moderation decision — the only `appeal` route appeals a *report
   the user filed*. The Safety panel routes to the real, working path rather than
   rendering a button that would 404.
10. **Chat/live-chat case text is redacted from staff by policy** (a fixed
    placeholder string). That is correct and deliberate — noted so nobody "fixes"
    it. `teachModel` is ignored for those cases.
