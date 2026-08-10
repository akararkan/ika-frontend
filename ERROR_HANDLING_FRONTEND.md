# Error Handling — Frontend Implementation Map

> Implements `frontend-error-handling.md` (backend docs). This file records
> **where** each contract lives in this codebase and which conventions every
> new surface must follow. The message/code catalog itself is
> `user-facing-messages.md` — never copy strings out of it into the client;
> display `err.message` and branch on `err.code`.

## The three rules (§1.1)

1. **Branch on `err.code`** — helpers in [`src/api/errors.js`](src/api/errors.js)
   (`isNotFound`, `isDuplicate`, `isConflict`, `isRateLimited`, `isStepUp`,
   `isTransient`, `isClientBug`, …). All are suffix-family aware
   (`*_NOT_FOUND`, `*_DUPLICATE`). Re-exported from the api barrel.
2. **Display `err.message` for 4xx** — `errorText(err, fallback)` is the
   default arm of any error switch; for 5xx it appends a short trace ref.
3. **Keep the traceId** — `http.js` calls `logApiError()` at **every** throw
   site, so each failed request self-reports one greppable console line
   (`[api] 403 STEP_UP_REQUIRED trace=… POST /path`). Page-level failures
   render it via `<ErrorState traceId={…}/>`.

## The envelope (§1)

`ApiError` (`src/api/http.js`) carries `status / code / message / payload /
fieldErrors / details / traceId / retryAfterSeconds / action`. Parsing is
defensive: both `errorCode` and `error`-keyed bodies (the multipart
`upload_failed` / `post_create_failed` escapes), bare-body 401/403/404, and
the header-only 429 all normalize into it. Mock mode throws the same shape.

## Global flows in the funnel (`src/api/http.js`)

Every REST call passes through `request()`, so these are app-wide:

- **401 → refresh once → retry once → logout** (§2.1). Single-flight refresh;
  any refusal from `/auth/refresh` is terminal. `AUTH_REFRESH_TOKEN_REUSED`
  signs out with "signed out of all devices for security" copy. The reason is
  parked in `sessionStorage['ika:signed-out']` and surfaced once by AuthPage.
- **403 `STEP_UP_REQUIRED` → arm → replay** (§2.2). `http.js` parks the
  failing request and asks `<StepUpHost/>` (mounted in Layout) to collect the
  password/TOTP code and `POST /security/step-up`; on 204 the original request
  replays once. Single-flight across concurrent 403s;
  `STEP_UP_BAD_PASSWORD` stays inline in the modal. A cancel tags the error
  `stepUpCancelled` so `security.withStepUp` wrappers don't prompt a second
  time. One server-side window (~5 min) covers a whole batch of admin work.
- **429** (§2.3): warn-toned toast with the server's hint; surfaces that own a
  submit button add a countdown via `useCooldown()`
  (`src/hooks/useCooldown.js` — wired in ComposeModal; chat's slow-mode
  Composer predates it and keeps its own). `cooldownSecondsFrom(err)` folds
  both `RATE_LIMITED.retryAfterSeconds` and `MEDIA_QUOTA_EXCEEDED.resetsAt`.
  Keep the draft; never auto-retry.
- **Deprecation headers** (§4): any response with `Deprecation: true` logs the
  `Link` successor to the console.
- **Unhydrated path params** (§2.4): a `/undefined` or `/null` path segment
  logs a loud BUG line before the request goes out, and a server-side
  `TYPE_MISMATCH` with `hint=frontend_path_param_unhydrated` logs the same
  guidance on the way back (`logApiError`).

## Per-family UI contracts

| Family | Where implemented |
|---|---|
| `VALIDATION_FAILED` fieldErrors → inline (§2.4) | `fieldErrorMap(err, rename)`; AuthPage maps register-DTO names onto its inputs; falls back to top-level message when `fieldErrors` is absent |
| `*_NOT_FOUND` → tombstone, not error toast (§2.5) | PostPage / ResearchDetailPage / QuestionPage: 404 renders "no longer available" `EmptyState`; **other** failures render `ErrorState` with retry + traceId |
| `*_DUPLICATE` → inline on `details.field` (§2.6) | `duplicateField(err)`; AuthPage marks handle/email inputs |
| `OPTIMISTIC_LOCK_CONFLICT` / `RESOURCE_CONFLICT` (§2.6) | `isConflict(err)`; the server copy ("modified by another user — refresh and try again") already displays via the save dialogs' message fallback (e.g. ResearchComposeModal) |
| `LARGE_AUDIENCE_CONFIRMATION_REQUIRED` (§2.7) | `needsLargeAudienceConfirm(err)` — when an announcements UI lands: `uiConfirm({message: err.message})` → resend identical body with `confirmLargeAudience: true`. Never set the flag by default |
| `CONTENT_BLOCKED_BY_POLICY` / `CONTENT_REJECTED` / `PENDING_REVIEW` (§2.8/§2.8a) | Already complete — `src/lib/moderation.js` + `<ModerationAlert/>`/`<ModerationBadge/>` (see `MODERATION_FRONTEND.md`): draft kept, server words verbatim, no category decoration, no retry button |
| 5xx (§2.9) | `errorText()` shows the (already generic) message + trace ref; `isTransient()` marks the 503 contract codes for "try again" states |

## Success-with-caveats (§3)

`<ResponseCaveat note warning/>` (`src/components/states.jsx`, styles in
`core.css .rc-note/.rc-warn`) — drop next to the data it qualifies; `warning`
renders as a prominent banner. Adopted at AdminSearchPage's reindex note; the
moderation settings `warning` and the degraded-search banner
(`ExplorePage`/`SearchTypeahead`, from `res.degraded` — "search unavailable",
never "no results") already rendered their caveats. Async media failures
surface `errorMessage` from `GET /media/{id}` polling (`api/media.js`).

## SSE (§5)

Already hardened per stream (realtime.js, notifications.js, stories.js,
activity.js, chat.js): token-in-query, heartbeat watchdogs > 2× cadence,
`connected` = reconcile-via-REST, `mockEnabled()` guards. SSE errors have no
envelope — handlers reconnect, never parse.

## Adding a new error code (§6)

Most codes need **nothing**: the generic fallback (`errorText`) already
displays the server's message. Add client code only for a new *flow* (a
confirm-and-resend flag, a new countdown source) — put the predicate in
`src/api/errors.js`, the UI where the flow lives, and a row in the table
above. Never pin behavior to message text.
