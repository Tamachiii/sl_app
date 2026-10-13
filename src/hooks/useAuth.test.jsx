import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('../lib/supabase', () => {
  return {
    supabase: {
      auth: {
        getSession: vi.fn(),
        onAuthStateChange: vi.fn(),
        signInWithPassword: vi.fn(),
        signOut: vi.fn(),
      },
      from: vi.fn(),
    },
  };
});

// The replay itself is lib/queryClient.test.js's subject; here only WHEN the
// provider asks for it. (useAuth.queue.test.jsx runs the two together.)
vi.mock('../lib/queryClient', () => ({ replayQueuedWrites: vi.fn() }));

import { AuthProvider, useAuth } from './useAuth';
import { supabase } from '../lib/supabase';
import { replayQueuedWrites } from '../lib/queryClient';

function makeProfileChain(result) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(result),
  };
  return chain;
}

const wrapper = ({ children }) => <AuthProvider>{children}</AuthProvider>;

let unsubscribeSpy;
let authChangeCallback;

beforeEach(() => {
  vi.clearAllMocks();
  unsubscribeSpy = vi.fn();
  supabase.auth.onAuthStateChange.mockImplementation((cb) => {
    authChangeCallback = cb;
    return { data: { subscription: { unsubscribe: unsubscribeSpy } } };
  });
});

describe('useAuth (no provider)', () => {
  it('returns {} when used outside the provider', () => {
    const { result } = renderHook(() => useAuth());
    expect(result.current).toEqual({});
  });
});

describe('AuthProvider', () => {
  it('hydrates user + profile from getSession on mount', async () => {
    supabase.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'u-1', email: 'a@b.c' } } },
    });
    supabase.from.mockReturnValue(
      makeProfileChain({
        data: { id: 'u-1', role: 'coach', full_name: 'Test Coach' },
        error: null,
      }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.user).toEqual({ id: 'u-1', email: 'a@b.c' });
    expect(result.current.profile.role).toBe('coach');
    expect(result.current.role).toBe('coach');
    expect(supabase.from).toHaveBeenCalledWith('profiles');
  });

  it('marks not loading when there is no session', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: null } });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.user).toBeNull();
    expect(result.current.profile).toBeNull();
    expect(result.current.role).toBeNull();
  });

  it('keeps user but clears profile when fetchProfile fails', async () => {
    supabase.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'u-1' } } },
    });
    supabase.from.mockReturnValue(
      makeProfileChain({ data: null, error: { message: 'boom' } }),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.user).toEqual({ id: 'u-1' });
    expect(result.current.profile).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('clears both user and profile on a SIGNED_OUT auth event', async () => {
    supabase.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'u-1' } } },
    });
    supabase.from.mockReturnValue(
      makeProfileChain({
        data: { id: 'u-1', role: 'student' },
        error: null,
      }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).not.toBeNull());

    await act(async () => {
      authChangeCallback('SIGNED_OUT', null);
    });

    expect(result.current.user).toBeNull();
    expect(result.current.profile).toBeNull();
  });

  it('refetches the profile when the auth state emits a fresh user', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: null } });
    supabase.from.mockReturnValue(
      makeProfileChain({
        data: { id: 'u-2', role: 'student' },
        error: null,
      }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      authChangeCallback('SIGNED_IN', { user: { id: 'u-2' } });
    });

    await waitFor(() => expect(result.current.profile?.role).toBe('student'));
    expect(result.current.user).toEqual({ id: 'u-2' });
  });

  it('unsubscribes from auth changes on unmount', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: null } });
    const { unmount } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(supabase.auth.onAuthStateChange).toHaveBeenCalled());
    unmount();
    expect(unsubscribeSpy).toHaveBeenCalled();
  });

  it('signIn forwards email + password to supabase and returns the error', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: null } });
    supabase.auth.signInWithPassword.mockResolvedValue({ error: null });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let res;
    await act(async () => {
      res = await result.current.signIn('a@b.c', 'pw');
    });
    expect(supabase.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'a@b.c',
      password: 'pw',
    });
    expect(res).toEqual({ error: null });
  });

  it('signOut clears user + profile and calls supabase.auth.signOut', async () => {
    supabase.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'u-1' } } },
    });
    supabase.from.mockReturnValue(
      makeProfileChain({ data: { id: 'u-1', role: 'coach' }, error: null }),
    );
    supabase.auth.signOut.mockResolvedValue({ error: null });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).not.toBeNull());

    await act(async () => {
      await result.current.signOut();
    });
    expect(supabase.auth.signOut).toHaveBeenCalled();
    expect(result.current.user).toBeNull();
    expect(result.current.profile).toBeNull();
  });
});

// The writes queued on the device are not sent without a session
// (lib/offlineMutations.js). They wait paused, so somebody has to say when a
// session is there again: the auth listener.
describe('AuthProvider: the queued writes are replayed when a session appears', () => {
  const SESSION = { access_token: 'jwt', user: { id: 'u-1' } };

  async function mount({ session }) {
    supabase.auth.getSession.mockResolvedValue({ data: { session } });
    supabase.from.mockReturnValue(
      makeProfileChain({ data: { id: 'u-1', role: 'student' }, error: null }),
    );
    const view = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(view.result.current.isLoading).toBe(false));
    return view;
  }

  const emit = (event, session) =>
    act(async () => {
      authChangeCallback(event, session);
    });

  it('on a sign-in where nobody was signed in', async () => {
    await mount({ session: null });
    expect(replayQueuedWrites).not.toHaveBeenCalled();

    await emit('SIGNED_IN', SESSION);

    expect(replayQueuedWrites).toHaveBeenCalledTimes(1);
  });

  it('on a token refresh — how a refresh that kept failing on a bad network ends', async () => {
    // The token had expired and could not be refreshed: no session at start-up.
    await mount({ session: null });

    await emit('TOKEN_REFRESHED', SESSION);

    expect(replayQueuedWrites).toHaveBeenCalledTimes(1);
  });

  it('on a token refresh with a session already known as well', async () => {
    // auth says nothing while a refresh fails: the session known here may have
    // been unusable for the last ten minutes.
    await mount({ session: SESSION });

    await emit('TOKEN_REFRESHED', SESSION);

    expect(replayQueuedWrites).toHaveBeenCalledTimes(1);
  });

  it('not at start-up: the restored cache runs that replay itself', async () => {
    await mount({ session: SESSION });

    await emit('INITIAL_SESSION', SESSION);

    expect(replayQueuedWrites).not.toHaveBeenCalled();
  });

  it('not on the SIGNED_IN supabase-js emits at every return to the tab', async () => {
    await mount({ session: SESSION });

    await emit('SIGNED_IN', SESSION);
    await emit('SIGNED_IN', SESSION);

    expect(replayQueuedWrites).not.toHaveBeenCalled();
  });

  it('not when the session goes, and again when it is back', async () => {
    await mount({ session: SESSION });

    await emit('SIGNED_OUT', null);
    expect(replayQueuedWrites).not.toHaveBeenCalled();

    await emit('SIGNED_IN', SESSION);
    expect(replayQueuedWrites).toHaveBeenCalledTimes(1);
  });
});
