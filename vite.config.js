import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

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
    plugins: [react()],
    // host:true binds 0.0.0.0 so Vite prints the LAN URL on every `npm run dev`
    // (handy for opening the app on your phone over Wi-Fi). proxy is optional;
    // when VITE_DEV_PROXY is set, /api requests are forwarded to the backend.
    server: { host: true, proxy },
  }
})
