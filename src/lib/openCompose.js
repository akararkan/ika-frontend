/* Open the app-wide compose modal from anywhere. */
export const openCompose = (type = 'TEXT') =>
  window.dispatchEvent(new CustomEvent('ika:compose', { detail: type }))

/* Open the composer in EDIT mode for an existing post (PATCH §6.4). */
export const openComposeEdit = (post) =>
  window.dispatchEvent(new CustomEvent('ika:compose', { detail: { editPost: post } }))
