# QnA — entity & domain enhancement notes

Logical / data-model suggestions for the QnA backend, gathered while wiring the
IKA web client against `QNA_API.md`. **None of these ask to rename or move an
endpoint** — they're about what the entities carry, what events broadcast, and
how the lifecycle behaves, so clients can render correctly without guessing or
extra round-trips.

_Last updated: 2026-05-28._

> ✅ **ALL ITEMS RESOLVED by the backend (2026-05-28).** This whole backlog
> shipped — A1–A4 (SSE now flat, embeds the full `answer` + root `parentAnswerId`,
> absolute counters, actor-event suppression), B1 (`acceptsNewAnswers` +
> `ANSWER_LIMIT_REACHED`, status unchanged), C2 (`§16.5` source-file upload),
> C3 (attachments-vs-sources doc), D1 (`tags` on feed/list), D2
> (`hasAcceptedAnswer`/`acceptedAnswerCount`), D3 (view-count caveats), E1
> (deleted answers excluded from list, tombstone via SSE only), E2
> (`replyToAnswerId`/`replyToUserId`), E3 (`links` = comma-separated string).
> The frontend is wired to all of them. Kept below for history.

Legend: 🟥 correctness / can't-be-done-cleanly-without-it · 🟧 saves round-trips ·
🟨 polish / future-proofing.

---

## A. Realtime payloads (the biggest win)

### A1. 🟥 Every `*_COUNT_UPDATED` event should carry the post-action **absolute** value
§9 says the event `data` holds "counter delta, etc." and §22 says to "treat the
SSE counter events as the authoritative push delta" — but the payload shape
isn't defined per event, so the client can't tell *absolute vs. delta* or *which
field*. Today the client reads `data.viewCount ?? data.count` and otherwise
falls back to a local `+1`, which drifts.

**Suggestion.** Standardize: `VIEW_COUNT_UPDATED → { viewCount }`,
`SAVE_COUNT_UPDATED → { saveCount }`, `SHARE_COUNT_UPDATED → { shareCount }`,
each the **final** value after the action. Name the field after the counter, not
a generic `count`. (`SAVE_COUNT_UPDATED` especially needs this — it fires for
both save and unsave with no direction today.)

### A2. 🟧 Answer-level events should embed the **full updated `QuestionAnswerResponse`** in `data`
`ANSWER_REACTION_ADDED`, `ANSWER_ACCEPTED`, `BEST_ANSWER_VOTED`,
`ANSWER_EDITED`, `ANSWER_FEEDBACK_ADDED`, … currently carry `answerId` only, so
the client refetches the whole answers page on each event. If `data` carried the
fresh answer DTO (with its recomputed `reactionCount`, `bestAnswerVoteCount`,
`accepted`, `feedbackCount`, …), the client could patch that one row in place.

**Suggestion.** Put the authoritative answer DTO in `data` for every
answer-scoped event. This is the single change that would most reduce QnA chatter.

### A3. 🟥 Reanswer / reply events need their **root answer id**
A reaction or edit on a *reanswer* fires `ANSWER_REACTION_ADDED` /
`ANSWER_EDITED` with the reanswer's own `answerId`. The client shows replies
nested under their root answer, but the event doesn't say which root thread to
update, so it has to refresh every open thread. `REANSWER_CREATED` has the same
gap.

**Suggestion.** Include `parentAnswerId` (and/or `rootAnswerId`) on every
answer/reanswer event so the client can target the right thread.

### A4. 🟨 Confirm QnA SSE suppresses the **actor's own** events
The client does optimistic updates assuming the server won't echo the actor's
own action back on their stream (as documented for Posts). §22 doesn't state this
for QnA. If QnA *does* echo, optimistic UIs double-count.

**Suggestion.** Document explicitly that QnA streams filter the actor's own events
(or that they don't, so clients can reconcile).

---

## B. Lifecycle & status

### B1. 🟥 Define the exact status transition when `maxAnswers` is reached
§4 says `CLOSED` happens when "maxAnswers reached," but §10.3 says the section
just "behaves as locked." So the client can't tell whether `status` actually
flips to `CLOSED` or stays `OPEN`/`ANSWERED` while silently rejecting new answers.

**Suggestion.** Pick one and emit it: either auto-set `CLOSED` (and broadcast a
lifecycle event) or keep status unchanged and expose a derived
`acceptsNewAnswers: boolean` on `QuestionResponse`. The client currently has to
recompute "is the composer allowed?" from `answersLocked` + `maxAnswers` + a
live answer count.

### B2. 🟧 Broadcast the question's **new status** on accept/unaccept
Accepting flips `OPEN → ANSWERED`; unaccepting the last accepted answer reverts
to `OPEN` (§13). There's no `QUESTION_STATUS_CHANGED` event, so the client infers
the status locally and can get out of sync with other viewers.

**Suggestion.** Either add a status-change event, or include the question's fresh
`status` in the `ANSWER_ACCEPTED` / `ANSWER_UNACCEPTED` event `data`.

### B3. 🟨 `ARCHIVED` has no transition endpoint or event
§4 defines `ARCHIVED` (hidden from feeds, readable by URL) but nothing in §6–§10
sets it. If archiving is a real author action, it needs a documented trigger and
a lifecycle event; otherwise drop the enum value to avoid dead states.

---

## C. Sources & attachments (the file story)

### C1. ✅ Resolved — `SourceType` doc enum corrected (2026-05-28)
`QNA_API.md §4` now lists the 5 real values
`URL | DOI | ISBN | MEDIA_FILE | MANUAL` and the examples no longer use `BOOK`.
Frontend already sends these.

### C2. 🟥 `MEDIA_FILE` sources have no documented upload path in QnA
`AnswerSourceResponse` exposes `fileUrl` / `originalFileName`, and `MEDIA_FILE`
means "an uploaded file as the source," but §17 only has a JSON create — there's
no QnA equivalent of Research's `POST /sources/{id}/file`. So a `MEDIA_FILE`
source can't actually get a file. The client assumes the Research-style sub-route
exists and degrades gracefully if not.

**Suggestion.** Add the source-file upload for QnA answer-sources (mirror
Research), or document that QnA sources are citation-only and files must go
through Attachments. (Logged as `BACKEND_NOTES.md` #8c.)

### C3. 🟨 Clarify the **semantic difference** between Attachments (§16) and `MEDIA_FILE` Sources (§17)
An answer now has two file mechanisms that overlap. The intended distinction
seems to be: *Attachments* = supporting downloads bundled with the answer;
*Sources* = bibliographic references where `MEDIA_FILE` is a hosted scan/PDF of
the cited work. Without this stated, clients render them inconsistently.

**Suggestion.** Document the intended use of each so UIs can present them right
(e.g., Attachments under the body, Sources in a citations panel).

---

## D. Feed & list projections

### D1. 🟧 Include `tags` in feed/list projections
§5 notes tags "may come back empty" on list/feed responses and are only
populated on single reads. So a feed card can't show tags without an extra
per-item detail fetch.

**Suggestion.** Denormalize `tags` into the feed projection (they already live in
Cassandra/ES), so cards render tags directly.

### D2. 🟧 Surface "is this question resolved?" on `QuestionResponse`
Feed cards want to badge questions that have an accepted/best answer without
loading all answers. Today the only signals are `status` (ANSWERED) and
`answerCount`.

**Suggestion.** Add `hasAcceptedAnswer: boolean` (and optionally
`acceptedAnswerCount` / `bestAnswerCount`) to `QuestionResponse`.

### D3. 🟨 `viewCount` is always pre-bump for non-subscribers
§6.2 returns the pre-increment count and relies on SSE for the bump. A feed card
or a viewer who never opens the SSE stream is permanently off-by-one. Anonymous
dedup via `X-Forwarded-For` is also fragile behind a CDN/proxy.

**Suggestion.** Either return the post-bump value, or document the dedup window;
consider a sturdier anonymous viewer key.

---

## E. Answers, replies & soft-delete

### E1. 🟥 Specify whether `GET /answers` includes **soft-deleted** rows
§11.8 soft-deletes (body nulled, `deleted:true`) so reanswer threads survive, and
§22 mentions "[deleted]" placeholders — but §11.1 doesn't say if the answers list
returns those tombstones. The client needs to know whether to render a
placeholder or that the row is simply gone.

**Suggestion.** State that the list includes soft-deleted rows (with
`deleted:true`, body/attachments/sources nulled) so clients render placeholders
consistently — and confirm `replyCount` still counts replies under a deleted
parent.

### E2. 🟧 Preserve the reply target across depth-1 hoisting
§11.5 hoists a reply-to-a-reply into a sibling at depth 1, which loses *who was
being replied to*. The client works around this by prefixing `@handle` into the
body text.

**Suggestion.** Persist a `replyToUserId` / `replyToAnswerId` (mention) on the
reanswer so clients can render "replying to @X" natively without mangling the
body.

### E3. 🟨 Define the `links` field shape
`QuestionAnswerResponse.links` is shown as `null` with no schema (array? string?
objects?). Clients can't safely render an untyped field.

**Suggestion.** Type it, e.g. `List<{ url, label }>`, or drop it if media/sources
already cover the use case.

---

## F. Feedback model

### F1. ✅ Resolved — answer rating/feedback feature **removed** (2026-05-28)
The whole feedback subsystem (FeedbackType, AnswerFeedbackResponse,
`feedbackCount`, the §15 endpoints, and the `ANSWER_FEEDBACK_*` events) was
removed — best-answer marking already signals answer quality. The frontend has
been stripped to match. (My earlier "upsert per answer" suggestion is now moot.)

---

## G. Security / integrity (cross-refs to BACKEND_NOTES.md)

### G1. 🟥 Enforce the scholar gate on best-answer voting server-side
§2/§14 explicitly say "frontend MUST gate." That's not enforcement — any client
can `POST …/best`. (Already #6 in `BACKEND_NOTES.md`.)

**Suggestion.** `@PreAuthorize` the scholar role on `…/best` (both verbs).

### G2. ✅ Resolved — author-check now maps to `403` (2026-05-28)
§21 now documents that `SecurityException` maps to a `403 FORBIDDEN` JSON
envelope (errorCode `FORBIDDEN`). The client's `qnaError()` already branches on
403.

---

## Priority shortlist

If only a few land, these three remove the most client guesswork:

1. **A2 + A3** — embed the full answer DTO (with `parentAnswerId`) in answer
   events → no refetch, correct reply-thread updates.
2. **B1** — define `maxAnswers`/`CLOSED` behavior (or add `acceptsNewAnswers`).
3. **C2** — give `MEDIA_FILE` sources a real upload path (or document files =
   Attachments).
