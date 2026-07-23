# Chat frontend — implementation guide

The messaging module: `src/api/chat.js`, `src/context/ChatContext.jsx`,
`src/components/chat/`, `src/pages/ChatPage.jsx`, `src/pages/ChatJoinPage.jsx`
and `src/styles/warm/chat.css`. It is the largest single feature in the client,
and most of it is not guessable from the code alone — this file is the part you
would otherwise have to rediscover.

Written for someone who has never opened the module and has to extend or debug
it. It explains **why** things are shaped the way they are, and what breaks if
you "simplify" them. Backend behaviour it depends on is documented separately in
the IRC backend repo under `docs/chat_documentation/` (`09-api-reference.md` is
the as-built HTTP contract).

> **On line numbers.** This guide deliberately cites *names* — components,
> functions, props, CSS selectors — rather than line numbers, which are wrong
> within a week. Grep the name.

**Contents**

- [Architecture and data flow](#architecture-and-data-flow)
- [Component map and prop contracts](#component-map-and-prop-contracts)
- [The stylesheet: vocabulary, stacking, responsive](#the-stylesheet-vocabulary-stacking-responsive)
- [Backend contract and what is wired](#backend-contract-and-what-is-wired)
- [The surfaces layered on top of the core](#the-surfaces-layered-on-top-of-the-core) — calls, media playback, channels, live, privacy, scheduling, star
- [Invariants and traps (do not undo these)](#invariants-and-traps-do-not-undo-these)
- [Working on this module](#working-on-this-module)
- [Known open issues](#known-open-issues)


## Architecture and data flow

Chat is four layers, each with a single owner. Nothing skips a layer: components never call `http`, `useThread` never opens a socket, and the service module never holds React state.

| Layer | File | Owns |
| --- | --- | --- |
| Service adapters | [src/api/chat.js](src/api/chat.js) | HTTP verbs, DTO→view adaptation (`msgFrom` / `convoFrom` / `memberFrom` / `requestFrom` / `participantFrom` / `settingsFrom` / `scheduledFrom` / `channelFrom` / `callFrom` / `callSignalFrom` / `liveStreamFrom` / `liveChatFrom`), id coercion, `assetUrl` on media, and `stream()` — the raw EventSource wrapper. No state. |
| Context | [src/context/ChatContext.jsx](src/context/ChatContext.jsx) | The ONE socket, inbox + archived + requests lists, `totalUnread`, typing/presence maps, the user directory, the privacy switches (`chatSettings`), `subscribe()` firehose, `setActiveConversation`. |
| Call layer | [src/context/CallContext.jsx](src/context/CallContext.jsx) | The WebRTC mesh: peer connections, local/remote streams, the synthesised ringer, and the call lifecycle driven off the `call.*` events on the same socket. Consumes `subscribe()`; owns no HTTP of its own beyond `api.chat.calls`. |
| Client-only stores | [mediaPrefs.js](src/components/chat/mediaPrefs.js) · [callLog.js](src/components/chat/callLog.js) | Two module-level stores with a `useSyncExternalStore` binding and localStorage behind them. `mediaPrefs` holds playback speed / volume / mute and which voice notes have been heard; `callLog` holds this device's call history, which the API does not have (see [Media playback](#media-playback--voice-and-video) and [Calls](#calls--a-mesh-a-deterministic-offerer-and-a-ringer-with-no-asset)). Neither touches React context: both are read by leaf nodes inside a memo-ed list, where a context bump would re-render the whole thread on a volume drag. |
| Per-thread store | [src/components/chat/useThread.js](src/components/chat/useThread.js) | One conversation's messages as `Map<messageId, msg>`, cursor paging, optimistic send/outbox, edit/delete/react deltas, star, gap-sync, delivered receipts, debounced read marker, pinned bar, the send-later queue. |
| Components | [src/pages/ChatPage.jsx](src/pages/ChatPage.jsx) + [src/components/chat/](src/components/chat) | Rendering, drafts, panel open/close, lightbox. `useThread` is instantiated **once** in `ChatPage`; the hook object is never passed whole — its fields are destructured into individual props (`messages`, `loadOlder`, `sendText`, `retry`, …) on `MessageList` and `Composer`. Both therefore render from the *same store*, so an optimistic bubble appears in the timeline without a second copy of the state. |

```
┌── src/api/chat.js ─────────────────────── service adapters ──────────┐
│ http.get/post/patch/del  ·  DTO → view  ·  mid() exact-id strings    │
│ pageOf() Spring Page      ·  cursor pages  ·  clampLimit(1..100)     │
│ stream(handlers): 1 EventSource + 60s watchdog + name normaliser     │
└──────────▲──────────────────────────────────────┬───────────────────-┘
           │ promises                             │ adapted events (view shapes)
┌──────────┴──────────────────────────────────────▼───────────────────┐
│ ChatProvider — mounted ABOVE <Layout/> (App.jsx route element)       │
│ conversations · archived · requests · totalUnread · requestCount     │
│ typingRef · presenceRef · usersRef (directory) · seenRef (dedupe)    │
│ onAny ──► broadcast() ──► subscribersRef                             │
└─────┬──────────────────────────────────────┬─────────────────────────┘
      │ useChat()                            │ subscribe(evt)  [firehose]
      │                        ┌─────────────▼──────────────────────┐
      │                        │ useThread(convId)                  │
      │                        │ Map<id,msg> · cursor · outbox       │
      │                        │ filters evt.conversationId itself  │
      │                        └─────────────┬──────────────────────┘
┌─────▼──────────────────────────────────────▼─────────────────────────┐
│ Layout badge · ConversationList · MessageList · Composer · Header …  │
└──────────────────────────────────────────────────────────────────────┘

message.new on the wire
  → stream(): dispatch → normalizeEventName → adaptEvent → onMessage + onAny
  → ChatProvider.applyMessageNew: seen-dedupe, mine?/active? → +1 badge,
    +1 convo.unreadCount, rewrite preview, re-sort byRecency
  → broadcast → useThread (convId match): addIncoming + markDelivered + scheduleRead
              → ChatPage: receipt high-water marks for the tick indicator
```

### One socket, mounted above Layout

`stream()` in [src/api/chat.js](src/api/chat.js) is called from exactly one place: the socket effect in `ChatProvider`. `ChatProvider` wraps the whole protected shell in [src/App.jsx](src/App.jsx) — `<RequireAuth><ChatProvider><Layout/></ChatProvider></RequireAuth>` — not just the `/chat` routes. Two reasons: the unread badge in [src/components/Layout.jsx](src/components/Layout.jsx) reads `totalUnread` from anywhere in the app, and the backend caps SSE connections per user, so every extra mount point is a socket you cannot afford. Moving the provider inside the chat route means the badge dies on every other page and the stream re-dials on every visit to `/chat`.

Hardening inside `stream()` that looks redundant but is not:

- The JWT is read **inside** `connect()`, not captured once. Access tokens rotate ~hourly; a tab open overnight reconnects with a token fetched at reconnect time. Hoisting it out re-dials forever with a dead token.
- Both the dotted lower-case event names and the `MESSAGE_NEW` upper/underscore spelling are registered, plus `onmessage` for unnamed frames routed by `data.eventType`. `EventSource` delivers each frame to exactly one listener, so nothing double-fires.
- The watchdog closes the socket **before** reconnecting after 60s of silence (it ticks every 15s). Reconnecting first would briefly hold two sockets and trip the per-user cap.
- `onError(readyState)` is only actionable at `readyState === 2` (CLOSED); `0`/CONNECTING is the browser's own retry. The context's handler refreshes auth, tears down and re-opens, guarded by a `healing` flag with an 8s cooldown so a flapping server can't produce a reconnect storm.

The provider effect's dependency array is `[signedIn, applyMessageNew, upsertConvo, patchConvo, removeConvo, reseedUnread, bumpTyping, bumpPresence, findConvo]`. `signedIn` is the one that actually makes the effect run once per sign-in; the rest are `useCallback`s with stable deps. Make any of those unstable (an inline arrow, a dep on `conversations`) and you get socket teardown/reopen on every message.

### Deltas, not counters — and the reseed

Platform contract: **SSE payloads carry no absolute counts.** No unread total, no reaction totals. Consumers apply ±1 locally:

- `applyMessageNew` bumps `totalUnread` and `convo.unreadCount` by 1, gated by three conditions: the id is not in `seenRef` (a 500-entry insertion-ordered `Set`, oldest evicted), the sender is not me, and the conversation is not the active one (`activeIdRef`, set by `ChatPage` via `setActiveConversation`). Drop the active check and reading a thread increments its own badge.
- `member.changed` (the `onMember` handler): the *sign* is derived outside the updater — it is a pure function of `evt.memberChange` (`ADDED` → +1, `REMOVED`/`LEFT` → −1, everything else 0) and depends on no state. What must stay **inside** the `setConversations`/`setArchivedList` updater is the read-modify-write of the count itself, `Math.max(0, (c.memberCount || 0) + delta)`. An earlier version read `convosRef` first and wrote an absolute value; a burst of joins all read the same pre-flush snapshot and collapsed to a single +1. Inside the updater each handler sees the previous one's result.
- Reactions use `applyReactionDelta` in [useThread.js](src/components/chat/useThread.js); the HTTP response's authoritative `ReactionSummary[]` then overwrites the optimistic guess.

Deltas drift across any disconnect (events missed while offline are simply never counted). The correction is the reseed: `GET /api/v1/messaging/unread-count` runs in the mount `Promise.all` **and again on every `connected` event** (`reseedUnread` inside `onConnected`). Delete that reseed and the badge is correct only until the first network blip.

`receipt.read` for **my own** userId also zeroes a conversation locally — that is how reading on another device clears the badge here.

### The user directory (`watchUsers` / `userOf` / `enrichAuthor`)

Chat DTOs deliberately carry only `senderId`/`senderUsername`/`senderFullName` (same for `peer` and `MemberResponse`). No `profileImage`, no `verified`. `authorFrom` in [src/api/adapters.js](src/api/adapters.js) therefore produces an author card with `profileImage: null` and `verified: false`, which would render initials everywhere in chat while the rest of the app shows avatars.

The fix lives in the context, not in components:

- `watchUsers(ids)` queues unknown ids and coalesces a 40ms burst into one flush (one page of senders = one round of requests). It skips ids that are cached, queued, **or in flight** — `inFlightUsersRef` exists because between clearing `pending` and the responses landing an id sits in neither map, and the next render would re-queue the same profile.
- `flushUsers` does `Promise.allSettled(ids.map(id => api.users.profile(id)))` — there is no batch-by-ids endpoint. Keep the explicit arrow: point-free `ids.map(api.users.profile)` hands `profile` the array index as a second argument and detaches it from the `users` object. A rejection caches `null`, so a deleted account is never re-asked in a loop.
- `enrichAuthor(author, userId)` is what actually enriches a bubble during render. It is a **pure synchronous `usersRef` read** — no effect, no waterfall — and merges: DTO fields win where present, the directory fills `profileImage`/`verified`/`role`. Callers: `MessageBubble`, `ConversationList`, `ConversationHeader`, `ConversationInfo`, `RequestsPanel`. Re-render comes from `bumpUsers()` bumping a tick in the provider, which re-renders all `useChat()` consumers.
- `userOf(id)` is the same synchronous ref read exposed raw, for callers that want the directory card rather than a merge. Nothing in the chat components uses it today — reach for `enrichAuthor` unless you specifically need the unmerged card.

Presence follows the same pattern with different constants: `watchPresence` has a 60s freshness TTL and a 60ms coalesce window, and hits the real batch endpoint `GET /api/v1/presence?userIds=a,b,c`.

### Optimistic send and `clientNonce` reconciliation

`sendText`/`sendFiles` mint a nonce (`api.chat.newNonce()` — `crypto.randomUUID` with a time+random fallback for non-secure contexts/old Safari), insert an optimistic bubble built by `buildOptimistic` in the exact `msgFrom` view shape, and stash a resend payload in `outboxRef` keyed by nonce so `retry(msg)` can replay it.

**Message ids are exact decimal STRINGS, never numbers** — see [src/api/ids.js](src/api/ids.js). A Snowflake is an 18-digit long (`355456387759665152`), roughly 40× past `Number.MAX_SAFE_INTEGER`. Put one in a JS number and two things break at once: the double's shortest decimal form is a *different* integer (`String(n)` → `…150`), so every `/messages/{id}/…` URL 404s; and the value lands *above* any `MAX_SAFE_INTEGER`-based sentinel, which is how the original `TMP_BASE` scheme silently disabled `highestRealId()` — it returned `0`, the read marker was never posted, and the unread badge never cleared.

So: [http.js](src/api/http.js) `parseJson` quotes every unsafe integer before `JSON.parse` (REST **and** the SSE frames, which must agree), `mid()` normalises DTO longs (`0` → `null`, the backend's "nothing yet"), and ordering goes through `cmpId` / `maxId` / `gteId` / `gtId`. Never `-`, `>=`, or `Math.max` on a message id. Temp ids are `t<seq>` — unmistakably local, sorted last by `cmpId`, and `isTmpId()` is every "is this real?" check.

There are **two** reconciliation paths, because the sender's own devices also receive `message.new`:

1. HTTP 201 returns the real message → `reconcile(nonce, real)` revokes object URLs, drops the outbox entry, adds the id to `deliveredRef` (never self-ack delivered), advances `highestRef`, then deletes every pending entry with that nonce and inserts the real one.
2. The SSE echo arrives first → `addIncoming` drops a matching pending bubble. Note the match is *heuristic*: `msgFrom` does not carry `clientNonce`, so the echo cannot be nonce-matched. It falls back to "first pending bubble from me with the same body":

```js
if (!next.has(m.id) && String(m.senderId) === String(myIdRef.current)) {
  // My own echo (may arrive before the 201) — drop the matching pending bubble.
  for (const [k, v] of next) {
    if (v.pending && String(v.senderId) === String(myIdRef.current) && (v.body || '') === (m.body || '')) {
      revokeUrls(v.clientNonce); next.delete(k); break
    }
  }
}
```

Two simultaneous uploads with empty bodies will match the older pending bubble. If the backend ever echoes `clientNonce`, thread it through `msgFrom` and match on it here.

Object URLs for optimistic media are tracked per nonce in `pendingUrlsRef` and revoked on reconcile, on conversation change, and on unmount. Remove any of those and the tab leaks blobs.

### Cursor paging vs Spring page/size

Two storage engines sit behind one service module and they page differently. The shapes are **not** interchangeable:

| Resource | Engine | Request | Response |
| --- | --- | --- | --- |
| conversations, archived, members, requests | Postgres | `{ page, size }` | `pageOf()` → `{ items, total, hasMore, page }` |
| messages | Cassandra | `{ cursor, limit }` (clamped 1..100) | `{ items, nextCursor, hasMore }`, newest→older |

A page **index** over a live message timeline skips and duplicates rows as new messages land at the head — that is exactly why messages are cursor-paged. Conversely the conversations endpoint has no `nextCursor` to hand back. So `ChatContext` tracks `inboxPageRef`/`archivedPageRef` as integers, and `useThread` tracks `cursor`/`cursorRef` as an opaque token. `jumpTo(messageId)` walks the cursor backwards up to 20 pages of 50 until the target is loaded (the guard exists so a bad id can't page an entire archive).

`msgFrom` normalises `messageId` through `mid()` — the exact decimal STRING, because an 18-digit Snowflake does not survive a JS number (see the ids invariant above). The client orders, dedupes, gap-syncs and compares receipt high-water marks with `cmpId`/`maxId`/`gteId`; a stray `Number(...)` anywhere in that chain reintroduces the 404s and the dead read marker.

### Gap-sync on reconnect

`useThread` subscribes to the firehose and treats `connected` as "you may have missed things" — it is the only case in the switch that is *not* filtered by `evt.conversationId`, because the event does not carry one:

```js
case 'connected':
  gapSync()
  break
```

`gapSync` reads `highestRef` (the highest **real** id currently held) and calls `GET /api/v1/conversations/{convId}/messages/sync?after=…&limit=100` — the route is nested under the conversation, there is no top-level `/messages/sync` — which returns ascending rows. Results are merged without clobbering fresher local copies, `highestRef` advances, each row gets a delivered ack, and the read marker is rescheduled. It bails when `highestRef` is 0 (nothing loaded yet — `reload()` covers that case). Because `connected` fires on the initial connect too, this is also a cheap catch-up after a slow first paint.

### The firehose and how consumers filter it

`ChatProvider` passes `onAny: broadcast` to `stream()`, so **every** adapted event is re-broadcast to `subscribersRef`. `subscribe(handler)` returns an unsubscribe function; `broadcast` wraps each call in try/catch so one throwing subscriber cannot starve the others.

The provider handles inbox-level concerns itself (`onMessage`, `onEdited`/`onDeleted` keeping the rail preview truthful, `onRead`, `onTyping`, `onPresence`, `onConversation`, `onMember`, `onRequest`). Everything else is a subscriber's job:

- `useThread` switches on `evt.type` and early-returns on `evt.conversationId !== conversationId` for every case except `connected`. It handles `message.new`, `message.edited`, `message.deleted`, `message.reaction` (skipping its own userId — already applied optimistically), and `conversation.updated` with `memberChange === 'PINNED' | 'UNPINNED'` → `reloadPinned()`. Without that last branch the pinned bar only ever showed pins made by this client.
- `ChatPage` runs a second subscriber purely for `receipt.delivered` / `receipt.read` from the *other* party, kept as `Math.max` high-water marks (`peerDelivered`, `peerRead`) that drive the tick indicator. Own-userId receipts are ignored — they prove nothing about the peer. Note `receipt.delivered` has no provider-level handler at all, so this subscriber is its only consumer.

The read marker itself is debounced 600ms, visible-only (`document.visibilityState`), and forward-only via `lastReadSentRef`; it calls `markRead` on the context (optimistic badge zero + `POST /read`). `onConvoPatch` is held in a ref specifically so an inline callback from a caller cannot churn `scheduleRead`'s identity and re-trigger the reload effect.

### Inbox pagination

`PAGE_SIZE = 30`. The rail pages on scroll rather than capping at one page. `loadMoreInbox` guards on `inboxLoadingRef` + `inboxHasMore`, appends `page+1`, **dedupes by id**, then re-sorts with `byRecency` (pinned first, then `lastMessageAt` desc, `lastMessageId` as tiebreak). The dedupe is load-bearing: a conversation bumped to the top of page 0 by a live message is still on the server's page 1 and would arrive twice.

Two nuances worth knowing before you touch this:

- Archived has its own `archivedPageRef`/`archivedLoadingRef`/`archivedHasMore` but reuses the single `inboxLoadingMore` state flag for its spinner, and its appended items are not re-sorted (archived order is server order plus prepends).
- `applyMessageNew`'s `known` check inspects `convosRef` (inbox) only. A message arriving for an **archived** thread takes the `conversations.get()` refetch path, and `upsertConvo` routes it back into the archived list because the DTO has `archived: true`. Conversation lookups for everything else go through `findConvo`, which searches both lists — several call sites used to search only the inbox and silently skipped badge bookkeeping for archived threads.

### Stylesheet ordering

[src/main.jsx](src/main.jsx) imports the base sheets first, then the Warm Archive override layer. `warm/chat.css` is imported after `warm/theme.css`/`core.css`/`social.css` and immediately before `warm/responsive.css`.

Chat's own mobile rules live *inside* [warm/chat.css](src/styles/warm/chat.css), not in the responsive sheet: the single-pane `ch-thread-open` switch is in the `@media(max-width:900px)` block, and the botnav suppression is in a `@media(max-width:720px)` block, as a deliberately split pair —

```css
body:has(.main.ch-main.ch-thread-open) .botnav{ display:none; }
body.chat-thread-open .botnav{ display:none; }
```

The botnav lives outside `<main>`, so no combinator rooted at `.ch-main` can reach it — hence `:has()`. The `:has()` argument is the compound `.main.ch-main.ch-thread-open`, not a bare class, and the two rules are kept separate on purpose: an unsupported `:has()` invalidates its whole selector list and would take the fallback down with it. The fallback hook is a **body** class named `chat-thread-open`, toggled in [ChatPage.jsx](src/pages/ChatPage.jsx) via `document.body.classList.toggle('chat-thread-open', threadOpen)`; `ch-thread-open` itself only ever lands on the page root div.

Most of the `@media` at-rules in the file are `prefers-reduced-motion` companions sitting next to the animation they disable. The viewport/interaction breakpoints are the interesting minority: ≤1180, ≤900, ≤720 (twice), ≤600, ≤460, plus `hover:none`.

The ordering of the whole warm block after the base block is what makes the redesign win at equal specificity: `.main.ch-main` and `.main.wide` ([styles.css](src/styles/styles.css)) are both two-class selectors, so chat's `grid-template-columns` override carries on source order alone.


## Component map and prop contracts

### (a) What each piece is

Routes: `chat`, `chat/requests`, `chat/:id` all mount [ChatPage.jsx](src/pages/ChatPage.jsx); `chat/join/:token` mounts [ChatJoinPage.jsx](src/pages/ChatJoinPage.jsx) (the chat `<Route>` block in [App.jsx](src/App.jsx), where `chat/join/:token` is declared *before* `chat/:id` so "join" is never eaten by the id route).

| Component | Responsibility | File |
| --- | --- | --- |
| `ChatPage` | Two-pane shell: routing, panel exclusivity, receipt marks, jump orchestration, forward/lightbox hosts. Owns exactly one `useThread`. | [ChatPage.jsx](src/pages/ChatPage.jsx) |
| `ChatJoinPage` | POSTs an invite token once (ref-guarded against StrictMode) and `navigate(..., {replace:true})` into the group. | [ChatJoinPage.jsx](src/pages/ChatJoinPage.jsx) |
| `useThread(conversationId)` | Per-conversation message store: Map keyed by id, cursor paging, optimistic send/reconcile, edit/delete/react, pin, gap-sync, read marker. | [useThread.js](src/components/chat/useThread.js) |
| `ConversationList` | Inbox rail: pinned grouping, client-side filter, IntersectionObserver paging, batched presence/avatar resolution. | [ConversationList.jsx](src/components/chat/ConversationList.jsx) |
| `ConversationRow` (local) | One inbox row + its pin/mute/archive/delete Popover menu. | [ConversationList.jsx](src/components/chat/ConversationList.jsx) |
| `ConversationHeader` | Identity bar, live status line (typing > presence > member count), search/info toggles, roving-focus actions menu. | [ConversationHeader.jsx](src/components/chat/ConversationHeader.jsx) |
| `MessageList` | Scroll choreography: stick-to-bottom, prepend anchoring, run grouping, day/unread rules, jump pill, `aria-live` announcer. | [MessageList.jsx](src/components/chat/MessageList.jsx) |
| `MessageBubble` | One message in every shape (TEXT / album / VOICE / FILE / SYSTEM) + reply quote, reactions, receipts, hover rail, long-press sheet. | [MessageBubble.jsx](src/components/chat/MessageBubble.jsx) |
| `MediaBlock`, `VideoTile` (local) | Album/file layout; a video tile that plays a muted preview under a fine pointer (never on touch, reduced-motion or Save-Data) and carries a duration chip. | [MessageBubble.jsx](src/components/chat/MessageBubble.jsx) |
| `VoiceNote` | The voice player: rAF-smooth waveform, drag-scrub, the shared 1×–2× speed cycle, the unheard dot, continuous playback, and the `Infinity`-duration fix for self-recorded WebM. | [VoiceNote.jsx](src/components/chat/VoiceNote.jsx) |
| `VideoPlayer` | The app's video surface — transport, buffered scrubber with hover times, volume, 0.5×–2×, PiP, fullscreen, keyboard and tap-zone gestures. Used by the lightbox. | [VideoPlayer.jsx](src/components/chat/VideoPlayer.jsx) |
| `mediaPrefs` | Playback preferences shared by every player + the heard-voice registry + the DOM-order handoff for continuous playback. | [mediaPrefs.js](src/components/chat/mediaPrefs.js) |
| `callLog` | This device's call history: `recordCall` / `entriesFor` / `statsOf` / `describeCall`, plus the `useConversationCalls` / `useCallStats` bindings. | [callLog.js](src/components/chat/callLog.js) |
| `CallCard` (local) | One ended call as a timeline row; the whole row calls back. | [MessageList.jsx](src/components/chat/MessageList.jsx) |
| `Composer` | Text, attachments (pick/paste/drop), MediaRecorder voice notes, emoji, reply/edit strip. Controlled shell; parent owns sending. | [Composer.jsx](src/components/chat/Composer.jsx) |
| `ConversationInfo` | Details panel: personal toggles, pinned list, shared media, group settings, invite link, roster with role controls. | [ConversationInfo.jsx](src/components/chat/ConversationInfo.jsx) |
| `can()` (local) | Client mirror of the backend `GroupPermissions` matrix — affordance only, server re-checks. | [ConversationInfo.jsx](src/components/chat/ConversationInfo.jsx) |
| `MemberRow` (local) | One roster row + promote/demote/restrict/transfer/remove menu, gated by `can()`. | [ConversationInfo.jsx](src/components/chat/ConversationInfo.jsx) |
| `NewChatModal` | DM picker / group creator; `mode="add"` reuses the picker to add members to an existing group. | [NewChatModal.jsx](src/components/chat/NewChatModal.jsx) |
| `ChatSearchPanel` | Slide-over search, "This chat" vs "All chats", `<mark>` highlighting via split (never innerHTML). | [ChatSearchPanel.jsx](src/components/chat/ChatSearchPanel.jsx) |
| `RequestsPanel` | Message-request inbox: accept / read / decline / block, optimistic in `ChatContext`. | [RequestsPanel.jsx](src/components/chat/RequestsPanel.jsx) |
| `Popover` | Portalled, viewport-fixed anchored menu — the only floating surface primitive in chat. | [Popover.jsx](src/components/chat/Popover.jsx) |
| `Switch` | The `role="switch"` toggle atom. Skinned `.ci-switch`; shared by the info panel and the privacy panel. | [Switch.jsx](src/components/chat/Switch.jsx) |
| `StarredPanel` | Slide-over over `GET /messaging/starred` — my private bookmarks across every conversation. | [StarredPanel.jsx](src/components/chat/StarredPanel.jsx) |
| `ScheduledPanel` | Slide-over over this thread's PENDING send-later queue, with cancel. | [ScheduledPanel.jsx](src/components/chat/ScheduledPanel.jsx) |
| `ChatPrefsPanel` | The three privacy switches, each stating **both** halves of its symmetric effect. | [ChatPrefsPanel.jsx](src/components/chat/ChatPrefsPanel.jsx) |
| `SeenBySheet` | Group "Seen by" for one message; disambiguates "nobody yet" from "your receipts are off". | [SeenBySheet.jsx](src/components/chat/SeenBySheet.jsx) |
| `CallOverlay` | The single call surface — ringer, in-call tiles, control bar, and the collapsed pill. Mounted from [Layout.jsx](src/components/Layout.jsx), not from the chat page. | [CallOverlay.jsx](src/components/chat/CallOverlay.jsx) |
| `StreamTile` (local) | One `<video>` bound imperatively to a `MediaStream`, with an avatar fallback for audio-only peers. | [CallOverlay.jsx](src/components/chat/CallOverlay.jsx) |
| `deleteIntentOf` | Single source of truth for what `DELETE /conversations/{id}` means to *this* user. | [conversationActions.js](src/components/chat/conversationActions.js) |
| `MediaLightbox`, `ForwardPicker` (local) | Full-screen media viewer with focus trap; forward-target sheet filtered to `myStatus === 'ACTIVE'`. | [ChatPage.jsx](src/pages/ChatPage.jsx) |
| `ChannelsPage` | Create / discover / subscribe. Reading and posting happen at `/chat/<channelId>` — a channel *is* a conversation. | [ChannelsPage.jsx](src/pages/ChannelsPage.jsx) |
| `LivePage` | Go live, watch, and the ephemeral live chat. Media rides an external ingest/playback origin. | [LivePage.jsx](src/pages/LivePage.jsx) |

### (b) Prop contracts that are easy to get wrong

**`Composer.onSendText({ body })` — one object, not a string.**
```js
// Composer.submit()
try { await onSendText?.({ body }) } finally { setSending(false) }
// ChatPage
onSendText={({ body }) => { thread.sendText({ body, replyToId: replyTo?.id ?? null }); … }}
```
Call it as `onSendText(body)` and the destructure yields `undefined`; `useThread.sendText` trims `''` and returns early — but the Composer has *already* run `onDraftChange('')`, so the message vanishes and the typed text is gone with it. No toast, no failed bubble.

**`Composer.onSendFiles({ files, body, durationMs })` — same object form, and `durationMs` is voice-only.** The attachment path sends `{ files: payload, body }`; the recorder's `onstop` sends `{ files: [file], body: '', durationMs: secs * 1000 }`. `durationMs` never reaches the server (the multipart endpoint has no duration part) — `useThread.sendFiles` only stamps it on the *optimistic* media so a pending voice bubble shows `0:07` instead of `0:00` until the echo lands. Drop it and voice bubbles flash 0:00; make it positional and the whole payload is `undefined`.

**Return the promise from both handlers if you want the double-send guard.** Composer's `sending` flag exists so the send button can't swap to the MIC between the draft clearing and the request resolving. ChatPage's handlers are block-bodied arrows that do *not* `return thread.sendText(...)`, so `await` resolves on the next microtask and the guard is effectively inert. If you touch this area, return the promise rather than deleting the flag.

**`Composer.conversationId` is a reset key, not decoration.** The Composer does not unmount between chats (same element, new props), so the unmount teardown never fires on a switch. The `[conversationId]` effect — the file calls it "focus + reset when the conversation or context changes" ([Composer.jsx](src/components/chat/Composer.jsx)) — is what aborts an in-flight `MediaRecorder`. Remove or stabilise that prop and a voice note started in chat A is delivered into chat B.

**`ConversationList.onOpen(convo.id)` — an ID, never the object.** Both the row click and its `Enter`/`Space` handler call `onOpen(convo.id)`; ChatPage's `onSelect` does `navigate('/chat/' + cid)`. Pass the object and you navigate to `/chat/[object Object]`, `getConvo(id)` misses, the direct fetch 404s and the pane renders the ErrorState. Note the asymmetry: `RequestsPanel.onOpen` is also called with an id (`req.conversationId`), but ChatPage defensively normalises *that* one only:
```js
<RequestsPanel onOpen={(c) => { const cid = typeof c === 'string' ? c : c?.id ?? c?.conversationId; … }}/>
```
Do not read that leniency as the list's contract.

**`MessageBubble.onReact(messageId, emoji)` — id first, every *other* callback gets the whole message.** `onReply / onEdit / onDelete / onForward / onPin / onUnpin / onRetry` receive `msg`; `onReact` receives `msg.id` (from the reaction chips, the quick-react strip and the long-press sheet alike), and `onJumpTo` receives a bare `msg.replyTo.messageId`. ChatPage absorbs the id/object ambiguity with `m.id ?? m` for delete/pin/unpin/react, but not for the state-setting ones. Swap `onReply?.(msg)` to `onReply?.(msg.id)` and the reply strip loses `replyTo.sender`/`body`, and `replyToId: replyTo?.id ?? null` becomes `null` — the reply silently degrades into a plain message. Swap `onRetry?.(msg)` to an id and `useThread.retry` finds no `clientNonce`, returns early, and "Tap to retry" becomes a dead button with no error.

**`MessageList.pinnedIds` accepts a `Set` (or any iterable) of ids in the *canonical string* form.** ChatPage builds its `pinnedIds` memo as `new Set((thread.pinned || []).map(m => m.id))`; MessageList re-wraps it in its own `pinnedSet` memo, `React.useMemo(() => new Set(pinnedIds || []), [pinnedIds])`, which is why a Set, an array, or `undefined` all work. What does not work is a *number*: `msgFrom` runs every id through `mid()` ([chat.js](src/api/chat.js)), so `pinnedSet.has(m.id)` is a strict string lookup. Feed it `123` and `isPinned` is always false — the bubble menu offers "Pin" on an already-pinned message. Also keep the prop referentially stable (ChatPage memoises on `thread.pinned`); an inline `new Set(...)` in JSX rebuilds the memo every render.

**`peerDelivered` / `peerRead` are high-water *id marks*, not per-message flags.** They live in ChatPage, reset to `null` on `[id]`, and only ever climb — through `maxId`, because they are Snowflake strings:
```js
if (evt.type === 'receipt.delivered') setPeerDelivered(v => maxId(v, evt.messageId || null))
if (evt.type === 'receipt.read')      setPeerRead(v => maxId(v, evt.lastReadMessageId || null))
```
MessageBubble derives the ladder in its `receipt` block with `gteId(peerRead, msg.id) ? Read : gteId(peerDelivered, msg.id) ? Delivered : Sent` ([MessageBubble.jsx](src/components/chat/MessageBubble.jsx)). Four ways to break it: (1) assign instead of `maxId` — an out-of-order frame regresses every tick from Read back to Sent; (2) drop the `String(evt.userId) === String(myId)` skip — your own receipts mark your own messages read; (3) pass a boolean — `gteId(true, …)` is meaningless, so everything pins to "Sent"; (4) go back to `Math.max` / `>=` — that coerces 18-digit ids to lossy doubles and compares ids of different lengths lexicographically.

They are **seeded** from `convo.peerLastReadMessageId` / `peerLastDeliveredMessageId` in a separate effect, which is what closed the old "lone Sent tick on your whole history until the peer emits a fresh receipt" behaviour. That seed is still a max, for reason (1): a conversation refetch landing after a live receipt must not regress the ladder. Those two fields are DIRECT-only and come back `null` when **either** side has read receipts off — "nothing known" — and the accompanying `receiptsOff` prop is what re-labels the tick so a privacy setting doesn't read as an undelivered message.

**The peer's marks are also persisted onto the conversation row.** ChatContext's `onRead` / `onDelivered` patch `peerLastReadMessageId` / `peerLastDeliveredMessageId` for DIRECT threads when the receipt is *not* mine. Without that, the marks only existed inside the ChatPage mount that saw them: walk to another conversation and back, and every "Seen" tick fell back to whatever the stale DTO said.

**Related single-shot marks.** `unreadFrom` is pinned once per conversation (`unreadPinnedFor` ref), and the value is conditional:
```js
// ChatPage, inside the unreadPinnedFor effect
setUnreadFrom(convo.unreadCount > 0 ? (convo.lastReadMessageId || '0') : null)
```
Only a conversation opened *with* unread messages gets a marker; an already-read one is pinned to `null`, and the unread-placement test inside MessageList's row-building memo requires a truthy `unreadFrom` (`!unreadPlaced && unreadFrom && gtId(m.id, unreadFrom) && …`), so no unread rule renders at all. The fallback is the **string** `'0'`, not the number: a first-ever-unread thread has no `lastReadMessageId`, and numeric `0` is falsy — that guard then dropped the rule in exactly the case it exists for. The test is `gtId`, not `>=`: `unreadFrom` is the last *read* id, so the rule belongs above the first message strictly after it. Either way the value is deliberately frozen so the rule doesn't slide as receipts land. `flashId` (`pendingJump`) uses a null-then-id protocol: `onJump` sets `null` *before* calling `thread.jumpTo` so re-jumping to the same id re-triggers MessageList's `flashedRef`-guarded scroll. Collapse that to a single `setPendingJump(id)` and the second jump to the same message does nothing.

**Two different jump signatures.** `MessageList/MessageBubble.onJumpTo(messageId)` is one argument (ChatPage closes over the current `id`); `ChatSearchPanel.onJump(messageId, conversationId)` is two, because a global hit can live in another thread and must route first via `deferredJump`.

**`useThread` is instantiated exactly once, in ChatPage.** Its second parameter `{ onConvoPatch }` exists but is unused at the only call site, `useThread(id || null)` in [ChatPage.jsx](src/pages/ChatPage.jsx). Calling the hook again inside `MessageList` or `Composer` gives you a second, independently-loading store: optimistic sends appear in one copy and not the other.

### (c) The shared `Popover`

Most mounts open from inside an `overflow-y: auto` container — `.ch-scroll` (thread; both bubble mounts), `.chat-list` (rail), `.ci-body` (info panel). Per CSS, a non-`visible` value on one axis computes the other to `auto`, so both axes clip: an absolutely-positioned menu was sliced at the edges and, near the bottom, extended the scrollable area and made the list jump. The rest sit in `flex:0 0 auto` chrome with no overflow of its own and are clipped for different reasons — the header menu by the stacking context the `.ch-hd` rule's own `backdrop-filter` creates ([chat.css](src/styles/warm/chat.css)), the emoji picker by the shell's `.main.ch-main { overflow:hidden }` on short viewports — but every one of them takes the same escape hatch.

`Popover` renders through `createPortal(..., document.body)` with `position: fixed`, placed from the trigger's `getBoundingClientRect()`. It flips bottom↔top, clamps to the viewport with an 8px margin, re-measures on `scroll` (capture: true, to catch inner scrollers) and `resize`, and stays `visibility: hidden` at `-9999px` until measured so it never flashes at the wrong spot. `<body>` is the portal target precisely because it has no transformed ancestor — `position: fixed` would otherwise resolve against one.

The mounts span the thread, the rail, the header, the info panel and the composer. The action menus — none of them passes a `role`, so each inherits Popover's default `role="menu"` and fills it with `role="menuitem"` buttons:

| Menu | File | Why portalled |
| --- | --- | --- |
| Conversation actions (mute/pin/archive/leave) | [ConversationHeader.jsx](src/components/chat/ConversationHeader.jsx) | the header sets `backdrop-filter`, whose stacking context sealed the menu *below* the thread's positioned bubbles |
| Inbox row actions | [ConversationList.jsx](src/components/chat/ConversationList.jsx) | clipped by `.chat-list` |
| Roster member actions | [ConversationInfo.jsx](src/components/chat/ConversationInfo.jsx) | clipped by `.ci-body` |
| Message "More" | [MessageBubble.jsx](src/components/chat/MessageBubble.jsx) | clipped by `.ch-scroll` |

The quick-react strip (`.ch-quickreact` in [MessageBubble.jsx](src/components/chat/MessageBubble.jsx), `prefer="top"`, `align` mirrors `mine`, also clipped by `.ch-scroll`) is another menu, not an exception: like the four above it passes no `role`, so it too inherits Popover's default `role = 'menu'` ([Popover.jsx](src/components/chat/Popover.jsx)) and each emoji button carries `role="menuitem"`. The emoji picker (`.ch-emoji` in [Composer.jsx](src/components/chat/Composer.jsx)) is the only mount that overrides the default — `role="dialog"` — and the only genuine non-menu surface. If you restyle `.ch-quickreact` as a toolbar, set the `role` at the call site too; the current markup promises menu semantics.

The corollary every call site documents: **do not add a local outside-click handler.** Because the panel lives on `<body>`, a `wrapRef.contains(e.target)` test reads every click *inside* the menu as an outside click and dismisses it before the item runs. Popover owns outside-`pointerdown` (capture, so it closes before the underlying click lands) and Escape; it also ignores pointerdowns on the anchor so the trigger can toggle itself. `ConversationHeader` keeps its own Escape listener only to restore focus to the trigger.

### (d) `deleteIntentOf(convo)` and its three outcomes

`DELETE /conversations/{id}` is overloaded, and the blast radius depends on who you are. [conversationActions.js](src/components/chat/conversationActions.js) turns `{ isGroup, myRole, displayTitle, memberCount, peer }` into `{ destroysForEveryone, label, title, message, confirmLabel }`:

| Input | `destroysForEveryone` | Menu label / confirm | What the server does |
| --- | --- | --- | --- |
| `isGroup && myRole === 'OWNER'` | `true` | "Delete group" / "Delete for everyone" | soft-deletes the group **for every member**; irreversible |
| `isGroup && myRole !== 'OWNER'` | `false` | "Clear and hide" / "Clear for me" | per-member `clearedBeforeMessageId` — hides it from your inbox *and* archived list, unpins, zeroes unread; returns on the next message showing only newer ones |
| DIRECT (either side) | `false` | "Delete chat" / "Delete for me" | same one-sided clear; the peer keeps their copy and is not notified |

Its consumers: the inbox row menu (`ConversationRow` in [ConversationList.jsx](src/components/chat/ConversationList.jsx)) and the info panel's danger row via `ChatPage.onLeaveOrDelete` ([ChatPage.jsx](src/pages/ChatPage.jsx)), which calls the helper and additionally routes non-owner group members to `api.chat.members.leave` instead. The point of centralising it: a call site that labelled this "Hide group" would let an owner destroy a group while believing they were tidying their inbox. `destroysForEveryone` is also what picks the success toast ("Group deleted" vs "Conversation cleared"). Distinct from `POST /archive`, which only moves a conversation to the archived list.

`ConversationHeader.doDelete` is the one surface that does **not** use the helper — it hard-codes "Delete chat / This cannot be undone", and it is only reachable for DMs (the `convo.isGroup` branch of its `items` memo pushes "Leave group" instead, [ConversationHeader.jsx](src/components/chat/ConversationHeader.jsx)), so today it is correct by construction. Add a group case to that menu and it becomes the exact mislabel the helper exists to prevent.


## The stylesheet: vocabulary, stacking, responsive

All chat styling lives in one file, [chat.css](src/styles/warm/chat.css), organised into numbered sections (§1 Shell → §12 media viewer). It is loaded **last but one** in [main.jsx](src/main.jsx) — after the base sheets (`styles.css` → `styles-responsive.css`) and after the whole `warm/` override layer, before only `warm/responsive.css`. That position is load-bearing: several chat rules beat base rules on source order alone, not specificity (see the `.ch-pop` note below).

Chat also reads, but does not own, the token layer in [theme.css](src/styles/warm/theme.css) — `--ink/--ink-soft/--muted`, `--paper/--paper-2/--card/--card-2`, `--line/--line-soft`, `--navy/--navy-deep/--blue/--blue-wash`, `--gold/--gold-deep/--gold-wash`, `--brass-soft/--brass-tint`, `--good/--danger`, `--shadow-sm/--shadow/--shadow-lg`, `--r-xl`, `--serif/--sans/--mono`. The file's header comment claims "no hardcoded palette values except the two translucent inks"; in practice literal hexes are scattered through it — `#faeeec` danger washes, `#e8cfcb` danger borders, `#8fd0ff`/`#a9dcff` read ticks, `#f7f3ea`/`#f5f1e8` on-navy inks — because they need an opacity or a tint no token carries. Add new colours as tokens, not literals.

### Class-name vocabulary by area

Four prefixes — `ch-`, `cv-`, `rq-`, `ci-` — and a handful of legacy names that break the scheme.

| Prefix | Area | Representative classes |
| --- | --- | --- |
| `ch-main`, `ch-pane` | shell / page grid | `.main.ch-main` + state classes `.ch-thread-open`, `.ch-info-open`, `.ch-solo`; `.ch-pane`, `.ch-pane-list`, `.ch-pane-thread` |
| `cv-` | one conversation row in the inbox rail | `.cv-row` (`.active`, `.unread`, `.muted-row`), `.cv-av`, `.cv-medallion`, `.cv-dot`, `.cv-body`, `.cv-line1/2`, `.cv-name`, `.cv-time`, `.cv-preview` (`.typing`), `.cv-badge` (gold gradient, `key={count}` remount replays chBadgeIn), `.cv-unread-dot`, `.cv-typing-ico`, `.cv-flags`, `.cv-menu-host/-menu/-menu-btn`, `.cv-more`, `.cv-skel*` |
| `rq-` | message requests | `.rq-row`, `.rq-body`, `.rq-name`, `.rq-handle`, `.rq-meta`, `.rq-actions`, `.rq-btn` (`.primary`, `.danger`) |
| `ch-hd-` | thread header | `.ch-hd`, `.ch-hd-back`, `.ch-hd-id`, `.ch-hd-medallion`, `.ch-hd-dot`, `.ch-hd-name/-sub`, `.ch-hd-actions/-act`, `.ch-hd-menu-wrap`, `.ch-hd-menu` |
| `ch-pinbar-` | pinned-message strip | `.ch-pinbar`, `-main`, `-body`, `-label`, `-text`, `-count`, `-x` |
| `ch-` (thread) | message list | `.ch-scrollwrap`, `.ch-scroll` (`.no-anim`), `.ch-msgs`, `.ch-day`, `.ch-unread-rule`, `.ch-older`, `.ch-start`, `.ch-jump`/`.ch-jump-n` |
| `ch-` (bubble) | one message | `.ch-row` (`.mine`, `.run-start`, `.run-end`), `.ch-row-av`, `.ch-stack`, `.ch-sender`, `.ch-bubble` (`.pending`, `.failed`, `.deleted`, `.media-only`, `.flash`), `.ch-text`, `.ch-meta`, `.ch-quote*`, `.ch-fwdmark`, `.ch-media.n-1…n-4`, `.ch-asset*`, `.ch-file*`, `.ch-voice*`/`.ch-wave*`, `.ch-reacts`/`.ch-react`, `.ch-retry`, `.ch-system`, `.ch-receipt`/`.ch-tick` (`.seen`, `.ch-tick-1/2` — the receipt SVG), `.ch-typing*` (`.with-ico`, `.act-recording_voice`, `.ch-typing-eq`, `.ch-typing-label`), `.ch-ell` (shared animated ellipsis: rail preview, header status, thread caption) |
| `ch-tool*` | hover action rail + its popovers | `.ch-tools`, `.ch-tool`, `.ch-tool-wrap`, `.ch-tool-menu`, `.ch-quickreact`, `.ch-qr` |
| `ch-menu-*`, `.ch-pop` | shared menu skin + portal wrapper | `.ch-menu-item` (`.danger`), `.ch-menu-sep`, `.ch-pop` |
| `ch-` (composer) | composer | `.ch-composer` (`.dropping`), `.ch-ctx*` (`.editing`), `.ch-tray*`, `.ch-inputrow`, `.ch-cbtn`, `.ch-inputwrap`, `.ch-input`, `.ch-send`, `.ch-rec*`, `.ch-emoji-wrap`, `.ch-emoji*`, `.ch-locked` |
| `ci-` | conversation info panel | `.ci-head`, `.ci-body`, `.ci-hero*`, `.ci-medallion`, `.ci-section`, `.ci-label`, `.ci-row` (`.click`, `.danger`), `.ci-switch`, `.ci-select`, `.ci-member*`, `.ci-tag` (`.owner`/`.admin`/`.restricted`), `.ci-invite*`, `.ci-grid*`, `.ci-pin*` |
| `ch-search-`, `ch-hit*` | search slide-over | `.ch-search`, `-head`, `-tabs`, `-field`, `-clear`, `-body`, `-hint`; `.ch-hitrow*`, `.ch-hit` (the `<mark>` tint) |
| `ch-modal-`, `ch-u*` | new-chat / add-people modal | `.ch-modal-overlay`, `.ch-modal`, `-head/-tabs/-body/-foot/-count`, `.ch-chips`, `.ch-chip-x`, `.ch-ulist`, `.ch-urow*` |
| `ch-fwd-` | forward picker | `.ch-fwd-overlay`, `.ch-fwd`, `-head/-snip/-q/-list/-row/-nm/-empty` |
| `ch-sheet*` | long-press touch sheet | `.ch-sheet-scrim`, `.ch-sheet`, `.ch-sheet-reacts` |
| `ch-lightbox*` | media viewer | `.ch-lightbox`, `-x`, `-dl`, `-nav` (`.prev`/`.next`), `-n` |
| `vp-` | the video player (chat-extras.css §13) | `.vp` (`.vp-chrome`, `.vp-playing`, `.vp-full`), `.vp-video`, `.vp-big`, `.vp-center`, `.vp-spin`, `.vp-nudge` (`.back`/`.fwd`), `.vp-bar`, `.vp-track`, `.vp-buffered`, `.vp-played`, `.vp-knob`, `.vp-hover`, `.vp-ctls`, `.vp-btn` (`.dim`, `.on`), `.vp-vol`, `.vp-volrange`, `.vp-time`, `.vp-rate`, `.vp-speedmenu`, `.vp-lightbox` |

Four more families live in [chat-extras.css](src/styles/warm/chat-extras.css), not in chat.css:

| Prefix | Area | Representative classes |
| --- | --- | --- |
| `cl-` | calls | `.cl-overlay` (`.ringing`), `.cl-frame`, `.cl-head*`, `.cl-stage.n-1…n-4`, `.cl-tile` (`.audio-only`, `.speaking`), `.cl-video` (`.mirrored`), `.cl-self`, `.cl-await*`, `.cl-bar`, `.cl-ctl` (`.off`), `.cl-btn` (`.accept`/`.decline`/`.wide`), `.cl-pill*` |
| `cn-` | channels | `.cn-page`, `.cn-head`, `.cn-title`, `.cn-sub`, `.cn-section*`, `.cn-chip*`, `.cn-search`, `.cn-grid`, `.cn-card*`, `.cn-field`, `.cn-handle`, `.cn-hint` (`.bad`) |
| `lv-` | live streaming | `.lv-page`, `.lv-grid`, `.lv-card*`, `.lv-badge` (`.sm`), `.lv-dot`, `.lv-room`, `.lv-main`, `.lv-stage`, `.lv-video`, `.lv-hls`, `.lv-ended`, `.lv-meta*`, `.lv-ingest*`, `.lv-note`, `.lv-chat*`, `.lv-line*` |
| `botnav-` | the mobile Messages tab badge | `.botnav-ico`, `.botnav-dot` — global by necessity: `.botnav` lives outside `<main>`, so no page-scoped selector can reach it |

Newer `ch-*` / `ci-*` members, all in chat-extras.css: the voice player (`.ch-voice-foot`, `.ch-voice-rate`, `.ch-voice-new`, `.ch-voice-spin`, `.ch-wave-layer` (`.played`), `.ch-wave-head`), the tombstone (`.ch-deleted-note`, `.ch-deleted-ico`), the video-tile duration chip (`.ch-asset-dur`), the timeline call card (`.ch-callcard*`), the connection banner (`.ch-netbar` with `.off`/`.wait`/`.ok`) and the info panel's call history (`.ci-callstats`, `.ci-stat`, `.ci-callsplit`, `.ci-calllist`, `.ci-callrow*`).

Earlier `ch-*` / `ci-*` members added alongside the extras families: `.ch-meta-star`, `.ch-sched-btn`/`.ch-sched-n`, `.ch-schedpop*`, `.ch-ttlnote`, `.ch-hd-kind`, `.ch-hd-ttl`, `.ch-list-tools`, `.ch-popout`, `.ch-prefrow`/`.ch-prefs-foot`, `.ch-schedrow*`, `.ch-seen*`, `.ci-hero-desc`, `.ci-note`.

**Search traps.** A few names use `chat-`, not `ch-`, and will not be found by grepping `ch-`: `.chat-list` (the scrolling rail, §2), `.chat-group-label` (§2), `.chat-info` (the info panel root, §7) and the body-level `body.chat-thread-open` (§10). Also, `.ch-search-field` is shared: it skins the slide-over in [ChatSearchPanel.jsx](src/components/chat/ChatSearchPanel.jsx) *and* the person-search box inside [NewChatModal.jsx](src/components/chat/NewChatModal.jsx), via the `.ch-modal-body .ch-search-field{margin:12px 0 0}` override in §9. Restyling "the search field" changes both.

Two non-chat surfaces live in the file and are easy to delete by accident, both in **§10.4 · Topbar unread bubble**: the topbar unread badge `.icon-btn .count` (`.count` has no styles anywhere else in the codebase, so without this the number renders as bare text below the icon), and `.sr-only`, which is still inside §10.4 — §10.5 · Motion & focus polish has not opened yet. `.sr-only` is the only visually-hidden utility in the project; the live region and the typing announcement depend on it. §10.4 also re-declares `.icon-btn{position:relative}`, but that one is *not* load-bearing: [core.css](src/styles/warm/core.css) already sets `position:relative` on `.icon-btn` to anchor the unread dot everywhere.

### The naming trap: `.ch-fwd` vs `.ch-fwdmark`

They are unrelated surfaces that sort next to each other alphabetically:

- `.ch-fwd`, `.ch-fwd-overlay`, `.ch-fwd-head|snip|q|list|row|nm|empty` — the **forward-target picker modal**, rendered in [ChatPage.jsx](src/pages/ChatPage.jsx). Full-screen overlay at z 130, `max-width:440px` (§9).
- `.ch-fwdmark` — the small italic "Forwarded" badge **inside a bubble**, rendered by [MessageBubble.jsx](src/components/chat/MessageBubble.jsx), styled in §5.

The picker classes all carry a hyphen after `fwd`; the badge deliberately does not. Never write a prefix selector like `[class^="ch-fwd"]` — it hits both. The comment above `.ch-fwdmark` flags the collision by name only (`/* forwarded marker (NOT .ch-fwd — that is the forward-target picker) */`); it says nothing about attribute selectors, so the prefix-selector hazard is undocumented in the file. Keep the comment and, if you touch it, add the selector warning.

### Shell geometry: `--ch-top` and `--ch-bottom`

```css
.main.ch-main{ --ch-top:60px; --ch-bottom:0px; position:relative; padding:0;
  display:grid; grid-template-columns:minmax(280px,340px) minmax(0,1fr);
  height:calc(100vh - var(--ch-top)); height:calc(100dvh - var(--ch-top));
  overflow:hidden; }
```

(§1 · Shell.) Chat opts out of document-flow scrolling: the panes scroll, the page does not, so the composer can stay pinned. That requires an exact height, which means the topbar offset must be exact. `.topbar` is `height:60px` ([styles.css](src/styles/styles.css)) but becomes `calc(56px + var(--safe-t))` at ≤720 ([styles-responsive.css](src/styles/styles-responsive.css)). **`--ch-top` is a variable precisely so the ≤720 block can rewrite one number** instead of duplicating the whole `height` calc; hardcoding 60 left the composer clipped below the fold on notched devices.

`.main.ch-main` must stay a **two-class selector** because the page root is `'main wide ch-main'` (`rootCls` in [ChatPage.jsx](src/pages/ChatPage.jsx)): `.main.wide{grid-template-columns:minmax(0,1fr)}` (styles.css) is also `(0,2,0)`, so a single `.ch-main` at `(0,1,0)` would lose the grid outright. It would *not* lose the padding fight — `.main{padding:14px 14px calc(88px + var(--safe-b))}` at ≤720 (styles-responsive.css) is `(0,1,0)` too, media queries add no specificity, and chat.css is imported after styles-responsive.css, so `.ch-main{padding:0}` would still win on source order. `.main.wide` is the one that actually forces the two classes.

`--ch-bottom` is declared once on `.main.ch-main` and **never read** — nothing in `src/` consumes it. Its stated job (clearing the botnav in list view) is actually done by the `padding-bottom` reservation on `.chat-list` in the ≤720 block. Treat it as dead; if you re-introduce a bottom offset, wire it into the `height` calc rather than leaving two mechanisms.

### The z-index ladder

Chat's floating surfaces interleave with app chrome defined in **four** other files — styles.css, styles-responsive.css, styles-content.css and styles-richtext.css. Full ladder, low to high:

| z | Selector | Defined in | Notes |
| --- | --- | --- | --- |
| 2 | `.ch-reacts`, `.ch-bubble.media-only .ch-meta` | chat.css §5 | reaction chips overlap the bubble's bottom edge via `margin-top:-6px` |
| 14 | `.ch-jump` | chat.css §5 | jump-to-bottom pill |
| 20 | `.ch-pinbar` | chat.css §4 | |
| 30 | `.ch-hd` | chat.css §4 | thread header |
| 50 | `.topbar` | styles.css | `position:sticky` |
| 60 | `.botnav` | styles.css | `position:fixed`, `display:flex` only ≤720 |
| 60 | `.ch-hd-menu` | chat.css §4 | **inert** — always co-classed with `.ch-pop` ([Popover.jsx](src/components/chat/Popover.jsx) emits `'ch-pop ' + className`), which wins at 100 |
| 80 | `.ch-search` | chat.css §4 | slide-over, `position:absolute` inside `.ch-main` |
| 90 | `.chat-info` | chat.css §10 | **only** inside `@media(max-width:900px)`; a plain grid column on desktop |
| 100 | `.ch-pop` | chat.css §5 | every portalled menu **and** the emoji picker |
| 155 | `.ch-pop.vp-speedmenu` | chat-extras.css §13 | the video speed menu opens from inside the lightbox (150), so it needs its own rung; two classes, so it beats `.ch-pop` without `!important` |
| 170 | `.ch-pop.cl-devmenu` | chat-extras.css §18 | same reasoning against the call overlay (160) |
| 115 | `.nav-scrim` | styles-responsive.css | mobile drawer backdrop (≤720) |
| 118 | `.sidebar` drawer | styles-responsive.css | mobile nav drawer (≤720) |
| 120 | `.overlay` | styles.css | app modal base |
| 120 | `.lightbox` | styles-content.css | the *app* lightbox, not chat's |
| 130 | `.ch-modal-overlay`, `.ch-fwd-overlay` | chat.css §9 | |
| 140 | `.ch-sheet-scrim` | chat.css §5 | long-press action sheet |
| 150 | `.ch-lightbox` | chat.css §12 | chat media viewer |
| 200 | `.dlg-overlay` | styles-richtext.css | `uiConfirm`/`uiPrompt` host |
| 200 | `.toast` | styles.css | |

**Hard rule: nothing in chat may exceed 199.** `.dlg-overlay` and `.toast` are 200 and are the app's permanent ceiling. Every destructive chat action (leave group, delete message, block) raises a confirm dialog and most raise a toast on completion — if a chat surface out-stacked 200, that dialog would render *behind* the sheet or modal that spawned it and the flow would deadlock. The ordering also matters below the ceiling: a menu (100) must clear the topbar (50) and botnav (60), but must sit under every overlay (≥120) so it can never float over a modal that replaced it.

Two ladder facts the in-file ladder comment in §12 gets wrong — the comment is stale, the code is right. It lists `70 .ch-emoji`; `.ch-emoji` carries **no** z-index today because it portals through [Popover.jsx](src/components/chat/Popover.jsx) and inherits `.ch-pop`'s 100. It also lists 100 before 70/80/90, which reads as a hierarchy error. Fix the comment, not the values.

**Fragile-by-source-order:** `.ch-pop{z-index:100}` and `.ch-hd-menu{z-index:60}` have identical specificity `(0,1,0)`. The portalled header menu only lands at 100 because `.ch-pop` appears *later in the same file* (§5, well below the §4 menu skin). Moving the `.ch-pop` block upward silently drops every header/row/member menu to 60 — below the mobile botnav.

### Rules that exist to prevent clipping — do not "tidy" these

1. **`.ch-hd{position:relative;z-index:30}`**. The header sets `backdrop-filter`, which **creates a stacking context**. Without the explicit z-index the header's own dropdown was sealed inside that context and painted *behind* the thread's `position:relative` bubbles. `.ch-pinbar{position:relative;z-index:20}` is **not** the same case — it has no `backdrop-filter` anywhere; it is simply the next rung down, sitting between the header (30) and the thread, exactly as its own comment says ("Same reasoning: the pinned bar sits between the header and the thread").
2. **`.ch-scrollwrap`**. The scroller and the floating pill are siblings inside this wrapper. `.ch-jump` cannot live inside `.ch-scroll`: an absolutely-positioned child of a scroll container resolves against the *scrolled content box*, so the pill would drift up the page as you scroll instead of hovering.
3. **`.ch-pop.ch-pop{ inset-*:auto; right:auto; bottom:auto; margin:0 }`**. The Popover wrapper carries both `.ch-pop` and a *skin* class that may bring its own placement: `.ch-hd-menu` is `position:absolute; inset-block-start:calc(100% + 6px); inset-inline-end:0` and `.cv-menu` is `inset-block-start:38px; inset-inline-end:6px`. JS supplies `position:fixed` + `top`/`left` inline; a surviving `right`/`bottom` from the skin would stretch the box between two opposite edges. The class is doubled to out-specify every skin without `!important`. Deleting the "redundant-looking" duplicate breaks every mount that carries a placement-bearing skin — [ConversationHeader.jsx](src/components/chat/ConversationHeader.jsx) (`"ch-hd-menu"`), [ConversationList.jsx](src/components/chat/ConversationList.jsx) (`"ch-hd-menu cv-menu"`) and [ConversationInfo.jsx](src/components/chat/ConversationInfo.jsx) (`"ch-hd-menu"`). The other portal skins — `.ch-tool-menu`, `.ch-quickreact` and `.ch-emoji` — declare no inset or margin at all, so the reset is a no-op for them.
4. **`min-width:0` / `min-height:0` on every flex and grid child** — `.ch-pane`, `.chat-list`, `.ch-scroll`, `.ch-stack`, `.cv-body`, `.ci-body`, `.ch-search-body`, `.ch-modal-body`, `.ch-fwd-list`, `.ch-scrollwrap`. Flex items default to `min-size:auto`, refuse to shrink below content, and the ellipsis truncation plus the inner scrollers both stop working. These look like noise; they are not.
5. **`.ch-tools` and `.cv-menu-btn` hide with `opacity:0`, never `display:none`** (in §5 and §2, and again in the ≤720 block of §10). `display:none` removes them from the tab order — which also disarms the very rules that reveal them, `.cv-menu-host:focus-within`/`.cv-menu-btn:focus-visible` and `.ch-row:focus-within .ch-tools`, since focus can never land there in the first place. At ≤720 the comment above that rule spells out the payload: reply/react/forward/delete would be unreachable for anyone on a keyboard.
6. **`.ch-menu-item:focus-visible` keeps a real ring.** An earlier `outline:0` here cancelled the global focus style across all four menus that share the class — the rationale is preserved in the comment above the rule.
7. **The `content-visibility:auto` note in §10.5.** It was tried and removed: it makes off-screen row heights estimates, and MessageList's prepend-anchoring restores scroll from measured `scrollHeight`. Re-adding it makes "load earlier" jump.

### Responsive: one pane at a time

Most of the file's `@media` at-rules are `prefers-reduced-motion`. The rest are five distinct width breakpoints (720 appears twice) plus a `hover:none` block: `max-width:1180px` (§1); `900px`, `720px`, `460px` and `hover:none` (all in §10); a second `720px` (§10.4); and `600px` (at the tail of §12).

**≤1180px** — the info panel loses its third column and the two remaining columns narrow, from `minmax(280px,340px)` to `minmax(260px,300px)`.

**≤900px (§10)** — the grid collapses to `minmax(0,1fr)` and exactly one pane renders:

```css
.main.ch-main.ch-thread-open .ch-pane-list{ display:none; }
.main.ch-main:not(.ch-thread-open) .ch-pane-thread{ display:none; }
```

`ch-thread-open` is composed into the root className by `rootCls` in [ChatPage.jsx](src/pages/ChatPage.jsx), from `threadOpen = !!id && !isRequests`, so **the pane switch is a pure CSS consequence of the URL** — nothing unmounts, nothing refetches, thread state survives a back-and-forth. Also at this breakpoint `.chat-info` stops being a grid column and becomes `position:absolute;inset:0;z-index:90` — which is why `.main.ch-main` carries `position:relative` (it is also the containing block for `.ch-search`, absolute at *all* widths). `.ch-hd-back` flips from `display:none` to `inline-flex`; it is the only way back to the rail.

**≤720px (§10)** — phone. `--ch-top` is rewritten; `.chat-list` reserves `calc(72px + var(--safe-b,0px))` of bottom padding *only in list view* (`:not(.ch-thread-open)`) because the fixed botnav at z 60 otherwise crops the last conversation row; the composer picks up `env(safe-area-inset-bottom)`; and both modals become bottom sheets (`align-items:flex-end`, `border-radius:20px 20px 0 0`, `chSheetUp`). A second ≤720 block in §10.4 shrinks the topbar unread bubble.

**The botnav problem.** `.botnav` is fixed and lives **outside** `<main>`, so no combinator rooted at `.ch-main` can reach it. Inside a thread it would sit on top of the composer. The fix is two deliberately separate rules in §10:

```css
body:has(.main.ch-main.ch-thread-open) .botnav{ display:none; }
body.chat-thread-open .botnav{ display:none; }
```

The `:has()` argument is the full compound `.main.ch-main.ch-thread-open`, not a bare `.ch-thread-open`. The body class is toggled by an effect in [ChatPage.jsx](src/pages/ChatPage.jsx) (`document.body.classList.toggle('chat-thread-open', threadOpen)`) as the fallback for engines without `:has()`. **They must stay as two rules.** An unsupported `:has()` invalidates its entire selector list at parse time — merged into one comma list, the unsupported selector would take the working fallback down with it and the nav would cover the composer on exactly the engines the fallback exists for. Both selectors are ≥ `(0,2,0)` so they beat `@media(max-width:720px){.botnav{display:flex}}` in styles.css.

**≤460px** — bubble max-width to 90%, gutter avatar to 26px, emoji picker clamped to `min(288px, calc(100vw - 32px))`.

**≤600px** — the only breakpoint that is *not* with the others; it sits at the very end of the file inside §12 and touches nothing but the chat lightbox (padding to 12px, nav buttons to 38px, download label hidden). If you are auditing breakpoints by reading §10, you will miss it.

**`@media(hover:none)`** re-declares `.cv-menu-btn{display:inline-flex;background:transparent;border-color:transparent}`. Note this block does **not** reset the base `opacity:0`, despite its comment ("keep the row menu button visible"). On touch the row menu button is currently an invisible-but-tappable target that only becomes visible via `:focus-within`/`[aria-expanded]` after the first tap. If you intend the documented behaviour, add `opacity:1` here — do not instead remove `opacity:0` from the base `.cv-menu-btn` rule in §2, which would make the button permanently visible on desktop.

### Motion and RTL

§10.5 gives `.ch-row` a `chRise` entry animation and cancels it with `.ch-scroll.no-anim` — set by [MessageList.jsx](src/components/chat/MessageList.jsx) (`'ch-scroll' + (bulk ? ' no-anim' : '')`) during bulk/history renders so "load earlier" does not cascade 50 bubbles.

The reduced-motion coverage is **not** complete, so do not assume the pairing exists when you edit an animated rule. The `prefers-reduced-motion:reduce` blocks cover `.ch-search`, `.ch-scroll` scroll-behavior, `.ch-tool-menu`/`.ch-quickreact`, `.ch-sheet`, `.ch-typing-dot`, `.ch-rec-dot`, the skeleton shimmer, `.ch-modal`/`.ch-fwd`, and `.ch-row` plus the shared transition set. Several animated rules have no reset at all: `.ch-hd-menu` (chPop), `.ch-bubble.flash` (chFlash), `.ch-sheet-scrim` (chFade — only the sheet itself is reset), `.ch-jump` (chPop), `.ch-emoji` (chPop), `.ch-modal-overlay`/`.ch-fwd-overlay` (chFade — again only the boxes are reset), and `.ch-lightbox` (chFade). One more escapes by source order: the ≤720 bottom-sheet re-declaration `.ch-modal,.ch-fwd{animation:chSheetUp…}` in §10 has the same specificity as the §9 reset but comes later, so on a phone with reduced motion the sheet still slides. Pair every new animation, and close these when you touch them.

RTL is handled by using logical properties throughout (`inset-inline-*`, `border-inline-start`, `margin-inline-start`, `border-end-start-radius`). The bubble tail is a squared corner via logical radius rather than an SVG notch specifically so it mirrors for free. §11 · RTL guards holds the cases logical properties cannot cover: `.ch-meta` and `.ch-sender` margins (physical shorthands elsewhere in the file), and `scaleX(-1)` on the send, back, and forward-mark icons. Two more `[dir="rtl"]` guards live outside §11 and are easy to miss when auditing: `.ch-search`'s directional drop shadow (§4) and `.ci-switch.on::after`'s translate (§7), which flips `translateX(16px)` to `-16px`.


## Backend contract and what is wired

All chat HTTP lives in one file, [src/api/chat.js](src/api/chat.js). It covers the **entire** documented surface of `09-api-reference.md` — there is no chat endpoint the backend ships that the client cannot call. `messages.get` and `messages.reactions` have no UI behind them (see below).

Everything goes through [src/api/http.js](src/api/http.js) (`http.get(path, query, opts)` — note query and opts are *separate* positional args, which is why `search` can take an options bag as a 4th argument: `search(convId, q, limit = 30, opts)` forwards it to `http.get`, whose `opts` is spread into the request options where `signal` is destructured. [ChatSearchPanel.jsx](src/components/chat/ChatSearchPanel.jsx) passes `{ signal: ctl.signal }` — the object, not a bare `AbortSignal`). Two storage engines page differently and the shapes are **not** interchangeable: conversations/members/requests are Postgres `Page` → `{ items, total, hasMore, page }`; messages are Cassandra cursor → `{ items, nextCursor, hasMore }`.

### Endpoint table

"Adapted return" is what the caller receives *after* `chat.js` maps it — never a raw DTO. "raw" means the HTTP body is passed through untouched (usually 200/204 with nothing useful).

| `api.chat.*` | Endpoint | Adapted return | Wired at |
|---|---|---|---|
| `conversations.list` | `GET /conversations` | page of `convoFrom` | [ChatContext.jsx](src/context/ChatContext.jsx) seed, `refreshInbox`, `loadMoreInbox` |
| `conversations.archived` | `GET /conversations/archived` | page of `convoFrom` | `loadArchived` / `loadMoreArchived` → archived tab in [ChatPage.jsx](src/pages/ChatPage.jsx) |
| `conversations.create` | `POST /conversations` | `convoFrom` | indirect only — reached via the two wrappers below |
| `conversations.createDirect` | `POST /conversations` `{type:DIRECT}` | `convoFrom` | `openDirect` ← [NewChatModal.jsx](src/components/chat/NewChatModal.jsx), [ConversationInfo.jsx](src/components/chat/ConversationInfo.jsx). [UserProfilePage.jsx](src/pages/UserProfilePage.jsx) bypasses the context and calls `api.chat.conversations.createDirect(id)` **directly**, so it never `upsertConvo`s the result itself — it only `navigate`s to `/chat/<id>`. The row still reaches the inbox, but the long way round: ChatPage's deep-link effect sees `getConvo(id) === null`, refetches with `conversations.get`, and upserts *that*. Net cost is one redundant GET, not a missing row |
| `conversations.createGroup` | `POST /conversations` `{type:GROUP}` | `convoFrom` | `createGroup` ← [NewChatModal.jsx](src/components/chat/NewChatModal.jsx), which passes `{title, memberIds}` only. **`avatarKey` is never passed** — chat has no upload endpoint of its own, so the modal deliberately ships no avatar picker |
| `conversations.get` | `GET /conversations/{id}` | `convoFrom` | deep-link fallback in [ChatPage.jsx](src/pages/ChatPage.jsx); every unknown-convo refetch in [ChatContext.jsx](src/context/ChatContext.jsx) — `applyMessageNew` on an unknown convo, `conversation.updated:REQUEST_ACCEPTED`, `member.changed:ADDED`, and `acceptRequest` refetching after a successful accept |
| `conversations.update` | `PATCH /conversations/{id}` | `convoFrom` | [ConversationInfo.jsx](src/components/chat/ConversationInfo.jsx) — title and `settings` only, in two separate calls; the `avatarKey` field is never sent |
| `conversations.remove` | `DELETE /conversations/{id}` | raw (204) | `deleteConvo` ← [ConversationHeader.jsx](src/components/chat/ConversationHeader.jsx), [ConversationList.jsx](src/components/chat/ConversationList.jsx), [ChatPage.jsx](src/pages/ChatPage.jsx) |
| `conversations.read` | `POST /{id}/read` | raw | `markRead` in [ChatContext.jsx](src/context/ChatContext.jsx) ← `scheduleRead` in [useThread.js](src/components/chat/useThread.js) |
| `conversations.mute` | `POST /{id}/mute` | raw | `setMuted` ← header / row menu / info panel switch |
| `conversations.pin` | `POST /{id}/pin` | raw | `setPinned` ← header / row menu / info panel ("Pin to the top" switch, parallel to the mute and archive switches) |
| `conversations.archive` | `POST /{id}/archive` | raw | `setArchived` ← header / row menu / info panel switch |
| `messages.page` | `GET /conversations/{id}/messages` | `{items: msg[] newest→older, nextCursor, hasMore}` | `reload` / `loadOlder` / `jumpTo` in [useThread.js](src/components/chat/useThread.js); shared-media scan in [ConversationInfo.jsx](src/components/chat/ConversationInfo.jsx) |
| `messages.sync` | `GET /conversations/{id}/messages/sync` | `msg[]` **ascending** | `gapSync`, fired on every `connected` event |
| `messages.search` | `GET /conversations/{id}/messages/search` | `msg[]` | [ChatSearchPanel.jsx](src/components/chat/ChatSearchPanel.jsx), "This chat" scope |
| `messages.send` | `POST /conversations/{id}/messages` | `msg` | `sendText` / `retry` |
| `messages.sendFiles` | `POST /conversations/{id}/messages/upload` | `msg` | `sendFiles` / `retry`. `replyToId` is appended best-effort — the documented parts are `clientNonce`/`body`/`files` only |
| `messages.get` | `GET /messages/{messageId}` | `msg` with **accurate `reactedByMe`** | **UNUSED — no call site anywhere** |
| `messages.edit` | `PATCH /messages/{messageId}` | `msg` | `editMessage` |
| `messages.remove` | `DELETE /messages/{messageId}` | raw (204) | `deleteMessage` |
| `messages.forward` | `POST /messages/{messageId}/forward` | `msg` | `forwardMessage` in [useThread.js](src/components/chat/useThread.js) ← forward sheet in [ChatPage.jsx](src/pages/ChatPage.jsx) |
| `messages.delivered` | `POST /messages/{messageId}/delivered` | raw | `markDelivered`, once per foreign message |
| `messages.react` | `POST /messages/{messageId}/react` `{emoji}` | `reaction[]` | `toggleReaction` |
| `messages.unreact` | `DELETE /messages/{messageId}/react` | `reaction[]` | `toggleReaction`. `unreact(messageId)` takes **no emoji and sends no body** — `http.del(path, opts)`'s second parameter is the options bag, not a body. One reaction per user per message; the DELETE removes whichever one is yours |
| `messages.reactions` | `GET /messages/{messageId}/reactions` | `reaction[]` with `reactedByMe` | **UNUSED — no call site anywhere** |
| `messages.pin` | `POST /conversations/{c}/messages/{m}/pin` | raw | `pinMessage` |
| `messages.unpin` | `DELETE /conversations/{c}/messages/{m}/pin` | raw (204) | `unpinMessage` |
| `messages.pinned` | `GET /conversations/{id}/pinned` | `msg[]` | `reloadPinned` — on mount and on every `PINNED`/`UNPINNED` event |
| `members.list` | `GET /{id}/members` | page of `memberFrom` | [ConversationInfo.jsx](src/components/chat/ConversationInfo.jsx), `size: 256` (the eager-fan-out cutoff — one page must hold the whole roster) |
| `members.add` | `POST /{id}/members` | raw | [NewChatModal.jsx](src/components/chat/NewChatModal.jsx) in add-people mode (`mode="add"`) |
| `members.remove` | `DELETE /{id}/members/{userId}` | raw | [ConversationInfo.jsx](src/components/chat/ConversationInfo.jsx) |
| `members.setRole` | `POST /{id}/members/{userId}/role` | raw | [ConversationInfo.jsx](src/components/chat/ConversationInfo.jsx) (promote + demote) |
| `members.restrict` | `POST /{id}/members/{userId}/restrict` | raw | [ConversationInfo.jsx](src/components/chat/ConversationInfo.jsx) |
| `members.leave` | `POST /{id}/leave` | raw | [ConversationHeader.jsx](src/components/chat/ConversationHeader.jsx), [ChatPage.jsx](src/pages/ChatPage.jsx) |
| `members.transferOwner` | `POST /{id}/transfer-owner` | raw | [ConversationInfo.jsx](src/components/chat/ConversationInfo.jsx) |
| `members.createInvite` | `POST /{id}/invite-link` | raw `{conversationId, token, expiresAt, maxUses, useCount}` | [ConversationInfo.jsx](src/components/chat/ConversationInfo.jsx), always `expiresInHours: 168`; `maxUses` never sent |
| `members.revokeInvite` | `DELETE /{id}/invite-link` | raw | [ConversationInfo.jsx](src/components/chat/ConversationInfo.jsx) |
| `members.join` | `POST /conversations/join` | `convoFrom` | [ChatJoinPage.jsx](src/pages/ChatJoinPage.jsx) |
| `requests.list` | `GET /message-requests` (`status` defaults to `PENDING`) | page of `requestFrom` | `loadRequests` ← [RequestsPanel.jsx](src/components/chat/RequestsPanel.jsx) |
| `requests.count` | `GET /message-requests/count` | `number` | seed effect in [ChatContext.jsx](src/context/ChatContext.jsx) |
| `requests.accept` / `.decline` / `.block` | `POST /message-requests/{id}/…` | raw | `acceptRequest` / `rejectRequest` |
| `presence` | `GET /presence?userIds=csv` | `[{userId, status (lowercased), lastSeenEpochMs}]` | `flushPresence` ← `watchPresence`, coalesced on a 60 ms timer with a 60 s per-user cache |
| `typing` | `POST /conversations/{id}/typing` (`{isTyping, activity?}` — `activity` ∈ TYPING · RECORDING_VOICE · SENDING_PHOTO/VIDEO/VOICE/FILE, sent best-effort; servers that only know `isTyping` ignore it) | raw | `sendTyping` ← `onTyping(isTyping, activity)` in [Composer.jsx](src/components/chat/Composer.jsx) |
| `unreadCount` | `GET /messaging/unread-count` | `number` (`r.count ?? 0`) | seed **and** re-seed on every `connected` |
| `searchAll` | `GET /messaging/search` | `msg[]` | [ChatSearchPanel.jsx](src/components/chat/ChatSearchPanel.jsx), "All chats" scope |
| `stream` | `GET /messaging/stream?token=` | unsubscribe fn | a single instance, owned by [ChatContext.jsx](src/context/ChatContext.jsx) |
| `conversations.unread` | `POST /{id}/unread` | raw | `markUnread` ← row menu + header menu. Does **not** touch `totalUnread` — the server keeps `unreadCount` at 0, so only the row's dot changes |
| `conversations.disappearing` | `POST /{id}/disappearing` | raw | `setDisappearing` ← the timer `<select>` in [ConversationInfo.jsx](src/components/chat/ConversationInfo.jsx); the header menu offers only the "off" shortcut |
| `messages.remove(id, scope)` | `DELETE /messages/{id}?scope=` | raw (204) | `deleteMessage(id, scope)`. `everyone` patches a tombstone in place; `me` **deletes the row from the map** — leaving a stub would claim a deletion the room never saw |
| `messages.star` / `.unstar` | `POST`/`DELETE /messages/{id}/star` | raw | `toggleStar` ← bubble menu + long-press sheet |
| `messages.starred` | `GET /messaging/starred` | `msg[]` (bare List, **no** `Page` envelope) | [StarredPanel.jsx](src/components/chat/StarredPanel.jsx). `hasMore` is inferred from "a full page came back" — there is no flag |
| `messages.seenBy` | `GET /messages/{id}/seen-by` | `participant[]` | [SeenBySheet.jsx](src/components/chat/SeenBySheet.jsx), groups only, own messages only |
| `messages.reactions` | `GET /messages/{id}/reactions` | `reaction[]` with `reactedByMe` | `refreshReactions` ← the bubble hydrates on hover/focus/long-press. **Previously unused — see below** |
| `scheduled.create` | `POST /{id}/messages/schedule` | `scheduled` | `scheduleMessage` ← the composer's clock popover |
| `scheduled.list` | `GET /{id}/scheduled` | `scheduled[]` | on conversation change, and after a fired row lands |
| `scheduled.cancel` | `DELETE /messaging/scheduled/{id}` | raw (204) | [ScheduledPanel.jsx](src/components/chat/ScheduledPanel.jsx) |
| `settings.get` / `.update` | `GET`/`PUT /messaging/settings` | `settings` | seeded in [ChatContext.jsx](src/context/ChatContext.jsx) (outside the `Promise.all`, so a deploy without the endpoint still opens the inbox), written by [ChatPrefsPanel.jsx](src/components/chat/ChatPrefsPanel.jsx) |
| `channels.create` / `.discover` / `.subscribe` / `.unsubscribe` | `/channels…` | `channel` | [ChannelsPage.jsx](src/pages/ChannelsPage.jsx) |
| `channels.byHandle` | `GET /channels/by-handle/{handle}` | `channel` | the **exact-address fallback** in ChannelsPage's discovery effect — `discover` is a text search, this is an address lookup, and a pasted `@handle` is asking the second question. Fires only when discovery came back empty and the query is handle-shaped; a 404 means "no channel at that address", not an error |
| `calls.start` / `.accept` / `.decline` / `.end` / `.signal` | `/conversations/{id}/calls`, `/calls/{id}…` | `call` | [CallContext.jsx](src/context/CallContext.jsx) |
| `calls.get` | `GET /calls/{callId}` | `call` | **UNUSED** — every state transition arrives on the stream as a `call.*` frame carrying the full `CallResponse`, so there is nothing to poll for. It is the natural backing for a "rejoin after a reload" flow, which does not exist yet |
| `streams.start` / `.live` / `.get` / `.join` / `.leave` / `.end` / `.chat` | `/streams…` | `stream` | [LivePage.jsx](src/pages/LivePage.jsx) |

### Exact per-viewer reads: `messages.reactions` (wired) and `messages.get` (still not)

`messages.get` and `messages.reactions` are the only *exact, per-viewer* read paths the backend offers. The gap they used to leave was visible:

- The timeline (`GET …/messages`, search, pinned) hydrates reaction counts from Redis and hard-codes **`reactedByMe: false`** for every row. Only `GET /messages/{id}` and `GET /messages/{id}/reactions` read the Cassandra source of truth and return an accurate flag.
- So after a page reload, "my" reactions were no longer highlighted, and `toggleReaction` computed `const had = …some(r => r.emoji === emoji && r.reactedByMe)` → `false` → it POSTed `/react` again instead of DELETEing. The response is the authoritative summary and self-corrects the row, so removing a reaction after a reload cost two taps.

**`messages.reactions` is now wired, lazily.** `refreshReactions(id)` in [useThread.js](src/components/chat/useThread.js) fetches the exact buckets and stamps `_reactionsExact: true` on the row; the flag is the cache, so repeated triggers cost one request. It is fired from [MessageBubble.jsx](src/components/chat/MessageBubble.jsx) at the moment the reader shows intent — `onPointerEnter` / `onTouchStart` / `onFocusCapture` on `.ch-reacts`, opening the quick-react popover, and opening the long-press sheet. Three properties make that the right trigger rather than "on load":

- it costs **nothing** on a page of forty messages, where an eager fetch would be forty requests;
- hover strictly precedes click on a pointer device and the long-press strictly precedes the sheet's react strip on touch, so the flag is correct *before* the first toggle can use it;
- `toggleReaction` also stamps `_reactionsExact` from its own authoritative response, so a message you have already reacted to never re-fetches.

A row rebuilt by `reload()` loses the flag and re-hydrates on next intent, which is correct — the underlying counts changed too. A 404 is swallowed: for a floored message that is "not available to you", not an error worth retrying.

**`messages.get` is still unused.** It is the natural backing for a "jump to message" that is not in the loaded window — but see the floor rules below: it 404s more often than you'd expect.

### `DELETE /conversations/{id}` is two operations behind one call

The endpoint is overloaded and the client **cannot** encode which one it wants — there is no flag, no query param, no body. `chat.js` just does `http.del('/api/v1/conversations/{id}')`. The server picks the behaviour from your role:

- **Group + you are the OWNER** → soft-deletes the group **for everyone**. Every member loses access, it vanishes from all inboxes, sends and reads start failing. Irreversible. Emits `conversation.updated` with `memberChange: 'DELETED'`.
- **Group + not the owner, or either side of a DM** → **"delete for me"**. The thread is cleared and hidden on your side only, drops out of *both* the inbox and the archived list, is unpinned, unread zeroed. The peer/group is untouched.

Because the wire call is identical in both cases, the *only* thing standing between an owner and accidentally destroying a group is the UI copy. That is why [conversationActions.js](src/components/chat/conversationActions.js) exists: `deleteIntentOf(convo)` returns the label, confirm title, body and confirm-button text, keyed on `isGroup && myRole === 'OWNER'`.

```js
const ownsGroup = !!convo?.isGroup && convo?.myRole === 'OWNER'
// → { destroysForEveryone: true, label: 'Delete group', title: 'Delete this group?',
//     confirmLabel: 'Delete for everyone', … }
// → group, not owner:  label: 'Clear and hide', confirmLabel: 'Clear for me'
// → DM:                label: 'Delete chat',    confirmLabel: 'Delete for me'
```

Its importers are few, and they do not cover every surface:

- **Row menu** — [ConversationList.jsx](src/components/chat/ConversationList.jsx) takes `label`, `title`, `message` and `confirmLabel` straight from the intent. This is the only surface whose *menu item text* is derived.
- **Info panel danger row** — the panel itself never calls `deleteIntentOf`; its button is statically labelled "Leave group" (groups, owner included) or "Delete conversation" (DMs) and just fires the `onLeave` prop. That prop is `onLeaveOrDelete` in [ChatPage.jsx](src/pages/ChatPage.jsx), which computes `leaving = convo.isGroup && convo.myRole !== 'OWNER'` and, for everyone who is *not* leaving, pulls the confirm dialog from the intent. So a group OWNER clicks a row that says "Leave group" and only learns it destroys the group from the confirm text — the intent is the last line of defence there, not a redundant one.
- **Header overflow menu** — [ConversationHeader.jsx](src/components/chat/ConversationHeader.jsx) does **not** import `conversationActions.js` at all. `doDelete` hard-codes `title: 'Delete chat'` / `'Delete this conversation from your inbox? This cannot be undone.'` / `confirmLabel: 'Delete'`, and the menu only offers delete for non-groups (`rows.push(convo.isGroup ? {leave} : {delete})`), so the destructive owner path is unreachable from the header. [ChatPage.jsx](src/pages/ChatPage.jsx) says so in a comment: "The header owns its own copy of this for its overflow menu."

If you add a delete affordance that *can* reach a group owner, call `deleteIntentOf` — do not write your own label. Labelling the owner path "Hide group" is a data-loss bug, not a copy nit. Note also that `myRole` comes from the conversation view object, so a stale inbox row can misclassify — and the two surfaces sit on opposite sides of that risk:

- The **row menu** derives label *and* confirm from one `deleteIntentOf(convo)` result, computed while the row renders and captured by the menu item's `run` closure. Those two can never disagree with each other — but if the row is stale, both are stale together, and the confirm silently agrees with a wrong label.
- The **info panel** is the inverse: `onLeaveOrDelete` calls `deleteIntentOf` at click time against the freshest `convo`, so the *dialog* is current while the button the user actually pressed is static text. For a group owner the confirm is **expected** to contradict its own button — that contradiction is the safety mechanism.

Also distinct from `POST /{id}/archive`, which only moves a thread to the archived list where it remains fully visible.

### The per-member read floor

"Delete for me" is implemented as a per-member `clearedBeforeMessageId` high-water mark, set to the conversation's `lastMessageId` at the moment you delete. A second, independent floor exists for groups with `historyVisibleToNewMembers: false` — the **join floor**, derived from your `joinedAt` as `(joinMs - CUSTOM_EPOCH) << 22`, i.e. the smallest possible Snowflake at your join millisecond. The server takes both into account as a single `floorId` and applies it to:

- `GET /conversations/{id}/messages` — floored rows are skipped mid-page.
- `GET …/messages/sync` — raises the effective cursor to `max(after, floorId - 1)`, so a stale client cannot pull cleared messages back with an old `after`.
- `GET …/messages/search` (scalar floor) and `GET /messaging/search` (**per-conversation** floor map — one scalar would be wrong across conversations).
- `GET /conversations/{id}/pinned`.
- **`GET /messages/{id}` and `GET /messages/{id}/reactions` return `MESSAGE_NOT_FOUND` (404)** for a floored message rather than serving it. Any future wiring of `messages.get` / `messages.reactions` must treat 404 as "not available to you", not as an error worth retrying.

Two consequences already handled in the code, which you should not undo:

1. **Reply previews are not floored.** The server embeds `replyTo` in the message DTO with no floor check on the quoted row, and `msgFrom` in [chat.js](src/api/chat.js) maps `replyTo.snippet` straight through — so a fully visible message can carry a snippet pointing at a message the server will never serve you. Clicking it runs `thread.jumpTo`, which pages history back to the start (up to its 20-page walk-back guard), finds nothing, returns `false`, and [ChatPage.jsx](src/pages/ChatPage.jsx) toasts "That message isn't available to you." from both jump paths — the direct click and the deferred cross-conversation jump. A `jumpTo` that resolves `false` is a *normal* outcome, not a bug.
2. **Search and pinned drop tombstoned and SYSTEM rows** server-side, while the live timeline passes them through (a delete renders in place as "message deleted"). Do not assume a search result set and a timeline slice contain the same rows.

### The floor is server-internal — the client cannot predict it

`ConversationResponse` carries `id, type, title, avatarKey/avatarUrl, ownerId, memberCount, lastMessageId, lastMessageAt, lastMessagePreview, groupSettings, myRole, myStatus, lastReadMessageId, unreadCount, hasUnread, mutedUntil, pinned, archived, peer, createdAt` — and **nothing else**. There is no `clearedBeforeMessageId` field, and `convoFrom` in [src/api/chat.js](src/api/chat.js) therefore has nothing to map. The floor is invisible.

Practical rules that follow:

- Never compute "which messages should be visible" locally. Trust `items` / `hasMore` / `nextCursor` from the server; paging back simply stops early at the floor, and that is the only signal you get.
- Never cache a message page across a delete-for-me. `deleteConvo` drops the convo from both lists optimistically (and restores the snapshot if the DELETE fails). **It does not navigate.** Only [ConversationHeader.jsx](src/components/chat/ConversationHeader.jsx) and `onLeaveOrDelete` in [ChatPage.jsx](src/pages/ChatPage.jsx) call `navigate('/chat')` afterwards; the row menu in [ConversationList.jsx](src/components/chat/ConversationList.jsx) does not — so deleting the *currently open* conversation from the row menu leaves the route on it, ChatPage's deep-link effect sees `known === null` and immediately re-fetches with `conversations.get`, re-upserting the row you just deleted. Deleting from the row menu is only safe for a conversation you are not looking at.
- Re-appearance is not client-driven. When the peer writes again, `message.new` arrives for a conversation the client no longer holds; `applyMessageNew` hits its `!known` branch and refetches with `conversations.get`. That refetch — not any local state — is what brings the thread back with the correct (post-floor) contents.
- `lastMessageId` in the inbox row is the conversation's global last id, not yours. It can point at a message you cannot read.

### SSE: chat's one stream, the full catalogue

Chat opens exactly **one** `EventSource`, owned by [ChatContext.jsx](src/context/ChatContext.jsx) at `GET /api/v1/messaging/stream?token=<jwt>` (EventSource cannot set headers) — one socket for every conversation, never one per thread, and `stream()` in [chat.js](src/api/chat.js) is called from nowhere else.

That is chat's stream, not *the* app's stream. Several unrelated SSE streams run alongside it, each constructing its own `EventSource` in its own api module: notifications ([notifications.js](src/api/notifications.js), `/notifications/stream`), the per-user activity feed ([activity.js](src/api/activity.js), `/users/me/activity/stream`), the stories tray ([stories.js](src/api/stories.js), `/stories/tray/stream`), and the per-entity live streams in [realtime.js](src/api/realtime.js) (`{base}/{id}/stream`). They share the hardening pattern below and nothing else — no event bus, no shared socket. Chat events never arrive on another module's connection, but the browser's per-host connection budget and any per-user SSE cap on the server are shared across all of them.

The hardening: the token is read **inside** `connect()` on every attempt because it rotates ~hourly — capturing it once means a long-lived tab re-dials forever with a dead token. A watchdog polling every 15 s closes on 60 s of silence before reconnecting, so two sockets never coexist. `onError(readyState)` with `readyState === 2` is a hard close the browser will not retry; the provider refreshes the token and re-opens, guarded by a `healing` flag.

Wire names are dotted lowercase; `normalizeEventName` lowercases and turns `_` into `.`, so it also accepts `MESSAGE_NEW`-style enums, and every name is registered in both spellings. The **named** listeners are exactly the keys of `EVENT_HANDLER` — nothing else is `addEventListener`'d except `heartbeat`/`HEARTBEAT`, which only stamp the watchdog timestamp and never dispatch. But named listeners are not the only way into `dispatch`: `es.onmessage` dispatches too, for unnamed frames, taking the type from the payload's own `eventType`/`type` discriminator.

```js
for (const name of Object.keys(EVENT_HANDLER)) {
  es.addEventListener(name, (e) => dispatch(name, parse(e)))
  const upper = name.toUpperCase().replace(/\./g, '_')
  if (upper !== name) es.addEventListener(upper, (e) => dispatch(name, parse(e)))
}
es.addEventListener('heartbeat', () => { lastBeat = Date.now() })
es.addEventListener('HEARTBEAT', () => { lastBeat = Date.now() })
es.onmessage = (e) => dispatch(null, parse(e))   // unnamed frames only
```

A new *named* server event that is not in `EVENT_HANDLER` is dropped silently — no listener is ever registered for that name, and `onmessage` does not fire for named frames. An *unnamed* frame behaves differently: `dispatch` looks up `EVENT_HANDLER[type]` (a miss just makes `handlers[undefined]?.()` a no-op) and then calls `handlers.onAny` **unconditionally**, so a payload-routed event outside the map still reaches `subscribe()` consumers — carrying `adaptEvent`'s `default` shape, with no provider handler behind it. Either way, adding a `case` to a `subscribe()` consumer is not enough for a named event: you must add the name to `EVENT_HANDLER` **and** a `case` to `adaptEvent` (the `default` branch spreads the raw payload through, so ids arrive un-normalised — no `mid()`, no `0`→`null` folding).

Every dispatched event goes to its named handler *and* to `onAny`, which the provider re-broadcasts to `subscribe()` consumers. `onReaction` and `onDelivered` are handler keys the provider never supplies — those events reach the UI only through `subscribe()`.

| `event:` | Handler key | Provider handler ([ChatContext.jsx](src/context/ChatContext.jsx)) | Also consumed via `subscribe()` |
|---|---|---|---|
| `connected` | `onConnected` | `setConnected(true)` + re-seed `unreadCount` (deltas drift across a disconnect) | `gapSync()` in [useThread.js](src/components/chat/useThread.js) |
| `message.new` | `onMessage` | `applyMessageNew` — dedupe by id, skip own/active convo, +1 badge, bump preview + reorder; refetch if the convo is unknown | [useThread.js](src/components/chat/useThread.js): `addIncoming` + `markDelivered` + `scheduleRead` |
| `message.edited` | `onEdited` | rewrite `lastMessagePreview` **only if** it is the conversation's last message | [useThread.js](src/components/chat/useThread.js): `patchMsg(body, editedAt)` |
| `message.deleted` | `onDeleted` | preview → `'Message deleted'`, same last-message guard | [useThread.js](src/components/chat/useThread.js): `patchMsg(deleted, body:'', media:[])` |
| `message.reaction` | `onReaction` | **none supplied** | [useThread.js](src/components/chat/useThread.js): ±1 delta, skips own userId (already applied optimistically) |
| `receipt.read` | `onRead` | if it's *my* userId (read on another device): zero this convo's badge, advance `lastReadMessageId` | [ChatPage.jsx](src/pages/ChatPage.jsx): `peerRead` high-water for the read tick |
| `receipt.delivered` | `onDelivered` | **none supplied** | [ChatPage.jsx](src/pages/ChatPage.jsx): `peerDelivered` high-water for the delivered tick |
| `typing` | `onTyping` | 6 s TTL per `{convId,userId}` storing `{until, activity}` in a ref + tick; own echo ignored; swept by a shared 2 s timer; a `message.new` from a typer retires their entry instantly | read through `typingIn(convId)` → `[{userId, activity}]` (stable identity between changes) |
| `presence` | `onPresence` | writes `presenceRef[userId]`, lowercased status | read through `presenceOf(userId)` |
| `conversation.updated` | `onConversation` | upsert the payload conversation; `memberChange === 'DELETED'` → `removeConvo`; `'REQUEST_ACCEPTED'` → refetch | [useThread.js](src/components/chat/useThread.js): `'PINNED'`/`'UNPINNED'` → `reloadPinned()` |
| `member.changed` | `onMember` | mine: `REMOVED`/`LEFT` → drop convo, `PROMOTED`/`DEMOTED` → patch `myRole`, `RESTRICTED`/`UNRESTRICTED` → patch `myStatus`, `ADDED` → refetch (role, status, settings and the history floor are all new). Others: ±1 `memberCount`, computed **inside** the state updater so a burst of joins doesn't collapse to a single +1 | — |
| `request.new` | `onRequest` | `requestCount + 1`; prepend to the list if it has been loaded | — |
| `call.incoming` · `.accepted` · `.declined` · `.participant` · `.ended` · `.signal` | `onCall` | **none supplied** | [CallContext.jsx](src/context/CallContext.jsx) — the entire call lifecycle and the WebRTC relay |
| `stream.started` · `.viewer` · `.chat` · `.ended` | `onStream` | **none supplied** | [LivePage.jsx](src/pages/LivePage.jsx) — the directory and the room both subscribe |
| `heartbeat` | — | not in `EVENT_HANDLER`; the dedicated `heartbeat`/`HEARTBEAT` listeners touch `lastBeat` only, and `dispatch` early-returns on the name. Never broadcast | — |

Calls and live streams are **multiplexed onto the same per-user socket** — there is no second `EventSource` for either. All six `call.*` names map to one handler key (`onCall`) and all four `stream.*` to `onStream`; consumers switch on `evt.type`. They are listed individually in `EVENT_HANDLER` anyway because that map is what `stream()` derives its `addEventListener` calls from — a name missing from it reaches nothing, not even `onAny`.

In `adaptEvent`, the `stream.*` cases bind the adapted payload to a local named **`stream_`**, not `stream`: `stream` is the module-level SSE function in the same file, and shadowing it inside a `case` block is a footgun waiting for the next person who adds a line there.

Counters are deliberately absent from every payload — the platform delta model. Anything that looks like an absolute count must come from a REST re-seed (`unreadCount` on `connected`) or from an authoritative response body (`react`/`unreact` return the full `ReactionSummary` list).


## The surfaces layered on top of the core

Everything above describes the message loop. These are the features that sit on
it, each with the one fact you cannot guess from the code.

### Calls — a mesh, a deterministic offerer, and a ringer with no asset

[CallContext.jsx](src/context/CallContext.jsx) is ordinary WebRTC glued to six
REST verbs and six SSE events. The server owns the lifecycle
(`RINGING → ONGOING → ENDED`) and is a **blind relay** for signalling: it
forwards `payload` verbatim and never parses it. Media is peer-to-peer and
never touches the backend, so STUN/TURN/SFU is deployment configuration —
`VITE_ICE_SERVERS` (a JSON array) overrides the public-STUN default.

The three decisions worth protecting:

1. **Who offers is a tie-break on user ids, not "the caller".** `negotiate()`
   only creates an offer when `String(myId) < String(peerId)`. Both sides run
   the same comparison and reach opposite answers, so exactly one offer exists
   and there is no glare to resolve. "The caller always offers" is wrong the
   moment there are three people in the room — in a group everyone is somebody's
   callee.
2. **ICE candidates are queued, not dropped.** A candidate can legitimately beat
   the SDP it belongs to. `iceQueueRef` holds them per peer until a remote
   description exists, and `drainIce` flushes on both the OFFER and ANSWER
   paths. Delete the queue and the call stalls on a slow relay with no error.
3. **The ringer is synthesised WebAudio, not an mp3** — no fetch, no bundled
   asset, and stoppable to the millisecond. It is built inside a mount
   `useEffect`, never during render: an `AudioContext` created in the render
   phase leaks a second one under StrictMode's double-invoke. Every call site
   uses `?.` so the one frame before that effect runs is safe.

**`POST /conversations/{id}/calls` is overloaded, and the two cases need
different follow-ups.** There is one live call per conversation, so the verb
either starts a fresh one *or hands back the one already in progress* — and in
the second case it only **returns** that call, it does not put you in it.
`accept` is the verb documented as "Answer; you join". `startCall` therefore
checks whether it is already a `JOINED` participant and calls `accept` when it
is not. Skipping that check is a silent failure of exactly the worst kind: the
local UI goes straight to "active", the server never marks you joined and never
tells the other side you are there, so `negotiate` offers to peers who have
never heard of you — the call looks connected and carries no audio.

`teardown()` is the single exit path for every ending — decline, hang-up,
`call.ended`, unmount. It stops the **local tracks** explicitly, which is what
turns the camera light off; closing the peer connections does not.

**Terminal statuses mean opposite things to the two ends**, so `call.ended`
splits them, and the side that *caused* the ending is told nothing because it
already knows:

| status | caller sees | callee sees |
| --- | --- | --- |
| `MISSED` (rang out ≥ 60s, server sweep) | "No answer" | "Missed call" |
| `CANCELLED` (caller hung up before an answer) | *silent* | "Missed call" |
| `ENDED` after a real conversation | *silent* | *silent* |
| `DECLINED` | "Call declined" (handled on `call.declined`) | — |

`call.declined` only tears down when the call's own status left the live set:
in a 1:1 a decline ends the call, but in a **group** it just drops that one
person and the call stays `ONGOING` for everyone else.

An incoming call while already in one is auto-declined immediately rather than
queued, so the caller is never left ringing a tab that will never answer.

#### What the call layer measures, and why none of it comes off the wire

Four things the surface shows are **derived locally**, because the relay carries
no signal for any of them:

- **Who is talking.** One `AnalyserNode` per stream, sampled on a single 80 ms
  interval, RMS → `levels[key]` (`'me'` for the local mic). Two constraints:
  ONE `AudioContext` for the whole call — a context per stream exhausts the
  browser's hard limit (~6) in a five-person call and every meter after that
  reads zero — and a remote stream only produces samples once it is *also*
  attached to a media element, which is the second reason the hidden tiles are
  shrunk rather than unmounted. The level is committed to state in 5 % buckets,
  because this is the one thing in the app that would otherwise re-render on a
  timer for the whole duration of a call.
- **You are muted but talking.** The local meter keeps reading while the track
  is disabled, so the most universal call mistake is exactly detectable.
- **Link quality.** `getStats()` every 3 s per peer. Packet loss is a **delta**
  between samples — the cumulative counter only grows, so a call that dropped
  packets in its first ten seconds would read "poor" for the rest of its life.
  Reported as the *worst* peer, in one word.
- **Reconnecting.** `onconnectionstatechange` writes `peerStates[peerId]`;
  `disconnected`/`failed` captions the tile. A frozen tile with no caption is
  indistinguishable from a peer who stopped moving.

**Screen share** replaces the video sender's track (`replaceTrack`) rather than
adding one, so it costs no renegotiation — with one exception: a *voice* call
has no video sender at all, so the track must be `addTrack`ed and a fresh offer
sent (`renegotiate()`, which only offers from `stable` and only from the side
that owns the offer by the id tie-break). The camera track is **parked, not
stopped**, so ending the share does not re-prompt for camera permission, and
`teardown` stops both. The browser's own "Stop sharing" bar bypasses the UI
entirely, hence the `ended` listener on the track.

**Device switching** is the same `replaceTrack` path, and it honours the current
mute state — switching microphones must not silently un-mute someone. Labels are
empty until a `getUserMedia` grant exists, so the list is only built once a call
is up, and `devicechange` covers the headset plugged in mid-call.

#### The call log lives in the client, because the API has no history

`GET /calls/{id}` answers about one call you already know the id of, the `call.*`
frames are ephemeral, and nothing writes a SYSTEM message into the timeline for
a call. So "you called Sara three times today, the last one lasted 4:12" exists
nowhere except in the client that watched it happen —
[callLog.js](src/components/chat/callLog.js) is that memory, and it feeds both
the timeline card and the info panel's totals.

`CallContext` opens a **draft** the moment a call exists in either direction
(`beginLog`), stamps `answeredAt` when it connects, and commits exactly once in
`teardown(outcome)`. That `outcome` argument is the load-bearing part: the same
terminal status means opposite things to the two ends, and the word is not
recoverable after the fact — so every exit path passes one, and `commitLog`
upgrades any of them to `answered` when `answeredAt` is set. `recordCall` is
idempotent on the call id because my own `hangUp` races the server's
`call.ended`, and two cards for one call is a bug the reader notices instantly.

Be honest about what this is: **per device, per account, and gone with site
data**. The info panel says so in as many words. If the API ever grows a history
endpoint, keep the shape and swap `load()` for the fetch — every consumer reads
`entriesFor` / `statsOf`, and nothing downstream touches localStorage.

### Media playback — voice and video

Both players follow one rule that is worth stating before anything else:
**playback position is not React state.** `timeupdate` fires about four times a
second, which is a visibly stuttering playhead, and driving the position from
state re-renders a leaf inside a memo-ed list at display refresh rate. Instead a
rAF loop writes ONE custom property (`--p`) plus one or two text nodes and the
slider's `aria-valuenow`; React state holds only what changes the *shape* of the
tree (playing / duration / buffering / failed). The waveform's played colour is a
second, pre-coloured copy of the bars clipped to `--p` — which is why a 40-bar
waveform costs nothing to animate.

**Speed, volume and mute are shared and persisted**
([mediaPrefs.js](src/components/chat/mediaPrefs.js)). A rate that resets on the
next bubble is worse than no rate control at all. Voice cycles `1 → 1.25 → 1.5 →
1.75 → 2` on one button (a menu for five values is more taps than the values are
worth, and the label *is* the state); video gets a wider ladder in a menu,
because 0.5× is a real review speed for a recorded demo and meaningless for
speech. Both re-apply `playbackRate` after every `loadedmetadata` — **Safari
resets it when a source loads**.

Three traps specific to voice notes:

- **A note this app recorded reports `Infinity` duration.** Chromium's
  `MediaRecorder` writes WebM with no duration header, so `duration` is
  `Infinity` until the element has seeked past the end once. The
  seek-to-`1e101`-then-rewind dance in `onLoadedMetadata` is what makes the
  scrubber work at all on your own notes; without it the bar is dead and the
  clock shows the placeholder forever.
- **Continuous playback only rolls into notes you have not heard.** The handoff
  walks the DOM (`audio[data-ika-voice]`, forward only) rather than the React
  tree, and skips any element whose `data-heard` is `1`. Without that guard,
  finishing one note restarts old ones simply because they sit lower in the DOM
  — the thread starts replaying itself at you.
- **The heard registry is local and capped.** The server has no "did this device
  play it" concept, and a read receipt is not one. 400 ids, oldest evicted; an
  uncapped set of Snowflakes in localStorage eventually throws the quota error
  that takes the whole preference blob down with it.

The video player replaces `<video controls>` deliberately: the native bar is a
closed shadow tree that cannot be themed, cannot carry a speed ladder, swallows
Space and the arrow keys the hosting dialog needs, and on iOS throws playback
out to the system player — out of the lightbox and out of the conversation. Two
consequences to keep in mind when editing:

- **The lightbox stands down from the arrow keys while focus is inside the
  player.** Its key handler is on `window` with `capture: true`, so it runs
  *before* the player's own handler and `stopPropagation` down there cannot
  reach it; the test is `e.target.closest('.vp')`. Without it, nudging the
  playhead skips to the next photo.
- **The player is keyed on the item** in the lightbox, so switching slides
  resets transport state instead of carrying the previous clip's position into
  the next.

### `CallOverlay` mounts in `Layout`, and its `<video>` elements must stay mounted

The overlay is rendered from [Layout.jsx](src/components/Layout.jsx), not from
[ChatPage.jsx](src/pages/ChatPage.jsx) — a call has to be answerable from the
feed, and its media elements must survive a route change mid-negotiation.

A `MediaStream` is not serialisable, so it cannot ride a `src` attribute. Tiles
attach it imperatively (`el.srcObject = stream`) behind an identity check;
re-assigning the same object restarts playback.

Two places therefore keep a `<video>` **rendered but invisible**, and both are
load-bearing:

- the collapsed pill's `.cl-pill-audio` tiles, 1px and `opacity:0`;
- an audio-only peer's `.cl-tile.audio-only .cl-video`, shrunk to 1px.

Neither may become `display:none` or be unmounted — that element is what plays
the remote audio track, and removing it silences the call while it looks fine.

Escape **collapses** the overlay; it never hangs up. A mis-keyed dismissal must
not drop a live call.

### Channels — a channel *is* a conversation

`ChannelResponse.id` **is** the conversationId. Posting and reading go through
the ordinary conversation and message endpoints, so there is no channel
timeline, no channel composer and no second message model —
[ChannelsPage.jsx](src/pages/ChannelsPage.jsx) only does the three things the
conversation surface cannot: create, discover, subscribe. "Open" navigates
straight to `/chat/<channel.id>`.

`convoFrom` folds `type === 'CHANNEL'` into `isGroup` (plus a separate
`isChannel` flag) precisely so the roster, the permission matrix, the medallion
and the invite-link flow all keep working unchanged. What `isChannel` then
changes is **wording, not behaviour**: "subscribers" not "members",
"Delete channel" not "Delete group" in
[conversationActions.js](src/components/chat/conversationActions.js), and no
call buttons in the header — a "call" in a broadcast channel would ring the
entire subscriber list.

The page itself carries no channel data of its own; it renders two sources that
are deliberately **not merged**. Discovery (`/channels/discover`) returns PUBLIC
channels only and is the grid. "Your channels" comes from the inbox
(`conversations` where `isChannel`) — the only place a PRIVATE channel you
belong to appears at all, and the only place unread state exists. Merging them
would either hide private channels or invent an unread count for a channel
nobody has joined. A channel has no avatar on the wire, so its art is derived:
`tintOf(id)` picks one of six discipline-spine tints deterministically and the
crest is the first letter of the title, which means the same channel wears the
same colours on every device and every reload — never a render-order palette.

One of those wording changes is not cosmetic. A subscriber hits the
admins-only send mode on **every** message they try to write — that is the
channel working correctly, not a restriction someone imposed on them — so
`lockedReason` in [ChatPage.jsx](src/pages/ChatPage.jsx) says *"This is a
broadcast channel — only its admins can post"* rather than the group's "Only
admins can post in this group", which reads as a demotion.

**Two subscribe affordances are deliberately absent** rather than disabled,
because the API refuses both and a control that can only 403 is worse than
none:

- the **owner** cannot unsubscribe from their own channel;
- a **private** channel rejects self-subscribe — you get in through the group
  invite-link flow, so the card shows "Invite only". Discovery never returns a
  private channel, so that arm is reachable only via an exact `@handle` lookup.

`discover` and `by-handle` are different questions and the page asks both:
text search first, then the exact address lookup **only if** discovery came
back empty and the query is handle-shaped. Falling back unconditionally would
hide the list whenever a handle also matched some titles.

### Live streaming — the app owns everything except the video

This app owns the lifecycle, the viewer registry, discovery and live chat. The
A/V is ingested to and served from an **external media server**. Two
consequences [LivePage.jsx](src/pages/LivePage.jsx) has to carry honestly:

- `ingestUrl` carries the stream's secret key, is returned **only** to the host,
  and is masked behind a Reveal — a screen-shared "go live" page must not leak
  it.
- `playbackUrl` is an HLS manifest. Safari plays it natively; other engines need
  an MSE player. The page probes `canPlayType` **in the attach effect and stores
  the answer in state** (probing a ref during render reads it before attachment)
  and offers an "open in a player" link instead of a black rectangle.

Live chat is **ephemeral** — broadcast only, never persisted, so a late joiner
sees an empty room. That is by design and the empty state says so. There is
deliberately no optimistic line: the server echoes your own message back on the
stream and a local copy would render it twice with no id to dedupe on.

The host does **not** `join` their own stream — joining is what registers a
viewer, and self-joining would inflate the audience by one.

**`joining` and `joinedRef` are two flags on purpose.** One guards StrictMode's
double-invoke; the other records a join that actually *succeeded*. Collapsing
them (setting the success flag before the `await`) meant a **failed** join still
unlocked the chat box — where every line then 403s, because you must join
before you can chat — and still fired a `leave` for a stream we were never in.
The composer is gated on `isHost || joined`, not on `stream.isLive`.

**Leaving needs `pagehide`, not just unmount.** Unmount misses the case that
actually matters: closing the tab. The viewer registry is what drives
`viewerCount`, so a phantom viewer inflates the number for *everyone* watching
until the server's expiry sweep catches it. `streams.leave(id, { beacon: true })`
goes out through the `keepalive` option added to [http.js](src/api/http.js) —
preferred over `navigator.sendBeacon`, which cannot set an `Authorization`
header. `pagehide` rather than `beforeunload` because it is the one that fires
on mobile Safari's bfcache path.

**`stream.viewer` names *who*, not just how many.** The event carries `userId`
and `memberChange` (`JOINED`/`LEFT`), and both were being discarded in favour of
the refreshed count. They now render as quiet presence lines folded into the
same log as the chat, so arrivals read in sequence with what is being said.
Own-userId is skipped — "you joined" is not news to you — and the lines share
the chat log's 200-entry tail so a long stream cannot grow the DOM without
limit.

### Privacy switches are symmetric, and the UI has to say so twice

`chatSettings` lives in [ChatContext.jsx](src/context/ChatContext.jsx) and is
seeded **outside** the mount `Promise.all`, so a deploy without
`/messaging/settings` still opens the inbox rather than erroring it. A user with
no saved row behaves as all-on, which is exactly the optimistic default.

Read receipts and last-seen are **reciprocal**: you can never take a signal you
refuse to give. [ChatPrefsPanel.jsx](src/components/chat/ChatPrefsPanel.jsx)
states both halves of every switch for that reason — someone who reads "read
receipts" as "what I broadcast" is going to be surprised when other people's
ticks vanish too. Typing is the odd one out, one-directional.

Two surfaces consume the setting rather than just writing it:

- **The tick ladder.** With receipts off the server sends no `receipt.*` frames
  and nulls the peer markers, so the ladder can never advance past "sent". A
  permanently-single tick reads as "undelivered", so `MessageBubble` takes a
  `receiptsOff` prop and re-labels it *"Sent · read receipts are off"*.
- **`SeenBySheet`.** An empty list means either "nobody yet" *or* "you gave up
  the right to know" — the same wire answer. The client knows its own setting,
  so the copy disambiguates.

Only **my own** switch is knowable. The peer's "off" is indistinguishable from
"no messages yet" on the wire, so the softened copy is only applied to the half
that can be stated truthfully.

**A switch the client only ever writes is a bug in waiting.** All three were
being set by the panel and read by nothing, which meant the app kept behaving as
though they were on:

- **`typingIndicatorsEnabled`** — the server *discards* typing events from a
  user who turned the indicator off, but the client kept sending them: one
  request per 3 seconds of composing, per conversation, guaranteed to do
  nothing. `sendTyping` now short-circuits. The setting is read from
  `settingsRef`, not taken as a dependency, because that callback's identity is
  load-bearing (the Composer's teardown closes over `onTyping`). The paired
  detail is the **stop** ping: it now fires only for a start we actually sent,
  which both avoids emitting stops for suppressed starts and correctly retires a
  live "typing…" if you flip the switch mid-composition.
- **`lastSeenVisible`** — symmetric, so hiding yours nulls `lastSeenEpochMs`
  for *everyone* and the DM status line degrades to a bare "offline" forever.
  The status itself stays true (online/offline is never hidden), but nothing
  connected the missing timestamp to the setting that removed it. The header now
  explains it on hover.
- **`readReceiptsEnabled`** — the one that was already wired, via the tick
  ladder and the seen-by sheet.

### Peer receipt marks are seeded from the DTO

`peerLastReadMessageId` / `peerLastDeliveredMessageId` on `ConversationResponse`
now seed `peerRead` / `peerDelivered` in [ChatPage.jsx](src/pages/ChatPage.jsx).
This closes the behaviour the previous revision of this guide flagged as
"worth not fixing blindly": the marks used to start at `0` with nothing to seed
them, so re-opening a thread showed a lone "Sent" tick on your whole history
until the peer emitted a fresh receipt.

The seed is still `Math.max`, never assignment — a slow DTO must not regress a
live receipt that already landed — and `|| 0` folds the privacy `null` into
"nothing known", which is the honest answer.

### Scheduled messages have no optimistic bubble, on purpose

A queued message does not exist in the timeline until a poller fires it
(~15s granularity) through the **normal send path**, so it gets the same
permission checks, idempotency, fan-out and realtime as a live send — and
permission is re-checked **at fire time**, so a message queued before you were
blocked or removed lands `FAILED` rather than sneaking through a closed door.

An optimistic bubble would be a lie the thread cannot reconcile. The composer
keeps its draft until the row is accepted instead, so a rejected schedule never
eats what you typed.

The presets and the "no earlier than" floor are stamped **once, when the picker
opens** (`schedWindow` state in [Composer.jsx](src/components/chat/Composer.jsx)).
Reading the clock during render is impure — and it would also let the "Tonight"
preset quietly vanish out from under an open menu at 20:00.

The only tell that a queued row has fired is one of *my own* messages arriving
that I did not just type, so `useThread`'s `message.new` case re-pulls the queue
when `scheduledCountRef.current` is non-zero and the outbox is empty.

### `deleteMessage(id, scope)` — one verb, two blast radii

Mirrors the conversation-level overload that
[conversationActions.js](src/components/chat/conversationActions.js) exists for:

- `everyone` — tombstone for all members. The row **stays** in the timeline as a
  "message deleted" stub, so it is patched in place. Confirms first.
- `me` — hides the row from my page/sync/search/starred only. Nothing is
  broadcast and nobody else is affected, so it is **deleted from the map**;
  leaving a stub would claim a deletion the room never saw. Does not confirm —
  it undoes nothing more dramatic than a scroll.

`scope=me` works on **any** readable message, mine or not, which is why it is
offered unconditionally while "Delete for everyone" is gated on
`mine || canModerate`.

### The end-edge panels are one state, not five booleans

`ChatPage` holds a single `panel` value (`PANELS.INFO | SEARCH | STARRED |
SCHEDULED | PREFS | null`). On desktop they all occupy the same third column and
on mobile they are all full-bleed sheets, so exclusivity is **structural** rather
than something each toggle has to remember to enforce. `infoOpen` is derived
(`panel === PANELS.INFO`) purely to keep feeding the `ch-info-open` root class.

`onJump` clears the panel unconditionally: any panel that can produce a jump has
done its job the moment one is taken, and the reader must land on the message
rather than behind a slide-over.


## Invariants and traps (do not undo these)

Every item below is load-bearing and carries an explanatory comment at the site. Each one exists because the "obvious" version was tried and broke something. If you are about to delete a ref, shorten a dependency array, or move a node into a scroll container, read this list first.

### 1. Composer teardown runs off a latest-ref with a genuinely empty dep array

**Invariant.** [Composer.jsx](src/components/chat/Composer.jsx) keeps *two* effects around `teardownRef`: one with no dep array that only refreshes `teardownRef.current`, and one with `[]` that calls it on unmount. The teardown itself is never listed as a dependency of anything.

```js
const teardownRef = React.useRef(null)
React.useEffect(() => {                     // refreshed after every render
  teardownRef.current = () => { /* cancel + stop recorder, cleanupRecorder(), stopTyping() */ }
})
React.useEffect(() => () => { teardownRef.current?.() }, [])   // unmount ONLY
```

**Breaks if changed.** `stopTyping` closes over `onTyping`, which [ChatPage.jsx](src/pages/ChatPage.jsx) passes as an inline arrow (`onTyping={(isTyping) => sendTyping(convo.id, isTyping)}`), so its identity changes on *every* ChatPage render — a typing tick, a presence tick, any incoming message. Listing `[cleanupRecorder, stopTyping]` makes React run the effect's cleanup between renders, which cancels and stops the live `MediaRecorder`. Symptom: recording a voice note dies whenever anyone else does anything in the thread. Do not "fix the lint warning" here.

**Where.** [Composer.jsx](src/components/chat/Composer.jsx), the `teardownRef` block.

### 2. Switching conversations must explicitly abort an in-flight recording

**Invariant.** The `[conversationId]` effect in [Composer.jsx](src/components/chat/Composer.jsx) sets `recRef.current.cancelled = true` and stops the recorder, guarded on `recRef.current.recorder` so first mount is a no-op.

**Breaks if changed.** The Composer is *not* remounted between chats — [ChatPage.jsx](src/pages/ChatPage.jsx) renders the same element with new props and no `key`, so the unmount teardown from #1 never fires on a conversation switch. Trace what actually happens without this branch:

- **Nothing stops the recorder.** There is no automatic `onstop` on a switch. The `MediaRecorder` and its 1s `setInterval` keep running, the mic track stays live, and `recording`/`recSecs` are component state that this effect does not reset — so the recording bar stays on screen in the *new* thread and keeps counting up. The blob goes on accumulating whatever is said while you are in the second conversation. The only unattended stop is the 300s hard cap inside the interval callback.
- **When it finally stops, the upload splits in two.** `recorder.onstop` was assigned inside `startRecording`, so it runs from that render's closure: `onSendFiles` is the *old* conversation's inline arrow, and the `thread.sendFiles` behind it is a `useCallback` keyed on `[conversationId, …]` bound to the conversation you left. The POST therefore lands in the **original** conversation. Meanwhile `setMsgMap` inside `sendFiles` is the single thread store, which has since been reset to the conversation now on screen — so the optimistic bubble, and then the reconciled real message, appear in the **wrong** conversation.

So the failure is not "audio delivered to whoever you landed on". It is worse and harder to spot: a recording that silently spans two conversations, is posted to the first, and is rendered in the second. Still not cosmetic — it sends private audio the recorder was never meant to still be capturing.

**Where.** [Composer.jsx](src/components/chat/Composer.jsx), the "focus + reset when the conversation or context changes" effect.

### 3. The jump pill is a sibling of `.ch-scroll`, never a child

**Invariant.** [MessageList.jsx](src/components/chat/MessageList.jsx) renders `.ch-scrollwrap` > (`.ch-scroll`, live region, `.ch-jump`). `.ch-scrollwrap` is `position:relative`; `.ch-jump` is `position:absolute; inset-block-end:14px; inset-inline-end:18px`.

**Breaks if changed.** An absolutely-positioned child of a scroll container resolves against the *scrolled content box*, not the viewport of the scroller. Moving `.ch-jump` inside `.ch-scroll` makes the pill drift upward and out of sight as you scroll instead of hovering at the bottom edge. Same reasoning applies to anything else you want floating over the thread — including the `.sr-only` live region, which is a sibling for a different reason (a live region over the whole list re-announces history on every paint).

**Where.** [MessageList.jsx](src/components/chat/MessageList.jsx) (the JSX tail) and the `.ch-scrollwrap` / `.ch-jump` rules in §5 of [chat.css](src/styles/warm/chat.css).

### 4. The flash/jump effect keys on `flashId` alone, and `flashedRef` resets on null

**Invariant.** In [MessageList.jsx](src/components/chat/MessageList.jsx) the scroll-into-view effect has `[flashId]` as its only dependency. `flashedRef` records which id has already been scrolled to; when `flashId` goes null the ref is cleared.

**Breaks if changed.** Two separate failures:

- Adding `messages` to the deps. Note first that it does **not** re-yank the viewport on every arriving message — the effect's own `if (flashedRef.current === flashId) return` short-circuits any id that has already landed, and that guard, not the dep array, is what makes each jump scroll exactly once. (The comment above the effect describes the pre-ref version and overstates this; do not take it as a spec.) What `messages` actually breaks is the retry window: the effect's cleanup is `cancelAnimationFrame(raf)`, so every arriving message tears down the pending rAF chain and restarts the effect with `attempts` back at 0. A jump still waiting on `jumpTo` to page history in has its retry budget refreshed by unrelated traffic instead of expiring, and the loop re-arms once per message for as long as the row is missing. Keep `[flashId]` alone so the effect's lifetime is tied to the jump and nothing else.
- Dropping the `if (!flashId) { flashedRef.current = null }` line breaks *re-jumping to the same message*. [ChatPage.jsx](src/pages/ChatPage.jsx) `onJump` deliberately does `setPendingJump(null)` and then sets it back to the same id; without the reset the second jump matches `flashedRef.current === flashId` and silently never scrolls.

The `attempts < 40` rAF retry loop is also required: `jumpTo` may still be paging history in, so the row does not exist on the frame the id arrives.

**Where.** [MessageList.jsx](src/components/chat/MessageList.jsx), "scroll a flashed (jumped-to) message into view". `flashedRef` is also cleared by the `[conversationId]` reset effect.

### 5. Prepend anchoring measures `scrollHeight` in `useLayoutEffect` — so `content-visibility` is banned

**Invariant.** Before a "load earlier" fetch, both the IntersectionObserver path and the manual button stash `prevHeightRef.current = el.scrollHeight` and set `prependingRef.current = true`. The `useLayoutEffect` then restores position with `el.scrollTop += el.scrollHeight - prevHeightRef.current`, *before paint*.

**Breaks if changed.** Two ways:

- Move it to `useEffect` and the browser paints the shoved-down content first — a visible jump on every page of history.
- Add `content-visibility:auto` to `.ch-row` (a tempting perf win on long threads) and off-screen row heights become *estimates*; `scrollHeight` is then a guess and the delta restores to the wrong place. This was tried and removed on purpose — there is a `NOTE:` comment guarding it in §10.5 of [chat.css](src/styles/warm/chat.css). Paint cost is not the bottleneck here.

**Where.** [MessageList.jsx](src/components/chat/MessageList.jsx) (the prepend-anchoring layout effect) and the `content-visibility` note in §10.5 of [chat.css](src/styles/warm/chat.css).

### 6. Every menu portals through `Popover`, and the hosts must not keep their own `contains()` handlers

**Invariant.** [Popover.jsx](src/components/chat/Popover.jsx) renders into `document.body` via `createPortal` with `position:fixed`, placed from the trigger's viewport rect, and owns *all* outside-pointer and Escape dismissal. Every floating menu in chat mounts through it: the bubble quick-react and the bubble more-menu in [MessageBubble.jsx](src/components/chat/MessageBubble.jsx), the conversation-row menu in [ConversationList.jsx](src/components/chat/ConversationList.jsx), the roster menu in [ConversationInfo.jsx](src/components/chat/ConversationInfo.jsx), the header actions menu in [ConversationHeader.jsx](src/components/chat/ConversationHeader.jsx), and the emoji picker in [Composer.jsx](src/components/chat/Composer.jsx).

**Breaks if changed.** Most of them open inside a scroller: `.ch-scroll` (both bubble menus), `.chat-list` (row menu) and `.ci-body` (roster menu) are all `overflow-y:auto`. Per CSS, a non-`visible` value on one axis computes the other to `auto` too, so **both** axes clip: an in-place menu is sliced off near a container edge, and near the bottom it also extends the scrollable area, which makes the list jump. The remaining two portal for their own reasons — the header menu opens from `.ch-hd` (`flex:0 0 auto`), whose `backdrop-filter` stacking context is #7; the emoji picker opens from `.ch-composer` (`flex:0 0 auto`) and was the last surface still cropped by the shell's `.main.ch-main{ overflow:hidden }` (§1 of [chat.css](src/styles/warm/chat.css); the reasoning is written out above the `.ch-emoji` skin in §6). In every case `position:fixed` is what escapes ancestor overflow — and it only works because the portal target is `<body>`, which has no transform/filter/perspective ancestor to re-anchor against.

**The paired trap:** each of those host components has a comment where its outside-click handler *used to be* ([MessageBubble.jsx](src/components/chat/MessageBubble.jsx) above `closeAll`, [ConversationList.jsx](src/components/chat/ConversationList.jsx), [ConversationInfo.jsx](src/components/chat/ConversationInfo.jsx), [ConversationHeader.jsx](src/components/chat/ConversationHeader.jsx), [Composer.jsx](src/components/chat/Composer.jsx) under "emoji popover dismissal"). Re-adding a `wrapRef.contains(e.target)` test reads every click **inside** the portalled menu as an outside click, so the menu closes before the item's `onClick` fires — the menu appears to do nothing. `ConversationHeader` keeps an Escape-only handler for its menu (it additionally restores focus to the trigger); that is the sanctioned exception.

**Also load-bearing:** the doubled-class rule `.ch-pop.ch-pop { inset-*: auto; right:auto; bottom:auto; margin:0 }` in §5 of [chat.css](src/styles/warm/chat.css). Skin classes are passed through to the portal wrapper and some carry their own placement — `.ch-hd-menu` is `position:absolute; inset-block-start:calc(100% + 6px); inset-inline-end:0` and `.cv-menu` offsets by `inset-block-start:38px; inset-inline-end:6px` — so a leftover `right`/`bottom` would stretch the box between two opposite edges once JS supplies inline `top`/`left`.

### 7. `.ch-hd` sets `backdrop-filter`, so it needs its own `z-index`

**Invariant.** §4 of [chat.css](src/styles/warm/chat.css) gives `.ch-hd` `position:relative; z-index:30`.

**Breaks if changed.** `backdrop-filter` **creates a stacking context**. Without an explicit z-index on the header, its dropdown (z 60) is sealed inside that context and cannot out-paint the thread below — message bubbles are `position:relative` and come later in DOM order, so they render straight *through* the open menu. Deleting the z-index because "the header has no overlapping siblings" reproduces this immediately. The portalling from #6 is a second belt, not a replacement.

**Not the same case:** `.ch-pinbar` also takes `position:relative; z-index:20`, but it has no `backdrop-filter` anywhere — its comment says "Same reasoning: the pinned bar sits between the header and the thread", i.e. it is an ordering rung between the header and the scroller, not an escape from a self-created stacking context. Do not go looking for a filter to justify it.

**Related invariant:** the stacking ladder is documented at the top of §12 in [chat.css](src/styles/warm/chat.css) (jump pill 14, botnav 60, `.ch-pop` 100, chat modals 130, sheet 140, lightbox 150, dialogs/toasts 200). Nothing in chat may exceed 199, or a `uiConfirm` dialog or toast raised *from* a chat surface is buried behind the surface that raised it.

### 8. `ChatContext.findConvo` searches the inbox **and** the archived list

**Invariant.** `findConvo` in [ChatContext.jsx](src/context/ChatContext.jsx) resolves against `convosRef` then `archivedRef`, and every mutator (`removeConvo`, `markRead`, `setPinned`, `setMuted`, `setArchived`, `deleteConvo`, the `onRead`/`onEdited`/`onDeleted` stream handlers) goes through it. `patchConvo` likewise writes into both lists.

**Breaks if changed.** A conversation lives in exactly one of the two lists. Call sites that only searched `conversations` found nothing for an archived thread, so its badge bookkeeping was silently skipped — reading an archived chat, or receiving a read receipt for one from another device, left `totalUnread` permanently inflated with no way to clear it. Any new lookup you add must use `findConvo` (or `getConvo`, its render-time twin), never `conversations.find(...)`.

### 9. `member.changed` count deltas are computed inside the state updater

**Invariant.** In the `onMember` handler of [ChatContext.jsx](src/context/ChatContext.jsx):

```js
const delta = evt.memberChange === 'ADDED' ? 1
  : (evt.memberChange === 'REMOVED' || evt.memberChange === 'LEFT') ? -1 : 0
if (delta) {
  const bump = (list) => list.map(c => (c.id === evt.conversationId
    ? { ...c, memberCount: Math.max(0, (c.memberCount || 0) + delta) } : c))
  setConversations(bump); setArchivedList(bump)
}
```

**Breaks if changed.** Reading `convosRef.current` first and writing an absolute value collapses a burst of joins to a single ±1: every handler in the burst reads the same pre-flush snapshot. `memberCount` is display-only on the client — it feeds the header subtitle in [ConversationHeader.jsx](src/components/chat/ConversationHeader.jsx), the group subtitle in [ChatPage.jsx](src/pages/ChatPage.jsx), the panel subtitle and Members label in [ConversationInfo.jsx](src/components/chat/ConversationInfo.jsx), and the "all N members lose access" copy in `deleteIntentOf` ([conversationActions.js](src/components/chat/conversationActions.js)). Nothing on the client gates behaviour on group size — any such threshold is the backend's — so the symptom is purely that all of those readouts drift permanently after someone bulk-adds people, including a destructive confirm that then understates what it is about to destroy. The same reasoning applies to `setTotalUnread(t => …)` everywhere in this file — never compute a total from a ref.

### 10. The cross-conversation jump gates on `loadedForRef`, not `thread.loading`

**Invariant.** [ChatPage.jsx](src/pages/ChatPage.jsx) keeps `loadedForRef`, a ref of which conversation the thread store has actually finished loading, and the deferred-jump consume effect requires both conditions:

```js
React.useEffect(() => { if (!thread.loading) loadedForRef.current = id }, [thread.loading, id])
// …
if (thread.loading || loadedForRef.current !== id) return
```

**Breaks if changed.** `thread.loading` alone is a stale snapshot: on the first render after `navigate()`, `id` is already the new conversation but `loading` still holds the *previous* thread's settled `false`. The effect then fires against the old store, `jumpTo` sees a reset cursor, returns `false`, and the jump is dropped with no retry — searching into another conversation lands you at the bottom of it instead of at the hit. Note also that `setDeferredJump(null)` happens in `.finally()`, *after* the attempt, so a jump can never be swallowed by a render that ran before the thread was ready.

### 11. Enter-to-send is gated on IME composition **and** a fine-pointer media query

**Invariant.** `onKeyDown` in [Composer.jsx](src/components/chat/Composer.jsx):

```js
if (e.nativeEvent?.isComposing || e.keyCode === 229) return
if (e.key === 'Enter' && !e.shiftKey && isFinePointer()) { e.preventDefault(); submit() }
```

`isFinePointer()` is `window.matchMedia?.('(hover: hover) and (pointer: fine)').matches`.

**Breaks if changed.** Two independent regressions:

- Dropping the `isComposing` / `keyCode === 229` guard: while an IME candidate window is open, Enter is *committing the composition*, not sending. Arabic, Kurdish and CJK input then sends a half-typed word on every accepted candidate. Keep both checks — `isComposing` is unreliable on older Safari/Android, `keyCode 229` is the legacy fallback.
- Dropping the fine-pointer gate: on a phone the on-screen Return key must insert a newline (there is a Send button right there). Making Enter send everywhere means touch users cannot write a multi-line message at all.

### 12. Keyboard-reachable controls are hidden with `opacity`, never `display:none`

**Invariant.** Two places in [chat.css](src/styles/warm/chat.css) hide a control while keeping it focusable:

- `.cv-menu-btn` (§2): `opacity:0`, revealed by `.cv-menu-host:hover`, `.cv-menu-host:focus-within`, its own `:focus-visible`, and `[aria-expanded="true"]`.
- `.ch-tools` inside the `@media(max-width:720px)` block in §10: `opacity:0; pointer-events:none`, revealed by `:focus-within` and `.open`.

**Breaks if changed.** `display:none` also removes the element from the tab order. For `.cv-menu-btn` the only rule that would bring it back is `[aria-expanded="true"]`, which can only be true *after* it has been activated — so a keyboard user could never reach it at all. For `.ch-tools` at mobile width, reply/react/forward/delete become unreachable for anyone on a keyboard, since the long-press sheet that replaces the rail needs touch. `visibility:hidden` has the same defect. Use `opacity` + `pointer-events` and add a `:focus-within` reveal.

> **Doc-vs-code mismatch, worth knowing:** the comment above `startPress` in [MessageBubble.jsx](src/components/chat/MessageBubble.jsx) still says the hover rail is "`display:none` under 720px". The CSS does *not* do that (see above) — the conclusion (long-press must open a sheet, not the rail) holds only because of `pointer-events:none`. Do not "restore consistency" by changing the CSS to match the comment; fix the comment. The file-header note and the comment on the long-press sheet JSX both say "hidden under 720px", which is accurate and needs no touching.

### 13. A self-scheduling rAF loop is created inside its effect, never as a `useCallback`

**Invariant.** Both players ([VoiceNote.jsx](src/components/chat/VoiceNote.jsx), [VideoPlayer.jsx](src/components/chat/VideoPlayer.jsx)) build the tick function *inside* the effect and re-arm through a ref:

```js
React.useEffect(() => {
  if (!playing) { cancelAnimationFrame(rafRef.current); paint(); return undefined }
  const tick = () => { paint(); rafRef.current = requestAnimationFrame(tick) }
  rafRef.current = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(rafRef.current)
}, [playing, paint])
```

**Breaks if changed.** A `useCallback` that schedules *itself* captures the version of itself that existed when it was created, so it never sees a newer `paint` — the lint rule (`react-hooks/immutability`) rejects it, and it is right to. Cancelling through the ref rather than a captured id is what makes the cleanup cancel the *latest* frame instead of the first one.

### 14. `--p` is written by the paint loop and by nothing else

**Invariant.** The progress custom property lives on `.ch-voice` / `.vp` and is written only from `paint()`. The played waveform layer and the video's played bar/knob derive from it in CSS; nothing reads it back.

**Breaks if changed.** Setting it from a React render re-introduces the 60 Hz re-render the loop exists to avoid, and setting it from two places produces a playhead that fights itself during a drag. Note the RTL pair: `clip-path` has no logical form, so `.ch-wave-layer.played` carries a `[dir="rtl"]` twin. `.ch-wave-head` does not need one — a percentage `inset-inline-start` already resolves against the start edge in both directions.

### 15. Every call teardown passes an outcome

**Invariant.** `teardown(outcome)` in [CallContext.jsx](src/context/CallContext.jsx) is the single exit path, and each caller names the ending: `hangUp` → `answered` while active / `cancelled` before, `declineCall` → `declined`, `call.ended` → the status translation table, a failed start → `failed`.

**Breaks if changed.** The word cannot be recovered afterwards — a `CANCELLED` call is "you hung up" to one end and "missed call" to the other — and it is the entire content of the timeline card. A `teardown()` with no argument still commits (answered / no-answer / missed by direction), so a missed call is never silently lost; but a *wrong* outcome is worse than a generic one, which is why the callers, not `commitLog`, own the decision.

### 16. Popovers opened from a surface above z 100 need their own rung

**Invariant.** `.ch-pop.vp-speedmenu{ z-index:155 }` (over the lightbox at 150) and `.ch-pop.cl-devmenu{ z-index:170 }` (over the call overlay at 160), both in chat-extras.css.

**Breaks if changed.** [Popover.jsx](src/components/chat/Popover.jsx) portals to `<body>` and inherits `.ch-pop`'s z-index of 100, which is *below* both of those surfaces — the menu opens, takes the outside-click handler with it, and is invisible. Two classes so it out-specifies the base rule without `!important`, and both stay under the 199 ceiling that belongs to dialogs and toasts.

### Smaller ones, same rule

- **Optimistic message ids.** `newTmpId()` in [ids.js](src/api/ids.js) mints `t1`, `t2`, … — not a Snowflake shape, so they can never collide with a real id, and `cmpId` sorts them last (pending messages are newest). Every "is this real?" check is `!isTmpId(id)`. The previous scheme (`Number.MAX_SAFE_INTEGER - 1_000_000 + seq`) was built on the false premise that real Snowflakes fit under 2^53; they are ~40× larger, so every real id tested as "temp", `highestRealId()` returned 0, and both the read marker and the gap-sync anchor were dead.
- **`onConvoPatchRef`.** [useThread.js](src/components/chat/useThread.js) holds `onConvoPatch` in a ref specifically so an inline parent callback cannot change `scheduleRead`'s identity — which would churn `reload`, whose identity is a dependency of the conversation-lifecycle effect that *resets and refetches the whole thread*. Inline that callback into the dep chain and the thread reloads in a loop.
- **The `sending` flag.** [Composer.jsx](src/components/chat/Composer.jsx). Send is async; without an in-flight flag the button swaps back to the MIC as soon as the draft clears, so the second hit of a double-click starts a recording instead of being a harmless no-op.
- **`inFlightUsersRef`.** [ChatContext.jsx](src/context/ChatContext.jsx). Between clearing `usersPendingRef` and the profile responses landing, an id sits in neither map, so `watchUsers` re-queues it every render. The in-flight set holds it for the round trip. The same shape of bug lies in wait for any "pending → cache" pair you add.
- **Pinned-bar markup.** [ChatPage.jsx](src/pages/ChatPage.jsx) uses two *sibling* buttons (`.ch-pinbar-main`, `.ch-pinbar-x`) rather than a nested control inside a `div[role="button"]`: the ARIA `button` role has presentational children, so a nested control is pruned from the accessibility tree entirely.
- **`unreadFrom` is pinned, not live.** [ChatPage.jsx](src/pages/ChatPage.jsx) captures the unread marker once per conversation via `unreadPinnedFor` — to `convo.lastReadMessageId || 0` when `convo.unreadCount > 0`, otherwise to `null` (no rule at all). Deriving it live from `convo.unreadCount` makes the "Unread messages" rule slide down the screen as receipts land.
- **`_reactionsExact` is a cache key, not a data field.** [useThread.js](src/components/chat/useThread.js) stamps it on a row once the per-viewer reaction flags are known — from `refreshReactions`, or from `toggleReaction`'s authoritative response. It is deliberately client-only and deliberately lost when `reload()` rebuilds the row, because the counts changed too. Strip it and every hover re-fetches; persist it across a reload and stale `reactedByMe` flags come back.
- **The two search scopes degrade differently, and "No matches" was lying about one of them.** In-conversation search has a bounded Cassandra-scan fallback, so `[]` there genuinely means nothing matched. Cross-conversation is **Elasticsearch-only** — deliberately no fallback, since an all-conversations scan would be unbounded — and it returns `[]` *rather than erroring* when the index is unavailable. On top of that, indexing is async and best-effort, and `SYSTEM` plus **empty-body (pure-media) messages are never indexed at all** — a photo with no caption is permanently unsearchable. One shared "Try a different word" covered four different situations; the empty state is now scope-aware and names the un-indexable content instead of implying the query was wrong.
- **Search results are BM25-ranked, not chronological.** The dates run out of order *by design*, which reads as a sorting bug until the ordering is named — hence the `.ch-search-order` line above the hits. The in-conversation scan fallback is the exception: with a cold index it returns newest-first instead, and nothing on the wire says which path served the request.
- **A search failure can be a permission answer.** In-conversation search returns `NOT_A_MEMBER` / `CONVERSATION_NOT_FOUND`; "Search is unavailable right now" is the wrong sentence for both. The panel keeps the error object, not just an error *flag*, and renders it through the shared catalog.
- **The forward picker must apply FULL send permission, not "am I a member?".** Forward re-evaluates send permission **against the target**, so a picker filtering only on `myStatus === 'ACTIVE'` cheerfully offered broadcast channels and admins-only groups — and the forward bounced `403 ADMINS_ONLY` *after* the user had chosen one. `sendBlockReason(convo)` in [conversationActions.js](src/components/chat/conversationActions.js) is now the single answer, consumed by both the composer's `lockedReason` and the picker's filter. Its precedence is the backend's own — membership, then restriction, then send mode; getting that order wrong tells a removed member they are "restricted".
- **`width`/`height` on IMAGE/VIDEO media are load-bearing, not metadata.** They come back on every visual attachment and were being dropped. Multi-tile albums survive it because `.ch-media:not(.n-1) .ch-asset` pins `aspect-ratio:1`, but a **single-image** bubble has `width:100%` and no height — so the tile is zero-high until the bytes decode and the row jumps. That is not a cosmetic flicker: MessageList anchors "load earlier" by measuring `scrollHeight` in a layout effect, and a row that resizes *after* the measurement restores the scroll to the wrong offset — the same failure mode the `content-visibility` ban exists to prevent. The attributes supply the intrinsic ratio and `.ch-media.n-1 .ch-asset img[width]{height:auto}` is what makes the browser honour it. Never set an explicit height there.
- **Chat reactions are ONE emoji per user, and a change looks exactly like an add.** Unlike the post module's single-`LIKE` model: reacting again with a different emoji **moves** you, one row per `(message, user)`. The trap is on the wire — an add and a change both arrive as a single `message.reaction` with `added: true` for the *new* emoji, with **no** paired `added: false` for the old one. A consumer that only increments leaves the previous bucket standing forever, so counts drift upward on every reaction anyone changes their mind about. `applyReactionSwitch` in [useThread.js](src/components/chat/useThread.js) retires the old bucket, and `reactorsRef` (`messageId → userId → emoji`, built purely from observed events) is what makes that possible — the reaction summary carries **counts, not member lists**, so there is no other record of who holds what. A reactor we never observed clears `_reactionsExact` instead of guessing, and the lazy re-hydration repairs it on the next hover. The same rule applies to my own optimistic frame: tapping a second emoji must retire my first, or I hold two reactions until the response lands.
- **A soft-deleted message is unpinned server-side, and the pin bar is a separate fetch.** Nothing in the delete path would otherwise refresh it, so a tombstoned message stayed quoted in `.ch-pinbar` until the next reload. `deleteMessage(id, 'everyone')` drops it from `pinned` optimistically and `reloadPinned()`s if the delete fails.
- **A conversation you lose access to while reading it must tear down its view.** The context drops it from the inbox; that is only half. Without the page-level half, an owner deleting the group (or you being removed) leaves you on a live-looking transcript you can no longer post to — and because `removeConvo` makes `getConvo(id)` miss, ChatPage's deep-link effect immediately re-fetches, so the only thing that stops the loop is a 404 rendering an error pane that explains nothing. [ChatPage.jsx](src/pages/ChatPage.jsx) subscribes for `conversation.updated:DELETED` and `member.changed:REMOVED|LEFT` **for my own userId**, toasts what happened, and `navigate('/chat', { replace: true })`.
- **A group OWNER must never be offered a bare "Leave group".** The server refuses it while anyone else remains (`400`, *"Transfer ownership before leaving, or delete the group"*), so it is a button that can only fail. [ConversationHeader.jsx](src/components/chat/ConversationHeader.jsx) branches three ways — DM → delete; owner with company → the **delete** path labelled by `deleteIntentOf`; everyone else (including a *sole* owner, whose leave legitimately soft-deletes the group in the same transaction) → leave. This is why the header now imports [conversationActions.js](src/components/chat/conversationActions.js): the moment the destructive owner path became reachable from that menu, hard-coded copy became the exact mislabel the helper exists to prevent.
- **`totalUnread` needs a re-seed, not a subtraction, for large groups.** Past 256 members the server stops maintaining `unreadCount` — it stays `0` while `hasUnread` carries the signal. `applyMessageNew` still adds `+1` per arrival, so `markRead`'s `t - c.unreadCount` subtracted nothing and the badge climbed and never came down until the next reconnect. `markRead` now calls `reseedUnread()` when there is nothing to subtract but the thread *was* unread. It is the one read path where a REST round trip beats a delta, and it fires only for that case.
- **SYSTEM messages have a vocabulary — use `systemEvent`.** The server composes readable text ("@actor added @user") and that always wins, because it is the only thing that knows the names. But when `body` is empty the bubble used to render one flat "Conversation updated" for an ownership transfer, a title tweak and a disappearing-timer change alike. [systemEvents.js](src/components/chat/systemEvents.js) maps the enum to specific copy **and** an icon; the fallback stays generic for an unknown constant rather than showing the reader a raw enum. The glyph goes *inside* `.ch-system span` — that span is the pill, and a sibling would be laid out as a second centred flex item beside it.
- **The inbox preview must never carry a disappearing message's text.** The server substitutes a neutral placeholder in `lastMessagePreview` (and in the push notification) whenever `disappearingSeconds > 0` — part of the same guarantee that keeps the body out of Elasticsearch. But the client *derives* its own preview from the `message.new` payload, which does carry the text, so `previewOf(m, ephemeral)` in [ChatContext.jsx](src/context/ChatContext.jsx) takes the timer as a second argument and returns `DISAPPEARING_PREVIEW` instead. Both write paths need it — `message.new` and `message.edited` (an edit re-applies the remaining TTL, so the new body is just as ephemeral). Without it the vanishing text is written into the rail, where it outlives the message it came from. The flag is read **inside** the `setConversations` updater so it stays correct if the timer changed in the same tick.
- **Two different member caps, one shared picker.** Creating a group seeds `memberIds` (≤ **256**, the conversation ceiling); adding to an existing group is `AddMembersRequest.userIds` (≤ **100 per call**). [NewChatModal.jsx](src/components/chat/NewChatModal.jsx) serves both modes from one list, so it keys the cap off `isAdd` — a single constant let an admin select 150 people and only learn on submit.
- **`markUnread` does not touch `totalUnread`.** The badge counts real unread *messages*; the server keeps `unreadCount` at 0 for a manually-flagged thread and only raises `markedUnread`. Incrementing the total here would inflate a badge that no read can ever clear. Conversely `markRead` must clear `markedUnread` locally, or a flagged thread keeps its dot after you have opened it.
- **The `me`/`everyone` delete asymmetry in the map.** `scope: 'everyone'` *patches* (the tombstone stays in the timeline); `scope: 'me'` *deletes* from the Map. Making them symmetric either way is a bug: patching for `me` shows the room a deletion that never happened, and deleting for `everyone` loses the stub every other member can see.
- **`localStamp()` emits a zone-less local wall clock.** `ScheduleMessageRequest.scheduledAt` is documented without a zone suffix. Appending `Z` — or using `toISOString()` — silently shifts every scheduled message by the reader's UTC offset. [Composer.jsx](src/components/chat/Composer.jsx).
- **`stream_`, not `stream`, inside `adaptEvent`'s `stream.*` cases.** `stream` is the module-level `EventSource` wrapper in the same file. [chat.js](src/api/chat.js).
- **A tombstone names its deleter only when it can.** `deletedBy` is stamped from the actor on the `message.deleted` frame and locally on my own delete; the REST row carries no actor (three plausible field names are read opportunistically in `msgFrom`, all absent today). When it is null the copy stays "This message was deleted" rather than guessing the sender removed their own message — in a group an admin very often did. The delete rollback restores `deletedBy: prev.deletedBy ?? null` for the same reason.
- **The connection banner is delayed by 1.2 s on purpose.** `connected` flickers false for a beat on the initial dial and during a token refresh; a bar that strobes on every routine reconnect trains people to ignore it. `offline` (from `navigator.onLine`) shows immediately — that one is never a flicker. "Back online" appears once for 2.4 s and only if something actually went down, which is what `wasDownRef` tracks.
- **Call cards are placed by TIME, not by id.** They never touched the server's timeline, so they have no id to sort against. A card lands before the first message newer than it; anything left over is appended (the common case — the call you just finished is newer than everything loaded). Cards older than the oldest loaded message are **dropped while `hasMore` is true**: they belong above the window, and pinning them to the top of a partial page would put yesterday's call above this morning's messages.
- **The `:has()` / body-class pair.** Inside the `@media(max-width:720px)` block in §10 of [chat.css](src/styles/warm/chat.css), `body:has(.main.ch-main.ch-thread-open) .botnav{ display:none }` and `body.chat-thread-open .botnav{ display:none }` are **two separate rules** — note the `:has()` argument is the full compound `.main.ch-main.ch-thread-open`, and the fallback hook is a *body* class with a different name. Merging them into one selector list is a real bug: an unsupported `:has()` invalidates the whole list and takes the fallback down with it, putting the bottom nav on top of the composer. [ChatPage.jsx](src/pages/ChatPage.jsx) sets the body class in an effect.


## Working on this module

### The files that matter

| File | Owns |
| --- | --- |
| [src/api/chat.js](src/api/chat.js) | HTTP surface, DTO→view adapters, the single SSE `stream()` |
| [src/context/ChatContext.jsx](src/context/ChatContext.jsx) | The ONE `/messaging/stream` socket for the whole app, inbox list, unread badge, privacy switches, typing/presence/user-directory caches |
| [src/context/CallContext.jsx](src/context/CallContext.jsx) | The WebRTC mesh and the call lifecycle, driven off that same socket |
| [src/components/chat/useThread.js](src/components/chat/useThread.js) | One conversation's messages (Map keyed by id), optimistic send, gap-sync, read marker, star, the send-later queue |
| [src/components/chat/mediaPrefs.js](src/components/chat/mediaPrefs.js) | Playback speed / volume / mute shared by every player, the heard-voice registry, the continuous-playback handoff |
| [src/components/chat/callLog.js](src/components/chat/callLog.js) | This device's call history — the timeline cards and the info panel's totals; the API has no equivalent |
| [src/components/chat/VoiceNote.jsx](src/components/chat/VoiceNote.jsx) · [VideoPlayer.jsx](src/components/chat/VideoPlayer.jsx) | The two media players. Position is driven by a rAF loop writing `--p`, never by React state |
| [src/pages/ChatPage.jsx](src/pages/ChatPage.jsx) | The two-pane shell; instantiates `useThread` **once** and hands the same object to the list and the composer |
| [src/styles/warm/chat.css](src/styles/warm/chat.css) | Every `.ch-*`, `.ci-*`, `.rq-*` rule and chat's `.cv-*` inbox-row family (`.cv-row`, `.cv-menu-host`, `.cv-menu-btn`, `.cv-preview`, …), imported from [src/main.jsx](src/main.jsx) |
| [src/styles/warm/chat-extras.css](src/styles/warm/chat-extras.css) | The surfaces chat.css predates: `.cl-*` calls, `.cn-*` channels, `.lv-*` live, and the additions to the starred / scheduled / privacy slide-overs. Imported **immediately after** chat.css and before `warm/responsive.css` |

Chat does not own the `.cv-*` prefix outright: `.cv-pill`, `.cv-rec` and `.cv-btn` belong to the reels recorder UI and live in [src/styles/styles-user.css](src/styles/styles-user.css) with a dark-theme override in [src/styles/warm/feed.css](src/styles/warm/feed.css). They never meet a chat element — but do not assume a `.cv-` selector you find is yours. The same now applies in reverse to `.cl-*`, which is calls and nothing else.

Routes live in [src/App.jsx](src/App.jsx): `chat`, `chat/requests`, `chat/join/:token`, `chat/:id`, plus `channels`, `live` and `live/:id`. The provider stack is
`<RequireAuth><ChatProvider><CallProvider><Layout/></CallProvider></ChatProvider></RequireAuth>` — `ChatProvider` wraps `<Layout/>` rather than the chat route because the nav badge and every chat surface must read one socket, and `CallProvider` sits inside it because it consumes that socket's firehose while still needing to be above the whole shell.

`chat-extras.css` extends the z-index ladder without breaching it: `.cl-pill` 150, `.cl-overlay` 160, `.ch-pop.vp-speedmenu` 155 and `.ch-pop.cl-devmenu` 170 (a portalled menu inherits `.ch-pop`'s 100, which is *under* the lightbox and the call overlay it opens from). The call sits above the chat lightbox (150 in chat.css §12) deliberately — a ringing phone must never be buried under a photo you happened to have open — and still under the 200 ceiling that `.dlg-overlay` and `.toast` own, so a confirm raised *from* a call surface lands on top of it.

### Running it

```
npm run dev      # vite (host:true → prints the LAN URL)
npm run build    # vite build
npm run lint     # eslint .
npm run preview  # vite preview
```

There is no test script and no typecheck. Set `VITE_DEV_PROXY=http://localhost:8080` to proxy `/api` (and websockets) at dev time and leave `VITE_API_BASE_URL` empty — see [vite.config.js](vite.config.js).

### Lint state

`npm run lint` currently reports problems, **all outside the chat module** (chat, its contexts and the channels/live pages are clean — keep it that way):

- [src/components/Reels.jsx](src/components/Reels.jsx) — `react-hooks/immutability`: `setCmtOpen` is used by a `useEffect` that sits above the `useState` declaring it.
- [src/components/Reels.jsx](src/components/Reels.jsx) — `react-hooks/refs`: "Cannot access refs during render" (`trackRef` and friends read inside the `reels.map` render body).
- [src/pages/WatchedReelsPage.jsx](src/pages/WatchedReelsPage.jsx) — `no-unused-vars`: `'Avatar' is defined but never used`.
- Warning: [src/components/TagInput.jsx](src/components/TagInput.jsx) — `react-hooks/exhaustive-deps` on a conditional `tags`.

Three rules bite hard in this module and shaped real code, so know them before
you "simplify":

- **`react-hooks/refs`** — no reading `ref.current` during render. It is why the
  ringer is built in a mount effect ([CallContext.jsx](src/context/CallContext.jsx))
  and why HLS support is probed into state rather than read off `videoRef`
  during render ([LivePage.jsx](src/pages/LivePage.jsx)).
- **`react-hooks/purity`** — no `Date.now()` in the render path. It is why the
  scheduler's presets are stamped into `schedWindow` state on open
  ([Composer.jsx](src/components/chat/Composer.jsx)).
- **`react-refresh/only-export-components`** — a component file exporting a
  helper is a warning, which is why `whenLabel` in
  [ScheduledPanel.jsx](src/components/chat/ScheduledPanel.jsx) is module-private.

Two project-wide rule overrides in [eslint.config.js](eslint.config.js) are load-bearing for chat: `react-hooks/set-state-in-effect` is **off** (the fetch-effect pattern used by `useThread.reload`, `ChatSearchPanel`, `ConversationInfo`), and `react-refresh/only-export-components` is a warning — `ChatContext.jsx` additionally file-disables it at the top because it exports a provider *and* `useChat`.

### Adding a new SSE event, end to end

Do these in order; steps 1–2 are mandatory, 3–5 depend on who cares.

1. **[src/api/chat.js](src/api/chat.js) → `EVENT_HANDLER`.** Add `'thing.happened': 'onThing'`. This is not optional bookkeeping: `stream()` derives its `es.addEventListener` calls from the keys of this map (each key plus the `THING_HAPPENED` alias it uppercases), and `es.onmessage` only catches *unnamed* frames. The only listeners registered outside the map are the `heartbeat` / `HEARTBEAT` pair inside `stream()`, which just stamp the watchdog clock and never dispatch. So a named event missing from this map reaches nothing — not even `onAny`.
2. **[src/api/chat.js](src/api/chat.js) → `adaptEvent()`.** Add a `case`. Push every message id through `mid()`; the whole client orders, dedupes and gap-syncs with `cmpId`, and a raw value that skipped normalisation breaks comparisons silently. The `default:` branch of `adaptEvent` spreads the raw payload — it looks like it works until you compare ids, so never rely on it for anything with a Snowflake in it.
3. **[src/context/ChatContext.jsx](src/context/ChatContext.jsx)** — if it changes inbox rows or the badge, add `onThing:` to the `api.chat.stream({ … })` options inside the big socket effect and mutate through the existing `findConvo` / `patchConvo` / `upsertConvo` / `removeConvo` helpers. Two rules: counters are **±1 deltas** (the wire carries no absolute counts; `reseedUnread()` on `connected` is the only correction), and a delta must be computed **inside** the state updater — `onMember` carries a comment explaining that reading `convosRef` first collapsed a burst of joins to a single +1, because every handler in the burst read the same pre-flush snapshot. Any new `useCallback` you reference must join that effect's dependency array or the handler closes over a stale one.
4. **[src/components/chat/useThread.js](src/components/chat/useThread.js)** — if only the open thread cares, skip step 3 entirely: `onAny: broadcast` already re-emits every adapted event to `subscribe()` consumers. Add a `case` to the switch inside `useThread`'s `subscribe()` effect, guard `if (evt.conversationId !== conversationId) return`, and add new callbacks to that effect's deps.
5. **[src/pages/ChatPage.jsx](src/pages/ChatPage.jsx)** — page-level state (not message state) has its own `subscribe()` effect; that is where `receipt.delivered` / `receipt.read` become the `peerDelivered` / `peerRead` high-water marks.
6. **Reconnect story.** The watchdog re-dials after 60s without a heartbeat (checked every 15s), and a hard close (`readyState === 2`) triggers a token refresh + re-open. Anything that mutates messages must also be repairable by `gapSync()` ([useThread.js](src/components/chat/useThread.js), fired on `connected`) or by `reseedUnread()`, or state drifts across every disconnect.

### Adding a new message type to the bubble

`msgFrom` passes `dto.type` through verbatim and derives `isSystem = type === 'SYSTEM' || !!dto.systemEvent`; `mediaFrom` defaults an unknown `kind` to `'FILE'` (both in [chat.js](src/api/chat.js)). So a new type renders *something* by default — usually the wrong thing.

1. **[MessageBubble.jsx](src/components/chat/MessageBubble.jsx)** — `MediaBlock` partitions `media` into visuals (`IMAGE|VIDEO`), voices (`VOICE`) and "everything else → file row". Add your partition there. Render the new block **inside `.ch-bubble` before the `.ch-meta` span**: the meta line is `float:inline-end` (the `.ch-meta` rule in §5 · Message list of [chat.css](src/styles/warm/chat.css)) in the text flow, which is what lets a short message share one line with its timestamp; a block-level sibling placed after it destroys that shape.
2. **Update every hard-coded preview map** — they are duplicated on purpose (different wording/casing per surface), and missing one shows a blank or "Message":
   - [ChatContext.jsx](src/context/ChatContext.jsx) — `previewOf`, inbox rail
   - [MessageBubble.jsx](src/components/chat/MessageBubble.jsx) — reply quote
   - [MessageList.jsx](src/components/chat/MessageList.jsx) — `liveSay`, lower-case "a photo" (screen-reader copy)
   - [Composer.jsx](src/components/chat/Composer.jsx) — reply/edit strip
   - [ChatPage.jsx](src/pages/ChatPage.jsx) — `.ch-pinbar-text`, the pin bar
   - [ConversationInfo.jsx](src/components/chat/ConversationInfo.jsx) — pinned list
3. **[useThread.js](src/components/chat/useThread.js)** — `kindOfFile()` maps a `File` to a kind for the optimistic bubble, and `buildOptimistic()` must emit `msgFrom`'s field set plus the three local-only flags `clientNonce` / `pending` / `failed`. `reconcile()` deletes the pending entry and inserts the server object under the real id, so anything the client stitched on locally is gone at that moment. The worked example is `durationMs` on a voice note: the multipart endpoint has no duration part, so `sendFiles` carries it on the optimistic media purely to stop the pending bubble rendering 0:00, and the server re-derives its own value (there is a comment on `sendFiles` saying so). A field the real message genuinely lacks will read as `undefined` from reconcile onward.
4. If the type is a centred notice rather than a bubble, it only needs `isSystem` — the early return for system messages in [MessageBubble.jsx](src/components/chat/MessageBubble.jsx) handles layout.

### Adding a new conversation action

1. **[src/api/chat.js](src/api/chat.js)** — one line in `chat.conversations` or `chat.members`.
2. **[ChatContext.jsx](src/context/ChatContext.jsx)** — a `useCallback` following the `setPinned` / `setMuted` / `setArchived` shape: read the current row via `findConvo` (it searches **both** the inbox and the archived list, so a caller can't miss an archived thread and skip its badge bookkeeping), `patchConvo` optimistically, `await`, then roll back + `showToast` on failure. Export it in the `value` object.
3. **Surface it in each menu**, all data-driven arrays of `{ key, label, icon, run, danger? }`:
   - [ConversationList.jsx](src/components/chat/ConversationList.jsx) — row hover menu
   - [ConversationHeader.jsx](src/components/chat/ConversationHeader.jsx) — thread overflow; this one **must** stay a flat array, because the roving-tabindex keyboard handling (`activeIdx`, `itemRefs`, Arrow/Home/End) indexes into it
   - [ConversationInfo.jsx](src/components/chat/ConversationInfo.jsx) — `.ci-row` toggles / danger zone
4. **Destructive actions**: put the copy in [conversationActions.js](src/components/chat/conversationActions.js), never inline. `deleteIntentOf()` exists because `DELETE /conversations/{id}` means "destroy for everyone" to a group owner and "clear for me" to everyone else — a surface that writes its own label can let an owner nuke a group while believing they are tidying an inbox. Then route it through `uiConfirm` from [Dialog.jsx](src/components/Dialog.jsx).
5. Menus render through [Popover.jsx](src/components/chat/Popover.jsx), which portals to `<body>` with `position:fixed`. **Do not add an outside-click handler based on `wrapRef.contains(e.target)`** — the menu is not a DOM descendant of the trigger, so every in-menu click reads as an outside click and dismisses before the item fires. Popover owns outside-pointer and Escape dismissal. Every file that opens one carries a comment saying so: [ConversationList.jsx](src/components/chat/ConversationList.jsx), [ConversationHeader.jsx](src/components/chat/ConversationHeader.jsx), [Composer.jsx](src/components/chat/Composer.jsx) and [MessageBubble.jsx](src/components/chat/MessageBubble.jsx).

### Accessibility baseline to preserve

- **Focus rings.** One shared `:focus-visible` block in §10.5 · Motion & focus polish of [chat.css](src/styles/warm/chat.css) — introduced by the single line `/* visible, consistent focus rings (keyboard only) */` — covers `.cv-row .ch-react .ch-tool .ch-cbtn .ch-send .ch-urow .ch-hitrow .ch-fwd-row .ci-row.click .rq-btn .ch-quote .ch-pinbar` plus a `.chat-list .cv-row` repeat. `.ch-menu-item` has its own ring next to the base `.ch-menu-item` rule, and that one carries the rationale in a comment above it: an `outline:0` there used to cancel the global `:focus-visible` style and left keyboard users with no indication of where they were in any menu sharing the class. (The comment says "four menus" and undercounts — `MessageBubble` alone renders `.ch-menu-item` twice, for the overflow menu and the long-press sheet, on top of `ConversationList`, `ConversationHeader` and `ConversationInfo`.) Never re-add one.
- **`sr-only`** is defined in [chat.css](src/styles/warm/chat.css) — chat introduced it; nothing else in `src/styles/` defines a visually-hidden utility.
- **Receipt ticks** ([MessageBubble.jsx](src/components/chat/MessageBubble.jsx)): the tick `<svg>` has no accessible name, so each state ships an `sr-only` word — `Sending` / `Sent` / `Delivered` / `Read`. Without it "sent" and "read" are indistinguishable, which is the entire point of a receipt.
- **Inbox flags and badges** ([ConversationList.jsx](src/components/chat/ConversationList.jsx)): pin and mute icons each get an `sr-only` word; the visible unread count is `aria-hidden` with an `sr-only` "N unread messages" beside it; the large-group `hasUnread` dot gets "Unread messages".
- **Focus traps.** The media lightbox ([ChatPage.jsx](src/pages/ChatPage.jsx)) and the long-press action sheet ([MessageBubble.jsx](src/components/chat/MessageBubble.jsx)) each trap Tab, lock `document.body.style.overflow`, focus the first control, and **restore focus to the element captured on open**. Copy that three-part pattern for any new modal. `NewChatModal` ([NewChatModal.jsx](src/components/chat/NewChatModal.jsx)) traps and locks but does not restore.
- **One live region.** [MessageList.jsx](src/components/chat/MessageList.jsx) renders a single `aria-live="polite" aria-atomic="true"` node, kept outside the scroller, fed by the `liveSay` memo, which returns `''` when the newest non-system message is mine. A live region spanning the list re-announces history on every paint.
- **Typing indicator** ([MessageList.jsx](src/components/chat/MessageList.jsx)): animated dots are `aria-hidden`; an `sr-only` sibling carries the text.
- **Menus**: items are `role="menuitem"` throughout, but trigger annotation is uneven and worth knowing before you copy a pattern. Only some triggers carry both `aria-haspopup="menu"` and `aria-expanded` — `ConversationHeader`'s "Conversation actions" button, `.cv-menu-btn` in [ConversationList.jsx](src/components/chat/ConversationList.jsx), the member-row `.cv-menu-btn` ("Actions for {username}") in [ConversationInfo.jsx](src/components/chat/ConversationInfo.jsx), and the bubble's "Message actions" overflow button in [MessageBubble.jsx](src/components/chat/MessageBubble.jsx). The quick-react trigger ("React to message", same file) sets `aria-expanded` only, even though its Popover inherits the default `role="menu"` and its `.ch-qr` emoji buttons are `role="menuitem"` — add the missing `aria-haspopup` if you touch it. The Composer's emoji trigger likewise has `aria-expanded` alone, but there the omission is correct: its Popover is passed `role="dialog"`. The long-press sheet is an explicit `role="menu"` with no button trigger at all. `ConversationHeader` wraps its items in a `role="none"` `.ch-hd-menu-items` div so they stay direct children of Popover's `role="menu"` in the a11y tree.
- **Rows are `div role="button" tabIndex=0`** with Enter/Space handling ([ConversationList.jsx](src/components/chat/ConversationList.jsx)). The row's menu button is a **sibling**, not a child: both the row and `.cv-menu-btn` live under the `.cv-menu-host` wrapper. Keep that shape — the ARIA button role gives its subtree presentational children, so folding the menu button inside the row would prune it from the accessibility tree. The pin bar is the case where that was actually hit, and it splits into two sibling buttons (`.ch-pinbar-main` and `.ch-pinbar-x`) for exactly this reason — see the comment above it in [ChatPage.jsx](src/pages/ChatPage.jsx).
- **Voice scrubber** is `role="slider"` with `aria-valuemin/max/now` and Arrow/Space/Enter keys ([MessageBubble.jsx](src/components/chat/MessageBubble.jsx)).
- **`Icon` accepts only `{ name, className, style }`** ([ui.jsx](src/components/ui.jsx)). Passing `title`, `aria-label` or `aria-hidden` to it is silently dropped — put the name on a wrapping element or an `sr-only` span.

### Known open issues (honest list)

1. **Nothing here has been run against a live backend.** Every DTO shape, event name, enum spelling and error code is written from the API documents. `stream()` defensively registers both `message.new` and `MESSAGE_NEW` for each event precisely because the casing is unconfirmed. Expect adapter fixes on first integration. This goes double for the newest surfaces — `call.*`, `stream.*`, `/messaging/settings`, `/messaging/starred`, `/channels` and the scheduled-message routes have never seen a response.
2. **`--muted` fails WCAG AA.** `#8b8371` ([theme.css](src/styles/warm/theme.css)) computes to roughly **3.7:1** on `--card` `#fffdf8` and ~3.3:1 on `--paper` `#f4f0e7` — below the 4.5:1 body-text threshold. This is theme-wide, not a chat bug, but chat leans on it for timestamps, `.ci-row-sub`, menu icons and previews, so darkening the token is the single highest-value fix for this module.
3. **The tablists do not implement the ARIA tabs keyboard contract.** [ChatPage.jsx](src/pages/ChatPage.jsx), [ChatSearchPanel.jsx](src/components/chat/ChatSearchPanel.jsx) and [NewChatModal.jsx](src/components/chat/NewChatModal.jsx) all render `role="tablist"` + `role="tab"` + `aria-selected`, but with no arrow-key navigation, no roving `tabIndex`, no `aria-controls`, and no `role="tabpanel"` on the content they switch. They are reachable and operable, just not conformant.
4. **The search slide-over and the info panel do not restore focus on close.** [ChatSearchPanel.jsx](src/components/chat/ChatSearchPanel.jsx) steals focus to its input on mount and [ConversationInfo.jsx](src/components/chat/ConversationInfo.jsx) closes on Escape, but neither captures the opener or refocuses it — closing either drops the caret to `<body>`. The lightbox and long-press sheet already do this correctly; port their effect.
5. **Group avatar upload is impossible.** `createGroup` / `conversations.update` accept an `avatarKey` ([chat.js](src/api/chat.js)), but no endpoint in [src/api](src/api) returns a `storageKey` you could use as one — `storageKey` appears only on *message* media (via `mediaFrom`), i.e. reachable only by actually posting a message into a conversation. The header comment in [NewChatModal.jsx](src/components/chat/NewChatModal.jsx) documents the deliberate omission; `ConversationInfo` offers Rename but no image control. This needs a backend media endpoint before any picker is worth building.
6. **Backend reply-preview hydration is not floored.** A message you can see may quote a target the server will never serve you (per-member clear point, or the hidden-history join point for a new member). The client mitigation is only a toast: `jumpTo` ([useThread.js](src/components/chat/useThread.js)) walks the cursor back up to 20 pages, returns false, and [ChatPage.jsx](src/pages/ChatPage.jsx) — in `onJump` and in the deferred cross-conversation path — shows "That message isn't available to you." The dead click is handled; the quote still renders as though it were reachable, because `replyTo.deleted` is the only unreachability signal the wire provides.
7. **Minor, verified:** the `<Icon … aria-hidden="true"/>` on the receipt tick in [MessageBubble.jsx](src/components/chat/MessageBubble.jsx) is a no-op — `Icon` destructures only three props. Harmless today (the SVG has no accessible name) but do not rely on it when adding decorative icons.


## Known open issues

Honest list. None of these are hidden behind a "TODO" in the code.

**Not verified against a running backend.** Everything in this module was built
and checked statically — lint, production build, and the dev-server module
graph. The realtime paths (SSE reconnect, gap-sync, receipts, typing, presence)
have not been exercised against a live server. Treat the first integration run
as the real test, and start with owner-delete-group, since that path is
irreversible.

**Accessibility gaps that are known and unfixed.**

- `--muted` (`#8b8371`) measures ~3.7:1 on `--card` and ~3.4:1 on `--card-2`,
  under the 4.5:1 WCAG AA threshold for the small text it is used on
  (conversation previews, timestamps, metadata). This is a **theme-wide token**
  in `src/styles/warm/theme.css`, not a chat-only decision — changing it touches
  every surface in the app, so it needs a product call rather than a local fix.
- The three tablists (inbox tabs, search scope, new-chat tabs) declare
  `role="tab"`/`role="tablist"` without the ARIA keyboard contract — no arrow-key
  navigation, no roving `tabindex`, no `aria-controls`. They are operable by Tab
  and click, so this is a conformance gap rather than a blocker.
- The search slide-over and the info panel close on Escape but do not return
  focus to the control that opened them; focus lands on `<body>`. The media
  lightbox and the long-press sheet *do* trap and restore focus correctly — copy
  their pattern when fixing these.

**Group avatar cannot be set.** `PATCH /conversations/{id}` accepts an
`avatarKey`, and the client sends it if present, but no endpoint in the API
returns a storage key suitable for it — the chat multipart upload returns a
*message*, and the user/research upload endpoints are scoped to their own
entities. Creating or changing a group image therefore needs a backend endpoint
first. The UI deliberately does not show a dead control.

**Backend: reply previews are not floored.** The server applies the per-member
read floor (`clearedBeforeMessageId` + the hidden-history join point) to
`loadPage`, `sync`, `getOne`, `reactions`, `pinnedMessages` and search — but the
reply-preview hydration (`findAllByMessageIdIn(replyIds)` in `hydrate` /
`hydrateByIds`) is not floored. A visible message can therefore quote the body
of a message the caller is not allowed to read. In a hidden-history group that is
a cross-user disclosure to a new joiner, the same class as the pinned-message
leak that was closed.

The client **cannot** mitigate this: `clearedBeforeMessageId` is server-internal
and absent from `ConversationResponse`, so there is no way to know a snippet
should be withheld. What the client does do is degrade honestly — a reply quote
whose target the server refuses to serve produces a toast rather than a dead
click (see the jump handling in [ChatPage.jsx](src/pages/ChatPage.jsx)).

**Calls are a mesh, so group calls do not scale.** One `RTCPeerConnection` per
remote participant is right for 1:1 and fine for a handful of people; beyond
that the uplink cost is quadratic in the room. The signalling frames are already
the ones an SFU would consume, so the fix is deployment-side (put an SFU in
front) rather than a client rewrite — but nothing in the UI currently warns a
host who starts a call in a 200-member group.

**No TURN by default.** `iceServers()` falls back to public STUN, which fails on
symmetric NATs. `VITE_ICE_SERVERS` accepts a JSON array of
`RTCIceServer` objects; a production deployment needs to set it or a meaningful
share of calls will ring, connect the signalling, and never carry audio.

**Live playback is HLS-only and unpolyfilled.** Non-Safari engines get an
"open in a player" link instead of inline video. Adding `hls.js` would fix it,
but it is a dependency this project does not currently carry, and the honest
fallback was preferred over a silent black frame.

**Call history is client-side, and stream recording does not exist.** Screen
sharing now ships (`getDisplayMedia` + `replaceTrack`, with a renegotiation for
the voice-call case, where there is no video sender to replace). The call log is
real but **local** — per device, per account, cleared with site data — because
the API still has no list endpoint; `GET /calls/{id}` is per-call only. The info
panel says exactly that rather than implying the history is the account's.
Stream recording is untouched: the documents describe none.

**Group avatar / channel avatar upload is still impossible**, for the reason
above: no endpoint returns a usable `storageKey`. `channels.create` therefore
takes no image either.

**A scheduled message that FAILS is invisible, and the client cannot fix it.**
`GET /conversations/{id}/scheduled` returns *"my own still-`PENDING`"* rows only.
So when the poller re-checks permission at fire time and the row lands `FAILED`
(you were blocked, removed, restricted, or the conversation was deleted), it
simply drops out of the queue and nothing tells the author their message never
went. `ScheduledPanel` can render `SENT` / `CANCELLED` / `FAILED` states and the
adapter maps them, but no endpoint will ever hand us such a row — surfacing this
needs either a status filter on that list or a notification. Do not mistake the
unused branches for dead code; they are waiting on the API.

**`MessageResponse.mentions` (a `Set<UUID>`) is mapped and unused.** The bubble
linkifies `@handle` **text** through the platform's shared `linkify`, which is
what makes mentions clickable today. The id set would allow reliably
highlighting a mention *of you* even when the display text does not match the
handle — but nothing maps those UUIDs back to positions in the body, so it would
need either server-side offsets or a directory round trip per message.

