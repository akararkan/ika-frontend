# Research — entity & domain enhancement notes

Logical / data-model suggestions for the Research backend, gathered while wiring
the IKA web client against `RESEARCH_API.md`. **None of these rename or move an
endpoint** — they're about what entities carry, what events broadcast, and how
the lifecycle behaves, so clients can render correctly without guessing or extra
round-trips. Same spirit as `QNA_BACKEND_NOTES.md`.

_Last updated: 2026-05-28._

> ✅ **ALL ITEMS RESOLVED by the backend (2026-05-28)** and the frontend is wired
> to the new contract. Summary of what shipped + the client sync:
> - **A1** — comment SSE events now embed the full `comment` (`CommentResponse`) +
>   `parentCommentId`. Frontend patches the comment row in place (no refetch).
> - **A2** — `*_COUNT_UPDATED` carry named **absolute** counters → frontend SETs
>   `metrics` from them; own react/save bump optimistically (no echo, A3).
> - **A3** — actor self-suppression confirmed (authenticated stream).
> - **A4** — `RESEARCH_UPDATED/PUBLISHED/DELETED` are defined but **not emitted**;
>   client keeps a harmless handler + uses its own response after a lifecycle call.
> - **B1** — `SourceType` doc corrected to `URL|DOI|ISBN|MEDIA_FILE|MANUAL`
>   (frontend's shared `SourceForm` already matched). **B2** sample fixed.
> - **C1** — `research_count` reconciled: not maintained, use `/users/{id}/stats`
>   (frontend already does).
> - **D1** — inline `replies` are complete (no paging needed). **D2** — comments
>   now carry `voiceUrl`/`voiceDurationSeconds`; frontend renders voice + media on
>   research comments and the comment composer can upload media/voice (§17.3).
> - **E2** — `/users/search?eligibleContributor=true` filters to RESEARCHER/SCHOLAR
>   (wired into `users.search`, ready for a contributor picker). **E3** — `cite`
>   now auth + 30-day dedup. **E4** — `download` returns `{ url }`; frontend reads
>   `res.url` and passes the first DOCUMENT `mediaId` for the main-PDF button.
>
> Kept below for history. Two backend follow-ups were flagged (not built): wiring
> A4 lifecycle broadcasts to passive viewers, and a scheduled-publish job (E1).

Legend: 🟥 correctness / can't-be-done-cleanly-without-it · 🟧 saves round-trips ·
🟨 polish / future-proofing.

---

## A. Realtime payloads (mirror what you did for QnA)

The QnA stream was upgraded to flat events that embed the fresh `answer` DTO +
root id, with named absolute counters and actor self-suppression. **Research
should get the same treatment** — today its SSE (§20) is the weakest realtime
surface on the platform.

### A1. 🟧 Comment events should embed the full `CommentResponse` (+ `parentId`)
`COMMENT_CREATED`, `REPLY_CREATED`, `COMMENT_EDITED`, `COMMENT_DELETED`,
`COMMENT_REACTION_ADDED/REMOVED` only carry an `actorId` / counter delta today.
The client can't patch the affected comment, so it **refetches the entire
comment page** on every comment event (chatty, and it fights optimistic state).

**Suggestion.** Embed the fresh `CommentResponse` and its `parentId` (root
comment id for replies) in each comment event — exactly like QnA's `answer` +
`parentAnswerId`. Then the client patches one row in place, no refetch.

### A2. 🟥 `*_COUNT_UPDATED` events should carry the post-action **absolute** value
§20 says `data` is "event-specific" without a schema; §23 says "treat SSE counter
events as the authoritative push delta." The client currently just does `+1`
locally per event (and can't tell save from unsave). Name the field after the
counter and send the final value: `VIEW_COUNT_UPDATED → { viewCount }`,
`SAVE_COUNT_UPDATED → { saveCount }`, `DOWNLOAD_COUNT_UPDATED → { downloadCount }`,
`SHARE_COUNT_UPDATED → { shareCount }`, `CITATION_COUNT_UPDATED → { citationCount }`,
`REACTION_COUNT_UPDATED → { reactionCount }`.

### A3. 🟥 Confirm the stream suppresses the **actor's own** events
The client reacts / comments optimistically and assumes the server won't echo
its own action back (as QnA now guarantees). §20/§23 don't state this for
Research. If it *does* echo, optimistic UIs double-count.

### A4. 🟧 `RESEARCH_UPDATED` / `RESEARCH_PUBLISHED` should carry the new status/summary
Today they're bare signals, so the client refetches the whole `ResearchResponse`.
Embedding at least `{ status, ...changed summary fields }` would let the client
patch the header (status pill, publishedAt, ircId/doi) without a round-trip.

---

## B. Enum / DTO accuracy

### B1. 🟥 `SourceType` in §4 is wrong (same bug as the QnA doc had)
§4 lists `BOOK | JOURNAL | WEBSITE | URL | DOI | ISBN | FILE | HADITH | QURAN | …`,
but the real shared enum is `ak.dev.irc.app.research.enums.SourceType =
URL | DOI | ISBN | MEDIA_FILE | MANUAL` (this is the enum the QnA doc was already
corrected to). The `SourceResponse` / create examples still show `"BOOK"`.

**Suggestion.** Fix §4 + the examples to the 5 real values. The client's shared
`SourceForm` already uses them, so a research source created with `"BOOK"` from a
doc-following client would be invalid.

### B2. 🟨 `ContributorResponse.accountType: "INDIVIDUAL"` isn't a real `AccountType`
The sample (§5) shows `"accountType": "INDIVIDUAL"`, but the enum (USER_API §5.2)
is `REGULAR | VERIFIED_SCHOLAR | VERIFIED_RESEARCHER | PLATFORM_OFFICIAL |
INSTITUTION | MEDIA`. Align the sample (and the field) to the real enum so badge
rendering on the contributors panel is consistent with everywhere else.

---

## C. Counts & cross-doc consistency

### C1. 🟥 `research_count` — two docs disagree
- `RESEARCH_API §23` and `USER_API §17` say `user_profiles.research_count` is a
  **maintained** denormalized counter (incremented by the research service).
- `USER_API §6.9 / §9.14` says the `user_profiles` counter columns are **not
  maintained and read 0** — use `GET /users/{id}/stats` instead.

These contradict. The client trusts `/users/{id}/stats` (per §9.14). **Please
reconcile**: either maintain `research_count` on publish/unpublish/delete, or
delete the column and make §17/§23 stop claiming it's kept in sync.

> The stats endpoint counts `researches WHERE status=PUBLISHED AND not deleted`.
> Confirm that matches what the profile RESEARCH tab lists
> (`GET /researches/researcher/{id}` — also PUBLISHED-only). They currently agree.

---

## D. Comments

### D1. 🟥 Are inline `replies` complete, or truncated?
`§17.1` returns `Page<CommentResponse>` with `replies: []` inline + `replyCount`.
If a comment has 50 replies, are all 50 in the array, or is it capped? There's
**no "load more replies" endpoint**, so if `replies` is truncated the extra ones
are unreachable.

**Suggestion.** Either guarantee `replies` is complete (depth-1 cap makes this
bounded-ish) **or** add `GET …/comments/{commentId}/replies?cursor=…`. State which
in the doc so clients know whether to show a "view N more replies" control.

### D2. 🟨 `comments/upload` accepts `voice`, but `CommentResponse` has no `voiceUrl`
§17.3 documents a `voice` (audio) multipart part, but the `CommentResponse` DTO
(§5) only has `mediaUrl` / `mediaType` / `mediaThumbnailUrl` — no `voiceUrl` /
`voiceDurationSeconds`. So an uploaded voice comment can't be rendered as audio.
Add the voice fields to `CommentResponse` (like QnA answers have), or drop the
`voice` part.

---

## E. Lifecycle & write semantics

### E1. 🟨 `scheduledPublishAt` — is it actually honored?
`CreateResearchRequest` / `ResearchResponse` carry `scheduledPublishAt`, but no
endpoint or job is documented that flips DRAFT→PUBLISHED at that time. Either
document the scheduled-publish behavior (and the event it emits), or drop the
field so clients don't show a scheduler that does nothing. (The client sends
`null` today.)

### E2. 🟧 Contributor picker needs a researcher-filtered user search
§11.1 rejects a contributor whose role isn't `RESEARCHER`/`SCHOLAR` with
`422 INVALID_CONTRIBUTOR_ROLE`. The only user search (`GET /users/search`) returns
all roles, so a contributor picker can't pre-filter and the user only learns of
the rejection after submitting. **Suggestion.** Add a `role`/`eligibleContributor`
filter to user search (or a dedicated researcher search) so the picker only
offers valid co-authors.

### E3. 🟨 `cite` (§19.3) is public with no dedup → spammable
`POST /researches/{id}/cite` is anonymous and just increments `citationCount`
with no dedup or rate limit, so the counter can be trivially inflated. It's
documented as server-to-server, but it's reachable by anyone. **Suggestion.**
Require auth (or a signed integration token) and dedup per source, or rate-limit.

### E4. 🟨 `download` returns a bare string body
§18.2 returns the signed URL as `text/plain`. Clients have to special-case a
non-JSON success body. A `{ "url": "…" }` JSON envelope would be consistent with
every other endpoint and easier to extend (expiry, filename).

---

## Priority shortlist

If only a few land:

1. **B1** — fix the `SourceType` enum in the doc (active correctness bug for any
   doc-following client).
2. **A1 + A2** — embed `CommentResponse` in comment events + named absolute
   counters → kills the comment-list refetch and the save/unsave ambiguity.
3. **C1** — reconcile `research_count` maintained-vs-not across the two docs.
4. **D1** — state whether inline `replies` are complete (or add replies paging).
