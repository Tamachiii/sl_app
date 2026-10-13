import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { appUpdater } from './lib/appUpdate';
import './index.css';

// The service worker is registered here, by hand, and not through
// `virtual:pwa-register`: that helper reloads every open window the moment a
// new worker takes over, whatever the window is doing. lib/appUpdate asks for
// new versions (on return to the app, and hourly) and lets each page reload at
// a moment of its own. Production builds only — in dev there is no worker
// (vite.config.js: devOptions.enabled = false).
if (import.meta.env.PROD) {
  appUpdater.start({
    swUrl: `${import.meta.env.BASE_URL}sw.js`,
    scope: import.meta.env.BASE_URL,
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
