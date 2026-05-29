# Notifications — backend notes

Observations from wiring the IKA web client against `NOTIFICATIONS_API.md`.
Short list — the notification system is the **best-designed realtime surface on
the platform** (events embed the full `NotificationResponse`, counters are
absolute, actor self-suppression, Redis multi-tab fan-out). The frontend now
mirrors it exactly. These are the only gaps worth a look.

_Last updated: 2026-05-28._

Legend: 🟥 correctness · 🟧 saves round-trips · 🟨 polish / future-proofing.

> ✅ **Resolved by the backend (2026-05-28).** N1 — `ANSWER_FEEDBACK_RECEIVED`
> removed end-to-end (kind/category/templates/consumer). N3 — `unread` now
> **composes** (ANDs) with `category`/`type`, so `?unread=true&category=QNA`
> returns unread Q&A; frontend dropped the standalone "Unread" tab for an
> **"Unread only" toggle** that composes with any category tab. N4 — new
> **`ANSWER_BEST_VOTED`** kind (QNA category) when a scholar endorses your answer;
> frontend needed no change (notifications render generically by category / title
> / body / deepLink, so it lands in the Q&A tab automatically). N2 was a
> cross-ref, no work. Kept below for history.

---

### N1. 🟥 `ANSWER_FEEDBACK_RECEIVED` is a dead kind — the QnA feedback feature was removed
The catalog (§3), the `QNA` category (§4), and `NotificationKind` still list
**`ANSWER_FEEDBACK_RECEIVED`** ("the asker gave feedback on your answer"). But the
QnA answer-rating/feedback feature was **removed** (see `QNA_BACKEND_NOTES.md` F1 —
the §15 endpoints, `FeedbackType`, `feedbackCount`, and the `ANSWER_FEEDBACK_*`
realtime events are all gone). So this kind can never fire.

**Suggestion.** Drop `ANSWER_FEEDBACK_RECEIVED` from the catalog/category/triggers
(or, if you want to keep a feedback signal, that's a QnA-side decision first). The
client does **not** special-case it, so no frontend change is needed — it's just a
stale entry that will confuse the next integrator.

---

### N2. 🟨 The notification stream is the reference model — point the other domains at it
This stream does exactly what QnA/Research should: the `notification` event carries
the **full DTO** (patch in place, no refetch), `unread-count` is **absolute** (set,
don't increment), and the actor's own events are suppressed. QnA already mirrors
this; **Research does not yet** — its comment events carry no `CommentResponse` and
its counters aren't named/absolute (logged in `RESEARCH_BACKEND_NOTES.md` A1–A3).
No work here — just the canonical example to copy.

---

### N3. 🟨 `unread` + `category` can't be combined in one query
§7.1 precedence is `unread → category → type → all`, so a request with both
`unread=true&category=POSTS` silently ignores `category` and returns all unread.
A client that wants "unread within the Posts tab" can't express it in one call.

**Suggestion.** Let `unread` compose with `category`/`type` (AND them) instead of
taking precedence. Today the client sidesteps this by keeping a single global
"Unread" tab, but per-tab unread filtering would need this.

---

### N4. 🟨 Consider a notification for `BEST_ANSWER_VOTED`
§5 explicitly fires **no** notification for best-answer votes. A scholar marking an
answer "best" is a meaningful endorsement the author would value (more so than a
plain reaction, which *does* notify). Worth considering an opt-in
`ANSWER_BEST_VOTED` kind (SOCIAL category, aggregable) so authors learn when their
answer is endorsed.

---

### Already aligned (no action)

- Frontend badge is seeded from `/unread/count` then **set** from `unread-count`
  events (never hand-incremented) — fixed this round.
- The stream **self-heals** on a hard close (readyState 2 = expired token):
  refresh the access token, reopen a fresh `EventSource` (§11.5).
- Full 6 inbox categories wired (`POSTS / QNA / RESEARCH / MENTIONS / SOCIAL /
  SYSTEM`), live upsert-by-id with float-to-top for aggregated rows, cross-tab
  `read`/`deleted` sync, navigate via `deepLink`.
