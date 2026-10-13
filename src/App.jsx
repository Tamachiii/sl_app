import { useEffect, useRef } from 'react';
import { HashRouter, useRoutes } from 'react-router-dom';
import { QueryClientProvider, useIsRestoring } from '@tanstack/react-query';
import { PersistQueryClientProvider, persistQueryClientSave } from '@tanstack/react-query-persist-client';
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

// The cache belongs to one account: what it read, and the writes it still owes
// the database. On a shared device the next account must find neither — the
// reads would be shown to it, the writes sent under its name. So the cache in
// memory and the blob in IndexedDB are both wiped when the account is not the
// one they belong to. Two things say so:
//   - the signed-in user changed while the app was open (sign-out, sign-in,
//     another account);
//   - the blob restored at launch names another owner than the account that
//     is signed in. The persister writes that name with the blob
//     (lib/persistence.js): what happened while the app was closed left no
//     other trace.
// Nothing is decided while the blob is still being read: a wipe would be
// followed by the restore it was meant to prevent. A change of user seen in
// that moment is remembered and acted on once the restore is over. (The queue
// does not go out in the meantime: a write is sent only under the session of
// the account the cache belongs to — `ownsQueue` in lib/offlineMutations.js.)
//
// The version of the stored reads is not handled here: that is `CACHE_BUSTER`
// in lib/persistence.js, which drops the reads of an older blob and keeps its
// queued writes.
export function ClearOnUserChange() {
  const { user, isLoading } = useAuth();
  const isRestoring = useIsRestoring();
  const prevUserId = useRef(undefined);
  const wipeDue = useRef(false);
  useEffect(() => {
    if (isLoading) return;
    const currentId = user?.id ?? null;
    if (prevUserId.current !== undefined && prevUserId.current !== currentId) wipeDue.current = true;
    prevUserId.current = currentId;
    if (isRestoring) return;

    const owner = queryPersister?.getOwner() ?? null;
    if (currentId !== null && owner !== null && owner !== currentId) wipeDue.current = true;
    if (wipeDue.current) {
      wipeDue.current = false;
      queryClient.clear();
      // Also forgets the owner: what is stored from here on is nobody's until
      // the line below says whose.
      queryPersister?.removeClient();
    }
    // Only a known account is written down. "Nobody signed in" is also what a
    // token that could not be refreshed looks like, and the cache is still
    // that account's.
    if (currentId !== null) queryPersister?.setOwner(currentId);
  }, [user, isLoading, isRestoring]);
  return null;
}

// Keeps this device's Web Push subscription in sync with the DB (heals a
// rotated endpoint) for whoever is signed in. Mounted once, app-wide.
function PushAutoHeal() {
  usePushAutoHeal();
  return null;
}

// PersistQueryClientProvider saves the cache at each of its changes — from the
// moment the restore is over, and the replay of the queue it waits for
// (`onSuccess` below). Until then it is not listening, and that can last: the
// replay is waited for while it moves, for seconds on a slow network, with the
// restored pages on screen. What changes in that time is in memory only: a
// queued write that reached the database is still stored as owed, and a set
// ticked meanwhile is not stored at all — until something else happens to
// change the cache, or the app is killed first.
//
// So the cache is saved once, at the moment the provider starts listening.
// This is the LAST child of the provider, and has to stay it: its effect runs
// after those of everything else under the provider — a wipe decided by
// `ClearOnUserChange`, a write a page makes as it mounts — and right before the
// provider's own, in the same pass. Nothing can happen between this save and
// the first change the provider hears of.
function SaveWhenRestored() {
  const isRestoring = useIsRestoring();
  useEffect(() => {
    if (isRestoring) return;
    persistQueryClientSave({ queryClient, ...persistOptions }).catch(() => {});
  }, [isRestoring]);
  return null;
}

export function CacheBoundary({ children }) {
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
      <SaveWhenRestored />
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
