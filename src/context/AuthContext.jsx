/* =========================================================
   Auth context — current user, sign in/up/out, route guard.
   Replaces the old hardcoded ME. The current user comes from
   the login response and /users/me.
   ========================================================= */
/* eslint-disable react-refresh/only-export-components */
import React from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { api, session, adapters } from '../api/index.js'

const AuthCtx = React.createContext(null)
export const useAuth = () => React.useContext(AuthCtx)

export function AuthProvider({ children }) {
  const [user, setUser] = React.useState(() => adapters.meFrom(session.getUser()))
  const [ready, setReady] = React.useState(!session.isAuthed())   // ready once we know auth state
  const refreshTimer = React.useRef(null)

  // Proactive refresh (§18.2): rotate the token ~60s before it expires so it
  // never lapses mid-request, rescheduling from each refresh's own expiresIn.
  // (The reactive 401 interceptor in http.js is the safety net if this misses.)
  const scheduleRefresh = React.useCallback(function schedule(expiresIn) {
    clearTimeout(refreshTimer.current)
    const secs = Math.max(30, (Number(expiresIn) || 3600) - 60)
    refreshTimer.current = setTimeout(() => {
      api.auth.refresh()
        .then(res => schedule(res?.expiresIn))            // chain the next one (self-ref, stays stable)
        .catch(() => { /* dead session → reactive path / endSession handles it */ })
    }, secs * 1000)
  }, [])

  // On boot, if a token exists, refresh the current user + arm the refresh timer.
  React.useEffect(() => {
    if (!session.isAuthed()) { setReady(true); return }
    let alive = true
    api.auth.me()
      .then(u => { if (alive && u) setUser(u) })
      .catch(() => { /* keep cached user if /me unavailable */ })
      .finally(() => { if (alive) setReady(true) })
    scheduleRefresh()
    return () => { alive = false }
  }, [scheduleRefresh])

  // The HTTP layer fires this when a refresh fails / token is revoked (§18.2,
  // §18.9 TOKEN_REVOKED): drop the user so RequireAuth bounces to /login.
  React.useEffect(() => {
    const onExpired = () => { clearTimeout(refreshTimer.current); setUser(null) }
    window.addEventListener('ika:auth-expired', onExpired)
    return () => { window.removeEventListener('ika:auth-expired', onExpired); clearTimeout(refreshTimer.current) }
  }, [])

  const login = async (fields) => { const { user, expiresIn } = await api.auth.login(fields); setUser(user || adapters.meFrom(session.getUser())); scheduleRefresh(expiresIn) }
  const register = async (fields) => { const { user, expiresIn } = await api.auth.register(fields); setUser(user || adapters.meFrom(session.getUser())); scheduleRefresh(expiresIn) }
  const logout = async () => { clearTimeout(refreshTimer.current); await api.auth.logout(); setUser(null) }
  const logoutEverywhere = async () => { clearTimeout(refreshTimer.current); await api.auth.logoutAll(); setUser(null) }            // §8.5
  const refreshUser = async () => { try { const u = await api.auth.me(); if (u) setUser(u) } catch { /* keep current */ } }

  const value = { user, ready, signedIn: session.isAuthed(), login, register, logout, logoutEverywhere, refreshUser, setUser }
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}

/** Wrap protected routes — redirects to /login when not authed. */
export function RequireAuth({ children }) {
  const { signedIn, ready } = useAuth()
  const loc = useLocation()
  if (!ready) return <div style={{ display:'grid', placeItems:'center', minHeight:'100vh', color:'var(--muted)' }}>Loading…</div>
  if (!signedIn) return <Navigate to="/login" state={{ from: loc }} replace/>
  return children
}
