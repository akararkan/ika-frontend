import { readFileSync } from 'node:fs'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Read rather than `import … with { type: 'json' }` so the config loads on any
// Node the team happens to have (import attributes are 20.10+/22).
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

/* The bundle has to know its OWN version or GET /api/v1/app/config can never
   retire it: the client compares itself against minSupportedVersion before it
   lets anyone in (src/lib/version.js reads the two constants below).
   package.json is still the create-vite placeholder "0.0.0", and that is what
   ships — the version string is ALSO what Settings → About shows the user, so
   substituting a plausible-looking release here would make that card (and any
   bug report quoting it) lie. "0.0.0" is the agreed unstamped marker: About
   renders it as "Development build" and VersionGate refuses to reason about
   it at all. Stamp package.json — or set VITE_APP_VERSION in the release
   pipeline — and both surfaces start telling the truth. */

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const appVersion = env.VITE_APP_VERSION || pkg.version || '0.0.0'
  const appBuild = env.VITE_APP_BUILD || new Date().toISOString().slice(0, 10)

  /* TRAP: this Vite applies `define` at BUILD time only — its vite:define
     transform returns early for the client environment, so under `npm run dev`
     the two __APP_*__ identifiers survive untouched and a package.json that
     IS stamped would still report "0.0.0" in the dev shell. Publish them as
     globals instead; version.js reads them with `typeof`, so dev and the
     build agree on the same string. */
  const devVersionGlobals = {
    name: 'ika-dev-version-globals',
    apply: 'serve',
    transformIndexHtml: () => [{
      tag: 'script',
      injectTo: 'head-prepend',
      children: `window.__APP_VERSION__=${JSON.stringify(appVersion)};` +
                `window.__APP_BUILD__=${JSON.stringify(appBuild)}`,
    }],
  }

  // Optional dev proxy: set VITE_DEV_PROXY=http://localhost:8080 to proxy
  // /api → your backend during `npm run dev` (avoids CORS). In that mode
  // leave VITE_API_BASE_URL empty so the client uses relative URLs.
  const proxyTarget = env.VITE_DEV_PROXY
  const proxy = proxyTarget
    ? {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
          ws: true,
          /* A down backend is a NORMAL state of this dev loop (every IntelliJ
             restart takes :8080 away for ~30s), and the default behaviour was
             the worst of both worlds: a full AggregateError STACK TRACE per
             failed request — and the app retries constantly (SSE reconnect,
             token refresh), so a restart printed dozens of them — while the
             browser saw only a hung socket.

             Instead: one throttled, human line per outage window, and a real
             `503 { errorCode: BACKEND_DOWN }` to the browser so the app's own
             error states render instead of requests dangling. The envelope
             matches the backend's, so http.js parses it like any other error. */
          configure(proxyServer) {
            let lastLog = 0
            proxyServer.on('error', (err, req, res) => {
              const now = Date.now()
              if (now - lastLog > 5000) {
                lastLog = now
                console.warn(
                  `[api-proxy] backend unreachable at ${proxyTarget} (${err.code}) — ` +
                  'is the Spring app running? Requests get a 503 until it is back.',
                )
              }
              // WebSocket upgrades hand over a bare socket, not a response.
              if (!res || typeof res.writeHead !== 'function') { req?.socket?.destroy?.(); return }
              if (!res.headersSent) {
                res.writeHead(503, { 'Content-Type': 'application/json' })
              }
              res.end(JSON.stringify({
                errorCode: 'BACKEND_DOWN',
                message: 'The backend is not running (dev proxy could not connect).',
              }))
            })
          },
        },
      }
    : undefined

  return {
    plugins: [react(), devVersionGlobals],
    // Consumed by src/lib/version.js (CLIENT_VERSION / CLIENT_BUILD) — the
    // version gate, the About card and the appVersion field on every consent
    // and contact-sync audit row.
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      __APP_BUILD__: JSON.stringify(appBuild),
    },
    // host:true binds 0.0.0.0 so Vite prints the LAN URL on every `npm run dev`
    // (handy for opening the app on your phone over Wi-Fi). proxy is optional;
    // when VITE_DEV_PROXY is set, /api requests are forwarded to the backend.
    server: { host: true, proxy },
  }
})
