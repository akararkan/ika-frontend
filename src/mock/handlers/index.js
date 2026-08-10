/* =========================================================
   Route table — generated from the per-domain handler modules.
   ---------------------------------------------------------
   Order matters: the first pattern that matches wins, so the
   domains are composed in the same order the fixture is merged.
   Regenerate with scratchpad/merge.mjs after adding a domain.
   ========================================================= */
import { routes as users } from './users.js'
import { routes as posts } from './posts.js'
import { routes as moderation } from './moderation.js'
import { routes as reels } from './reels.js'
import { routes as qna } from './qna.js'
import { routes as research } from './research.js'
import { routes as chat } from './chat.js'
import { routes as platform } from './platform.js'
import { routes as live } from './live.js'
import { routes as extra } from './extra.js'

export const routes = [
  ...users,
  ...posts,
  /* Moderation sits ABOVE reels deliberately. Its own namespace
     (/admin/moderation/**) is unclaimed and could go anywhere, but its fake
     classifier has to screen a story BEFORE the fragment that owns story
     creation writes the row — and the registry has no fall-through, so the
     screening route must be reached first. It hands every clean story straight
     back to reels' handler; see the comment on storyCreateHandler(). */
  ...moderation,
  ...reels,
  ...qna,
  ...research,
  ...chat,
  ...platform,
  ...live,
  ...extra,
]
