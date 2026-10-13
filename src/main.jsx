import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { appUpdater } from './lib/appUpdate';
import { chunkRecovery } from './lib/chunkRecovery';
import { restNotifications } from './lib/restNotifications';
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
  // A screen whose file the server no longer has (the page is older than the
  // builds a deploy keeps): lib/chunkRecovery reloads the page once, when that
  // costs nothing. Before the first render, so that no screen is asked for
  // before someone listens. Production builds only — a dev server has every
  // file, and the event this listens for is dispatched by built code alone.
  chunkRecovery.install();
  // A "Rest done" that is still on the lock screen when the app is opened or
  // comes back to the front is closed (lib/restNotifications): the worker that
  // showed it hears of a tap, not of the app being opened from its icon.
  // Production builds only — in dev no worker shows a notification.
  restNotifications.install();
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
