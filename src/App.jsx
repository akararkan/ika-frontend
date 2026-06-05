/* =========================================================
   IKA — Islamic Knowledge Archive
   Router + providers. The Layout renders the shell; protected
   routes require auth. All data is live from the backend.

   Pages are CODE-SPLIT (React.lazy) so the initial download is
   just the shell + the first route's chunk, not the whole app —
   each page loads on demand. The shell stays mounted during
   navigation; only the content area shows the Suspense loader
   (boundary lives around <Outlet/> in Layout).
   ========================================================= */
import { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, RequireAuth } from './context/AuthContext.jsx'
import { Layout } from './components/Layout.jsx'
import { Loader } from './components/states.jsx'

const named = (p, key) => lazy(() => p().then(m => ({ default: m[key] })))
const AuthPage           = named(() => import('./pages/AuthPage.jsx'), 'AuthPage')
const FeedPage           = named(() => import('./pages/FeedPage.jsx'), 'FeedPage')
const ExplorePage        = named(() => import('./pages/ExplorePage.jsx'), 'ExplorePage')
const ReelsPage          = named(() => import('./pages/ReelsPage.jsx'), 'ReelsPage')
const WatchedReelsPage   = named(() => import('./pages/WatchedReelsPage.jsx'), 'WatchedReelsPage')
const QnaPage            = named(() => import('./pages/QnaPage.jsx'), 'QnaPage')
const QuestionPage       = named(() => import('./pages/QuestionPage.jsx'), 'QuestionPage')
const ResearchPage       = named(() => import('./pages/ResearchPage.jsx'), 'ResearchPage')
const ResearchDetailPage = named(() => import('./pages/ResearchDetailPage.jsx'), 'ResearchDetailPage')
const PostPage           = named(() => import('./pages/PostPage.jsx'), 'PostPage')
const NotificationsPage  = named(() => import('./pages/NotificationsPage.jsx'), 'NotificationsPage')
const ActivityPage       = named(() => import('./pages/ActivityPage.jsx'), 'ActivityPage')
const SavedPage          = named(() => import('./pages/SavedPage.jsx'), 'SavedPage')
const ProfilePage        = named(() => import('./pages/ProfilePage.jsx'), 'ProfilePage')
const UserProfilePage    = named(() => import('./pages/UserProfilePage.jsx'), 'UserProfilePage')
const SettingsPage       = named(() => import('./pages/SettingsPage.jsx'), 'SettingsPage')
const TagPage            = named(() => import('./pages/TagPage.jsx'), 'TagPage')

const fullScreenLoader = <div className="main center"><div className="col-main"><Loader label="Loading…"/></div></div>

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Suspense fallback={fullScreenLoader}>
          <Routes>
            {/* public auth routes */}
            <Route path="/login" element={<AuthPage mode="SIGN_IN"/>}/>
            <Route path="/register" element={<AuthPage mode="SIGN_UP"/>}/>

            {/* protected app shell */}
            <Route element={<RequireAuth><Layout/></RequireAuth>}>
              <Route index element={<FeedPage/>}/>
              <Route path="explore" element={<ExplorePage/>}/>
              <Route path="tags/:tag" element={<TagPage/>}/>
              <Route path="reels" element={<ReelsPage/>}/>
              <Route path="reels/watched" element={<WatchedReelsPage/>}/>
              <Route path="reels/:id" element={<ReelsPage/>}/>
              <Route path="qna" element={<QnaPage/>}/>
              <Route path="qna/:id" element={<QuestionPage/>}/>
              <Route path="research" element={<ResearchPage/>}/>
              <Route path="research/:id" element={<ResearchDetailPage/>}/>
              <Route path="posts/:id" element={<PostPage/>}/>
              <Route path="notifications" element={<NotificationsPage/>}/>
              <Route path="activity" element={<ActivityPage/>}/>
              <Route path="saved" element={<SavedPage/>}/>
              <Route path="profile" element={<ProfilePage/>}/>
              <Route path="u/:id" element={<UserProfilePage/>}/>
              <Route path="settings" element={<SettingsPage/>}/>
            </Route>

            <Route path="*" element={<Navigate to="/" replace/>}/>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
  )
}
