/* =========================================================
   API barrel — single import surface for the whole app.
     import { api } from '../api'
   ========================================================= */
export { API_BASE, assetUrl, session } from './config.js'
export { http, ApiError } from './http.js'
export { openStream, applyPostDelta } from './realtime.js'
export * as adapters from './adapters.js'

import { auth } from './auth.js'
import { users, closeFriends } from './users.js'
import { posts } from './posts.js'
import { reels } from './reels.js'
import { stories, highlights, closeCircle } from './stories.js'
import { sounds } from './sounds.js'
import { qna } from './qna.js'
import { research } from './research.js'
import { search } from './search.js'
import { tags } from './tags.js'
import { activity } from './activity.js'
import { mentions } from './mentions.js'
import { notifications } from './notifications.js'

export const api = {
  auth, users, posts, reels, stories, closeFriends, closeCircle, highlights, sounds,
  qna, research, search, tags, activity, mentions, notifications,
}
