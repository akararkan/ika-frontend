import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './styles/styles.css'
import './styles/styles-feed.css'
import './styles/styles-content.css'
import './styles/styles-user.css'
import './styles/styles-richtext.css'
import './styles/styles-responsive.css'

import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
