/* =========================================================
   IKA — Islamic Knowledge Archive
   Router + providers. The Layout renders the shell; protected
   routes require auth. All data is live from the backend.
   ========================================================= */
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, RequireAuth } from './context/AuthContext.jsx'
import { Layout } from './components/Layout.jsx'

import { AuthPage } from './pages/AuthPage.jsx'
import { FeedPage } from './pages/FeedPage.jsx'
import { ExplorePage } from './pages/ExplorePage.jsx'
import { ReelsPage } from './pages/ReelsPage.jsx'
import { WatchedReelsPage } from './pages/WatchedReelsPage.jsx'
import { QnaPage } from './pages/QnaPage.jsx'
import { QuestionPage } from './pages/QuestionPage.jsx'
import { ResearchPage } from './pages/ResearchPage.jsx'
import { ResearchDetailPage } from './pages/ResearchDetailPage.jsx'
import { PostPage } from './pages/PostPage.jsx'
import { NotificationsPage } from './pages/NotificationsPage.jsx'
import { ActivityPage } from './pages/ActivityPage.jsx'
import { SavedPage } from './pages/SavedPage.jsx'
import { ProfilePage } from './pages/ProfilePage.jsx'
import { UserProfilePage } from './pages/UserProfilePage.jsx'
import { SettingsPage } from './pages/SettingsPage.jsx'
import { TagPage } from './pages/TagPage.jsx'

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
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
      </BrowserRouter>
    </AuthProvider>
  )
}
