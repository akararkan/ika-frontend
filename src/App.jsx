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
import { ChatProvider } from './context/ChatContext.jsx'
import { CallProvider } from './context/CallContext.jsx'
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
const ChatPage           = named(() => import('./pages/ChatPage.jsx'), 'ChatPage')
const ChatJoinPage       = named(() => import('./pages/ChatJoinPage.jsx'), 'ChatJoinPage')
const ChannelsPage       = named(() => import('./pages/ChannelsPage.jsx'), 'ChannelsPage')
const ChannelPage        = named(() => import('./pages/ChannelPage.jsx'), 'ChannelPage')
const ChannelLinkPage    = named(() => import('./pages/ChannelLinkPage.jsx'), 'ChannelLinkPage')
const LivePage           = named(() => import('./pages/LivePage.jsx'), 'LivePage')

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
            {/* ChatProvider wraps the shell (not just the chat route) so the ONE
                /messaging/stream socket and the unread badge live app-wide.
                CallProvider sits INSIDE it — it consumes that socket's firehose
                via subscribe() — and above <Layout/> so an incoming call rings
                on the feed, not only on /chat. */}
            <Route element={
              <RequireAuth>
                <ChatProvider>
                  <CallProvider>
                    <Layout/>
                  </CallProvider>
                </ChatProvider>
              </RequireAuth>
            }>
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
              <Route path="chat" element={<ChatPage/>}/>
              <Route path="chat/requests" element={<ChatPage/>}/>
              {/* invite links are shared as URLs, so joining has to be a real
                  route — it redeems the token then replaces itself with the
                  group's thread. Declared BEFORE chat/:id so "join" is never
                  mistaken for a conversation id. */}
              <Route path="chat/join/:token" element={<ChatJoinPage/>}/>
              <Route path="chat/:id" element={<ChatPage/>}/>
              {/* A channel IS a conversation, so its POSTS live at
                  /chat/<channelId>. /channels discovers; /channels/:id is the
                  channel's profile — cover, badges and the admin console,
                  i.e. everything that describes the channel rather than
                  carrying its posts. */}
              <Route path="channels" element={<ChannelsPage/>}/>
              <Route path="channels/:id" element={<ChannelPage/>}/>
              {/* The routes behind the server-minted share links:
                  /c/{handle} on every public ChannelResponse.shareUrl, and
                  /join/{token} on InviteLinkResponse.shareUrl (same page as
                  the older /chat/join/:token, kept for existing links). */}
              <Route path="c/:handle" element={<ChannelLinkPage/>}/>
              <Route path="join/:token" element={<ChatJoinPage/>}/>
              <Route path="live" element={<LivePage/>}/>
              <Route path="live/:id" element={<LivePage/>}/>
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
