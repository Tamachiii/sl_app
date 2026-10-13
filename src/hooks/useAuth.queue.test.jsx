import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { dehydrate, hydrate, onlineManager, QueryClient } from '@tanstack/react-query';

// The auth listener and the queue together, nothing between them mocked: only
// supabase is. What is checked is the whole way from "the token refresh went
// through" to "the set ticked in the basement is in the database".
vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn(), onAuthStateChange: vi.fn() },
    from: vi.fn(),
  },
}));
vi.mock('../lib/toast', () => ({ pushToast: vi.fn() }));

import { AuthProvider, useAuth } from './useAuth';
import { supabase } from '../lib/supabase';
import { queryClient, replayQueuedWrites } from '../lib/queryClient';
import { MUTATION_KEYS, registerOfflineMutationDefaults } from '../lib/offlineMutations';

const wrapper = ({ children }) => <AuthProvider>{children}</AuthProvider>;
const SESSION = { access_token: 'jwt', user: { id: 'u-1' } };

let authChangeCallback;
let session;
let setLogs;

beforeEach(() => {
  vi.clearAllMocks();
  session = null;
  supabase.auth.getSession.mockImplementation(async () => ({ data: { session }, error: null }));
  supabase.auth.onAuthStateChange.mockImplementation((cb) => {
    authChangeCallback = cb;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
  setLogs = {
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: { id: 'l-1', done: true }, error: null }),
  };
  const profiles = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: { id: 'u-1', role: 'student' }, error: null }),
  };
  supabase.from.mockImplementation((table) => (table === 'set_logs' ? setLogs : profiles));
});

afterEach(() => {
  queryClient.clear();
  onlineManager.setOnline(true);
});

// What the persister restores at launch: a set ticked without signal.
async function restoreQueueWrittenOffline() {
  onlineManager.setOnline(false);
  const phone = new QueryClient();
  registerOfflineMutationDefaults(phone);
  phone
    .getMutationCache()
    .build(phone, {
      mutationKey: MUTATION_KEYS.toggleDone,
      ...phone.getMutationDefaults(MUTATION_KEYS.toggleDone),
    })
    .execute({ logId: 'l-1', done: true })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 0));
  const stored = JSON.parse(JSON.stringify(dehydrate(phone)));
  onlineManager.setOnline(true);
  hydrate(queryClient, stored);
  return queryClient.getMutationCache().getAll()[0];
}

describe('a queue restored while the session could not be read', () => {
  it('stays on the device, then is sent when the auth listener sees the session', async () => {
    // Launch on a bad network: the token had expired, its refresh got no
    // answer, so supabase-js reports no session — and nothing may be sent.
    const queued = await restoreQueueWrittenOffline();
    replayQueuedWrites(); // the persister's onSuccess
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(setLogs.update).not.toHaveBeenCalled();
    expect(queued.state).toMatchObject({ status: 'pending', isPaused: true });

    // The refresh goes through.
    session = SESSION;
    await act(async () => {
      authChangeCallback('TOKEN_REFRESHED', SESSION);
    });

    await waitFor(() => expect(queued.state.status).toBe('success'));
    expect(setLogs.update).toHaveBeenCalledTimes(1);
    expect(setLogs.update.mock.calls[0][0]).toMatchObject({ done: true, failed: false });
    expect(setLogs.eq).toHaveBeenCalledWith('id', 'l-1');
  });
});
