# Backend Notes — from the IKA frontend

Technical issues and enhancement requests found while integrating the **IKA**
web client (Vite + React, `http://localhost:5173`) against the IRC backend
(`http://localhost:8080`, base path `/api/v1`).

Each item lists the **symptom**, **evidence** (verified against the running
backend where possible), and a **recommended fix**. Several items are already
worked around in the frontend (noted as _workaround:_) — they're listed anyway
so the workaround can be removed once the backend is fixed.

_Last verified: 2026-05-27._

---

## 🔴 P0 — Media streaming

### 1. `/api/v1/media/**` ignores HTTP `Range` → video/audio stalls
Browsers stream `<video>` / `<audio>` with byte-range requests and expect
`206 Partial Content`. The media endpoint returns the **whole file with `200`**
and no range headers, so playback stutters/stops and seeking is impossible.

**Evidence**
```
$ curl -D- -o/dev/null -H "Range: bytes=0-1023" \
    http://localhost:8080/api/v1/media/posts/media/461d0cc7-…df3a.mp4
HTTP/1.1 200
Content-Length: 713494          # full file returned; Range ignored
# no Accept-Ranges, no Content-Range
```

**Fix** — serve media so Spring honors `Range`:
- preferred: register a static resource handler
  (`registry.addResourceHandler("/api/v1/media/**").addResourceLocations(…)`),
  which emits `206` + `Accept-Ranges: bytes` automatically; **or**
- return a **seekable** `Resource` (`FileSystemResource` / `ByteArrayResource`,
  **not** `InputStreamResource`) from the controller so
  `ResourceRegionHttpMessageConverter` produces partial content.

_Impact:_ root cause of every "reel / voice note doesn't play well" report.

---

### 2. Media endpoint returns **two** `Access-Control-Allow-Origin` headers
CORS is now present (👍) but the response carries **both** an echoed origin and
`*`. Duplicate ACAO is invalid per the CORS spec; browsers reject it for any JS
`fetch` / blob read.

**Evidence**
```
$ curl -D- -o/dev/null -H "Origin: http://localhost:5173" \
    http://localhost:8080/api/v1/media/…mp4
Access-Control-Allow-Origin: http://localhost:5173
Access-Control-Allow-Origin: *
```

**Fix** — emit exactly **one** ACAO value (echo the request origin **or** `*`,
never both). Almost always a double registration: Spring CORS config **and** a
manual filter / `@CrossOrigin` both adding the header.

---

## 🟠 P1 — Correctness / behavior

### 3. Relative media & avatar URLs
`mediaUrl`, `videoUrl`, `audioTrackUrl`, `avatarUrl`, `coverImageUrl`, etc. come
back as **host-relative** paths (`/api/v1/media/…`). Used directly in
`<video>`/`<img>` they resolve against the frontend origin and 404 to the SPA.

_Workaround:_ the client prefixes every asset path with the API base
(`assetUrl()`).

**Fix** — return absolute URLs, **or** explicitly document that asset URLs are
host-relative to the API origin so every client treats them consistently.

---

### 4. SSE counter events are inconsistent
- `POST_API §24`: counter fields are **never** populated — apply ±1 deltas.
- `POST_ENGAGEMENT §7`: `SHARE_COUNT_UPDATED` **does** carry an absolute
  `postShareCount`.
- `SAVE_COUNT_UPDATED` fires for **both** save and unsave with **no direction**.

The client has to special-case each event (delta vs. absolute vs. "re-read").

**Fix** — standardize per event and document it. Ideally every
`*_COUNT_UPDATED` carries the **post-action absolute count** (or a signed delta).
At minimum, give `SAVE_COUNT_UPDATED` a direction.

---

### 5. Author-only failures return `500` instead of `403`
Several mutating endpoints throw a raw `SecurityException` mapped to
`500 INTERNAL_ERROR` when the caller isn't the owner (e.g. story delete
`§20.4`, poll attach `§22.1`, QnA/Research author checks). The client can't tell
"forbidden" from "server error."

**Fix** — map `SecurityException` → `403 FORBIDDEN` in the global handler.

> ✅ **Resolved for QnA (2026-05-28)** — `QNA_API.md §21` now documents the
> `SecurityException → 403 FORBIDDEN` mapping. Please confirm the same handler
> covers Posts/Stories/Research too.

---

### 6. Privileged actions not enforced server-side
These are documented as "frontend MUST gate," which is a security gap — any
client can call them directly:
- best-answer voting (scholar only) — `POST /questions/{id}/answers/{aid}/best`
- voter list — `GET /polls/{pollId}/voters/{choice}`
- `POST /sounds` with `autoApprove: true` (admin/moderator only)

**Fix** — enforce the role/author check at the controller (`@PreAuthorize` or
equivalent), not just in the UI.

---

### 7. QnA tags can't be set on create
`CreateQuestionRequest §6.1` has no `tags` field, yet `QuestionResponse`
returns `tags` and the UI exposes a tags input.

**Fix** — accept `tags[]` on question create, or document that tags are derived
from `#hashtags` in the body (so the client can stop showing a dead field).

---

### 8. Inconsistent error envelopes across modules
- Posts: `{ errorCode, message, fieldErrors, traceId, … }`
- QnA / Research: `{ error, message, path }` (`error` = the code)
- Some Posts `401/403/404`: **bare body, no JSON**

The HTTP client parses three shapes to extract a code/message.

**Fix** — one unified error envelope across all modules (always JSON, always the
same field names).

---

### 8b. `SourceType` enum in QNA_API.md is wrong
`QNA_API.md §4` documents `SourceType` as
`BOOK | JOURNAL | WEBSITE | URL | DOI | ISBN | FILE | HADITH | QURAN | …`,
but the real shared enum (`ak.dev.irc.app.research.enums.SourceType`) is only:
`URL | DOI | ISBN | MEDIA_FILE | MANUAL`. The client was sending invalid values
(`BOOK`, `FILE`, …) until corrected.

**Fix** — update the QnA doc's SourceType list to the real 5 values.

> ✅ **Resolved (2026-05-28)** — `QNA_API.md §4` now lists the 5 real values and
> fixed the examples. Frontend already aligned.

---

### 8c. QnA answer-source **file upload** endpoint is undocumented
Research exposes `POST /api/v1/researches/{id}/sources/{sourceId}/file` to attach
the binary for a `MEDIA_FILE` source. `AnswerSourceResponse` (QnA) also has
`fileUrl` / `originalFileName`, but **no** QnA source-file upload endpoint is
documented. The client assumes the analogous
`POST /api/v1/questions/{qid}/answers/{aid}/sources/{sourceId}/file`
(part name `file`) exists by mirroring Research.

**Fix** — confirm/expose the QnA source-file endpoint, or document how a QnA
`MEDIA_FILE` source's `fileUrl` is meant to be populated. _Workaround:_ the
MEDIA_FILE source row is still created; only the file attach degrades (toast).

> ✅ **Resolved (2026-05-28)** — shipped as `QNA_API.md §16.5`
> `POST …/sources/{sourceId}/file` (part `file`). Matches the client's assumed
> path exactly, so the workaround is now the real flow.

---

## 🟡 P2 — Consistency / DX

### 9. VOICE_POST audio is represented three different ways
JSON create uses `audioTrackUrl`; multipart create has no audio field so the
uploaded audio lands in `mediaUrls`; the feed item surfaces it in `mediaUrl`.

**Fix** — always surface voice audio in `audioTrackUrl` on the response
regardless of create path (and/or accept an audio part on multipart create).

---

### 10. Multipart file part-name ambiguity
Post create accepts many part names (`files`, `files[]`, `media`, …); research
create's docs show `files[]`. The client currently sends `files`.

**Fix** — document the single canonical part name per endpoint.

---

### 11. `FEED_NEW_POST` live push isn't reachable by the client
`FEED_API §12` describes a per-user feed push on `irc:feed:{userId}`, but it's
not delivered on the notification SSE stream the browser subscribes to, so
live home-feed prepend can't be wired.

**Fix** — document the channel/event the browser should subscribe to, or fold
`FEED_NEW_POST` into the existing notification SSE stream.

---

### 12. Reels discover has no cross-day cursor
`§6` requires the client to iterate `?day=YYYY-MM-DD` backwards to page through
time. A server-side cross-bucket cursor would simplify clients.

---

## ✅ Resolved since first review (verified 2026-05-27)

- **Ranked / following reel feeds deployed** — `GET /api/v1/posts/reels/for-you`
  and `/reels/following` now return `200` (were `404 ENDPOINT_NOT_FOUND`). The
  client prefers them; the day-bucket walk is now only a fallback.
- **Media CORS present** — cross-origin requests now receive CORS headers
  (see item **#2** for the remaining duplicate-header bug).
- **`videoUrl` on feed items** — fixed the "reel cover was a thumbnail"
  problem. Please ensure it's populated for **all** reels; old rows return
  `null` and the client falls back to `GET /posts/{id}`.

---

## Quick reference — verification commands

```bash
B=http://localhost:8080
# Range (expect 206 + Accept-Ranges once fixed):
U=$(curl -s "$B/api/v1/posts/reels?pageSize=1" | grep -o '/api/v1/media[^"]*' | head -1)
curl -sD- -o/dev/null -H "Range: bytes=0-1023" "$B$U" | grep -iE '^HTTP/|accept-ranges|content-range'
# CORS (expect a single ACAO):
curl -sD- -o/dev/null -H "Origin: http://localhost:5173" "$B$U" | grep -i access-control-allow-origin
```
