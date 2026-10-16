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
import { REFRESH_DELAY_MS } from '../lib/realtimeCache';
import { RESYNC_AFTER_HIDDEN_MS } from '../lib/realtimeChannel';
import { useNotificationsRealtime } from './useNotifications';

const LIST = ['notifications', 'list', 'me'];
const UNREAD = ['notifications', 'unread-count', 'me'];

const read = { id: 'a', kind: 'session_completed', payload: { session_id: 's-a' }, read_at: '2026-10-15T08:00:00+00:00', created_at: '2026-10-15T07:00:00+00:00' };
const unread = { id: 'b', kind: 'session_deviation', payload: { session_id: 's-b' }, read_at: null, created_at: '2026-10-15T09:00:00+00:00' };

function seed(qc, list = [unread, read], count = 1) {
  qc.setQueryData(LIST, list);
  qc.setQueryData(UNREAD, count);
}

function notification(id, minute, extra = {}) {
  return {
    id,
    recipient_id: 'me',
    kind: 'session_completed',
    payload: { session_id: `s-${id}` },
    read_at: null,
    created_at: `2026-10-15 09:${String(minute).padStart(2, '0')}:00.25+00`,
    ...extra,
  };
}

/** The exact keys read again, once the gathered reads are sent. */
function exactReads(invalidate) {
  vi.advanceTimersByTime(REFRESH_DELAY_MS);
  return invalidate.mock.calls
    .filter(([filters]) => filters?.exact)
    .map(([filters]) => filters.queryKey);
}

function mount() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
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

  it('reads the bell again on online, and on visibilitychange after a long absence only', () => {
    const { invalidate, channel, unmount } = mount();
    channel().status('SUBSCRIBED');
    invalidate.mockClear();
    vi.advanceTimersByTime(5_000);
    goOnline();
    expect(rootReads(invalidate)).toHaveLength(1);

    vi.advanceTimersByTime(5_000);
    setVisibility('hidden');
    vi.advanceTimersByTime(5_000);
    setVisibility('visible');
    expect(rootReads(invalidate)).toHaveLength(1);

    setVisibility('hidden');
    vi.advanceTimersByTime(RESYNC_AFTER_HIDDEN_MS);
    setVisibility('visible');
    expect(rootReads(invalidate)).toHaveLength(2);
    unmount();
  });

  it('joins a read in flight on online and visible, and sends it again on SUBSCRIBED', () => {
    const { invalidate, channel, unmount } = mount();
    goOnline();
    vi.advanceTimersByTime(5_000);
    setVisibility('hidden');
    vi.advanceTimersByTime(RESYNC_AFTER_HIDDEN_MS);
    setVisibility('visible');
    channel().status('SUBSCRIBED');
    expect(rootReads(invalidate).map(([, options]) => options)).toEqual([
      { cancelRefetch: false },
      { cancelRefetch: false },
      { cancelRefetch: true },
    ]);
    unmount();
  });

  it('removes the channel when the hook unmounts', () => {
    const { channel, unmount } = mount();
    const ch = channel();
    unmount();
    expect(realtime.removeChannel).toHaveBeenCalledWith(ch);
  });
});

describe('useNotificationsRealtime — one event, one line of the bell', () => {
  it('listens to the rows addressed to me and to deletions — never to the whole table', () => {
    const { channel, unmount } = mount();
    expect(channel().bindings.map((b) => b.filter)).toEqual([
      { event: '*', schema: 'public', table: 'notifications', filter: 'recipient_id=eq.me' },
      { event: 'DELETE', schema: 'public', table: 'notifications' },
    ]);
    expect(channel().emit('INSERT', notification('x', 1, { recipient_id: 'someone' }))).toBe(0);
    unmount();
  });

  it('an INSERT puts the line at the top with the cached columns, raises the count, and reads nothing', () => {
    const { qc, invalidate, channel, unmount } = mount();
    seed(qc);
    channel().emit('INSERT', notification('c', 30));
    expect(qc.getQueryData(LIST)).toEqual([
      { id: 'c', kind: 'session_completed', payload: { session_id: 's-c' }, read_at: null, created_at: '2026-10-15T09:30:00.25+00:00' },
      unread,
      read,
    ]);
    expect(qc.getQueryData(UNREAD)).toBe(2);
    expect(rootReads(invalidate)).toEqual([]);
    expect(exactReads(invalidate)).toEqual([]);
    expect(realtime.from).not.toHaveBeenCalled();
    unmount();
  });

  it('an INSERT heard twice is one line and one count', () => {
    const { qc, channel, unmount } = mount();
    seed(qc);
    channel().emit('INSERT', notification('c', 30));
    channel().emit('INSERT', notification('c', 30));
    expect(qc.getQueryData(LIST).map((n) => n.id)).toEqual(['c', 'b', 'a']);
    expect(qc.getQueryData(UNREAD)).toBe(2);
    unmount();
  });

  it('the list keeps its page of 30', () => {
    const { qc, channel, unmount } = mount();
    const page = Array.from({ length: 30 }, (_, i) => ({
      id: `p${i}`, kind: 'session_completed', payload: {}, read_at: null,
      created_at: `2026-10-14T${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(59 - (i % 60)).padStart(2, '0')}:00+00:00`,
    }));
    seed(qc, page, 30);
    channel().emit('INSERT', notification('new', 1));
    const list = qc.getQueryData(LIST);
    expect(list).toHaveLength(30);
    expect(list[0].id).toBe('new');
    expect(list.at(-1).id).toBe('p28');
    expect(qc.getQueryData(UNREAD)).toBe(31);
    unmount();
  });

  it('an UPDATE of read_at marks the line and lowers the count once', () => {
    const { qc, invalidate, channel, unmount } = mount();
    seed(qc);
    const marked = { ...unread, recipient_id: 'me', read_at: '2026-10-15 10:00:00+00' };
    channel().emit('UPDATE', marked);
    channel().emit('UPDATE', marked);
    expect(qc.getQueryData(LIST)[0]).toEqual({ ...unread, read_at: '2026-10-15T10:00:00+00:00' });
    expect(qc.getQueryData(UNREAD)).toBe(0);
    expect(exactReads(invalidate)).toEqual([]);
    unmount();
  });

  it('a DELETE takes the line out by its id, once, and lowers the count of an unread one', () => {
    const { qc, invalidate, channel, unmount } = mount();
    seed(qc);
    expect(channel().emit('DELETE', { id: 'b' })).toBe(2);
    expect(qc.getQueryData(LIST)).toEqual([read]);
    expect(qc.getQueryData(UNREAD)).toBe(0);
    expect(exactReads(invalidate)).toEqual([]);
    unmount();
  });

  it('a DELETE that a whole short list does not hold was someone else\'s: nothing is read', () => {
    const { qc, invalidate, channel, unmount } = mount();
    seed(qc);
    channel().emit('DELETE', { id: 'elsewhere' });
    expect(exactReads(invalidate)).toEqual([]);
    expect(qc.getQueryData(UNREAD)).toBe(1);
    unmount();
  });

  it('a DELETE that a full page does not hold reads the count again, by its exact key', () => {
    const { qc, invalidate, channel, unmount } = mount();
    const page = Array.from({ length: 30 }, (_, i) => ({ ...read, id: `p${i}` }));
    seed(qc, page, 3);
    channel().emit('DELETE', { id: 'older' });
    expect(exactReads(invalidate)).toEqual([UNREAD]);
    expect(rootReads(invalidate)).toEqual([]);
    unmount();
  });

  it('an UPDATE of a line beyond the page reads the count again', () => {
    const { qc, invalidate, channel, unmount } = mount();
    seed(qc);
    channel().emit('UPDATE', notification('old', 1, { read_at: '2026-10-15 10:00:00+00' }));
    expect(qc.getQueryData(LIST)).toEqual([unread, read]);
    expect(exactReads(invalidate)).toEqual([UNREAD]);
    unmount();
  });
});
