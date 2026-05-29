# IKA — Islamic Knowledge Archive

A scholarly community frontend (React 19 + Vite + React Router): posts, reels,
stories, sounds, Q&A, research publications, activity, and saved — with
**realtime** updates over SSE. **All data is live from your backend** (no mock).

## Quick start

```bash
npm install

# Point the app at your backend (one of the two options below), then:
npm run dev        # http://localhost:5173
npm run build      # production build → dist/
npm run preview    # serve the production build
npm run lint
```

### Connect your backend (pick one)

**Option A — direct (backend allows CORS):** create a `.env` from `.env.example`:

```
VITE_API_BASE_URL=https://api.your-backend.example
```

**Option B — dev proxy (no CORS needed in dev):** leave `VITE_API_BASE_URL`
empty and set a proxy target so Vite forwards `/api` (incl. SSE) to your backend:

```
VITE_DEV_PROXY=http://localhost:8080
```

In production, serve this build behind the same gateway that exposes `/api`,
or set `VITE_API_BASE_URL` to the API origin.

## Routes

`/login` · `/register` · `/` (feed) · `/explore` · `/reels` · `/qna` ·
`/qna/:id` · `/research` · `/research/:id` · `/posts/:id` · `/notifications` ·
`/activity` · `/saved` · `/profile` · `/settings`. Everything except auth is
behind a sign-in guard (`RequireAuth`).

## Structure

```
src/
  App.jsx                router + providers
  main.jsx               entry + global styles
  context/AuthContext    current user, sign in/up/out, RequireAuth guard
  components/            Layout (shell), PostCard, ComposeModal, StoryViewer,
                         Reels, Source, ui (atoms), states (loader/empty)
  pages/                 one file per route (Feed, Explore, Qna, Question, …)
  hooks/useRealtime      React wrapper around the SSE stream
  lib/                   userView (author resolver), openCompose
  api/
    config   base URL + JWT/session storage
    http     fetch client (Bearer + cookie, dual error parsing, bare-body)
    realtime SSE streams + post counter deltas
    adapters backend DTO → view shapes
    auth posts stories sounds qna research search activity mentions notifications
    index    `import { api } from '../api'`
  styles/                the design CSS (verbatim)
```

## Realtime ("always listen")

Each post / question / research has one SSE stream
(`/api/v1/{domain}/{id}/stream`). Detail pages open an `EventSource` with
`?token=<jwt>`, receive a `connected` handshake + `heartbeat` ~25s, and patch
the UI live. **Posts** carry no counter values on events → the client applies
+1/−1 locally by event type (`api/realtime.js`); **Q&A / Research** events carry
an authoritative payload. The actor's own action is filtered server-side, so
optimistic updates never double-count. See `pages/PostPage.jsx`.

## Public vs. admin

Only public / authenticated-user features are exposed. Admin & scholar-gated
actions are hidden: best-answer voting shows only to `SCHOLAR`/`ADMIN`, answer
**Accept** only to the question author, **Publish research** only to
`SCHOLAR`/`RESEARCHER`/`ADMIN`. Sound auto-approve, sound approval, and poll
voter lists are never surfaced.

## Notes on assumed endpoints

Auth, current-user, notifications, and activity live in `USER_API.md` /
`USER_ACTIVITY_API.md` (not provided), so their paths follow the platform
convention and are isolated in `api/auth.js`, `api/notifications.js`,
`api/activity.js` — edit only those files if your backend differs. Pages handle
empty/unavailable responses gracefully (no fake data).
