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
    ? { '/api': { target: proxyTarget, changeOrigin: true, ws: true } }
    : undefined

  return {
    plugins: [react()],
    // host:true binds 0.0.0.0 so Vite prints the LAN URL on every `npm run dev`
    // (handy for opening the app on your phone over Wi-Fi). proxy is optional;
    // when VITE_DEV_PROXY is set, /api requests are forwarded to the backend.
    server: { host: true, proxy },
  }
})
