import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import './index.css';

// Register the service worker (autoUpdate). VitePWA injects this virtual
// module at build time; in dev (devOptions.enabled = false) it's a no-op
// shim, so this stays safe to call unconditionally.
if (import.meta.env.PROD) {
  registerSW({ immediate: true });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
