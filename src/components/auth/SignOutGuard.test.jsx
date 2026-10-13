import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

// The guard where App.jsx mounts it: under the real auth provider, on a client
// that holds the writes of a workout logged without signal. What is asserted
// is what the athlete sees and what is left on the device — the session, the
// queue — not which function was called.

const SESSION_KEY = 'sb-test-auth-token';

vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      storageKey: 'sb-test-auth-token',
      getSession: vi.fn(),
      onAuthStateChange: vi.fn(),
      signOut: vi.fn(),
    },
    from: vi.fn(),
    rpc: vi.fn(),
  },
}));
vi.mock('../../lib/toast', () => ({ pushToast: vi.fn() }));
// The provider replays the queue when a session appears: not this file's subject.
vi.mock('../../lib/queryClient', () => ({ replayQueuedWrites: vi.fn() }));

import SignOutGuard from './SignOutGuard';
import { AuthProvider, useAuth } from '../../hooks/useAuth';
import { supabase } from '../../lib/supabase';
import { MUTATION_KEYS, registerOfflineMutationDefaults } from '../../lib/offlineMutations';
import { markUnsynced } from '../../lib/draftTree';

const ATHLETE = { id: 'u-athlete', email: 'athlete@example.test' };
const SESSION = { access_token: 'jwt', refresh_token: 'r', expires_at: 4102444800, user: ATHLETE };

function deviceIs(online) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  onlineManager.setOnline(online);
}

// A device the athlete is signed in on.
function signedInDevice() {
  localStorage.setItem(SESSION_KEY, JSON.stringify(SESSION));
  localStorage.setItem('sl_profile_cache', JSON.stringify({ id: ATHLETE.id, role: 'student', full_name: 'Ada' }));
}
const sessionOnDevice = () => localStorage.getItem(SESSION_KEY);

// The app's client, as far as the queue goes: the writes registered under
// their keys, held back while the device is offline.
function clientWithQueue() {
  const client = new QueryClient();
  registerOfflineMutationDefaults(client);
  return client;
}

// A write made without signal: it waits in the client.
function logOffline(client, key, variables) {
  client
    .getMutationCache()
    .build(client, { mutationKey: key, ...client.getMutationDefaults(key) })
    .execute(variables)
    .catch(() => {});
}
const owed = (client) => client.getMutationCache().findAll({ status: 'pending' }).length;

// Every "Sign out" of the app is this: the provider's signOut, called from a
// component that knows nothing of the guard.
function SignOutButton() {
  const { user, signOut, signOuts } = useAuth();
  return (
    <>
      <output data-testid="who">{user ? user.id : 'nobody'}</output>
      <output data-testid="sign-outs">{signOuts}</output>
      <button type="button" onClick={signOut}>
        Sign out
      </button>
    </>
  );
}

let client;
async function openApp() {
  render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <SignOutGuard />
        <SignOutButton />
      </AuthProvider>
    </QueryClientProvider>,
  );
  await act(async () => {});
}

const who = () => screen.getByTestId('who').textContent;
const question = () => screen.queryByRole('dialog', { hidden: true });
const tapSignOut = () => userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  signedInDevice();
  deviceIs(false);
  client = clientWithQueue();
  supabase.auth.getSession.mockResolvedValue({ data: { session: SESSION }, error: null });
  supabase.auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  supabase.auth.signOut.mockResolvedValue({ error: null });
  supabase.from.mockImplementation(() => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: { id: ATHLETE.id, role: 'student', full_name: 'Ada' }, error: null }),
  }));
});

afterEach(() => {
  client.clear();
  deviceIs(true);
});

describe('signing out with writes the device has not sent', () => {
  beforeEach(async () => {
    logOffline(client, MUTATION_KEYS.toggleDone, { logId: 'l-1', done: true });
    logOffline(client, MUTATION_KEYS.setRpe, { logId: 'l-1', rpe: 8 });
    logOffline(client, MUTATION_KEYS.confirmSession, { sessionId: 's-1', performedOn: '2026-10-13' });
    await openApp();
    expect(owed(client)).toBe(3);
  });

  it('offline: the tap opens the question, says how much is at stake, and signs nobody out', async () => {
    await tapSignOut();

    expect(question()).toBeInTheDocument();
    expect(screen.getByText(/sign out and lose unsynced changes\?/i)).toBeInTheDocument();
    expect(screen.getByText(/3 changes made on this device have not been sent yet/i)).toBeInTheDocument();
    expect(who()).toBe(ATHLETE.id);
    expect(sessionOnDevice()).not.toBeNull();
    expect(owed(client)).toBe(3);
    expect(screen.getByTestId('sign-outs')).toHaveTextContent('0');
  });

  it('Cancel: still signed in, and the workout is still on the device', async () => {
    await tapSignOut();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel', hidden: true }));

    expect(question()).not.toBeInTheDocument();
    expect(who()).toBe(ATHLETE.id);
    expect(sessionOnDevice()).not.toBeNull();
    expect(owed(client)).toBe(3);
    expect(screen.getByTestId('sign-outs')).toHaveTextContent('0');
    expect(supabase.auth.signOut).not.toHaveBeenCalled();
  });

  it('closing the dialog — its cross, the Escape key — is Cancel', async () => {
    await tapSignOut();
    // What the browser fires on the element for either (jsdom's <dialog> has
    // no close() of its own; the one of test/setup.js fires nothing).
    fireEvent(question(), new Event('close'));

    await waitFor(() => expect(question()).not.toBeInTheDocument());
    expect(who()).toBe(ATHLETE.id);
    expect(sessionOnDevice()).not.toBeNull();
  });

  it('"Sign out anyway": the device is signed out — offline, by forgetting the session itself', async () => {
    await tapSignOut();
    await userEvent.click(screen.getByRole('button', { name: 'Sign out anyway', hidden: true }));

    await waitFor(() => expect(who()).toBe('nobody'));
    expect(question()).not.toBeInTheDocument();
    expect(sessionOnDevice()).toBeNull();
    expect(screen.getByTestId('sign-outs')).toHaveTextContent('1');
    // No network: the server was not asked.
    expect(supabase.auth.signOut).not.toHaveBeenCalled();
  });

  it('a second tap while the question is on screen opens no second one, and one answer settles both', async () => {
    await tapSignOut();
    // The dialog is modal in a browser; a keyboard or a second finger is not.
    await act(async () => {
      screen.getByRole('button', { name: 'Sign out' }).click();
    });
    expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Sign out anyway', hidden: true }));

    await waitFor(() => expect(who()).toBe('nobody'));
    await waitFor(() => expect(screen.getByTestId('sign-outs')).toHaveTextContent('2'));
    expect(question()).not.toBeInTheDocument();
  });

  it('asks again the next time: an answer is for one sign-out', async () => {
    await tapSignOut();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel', hidden: true }));

    await tapSignOut();

    expect(question()).toBeInTheDocument();
  });
});

describe('what counts as unsent', () => {
  it('one write: the sentence is about one', async () => {
    logOffline(client, MUTATION_KEYS.toggleDone, { logId: 'l-1', done: true });
    await openApp();

    await tapSignOut();

    expect(screen.getByText(/1 change made on this device has not been sent yet/i)).toBeInTheDocument();
  });

  it('a write still waiting with a network — its request out, or between two attempts — counts as well', async () => {
    deviceIs(true);
    // Nobody to send it as: the write looks again later.
    supabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    signedInDevice();
    logOffline(client, MUTATION_KEYS.toggleDone, { logId: 'l-1', done: true });
    await openApp();

    await tapSignOut();

    expect(question()).toBeInTheDocument();
  });

  it('a program draft that is ahead of the server, with no save on its way', async () => {
    client.setQueryData(['draft-tree', 'p-1'], markUnsynced({ id: 'p-1', weeks: [] }));
    await openApp();

    await tapSignOut();

    expect(screen.getByText(/your program draft has changes that have not been sent yet/i)).toBeInTheDocument();
    expect(who()).toBe(ATHLETE.id);
  });

  it('a write that is not part of the queue does not: the device would not have kept it anyway', async () => {
    client
      .getMutationCache()
      .build(client, { mutationFn: async () => null })
      .execute({})
      .catch(() => {});
    await openApp();

    await tapSignOut();

    await waitFor(() => expect(who()).toBe('nobody'));
    expect(question()).not.toBeInTheDocument();
  });
});

describe('signing out with nothing unsent', () => {
  it('offline: no question, signed out at once', async () => {
    await openApp();

    await tapSignOut();

    await waitFor(() => expect(who()).toBe('nobody'));
    expect(question()).not.toBeInTheDocument();
    expect(sessionOnDevice()).toBeNull();
  });

  it('online: no question, and the server is told', async () => {
    deviceIs(true);
    await openApp();

    await tapSignOut();

    await waitFor(() => expect(who()).toBe('nobody'));
    expect(supabase.auth.signOut).toHaveBeenCalledTimes(1);
    expect(question()).not.toBeInTheDocument();
  });
});
