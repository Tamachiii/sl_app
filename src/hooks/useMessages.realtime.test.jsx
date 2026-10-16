import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';

const { realtime } = await vi.hoisted(async () => {
  const { createFakeRealtime } = await import('../test/fakeRealtime');
  const fake = createFakeRealtime();
  fake.from = vi.fn();
  return { realtime: fake };
});
vi.mock('../lib/supabase', () => ({ supabase: realtime }));
vi.mock('./useAuth', () => ({ useAuth: () => ({ user: { id: 'me' } }) }));

import { goOnline, setVisibility } from '../test/fakeRealtime';
import { MAX_JOIN_FAILURES, RESYNC_AFTER_HIDDEN_MS } from '../lib/realtimeChannel';
import { REFRESH_DELAY_MS } from '../lib/realtimeCache';
import {
  useMessagesRealtime,
  useMarkThreadRead,
  useSendMessage,
  useDeleteMessage,
} from './useMessages';

const THREAD_S1 = ['messages', 'thread', 'me', 's1'];
const THREAD_S2 = ['messages', 'thread', 'me', 's2'];
const CONVERSATIONS = ['messages', 'conversations', 'me'];
const UNREAD = ['messages', 'unread-count', 'me'];
const FEEDBACK_IDS = ['messages', 'my-feedback-session-ids', 'me'];
const feedbackKey = (sessionId) => ['messages', 'session-feedback', sessionId];

// Two threads: s1 (everything read), s2 (one unread message to me).
const m1 = { id: 'm1', sender_id: 's1', recipient_id: 'me', body: 'hello', session_id: null, read_at: '2026-10-15T08:10:00+00:00', created_at: '2026-10-15T08:00:00+00:00' };
const m2 = { id: 'm2', sender_id: 'me', recipient_id: 's1', body: 'hi back', session_id: null, read_at: null, created_at: '2026-10-15T08:30:00+00:00' };
const n1 = { id: 'n1', sender_id: 's2', recipient_id: 'me', body: 'a question', session_id: null, read_at: null, created_at: '2026-10-15T07:00:00+00:00' };

function seed(qc) {
  qc.setQueryData(THREAD_S1, [m1, m2]);
  qc.setQueryData(THREAD_S2, [n1]);
  qc.setQueryData(CONVERSATIONS, [
    { otherProfileId: 's1', lastMessage: m2, unreadCount: 0, otherFullName: 'One', otherRole: 'student' },
    { otherProfileId: 's2', lastMessage: n1, unreadCount: 1, otherFullName: 'Two', otherRole: 'student' },
  ]);
  qc.setQueryData(UNREAD, 1);
}

function mount(useExtra = () => null) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  function Wrapper({ children }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  const view = renderHook(() => {
    useMessagesRealtime();
    return useExtra();
  }, { wrapper: Wrapper });
  return {
    qc,
    invalidate,
    result: view.result,
    unmount: view.unmount,
    channel: () => realtime.live().at(-1),
  };
}

/** The calls that read the whole messages root again. */
function rootReads(invalidate) {
  return invalidate.mock.calls.filter(([filters]) => (
    filters?.queryKey?.length === 1 && filters.queryKey[0] === 'messages'
  ));
}

/** The exact keys read again, once the gathered reads are sent. */
function exactReads(invalidate) {
  vi.advanceTimersByTime(REFRESH_DELAY_MS);
  return invalidate.mock.calls
    .filter(([filters]) => filters?.exact)
    .map(([filters]) => filters.queryKey);
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

describe('useMessagesRealtime — the channel outlives a lost connection', () => {
  it('keeps the channel through CHANNEL_ERROR and TIMED_OUT and reads the messages root again once it is joined', () => {
    const { invalidate, channel, unmount } = mount();
    const ch = channel();
    ch.status('SUBSCRIBED');
    invalidate.mockClear();

    ch.status('CHANNEL_ERROR');
    ch.status('TIMED_OUT');
    expect(realtime.removeChannel).not.toHaveBeenCalled();
    expect(realtime.live()).toEqual([ch]);

    ch.status('SUBSCRIBED');
    expect(rootReads(invalidate)).toHaveLength(1);
    unmount();
  });

  it('reads the messages root again when the browser is back online and when the page is visible after a long absence', () => {
    const { invalidate, channel, unmount } = mount();
    channel().status('SUBSCRIBED');
    invalidate.mockClear();
    vi.advanceTimersByTime(5_000);
    goOnline();
    expect(rootReads(invalidate)).toHaveLength(1);
    vi.advanceTimersByTime(5_000);
    setVisibility('hidden');
    vi.advanceTimersByTime(RESYNC_AFTER_HIDDEN_MS);
    setVisibility('visible');
    expect(rootReads(invalidate)).toHaveLength(2);
    unmount();
  });

  it('reads nothing again when the page was hidden a short while and the channel stayed joined', () => {
    const { qc, invalidate, channel, unmount } = mount();
    channel().status('SUBSCRIBED');
    seed(qc);
    invalidate.mockClear();
    vi.advanceTimersByTime(5_000);
    setVisibility('hidden');
    vi.advanceTimersByTime(5_000);
    setVisibility('visible');
    expect(invalidate).not.toHaveBeenCalled();
    expect(qc.getQueryState(CONVERSATIONS).isInvalidated).toBe(false);
    unmount();
  });

  it('a resync on online or visible joins a read already in flight; one on SUBSCRIBED sends it again', async () => {
    const answers = [];
    const queryFn = vi.fn(() => new Promise((resolve) => { answers.push(resolve); }));
    const { qc, channel, unmount } = mount(() => useQuery({ queryKey: THREAD_S1, queryFn, staleTime: Infinity }));
    const answer = async () => {
      await act(async () => { answers.at(-1)([m1, m2]); });
    };
    expect(queryFn).toHaveBeenCalledTimes(1);
    await answer();

    // React Query's own refetch on reconnect goes first; the resync joins it.
    act(() => { qc.refetchQueries({ queryKey: THREAD_S1 }); });
    expect(queryFn).toHaveBeenCalledTimes(2);
    goOnline();
    expect(queryFn).toHaveBeenCalledTimes(2);
    await answer();

    vi.advanceTimersByTime(5_000);
    act(() => { qc.refetchQueries({ queryKey: THREAD_S1 }); });
    setVisibility('hidden');
    vi.advanceTimersByTime(RESYNC_AFTER_HIDDEN_MS);
    setVisibility('visible');
    expect(queryFn).toHaveBeenCalledTimes(3);
    await answer();

    // A read sent before the join may be older than the first event: it is sent again.
    act(() => { qc.refetchQueries({ queryKey: THREAD_S1 }); });
    expect(queryFn).toHaveBeenCalledTimes(4);
    channel().status('SUBSCRIBED');
    expect(queryFn).toHaveBeenCalledTimes(5);
    await answer();
    unmount();
  });

  it('a resync leaves the session titles alone: no message changes them', () => {
    const { qc, channel, unmount } = mount();
    qc.setQueryData(['messages', 'session-refs', ['sess-1']], [{ id: 'sess-1', title: 'Upper' }]);
    seed(qc);
    channel().status('SUBSCRIBED');
    expect(qc.getQueryState(['messages', 'session-refs', ['sess-1']]).isInvalidated).toBe(false);
    expect(qc.getQueryState(THREAD_S1).isInvalidated).toBe(true);
    expect(qc.getQueryState(UNREAD).isInvalidated).toBe(true);
    unmount();
  });

  it(`gives the channel up after ${MAX_JOIN_FAILURES} refused joins and opens a new one when the page comes back`, () => {
    const { channel, unmount } = mount();
    const first = channel();
    for (let i = 0; i < MAX_JOIN_FAILURES; i += 1) first.status('CHANNEL_ERROR');
    expect(realtime.removeChannel).toHaveBeenCalledWith(first);
    setVisibility('visible');
    expect(realtime.live()).toHaveLength(1);
    expect(channel()).not.toBe(first);
    unmount();
  });

  it('removes the channel when the hook unmounts', () => {
    const { channel, unmount } = mount();
    const ch = channel();
    unmount();
    expect(realtime.removeChannel).toHaveBeenCalledWith(ch);
    expect(realtime.live()).toEqual([]);
  });
});

describe('useMessagesRealtime — one event, one thread', () => {
  it('listens to the rows I receive, the rows I send, and deletions — never to the whole table', () => {
    const { channel, unmount } = mount();
    expect(channel().bindings.map((b) => b.filter)).toEqual([
      { event: '*', schema: 'public', table: 'messages', filter: 'recipient_id=eq.me' },
      { event: '*', schema: 'public', table: 'messages', filter: 'sender_id=eq.me' },
      { event: 'DELETE', schema: 'public', table: 'messages' },
    ]);
    // A message between two other people reaches no binding.
    expect(channel().emit('INSERT', { id: 'x', sender_id: 'a', recipient_id: 'b' })).toBe(0);
    unmount();
  });

  it('an INSERT patches its own thread, the unread count and its conversation, and reads nothing', () => {
    const { qc, invalidate, channel, unmount } = mount();
    seed(qc);
    const s2Thread = qc.getQueryData(THREAD_S2);

    channel().emit('INSERT', {
      id: 'm3',
      sender_id: 's1',
      recipient_id: 'me',
      body: 'new one',
      session_id: null,
      read_at: null,
      // Realtime hands timestamptz over in Postgres' text form.
      created_at: '2026-10-15 09:00:00.123456+00',
    });

    const thread = qc.getQueryData(THREAD_S1);
    expect(thread.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(thread[2]).toEqual({
      id: 'm3',
      sender_id: 's1',
      recipient_id: 'me',
      body: 'new one',
      session_id: null,
      read_at: null,
      created_at: '2026-10-15T09:00:00.123456+00:00',
    });
    expect(qc.getQueryData(THREAD_S2)).toBe(s2Thread);
    expect(qc.getQueryData(UNREAD)).toBe(2);
    const conversations = qc.getQueryData(CONVERSATIONS);
    expect(conversations.map((c) => c.otherProfileId)).toEqual(['s1', 's2']);
    expect(conversations[0]).toMatchObject({ lastMessage: { id: 'm3' }, unreadCount: 1, otherFullName: 'One' });

    expect(rootReads(invalidate)).toEqual([]);
    expect(exactReads(invalidate)).toEqual([]);
    expect(realtime.from).not.toHaveBeenCalled();
    unmount();
  });

  it('a newer message brings its conversation to the top', () => {
    const { qc, channel, unmount } = mount();
    seed(qc);
    channel().emit('INSERT', {
      id: 'n2', sender_id: 's2', recipient_id: 'me', body: 'later', session_id: null, read_at: null,
      created_at: '2026-10-15 09:30:00+00',
    });
    const conversations = qc.getQueryData(CONVERSATIONS);
    expect(conversations.map((c) => c.otherProfileId)).toEqual(['s2', 's1']);
    expect(conversations[0]).toMatchObject({ lastMessage: { id: 'n2' }, unreadCount: 2 });
    expect(qc.getQueryData(UNREAD)).toBe(2);
    unmount();
  });

  it('an INSERT heard twice, or one a read already brought, is added once and counted once', () => {
    const { qc, channel, unmount } = mount();
    seed(qc);
    const row = {
      id: 'm3', sender_id: 's1', recipient_id: 'me', body: 'new one', session_id: null, read_at: null,
      created_at: '2026-10-15 09:00:00+00',
    };
    channel().emit('INSERT', row);
    const once = qc.getQueryData(THREAD_S1);
    channel().emit('INSERT', row);
    expect(qc.getQueryData(THREAD_S1)).toBe(once);
    expect(qc.getQueryData(UNREAD)).toBe(2);
    expect(qc.getQueryData(CONVERSATIONS)[0].unreadCount).toBe(1);

    // n2 is already in the thread a refetch read: the event changes nothing.
    const n2 = { id: 'n2', sender_id: 's2', recipient_id: 'me', body: 'b', session_id: null, read_at: null, created_at: '2026-10-15T09:10:00+00:00' };
    qc.setQueryData(THREAD_S2, [n1, n2]);
    qc.setQueryData(UNREAD, 3);
    channel().emit('INSERT', { ...n2, created_at: '2026-10-15 09:10:00+00' });
    expect(qc.getQueryData(THREAD_S2)).toHaveLength(2);
    expect(qc.getQueryData(UNREAD)).toBe(3);
    unmount();
  });

  it('a message the conversation list already holds as its last one is counted once, though its thread lacks it', () => {
    const { qc, invalidate, channel, unmount } = mount();
    seed(qc);
    // The list and the count were read after n2 was sent, the thread of s2 before.
    const n2 = { id: 'n2', sender_id: 's2', recipient_id: 'me', body: 'later', session_id: null, read_at: null, created_at: '2026-10-15T09:30:00+00:00' };
    qc.setQueryData(CONVERSATIONS, [
      { otherProfileId: 's2', lastMessage: n2, unreadCount: 2, otherFullName: 'Two', otherRole: 'student' },
      { otherProfileId: 's1', lastMessage: m2, unreadCount: 0, otherFullName: 'One', otherRole: 'student' },
    ]);
    qc.setQueryData(UNREAD, 2);

    channel().emit('INSERT', { ...n2, created_at: '2026-10-15 09:30:00+00' });
    expect(qc.getQueryData(THREAD_S2).map((m) => m.id)).toEqual(['n1', 'n2']);
    expect(qc.getQueryData(UNREAD)).toBe(2);
    expect(qc.getQueryData(CONVERSATIONS)[0]).toMatchObject({ otherProfileId: 's2', unreadCount: 2 });

    // Reading both takes the badge and the conversation to 0, not to 1.
    channel().emit('UPDATE', { ...n1, read_at: '2026-10-15 09:59:00+00' });
    channel().emit('UPDATE', { ...n2, read_at: '2026-10-15 09:59:00+00' });
    expect(qc.getQueryData(UNREAD)).toBe(0);
    expect(qc.getQueryData(CONVERSATIONS)[0]).toMatchObject({ otherProfileId: 's2', unreadCount: 0 });
    expect(exactReads(invalidate)).toEqual([]);
    unmount();
  });

  it('a thread that lacks a new message still counts it when the conversation list cannot say', () => {
    const { qc, channel, unmount } = mount();
    seed(qc);
    qc.invalidateQueries({ queryKey: CONVERSATIONS, exact: true, refetchType: 'none' });
    channel().emit('INSERT', {
      id: 'n2', sender_id: 's2', recipient_id: 'me', body: 'later', session_id: null, read_at: null,
      created_at: '2026-10-15 09:30:00+00',
    });
    expect(qc.getQueryData(THREAD_S2).map((m) => m.id)).toEqual(['n1', 'n2']);
    expect(qc.getQueryData(UNREAD)).toBe(2);
    unmount();
  });

  it('a message read in the conversation list, still unread in its thread, is not taken off the counts twice', () => {
    const { qc, invalidate, channel, unmount } = mount();
    seed(qc);
    // The list and the count were read after n1 was read on another device;
    // the thread of s2 before. One message of s1 is still unread.
    const readN1 = { ...n1, read_at: '2026-10-15T09:50:00+00:00' };
    qc.setQueryData(CONVERSATIONS, [
      { otherProfileId: 's1', lastMessage: m2, unreadCount: 1, otherFullName: 'One', otherRole: 'student' },
      { otherProfileId: 's2', lastMessage: readN1, unreadCount: 0, otherFullName: 'Two', otherRole: 'student' },
    ]);
    qc.setQueryData(UNREAD, 1);

    channel().emit('UPDATE', { ...n1, read_at: '2026-10-15 09:50:00+00' });
    expect(qc.getQueryData(THREAD_S2)).toEqual([readN1]);
    expect(qc.getQueryData(UNREAD)).toBe(1);
    expect(qc.getQueryData(CONVERSATIONS).map((c) => c.unreadCount)).toEqual([1, 0]);
    expect(exactReads(invalidate)).toEqual([]);
    unmount();
  });

  it('an UPDATE of read_at patches the row and lowers the counts once', () => {
    const { qc, invalidate, channel, unmount } = mount();
    seed(qc);
    const s1Thread = qc.getQueryData(THREAD_S1);
    const read = { ...n1, read_at: '2026-10-15 09:59:00.5+00' };
    channel().emit('UPDATE', read);
    channel().emit('UPDATE', read);

    expect(qc.getQueryData(THREAD_S2)).toEqual([{ ...n1, read_at: '2026-10-15T09:59:00.5+00:00' }]);
    expect(qc.getQueryData(THREAD_S1)).toBe(s1Thread);
    expect(qc.getQueryData(UNREAD)).toBe(0);
    expect(qc.getQueryData(CONVERSATIONS)[1]).toMatchObject({ otherProfileId: 's2', unreadCount: 0 });
    expect(exactReads(invalidate)).toEqual([]);
    unmount();
  });

  it('the other side reading my message shows in my thread and leaves my counts alone', () => {
    const { qc, channel, unmount } = mount();
    seed(qc);
    channel().emit('UPDATE', { ...m2, read_at: '2026-10-15 09:00:00+00' });
    expect(qc.getQueryData(THREAD_S1)[1].read_at).toBe('2026-10-15T09:00:00+00:00');
    expect(qc.getQueryData(UNREAD)).toBe(1);
    expect(qc.getQueryData(CONVERSATIONS)[0].lastMessage.read_at).toBe('2026-10-15T09:00:00+00:00');
    unmount();
  });

  it('a DELETE removes the message by its id, once, and its conversation falls back on the message before it', () => {
    const { qc, invalidate, channel, unmount } = mount();
    seed(qc);
    // The binding on deletions and both filtered bindings may all hear it.
    const reached = channel().emit('DELETE', { id: 'm2' });
    expect(reached).toBeGreaterThan(1);

    expect(qc.getQueryData(THREAD_S1)).toEqual([m1]);
    expect(qc.getQueryData(CONVERSATIONS)[0]).toMatchObject({ otherProfileId: 's1', lastMessage: m1, unreadCount: 0 });
    expect(qc.getQueryData(UNREAD)).toBe(1);
    expect(exactReads(invalidate)).toEqual([]);
    unmount();
  });

  it('a DELETE of an unread message to me lowers the counts, and a pair left empty leaves the list', () => {
    const { qc, channel, unmount } = mount();
    seed(qc);
    channel().emit('DELETE', { id: 'n1' });
    expect(qc.getQueryData(THREAD_S2)).toEqual([]);
    expect(qc.getQueryData(UNREAD)).toBe(0);
    expect(qc.getQueryData(CONVERSATIONS).map((c) => c.otherProfileId)).toEqual(['s1']);
    unmount();
  });

  it('a DELETE of a message no entry holds reads the counts again, once, by their exact keys', () => {
    const { qc, invalidate, channel, unmount } = mount();
    seed(qc);
    channel().emit('DELETE', { id: 'somebody-elses' });
    channel().emit('DELETE', { id: 'another-one' });
    expect(exactReads(invalidate)).toEqual([UNREAD, CONVERSATIONS]);
    expect(rootReads(invalidate)).toEqual([]);
    unmount();
  });

  it('an INSERT attached to a session is that session\'s feedback, and joins the list of sessions with feedback', () => {
    const { qc, channel, unmount } = mount();
    qc.setQueryData(feedbackKey('sess-1'), null);
    qc.setQueryData(FEEDBACK_IDS, ['sess-0']);
    channel().emit('INSERT', {
      id: 'f1', sender_id: 'coach', recipient_id: 'me', body: 'Good work', session_id: 'sess-1', read_at: null,
      created_at: '2026-10-15 09:00:00+00',
    });
    expect(qc.getQueryData(feedbackKey('sess-1'))).toEqual({
      id: 'f1', sender_id: 'coach', recipient_id: 'me', body: 'Good work', session_id: 'sess-1',
      created_at: '2026-10-15T09:00:00+00:00',
    });
    expect(qc.getQueryData(FEEDBACK_IDS)).toEqual(['sess-0', 'sess-1']);
    // A session whose feedback nobody asked for gets no entry.
    expect(qc.getQueryState(feedbackKey('sess-2'))).toBeUndefined();
    unmount();
  });

  it('a message whose thread is not cached reads the unread count again rather than guessing', () => {
    const { qc, invalidate, channel, unmount } = mount();
    qc.setQueryData(UNREAD, 4);
    channel().emit('INSERT', {
      id: 'f1', sender_id: 'coach', recipient_id: 'me', body: 'x', session_id: null, read_at: null,
      created_at: '2026-10-15 09:00:00+00',
    });
    expect(qc.getQueryData(UNREAD)).toBe(4);
    expect(exactReads(invalidate)).toEqual([UNREAD, CONVERSATIONS]);
    unmount();
  });

  it('a first message from someone the list does not hold reads the conversations again, once for a burst', () => {
    const { qc, invalidate, channel, unmount } = mount();
    seed(qc);
    for (const id of ['p1', 'p2', 'p3']) {
      channel().emit('INSERT', {
        id, sender_id: 's3', recipient_id: 'me', body: id, session_id: null, read_at: null,
        created_at: '2026-10-15 09:00:00+00',
      });
    }
    expect(exactReads(invalidate).filter((key) => key[1] === 'conversations')).toEqual([CONVERSATIONS]);
    unmount();
  });

  it('a thread being read when its event arrives is read again, so the answer cannot drop the message', async () => {
    const { qc, invalidate, channel, unmount } = mount();
    seed(qc);
    let release;
    qc.fetchQuery({
      queryKey: THREAD_S1,
      queryFn: () => new Promise((resolve) => { release = resolve; }),
      staleTime: 0,
    });
    expect(qc.getQueryState(THREAD_S1).fetchStatus).toBe('fetching');
    channel().emit('INSERT', {
      id: 'm3', sender_id: 's1', recipient_id: 'me', body: 'x', session_id: null, read_at: null,
      created_at: '2026-10-15 09:00:00+00',
    });
    // Nobody shows the thread: an invalidation now would be cleared by the
    // answer of the read in flight, sent before m3. It waits for that answer.
    expect(exactReads(invalidate)).not.toContainEqual(THREAD_S1);
    await act(async () => { release([m1, m2]); });
    expect(exactReads(invalidate)).toContainEqual(THREAD_S1);
    expect(qc.getQueryState(THREAD_S1).isInvalidated).toBe(true);
    unmount();
  });

  it('a thread shown on the page, being read when its event arrives, is sent again at once', () => {
    const queryFn = vi.fn(() => new Promise(() => {}));
    const { qc, channel, unmount } = mount(() => useQuery({ queryKey: THREAD_S1, queryFn, staleTime: Infinity }));
    seed(qc);
    act(() => { qc.refetchQueries({ queryKey: THREAD_S1 }); });
    const sent = queryFn.mock.calls.length;
    channel().emit('INSERT', {
      id: 'm3', sender_id: 's1', recipient_id: 'me', body: 'x', session_id: null, read_at: null,
      created_at: '2026-10-15 09:00:00+00',
    });
    expect(qc.getQueryData(THREAD_S1).map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    vi.advanceTimersByTime(REFRESH_DELAY_MS);
    expect(queryFn).toHaveBeenCalledTimes(sent + 1);
    unmount();
  });

  it('a thread whose first read is in flight when its event arrives is read again once that read has answered', async () => {
    const answers = [];
    const queryFn = vi.fn(() => new Promise((resolve) => { answers.push(resolve); }));
    const { qc, channel, unmount } = mount(() => useQuery({ queryKey: THREAD_S1, queryFn, staleTime: Infinity }));
    expect(queryFn).toHaveBeenCalledTimes(1);
    const m3 = { id: 'm3', sender_id: 's1', recipient_id: 'me', body: 'x', session_id: null, read_at: null, created_at: '2026-10-15T09:00:00+00:00' };
    channel().emit('INSERT', { ...m3, created_at: '2026-10-15 09:00:00+00' });

    // An invalidation would only join the read in flight, sent before m3.
    vi.advanceTimersByTime(REFRESH_DELAY_MS);
    expect(queryFn).toHaveBeenCalledTimes(1);
    await act(async () => { answers[0]([m1, m2]); });
    vi.advanceTimersByTime(REFRESH_DELAY_MS);
    expect(queryFn).toHaveBeenCalledTimes(2);
    await act(async () => { answers[1]([m1, m2, m3]); });
    expect(qc.getQueryData(THREAD_S1).map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    unmount();
  });

  it('a conversation list whose first read is in flight is read again for a message its thread places', async () => {
    const answers = [];
    const queryFn = vi.fn(() => new Promise((resolve) => { answers.push(resolve); }));
    const { qc, channel, unmount } = mount(() => useQuery({ queryKey: CONVERSATIONS, queryFn, staleTime: Infinity }));
    qc.setQueryData(THREAD_S1, [m1, m2]);
    qc.setQueryData(UNREAD, 0);
    channel().emit('INSERT', {
      id: 'm3', sender_id: 's1', recipient_id: 'me', body: 'x', session_id: null, read_at: null,
      created_at: '2026-10-15 09:00:00+00',
    });
    expect(qc.getQueryData(UNREAD)).toBe(1);
    await act(async () => { answers[0]([]); });
    vi.advanceTimersByTime(REFRESH_DELAY_MS);
    expect(queryFn).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('a DELETE reads again a thread whose read is in flight: it may answer with the message', async () => {
    const answers = [];
    const queryFn = vi.fn(() => new Promise((resolve) => { answers.push(resolve); }));
    const { qc, channel, unmount } = mount(() => useQuery({ queryKey: THREAD_S2, queryFn, staleTime: Infinity }));
    qc.setQueryData(THREAD_S1, [m1, m2]);
    channel().emit('DELETE', { id: 'n1' });
    await act(async () => { answers[0]([n1]); });
    vi.advanceTimersByTime(REFRESH_DELAY_MS);
    expect(queryFn).toHaveBeenCalledTimes(2);
    await act(async () => { answers[1]([]); });
    expect(qc.getQueryData(THREAD_S2)).toEqual([]);
    unmount();
  });

  it('an entry a resync marked as behind is not patched into looking current', () => {
    const { qc, channel, unmount } = mount();
    seed(qc);
    qc.invalidateQueries({ queryKey: ['messages'], refetchType: 'none' });
    channel().emit('INSERT', {
      id: 'm3', sender_id: 's1', recipient_id: 'me', body: 'x', session_id: null, read_at: null,
      created_at: '2026-10-15 09:00:00+00',
    });
    expect(qc.getQueryData(THREAD_S1)).toEqual([m1, m2]);
    expect(qc.getQueryState(THREAD_S1).isInvalidated).toBe(true);
    expect(qc.getQueryData(UNREAD)).toBe(1);
    unmount();
  });
});

describe('the messages mutations patch the cache instead of reading the root again', () => {
  it('useMarkThreadRead marks the rows it changed, lowers the counts, and the channel\'s echo changes nothing', async () => {
    const select = vi.fn().mockResolvedValue({
      data: [{ id: 'n1', read_at: '2026-10-15T10:00:00+00:00' }],
      error: null,
    });
    const chain = { update: vi.fn(), eq: vi.fn(), is: vi.fn(), select };
    chain.update.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    chain.is.mockReturnValue(chain);
    realtime.from.mockReturnValue(chain);

    const { qc, invalidate, result, channel, unmount } = mount(() => useMarkThreadRead());
    seed(qc);
    await act(async () => {
      await result.current.mutateAsync('s2');
    });

    expect(chain.eq).toHaveBeenCalledWith('sender_id', 's2');
    expect(chain.eq).toHaveBeenCalledWith('recipient_id', 'me');
    expect(select).toHaveBeenCalledWith('id, read_at');
    expect(qc.getQueryData(THREAD_S2)[0].read_at).toBe('2026-10-15T10:00:00+00:00');
    expect(qc.getQueryData(UNREAD)).toBe(0);
    expect(qc.getQueryData(CONVERSATIONS)[1].unreadCount).toBe(0);

    channel().emit('UPDATE', { ...n1, read_at: '2026-10-15 10:00:00+00' });
    expect(qc.getQueryData(UNREAD)).toBe(0);
    expect(rootReads(invalidate)).toEqual([]);
    expect(exactReads(invalidate)).toEqual([]);
    unmount();
  });

  it('useSendMessage puts the row in its thread, once with the channel\'s echo, without reading the root', async () => {
    const row = { id: 'm3', sender_id: 'me', recipient_id: 's1', body: 'sent', session_id: null, read_at: null, created_at: '2026-10-15T09:00:00+00:00' };
    const chain = { insert: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue({ data: row, error: null }) };
    chain.insert.mockReturnValue(chain);
    chain.select.mockReturnValue(chain);
    realtime.from.mockReturnValue(chain);

    const { qc, invalidate, result, channel, unmount } = mount(() => useSendMessage());
    seed(qc);
    await act(async () => {
      await result.current.mutateAsync({ recipientProfileId: 's1', body: 'sent' });
    });
    channel().emit('INSERT', { ...row, created_at: '2026-10-15 09:00:00+00' });

    expect(qc.getQueryData(THREAD_S1).map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(qc.getQueryData(CONVERSATIONS)[0].lastMessage.id).toBe('m3');
    expect(qc.getQueryData(UNREAD)).toBe(1);
    expect(rootReads(invalidate)).toEqual([]);
    expect(exactReads(invalidate)).toEqual([]);
    unmount();
  });

  it('useSendMessage with a session fills the review\'s feedback entry and still flags the session and the feed', async () => {
    const row = { id: 'f1', sender_id: 'me', recipient_id: 's1', body: 'Feedback', session_id: 'sess-1', read_at: null, created_at: '2026-10-15T09:00:00+00:00' };
    const chain = { insert: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue({ data: row, error: null }) };
    chain.insert.mockReturnValue(chain);
    chain.select.mockReturnValue(chain);
    realtime.from.mockReturnValue(chain);

    const { qc, invalidate, result, unmount } = mount(() => useSendMessage());
    qc.setQueryData(feedbackKey('sess-1'), null);
    await act(async () => {
      await result.current.mutateAsync({ recipientProfileId: 's1', body: 'Feedback', sessionId: 'sess-1' });
    });
    expect(qc.getQueryData(feedbackKey('sess-1'))).toMatchObject({ id: 'f1', session_id: 'sess-1' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['all-confirmations'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['session', 'sess-1'] });
    expect(rootReads(invalidate)).toEqual([]);
    unmount();
  });

  it('useDeleteMessage takes the bubble out, and the channel\'s DELETE afterwards asks for nothing', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    realtime.from.mockReturnValue({ delete: vi.fn().mockReturnValue({ eq }) });

    const { qc, invalidate, result, channel, unmount } = mount(() => useDeleteMessage());
    seed(qc);
    await act(async () => {
      await result.current.mutateAsync('m2');
    });
    expect(qc.getQueryData(THREAD_S1)).toEqual([m1]);
    expect(qc.getQueryData(CONVERSATIONS)[0].lastMessage).toEqual(m1);

    channel().emit('DELETE', { id: 'm2' });
    expect(rootReads(invalidate)).toEqual([]);
    expect(exactReads(invalidate)).toEqual([]);
    unmount();
  });
});
