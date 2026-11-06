import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { isRemote } from './api'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)

// Remote browsers only. Needs a secure context (localhost or the HTTPS tunnel); over plain http://192.168.x.x
// `serviceWorker` is undefined, and the page still works and can still be added to the home screen, just not offline.
if (isRemote && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined))
}
