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
import './styles/warm/responsive.css'

import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
