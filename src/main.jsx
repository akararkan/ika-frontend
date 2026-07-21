import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './styles/styles.css'
import './styles/styles-feed.css'
import './styles/styles-content.css'
import './styles/styles-user.css'
import './styles/styles-richtext.css'
import './styles/styles-responsive.css'

/* TADHHIB — The Illuminated Edition (override layer; order matters, responsive last) */
import './styles/tadhhib/core.css'
import './styles/tadhhib/richtext.css'
import './styles/tadhhib/qna.css'
import './styles/tadhhib/research.css'
import './styles/tadhhib/feed.css'
import './styles/tadhhib/reels.css'
import './styles/tadhhib/user.css'
import './styles/tadhhib/social.css'
import './styles/tadhhib/responsive.css'

import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
