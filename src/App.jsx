import { useEffect, useRef } from 'react';
import { HashRouter, useRoutes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { ThemeProvider } from './hooks/useTheme';
import { I18nProvider } from './hooks/useI18n';
import { usePushAutoHeal } from './hooks/usePushAutoHeal';
import { queryClient, queryPersister, persistOptions, replayQueuedWrites } from './lib/queryClient';
import { routes } from './routes';
import ErrorBoundary from './components/ui/ErrorBoundary';
import { installGlobalErrorReporting } from './lib/errorReporter';

// Wire window.onerror / unhandledrejection telemetry once at module load.
installGlobalErrorReporting();

function AppRoutes() {
  return useRoutes(routes);
}

// Wipe both the in-memory and IndexedDB-persisted query cache whenever the
// signed-in user changes (logout, login, switch). Without this, a shared
// device could briefly serve user A's persisted sessions to user B between
// hydration and the first authenticated refetch. (A change of version of the
// stored reads is another matter: `CACHE_BUSTER` in lib/persistence.js, which
// drops the reads of an older blob and keeps its queued writes.)
function ClearOnUserChange() {
  const { user, isLoading } = useAuth();
  const prevUserId = useRef(undefined);
  useEffect(() => {
    if (isLoading) return;
    const currentId = user?.id ?? null;
    if (prevUserId.current !== undefined && prevUserId.current !== currentId) {
      queryClient.clear();
      queryPersister?.removeClient?.();
    }
    prevUserId.current = currentId;
  }, [user, isLoading]);
  return null;
}

// Keeps this device's Web Push subscription in sync with the DB (heals a
// rotated endpoint) for whoever is signed in. Mounted once, app-wide.
function PushAutoHeal() {
  usePushAutoHeal();
  return null;
}

function CacheBoundary({ children }) {
  // No IndexedDB (older Safari, jsdom test runs): drop straight to a vanilla
  // provider. Persistence becomes a no-op; queries still work in-memory.
  if (!persistOptions) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return (
    <PersistQueryClientProvider
      client={queryClient}
      // The persister, how long the stored reads live, their version and what
      // is stored at all: one object, built in lib/queryClient.js. Do not
      // rebuild it here option by option — the persister and its options only
      // work together: the filter that keeps a write whose request is out is
      // of no use without the persister that stores it as one that waits.
      persistOptions={persistOptions}
      // Replay mutations queued offline in a previous session, then reconcile
      // the draft caches. No-op if the queue is empty, we're still offline
      // (network-mode pauses) or nobody is signed in. This provider holds
      // every query back until the promise of its onSuccess settles — so that
      // no read comes back before the queued writes have landed — and the
      // helper's promise settles as soon as the replay is done OR has to
      // wait. Do not hand it the promise of the replay itself.
      onSuccess={replayQueuedWrites}
    >
      {children}
    </PersistQueryClientProvider>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <CacheBoundary>
          <AuthProvider>
            <ClearOnUserChange />
            <PushAutoHeal />
            <HashRouter>
              <ErrorBoundary>
                <AppRoutes />
              </ErrorBoundary>
            </HashRouter>
          </AuthProvider>
        </CacheBoundary>
      </I18nProvider>
    </ThemeProvider>
  );
}
