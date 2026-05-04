import { useEffect, useRef } from 'react';
import { HashRouter, useRoutes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { ThemeProvider } from './hooks/useTheme';
import { I18nProvider } from './hooks/useI18n';
import { queryClient, queryPersister, shouldPersistQuery } from './lib/queryClient';
import { routes } from './routes';
import ErrorBoundary from './components/ui/ErrorBoundary';

function AppRoutes() {
  return useRoutes(routes);
}

// Wipe both the in-memory and IndexedDB-persisted query cache whenever the
// signed-in user changes (logout, login, switch). Without this, a shared
// device could briefly serve user A's persisted sessions to user B between
// hydration and the first authenticated refetch. The `buster` key in
// PersistQueryClientProvider invalidates the blob cross-version; this effect
// handles intra-version user swaps.
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

function CacheBoundary({ children }) {
  // No IndexedDB (older Safari, jsdom test runs): drop straight to a vanilla
  // provider. Persistence becomes a no-op; queries still work in-memory.
  if (!queryPersister) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister: queryPersister,
        // 14d is long enough to cover a vacation without internet, short
        // enough that stale set-log targets eventually get refreshed.
        maxAge: 1000 * 60 * 60 * 24 * 14,
        // Bump this when the persisted shape changes incompatibly.
        buster: 'sl-app-cache-v1',
        dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
      }}
      onSuccess={() => {
        // Replay any mutations queued offline in a previous session. No-op if
        // the queue is empty or we're still offline (network-mode pauses).
        queryClient.resumePausedMutations();
      }}
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
