import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './nielsen.css'
import App from './App.tsx'

// Ops used to live inside Actor with hash routes (#/businesses). As its own origin it uses
// path routes, so carry an old #/ link or bookmark to the same page instead of the dashboard.
// A hash-only change does not reload the page, so also handle it live and let the router know.
function followLegacyHashLink() {
  if (import.meta.env.BASE_URL !== '/' || !window.location.hash.startsWith('#/')) return false
  window.history.replaceState(null, '', window.location.hash.slice(1))
  return true
}
followLegacyHashLink()
window.addEventListener('hashchange', () => {
  if (followLegacyHashLink()) window.dispatchEvent(new PopStateEvent('popstate'))
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
