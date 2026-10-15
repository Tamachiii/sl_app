import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { realtime } = await vi.hoisted(async () => {
  const { createFakeRealtime } = await import('../test/fakeRealtime');
  const fake = createFakeRealtime();
  fake.from = vi.fn();
  return { realtime: fake };
});
vi.mock('../lib/supabase', () => ({ supabase: realtime }));
vi.mock('./useAuth', () => ({ useAuth: () => ({ user: { id: 'me' } }) }));

import { goOnline, setVisibility } from '../test/fakeRealtime';
import { useNotificationsRealtime } from './useNotifications';

function mount() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  function Wrapper({ children }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  const view = renderHook(() => useNotificationsRealtime(), { wrapper: Wrapper });
  return { qc, invalidate, unmount: view.unmount, channel: () => realtime.live().at(-1) };
}

/** The calls that read the whole bell again. */
function rootReads(invalidate) {
  return invalidate.mock.calls.filter(([filters]) => (
    filters?.queryKey?.length === 1 && filters.queryKey[0] === 'notifications'
  ));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-15T10:00:00Z'));
  realtime.reset();
  realtime.from.mockReset();
});

afterEach(() => {
  setVisibility('visible');
  vi.useRealTimers();
});

describe('useNotificationsRealtime — the channel outlives a lost connection', () => {
  it('keeps the channel through CHANNEL_ERROR and TIMED_OUT and reads the bell again once it is joined', () => {
    const { invalidate, channel, unmount } = mount();
    const ch = channel();
    ch.status('SUBSCRIBED');
    invalidate.mockClear();

    ch.status('CHANNEL_ERROR');
    ch.status('TIMED_OUT');
    expect(realtime.removeChannel).not.toHaveBeenCalled();

    ch.status('SUBSCRIBED');
    expect(rootReads(invalidate)).toHaveLength(1);
    unmount();
  });

  it('reads the bell again on online and on visibilitychange', () => {
    const { invalidate, unmount } = mount();
    goOnline();
    vi.advanceTimersByTime(5_000);
    setVisibility('visible');
    expect(rootReads(invalidate)).toHaveLength(2);
    unmount();
  });

  it('removes the channel when the hook unmounts', () => {
    const { channel, unmount } = mount();
    const ch = channel();
    unmount();
    expect(realtime.removeChannel).toHaveBeenCalledWith(ch);
  });
});
