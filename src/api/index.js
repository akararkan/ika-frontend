/* =========================================================
   API barrel — single import surface for the whole app.
     import { api } from '../api'
   ========================================================= */
export { API_BASE, assetUrl, session } from './config.js'
export { http, ApiError, setStepUpPrompt } from './http.js'
/* Error taxonomy (frontend-error-handling.md): branch on codes via these
   predicates, display via errorText, count down via cooldownSecondsFrom —
   never string-match `message` and never hardcode copy the backend sends. */
export {
  codeOf, detailsOf, isNotFound, isDuplicate, duplicateField, isConflict,
  isRateLimited, isStepUp, isTransient, isNetworkError, isClientBug,
  isUnhydratedParam, needsLargeAudienceConfirm, cooldownSecondsFrom,
  fieldErrorMap, traceRef, errorText, logApiError,
} from './errors.js'
export { openStream, applyPostDelta, applyResearchDelta } from './realtime.js'
export {
  convoFrom, msgFrom, memberFrom, requestFrom, participantFrom,
  settingsFrom, scheduledFrom, channelFrom, callFrom, callSignalFrom,
  liveStreamFrom, liveChatFrom, recordingInfoFrom, pollFrom, draftFrom,
  channelSettingsFrom, channelSettingsTo,
} from './chat.js'
export {
  adminFrom, inviteFrom, joinRequestFrom, statsFrom,
  rightsFrom, rightsTo, can as canRight,
  RIGHT_KEYS, RIGHT_LABELS, JOIN_SOURCE_LABELS,
} from './channels.js'
export {
  taxonomyRowFrom, taxonomyName, taxonomyDir, taxonomyFilter, specializationsTo,
} from './taxonomy.js'
export { SEARCH_TYPES, CURSOR_HEAD, hitHref } from './search.js'
export {
  VISIBILITY_LEVELS, VISIBILITY_LABELS, PRIVACY_GROUPS, PRESENCE_POLICIES,
  NOTIFICATION_CHANNELS, CHANNEL_LABELS, NOTIFICATION_GROUPS, LOCKED_NOTIFICATION_TYPES,
  DND_DAYS, REPORT_TARGET_TYPES, REPORT_REASONS, REPORT_OUTCOME_LABELS,
  MEDIA_TIERS, POLICY_KEYS,
} from './settings.js'
export { OTP_PURPOSES } from './security.js'
export { MEDIA_STATUS_FAILED } from './media.js'
export { REINDEX_CORPORA } from './admin.js'
export {
  MODERATION_REDACTED, REDACTED_ENTITY_TYPES, isRedactedText, isRedactedType,
  MODERATION_STATUSES, MODERATION_VERDICTS, MODERATED_ENTITY_TYPES, MODERATION_LABELS,
  FALLBACK_POLICIES, MODEL_VERSION_STATUSES, TRAINING_SOURCES, REASON_CODES,
  BLOCKLIST_SEVERITIES, REVIEW_SORTS, QUEUE_SOURCES, QUEUE_BULK_ACTIONS, REQUIRES_STEP_UP,
  entityTypeName, entityTypeKey, labelsTo, goldenLabelsOf,
} from './moderation.js'
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
import { chat } from './chat.js'
import { channels } from './channels.js'
import { topics, madhhabs } from './taxonomy.js'
import { admin } from './admin.js'
import { moderation } from './moderation.js'
import { settings } from './settings.js'
import { security } from './security.js'
import { media } from './media.js'

export const api = {
  auth, users, posts, reels, stories, closeFriends, closeCircle, highlights, sounds,
  qna, research, search, tags, activity, mentions, notifications, chat,
  // Knowledge taxonomy (TAXONOMY_API) — public reads, session-cached.
  topics, madhhabs,
  // Search-index maintenance (ROLE_ADMIN only).
  admin,
  // Automated-moderation console (ADMIN/MODERATOR, some routes widen to
  // ANALYST): review queue, decision-engine settings, classifier registry, and
  // the pre-existing reactive queue + keyword blocklist. Seven writes need a
  // step-up marker — wrap those in security.withStepUp (see REQUIRES_STEP_UP).
  moderation,
  // Settings module (SETTINGS docs): cosmetics + privacy resolver + presence +
  // discovery/QR + consent + notification matrix + storage + data + safety + app.
  settings,
  // Security surface: sessions, 2FA, login history, step-up, phone/OTP.
  security,
  // Media upload pipeline (upload-intent → PUT → complete → poll).
  media,
  // Same object as `api.chat.channels` — both names are load-bearing: the chat
  // surface reaches it through `chat`, the channel pages import it directly.
  channels,
}
