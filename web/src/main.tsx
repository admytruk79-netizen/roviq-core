import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './universal.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js'); });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
