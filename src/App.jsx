import { useEffect, useRef } from 'react';
import { HashRouter, useRoutes } from 'react-router-dom';
import { QueryClientProvider, useIsRestoring } from '@tanstack/react-query';
import { PersistQueryClientProvider, persistQueryClientSave } from '@tanstack/react-query-persist-client';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { I18nProvider } from './hooks/useI18n';
import { usePushAutoHeal } from './hooks/usePushAutoHeal';
import { queryClient, queryPersister, cacheOwner, persistOptions, replayQueuedWrites } from './lib/queryClient';
import { routes } from './routes';
import ErrorBoundary from './components/ui/ErrorBoundary';
import SignOutGuard from './components/auth/SignOutGuard';
import { installGlobalErrorReporting } from './lib/errorReporter';

// Wire window.onerror / unhandledrejection telemetry once at module load.
installGlobalErrorReporting();

function AppRoutes() {
  return useRoutes(routes);
}

// The cache belongs to one account: what it read, and the writes it still owes
// the database. On a shared device the next account must find neither — the
// reads would be shown to it, the writes sent under its name. So the cache in
// memory and the blob in IndexedDB are both wiped, in exactly three cases:
//   - ANOTHER account is signed in than the one the cache belongs to. The
//     persister writes that owner with the blob (lib/persistence.js), so this
//     is seen at launch as well — what happened while the app was closed left
//     no other trace;
//   - the user SIGNED OUT of this device (`signOuts` of useAuth);
//   - the cache does not say whose it is, and NOBODY is signed in to claim it
//     (below).
//
// "Nobody is signed in" is, for a cache that has an owner, none of these. It
// is also what a session looks like that went away without anyone asking: a
// token the server refused to refresh, a sign-out on another device. The cache
// used to be wiped on any change of the signed-in user, that one included —
// and with it the unsynced workout of an athlete who then signed in again, as
// the same person. What nobody signed out of stays, labelled with its owner:
// the same account finds it again, and another one falls under the first case.
//
// That rests on the label, and a cache can be without one: every blob written
// by the app as it was deployed before the label, and whatever was read since
// the last wipe. Opened by the account this device is signed in as, such a
// cache is taken for that account's and labelled — nothing says otherwise, and
// it is what that app did. With nobody signed in there is no one to take it
// for, and no way to tell the account that signs in next from a stranger: it
// is wiped. At once, not when that account arrives: a sign-in replays the
// queue from the auth listener, before this effect has run, and an unlabelled
// write is held back by nothing (`ownsQueue` in lib/offlineMutations.js) — it
// would leave under the newcomer's session on its way to being wiped.
//
// Nothing is decided while the blob is still being read: a wipe would be
// followed by the restore it was meant to prevent. A sign-out seen in that
// moment is remembered and acted on once the restore is over, and so is the
// fact that nobody was signed in. (A labelled queue does not go out in the
// meantime: a write is sent only under the session of the account the cache
// belongs to.)
//
// The version of the stored reads is not handled here: that is `CACHE_BUSTER`
// in lib/persistence.js, which drops the reads of an older blob and keeps its
// queued writes.
export function ClearOnUserChange() {
  const { user, isLoading, signOuts = 0 } = useAuth();
  const isRestoring = useIsRestoring();
  const signOutsSeen = useRef(signOuts);
  // Nobody was signed in at some moment since the last decision.
  const nobodySeen = useRef(false);
  const wipeDue = useRef(false);
  useEffect(() => {
    if (signOuts !== signOutsSeen.current) {
      signOutsSeen.current = signOuts;
      wipeDue.current = true;
    }
    if (isLoading) return;
    const currentId = user?.id ?? null;
    if (currentId === null) nobodySeen.current = true;
    if (isRestoring) return;

    // Whose the cache is: the persister's word, or the app's own on a browser
    // without IndexedDB (lib/queryClient.js).
    const owner = cacheOwner.get();
    if (owner === null ? nobodySeen.current : currentId !== null && owner !== currentId) {
      wipeDue.current = true;
    }
    nobodySeen.current = false;
    if (wipeDue.current) {
      wipeDue.current = false;
      queryClient.clear();
      // What is held from here on is nobody's until the lines below say whose.
      queryPersister?.removeClient();
      cacheOwner.set(null);
    }
    // Only a known account is written down. With nobody signed in a cache that
    // has an owner is still its owner's.
    if (currentId !== null) cacheOwner.set(currentId);
  }, [user, isLoading, isRestoring, signOuts]);
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
    <I18nProvider>
      <CacheBoundary>
        <AuthProvider>
          <ClearOnUserChange />
          <SignOutGuard />
          <PushAutoHeal />
          <HashRouter>
            <ErrorBoundary>
              <AppRoutes />
            </ErrorBoundary>
          </HashRouter>
        </AuthProvider>
      </CacheBoundary>
    </I18nProvider>
  );
}
