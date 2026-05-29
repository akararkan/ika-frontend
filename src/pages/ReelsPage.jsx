/* Reels page — /reels (discover) and /reels/:id (deep-link a single reel). */
import { useNavigate, useParams } from 'react-router-dom'
import { Reels } from '../components/Reels.jsx'

export function ReelsPage() {
  const navigate = useNavigate()
  const { id } = useParams()            // present on /reels/:id → open that reel first
  return <Reels initialId={id} onClose={() => navigate('/')}/>
}
