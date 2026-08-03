/* Boot hook — kept separate from index.js so main.jsx can call it without a
   static import of the fixture. When the flag is off this file is the only
   mock code that ever loads, and it does nothing. */
import { mockEnabled } from './flag.js'

export function preloadMocks() {
  if (!mockEnabled()) return
  import('./index.js').then(m => m.preloadMocks?.()).catch(() => {})
}
