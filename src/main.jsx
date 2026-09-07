import './components/remote-hub/remoteTransportBootstrap'
import React from 'react'
import ReactDOM from 'react-dom/client'

import App from './App.tsx'
import RemoteHubApp from './components/remote-hub/RemoteHubApp'

import './index.css'
import 'katex/dist/katex.min.css'

// Initialize i18n
import './i18n/config.js'

// Register service worker for PWA + Web Push support
if (!window.__REMOTE_BASE__ && !window.__REMOTE_HUB__ && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('Service worker registration failed:', err);
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {window.__REMOTE_HUB__ ? <RemoteHubApp /> : <App />}
  </React.StrictMode>,
)
