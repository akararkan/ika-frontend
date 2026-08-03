import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './styles/styles.css'
import './styles/styles-feed.css'
import './styles/styles-content.css'
import './styles/styles-user.css'
import './styles/styles-richtext.css'
import './styles/styles-responsive.css'

/* WARM ARCHIVE — the redesign override layer (order matters, responsive last).
   theme.css re-maps the token layer to navy/gold/warm-paper; the area files
   then re-skin each surface to the approved prototype. */
import './styles/warm/theme.css'
import './styles/warm/core.css'
import './styles/warm/richtext.css'
import './styles/warm/stories.css'
import './styles/warm/qna.css'
import './styles/warm/research.css'
import './styles/warm/feed.css'
import './styles/warm/reels.css'
import './styles/warm/user.css'
/* Settings v2 widget vocabulary (stx-*) — extends the set-* shell that
   user.css skins, so it sits right after it and before responsive.css. */
import './styles/warm/settings.css'
import './styles/warm/social.css'
import './styles/warm/chat.css'
/* chat-extras carries the surfaces chat.css predates — calls, channels, live,
   starred/scheduled/privacy slide-overs. It must sit immediately AFTER
   chat.css (several rules re-skin its classes at equal specificity and win on
   source order) and still before responsive.css. */
import './styles/warm/chat-extras.css'
/* Handoff #3 redesign layer for Messages · Channels · Live. Must sit AFTER
   chat.css + chat-extras.css (it refines their shared .cv-/.ch-/.cn-/.lv-
   classes and wins on source order) and BEFORE responsive.css so the mobile
   one-pane collapse still has the final say. Style-only; no markup changes. */
import './styles/warm/ika-messages-theme.css'
/* The channel build-out: profile page, management console, statistics, and
   the typed message payloads (poll / location / contact / video note). Sits
   AFTER the theme layer because a handful of its rules extend shared
   `.cn-`/`.ch-` classes and must win on source order — and still BEFORE
   responsive.css, which keeps the last word on layout. */
import './styles/warm/channels-pro.css'
/* DARK MODE — the repair layer for `appearance.theme` (prefs.js sets
   data-theme="dark" on <html>). It must be LAST in the warm layer:
   every rule is scoped under :root[data-theme="dark"], so it is inert
   in light mode, but the literals it repairs are spread across all of
   the files above and several of them re-skin the same class at equal
   specificity — only a file that loads after all of them is certain
   to win. It still sits BEFORE responsive.css, which owns layout and
   must keep the last word on the mobile collapse (dark.css never
   touches geometry, so there is nothing for responsive.css to undo). */
import './styles/warm/dark.css'
import './styles/warm/responsive.css'
/* LAST in the warm layer: the client-owned preference appliers (font scale,
   density, reduced motion, high contrast). Every default state is a no-op, so
   a user on defaults renders byte-identically — it only bites once someone
   changes a setting, and it must be able to override everything above. */
import './styles/warm/prefs.css'

import App from './App.jsx'
import { applyCachedPrefs } from './lib/prefs.js'
/* Mock mode parses a ~300 KB fixture on first use; warm it here so the opening
   screen does not flash a loader. No-ops when the flag is off. */
import { preloadMocks } from './mock/flag-boot.js'

/* Apply the last-known appearance/accessibility choices BEFORE the first
   paint, so a reload doesn't flash default sizing and then jump. The live
   values are re-fetched from the server once the session is up (Layout). */
applyCachedPrefs()
preloadMocks()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
