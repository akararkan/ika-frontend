/* =========================================================
   The running client build.
   ---------------------------------------------------------
   `GET /api/v1/app/config` is the only reliable way to retire a
   client with a security defect: the client compares ITSELF
   against minSupportedVersion before it lets anyone in. That
   only works if the client actually knows its own version — a
   hardcoded "1.0.0" makes the gate permanently satisfied and the
   `appVersion` recorded on every consent event a lie.

   vite.config.js defines __APP_VERSION__ / __APP_BUILD__ from
   package.json and the build time; VITE_APP_VERSION can override
   the former for a release pipeline that stamps its own number.
   ========================================================= */

/* eslint-disable no-undef */
const injected = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
const injectedBuild = typeof __APP_BUILD__ === 'string' ? __APP_BUILD__ : ''
/* eslint-enable no-undef */

/** Semver of the running bundle, e.g. "1.4.2". */
export const CLIENT_VERSION = import.meta.env?.VITE_APP_VERSION || injected || '0.0.0'

/** Build stamp (ISO date of the build), for the About card and bug reports. */
export const CLIENT_BUILD = import.meta.env?.VITE_APP_BUILD || injectedBuild || ''

/** Compare two dotted versions. -1 / 0 / 1; unparsable parts count as 0. */
export function compareVersions(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}
