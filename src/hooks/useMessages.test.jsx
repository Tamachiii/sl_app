import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// `vi.mock` factories are hoisted to the top of the file, so any variables
// they close over must also be hoisted via `vi.hoisted` (otherwise we hit a
// TDZ "cannot access X before initialization" at import time).
const { mockSupabase } = vi.hoisted(() => ({
  mockSupabase: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock('../lib/supabase', () => ({ supabase: mockSupabase }));
vi.mock('./useAuth', () => ({
  useAuth: () => ({ user: { id: 'me' }, profile: { id: 'me' } }),
}));

import { fakePostgrest } from '../test/fakePostgrest';
import { pairKey, formatMessageStamp, useGroupedThread, useMessageThread, useConversations, useSendMessage, useDeleteMessage } from './useMessages';

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return { Wrapper, qc };
}

beforeEach(() => {
  mockSupabase.from.mockReset();
  mockSupabase.rpc.mockReset();
});

describe('pairKey', () => {
  it('returns a deterministic ordering regardless of input order', () => {
    expect(pairKey('b', 'a')).toEqual(['a', 'b']);
    expect(pairKey('a', 'b')).toEqual(['a', 'b']);
  });
  it('returns null when either id is missing', () => {
    expect(pairKey(null, 'a')).toBeNull();
    expect(pairKey('a', null)).toBeNull();
  });
});

describe('formatMessageStamp', () => {
  it('returns empty string for falsy input', () => {
    expect(formatMessageStamp(null)).toBe('');
    expect(formatMessageStamp('')).toBe('');
  });
  it('formats a same-day timestamp as HH:MM', () => {
    const today = new Date();
    today.setHours(14, 30, 0, 0);
    const out = formatMessageStamp(today.toISOString(), 'en');
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe('useGroupedThread', () => {
  it('groups consecutive messages from the same sender', () => {
    const messages = [
      { id: '1', sender_id: 'a', body: 'hi' },
      { id: '2', sender_id: 'a', body: 'how are you' },
      { id: '3', sender_id: 'b', body: 'good' },
      { id: '4', sender_id: 'a', body: 'great' },
    ];
    const { result } = renderHook(() => useGroupedThread(messages));
    expect(result.current).toHaveLength(3);
    expect(result.current[0].senderId).toBe('a');
    expect(result.current[0].messages).toHaveLength(2);
    expect(result.current[1].senderId).toBe('b');
    expect(result.current[2].senderId).toBe('a');
  });
});

describe('useMessageThread', () => {
  it('fetches the NEWEST 500 rows (descending) and reverses to oldest-first for render', async () => {
    // Regression guard: ordering ascending pins the 500-row window to the
    // OLDEST messages, so once a pair passes 500 total, new messages never
    // render again while the unread badge keeps counting them.
    const rows = [
      { id: 'm2', sender_id: 'me', recipient_id: 'r1', body: 'newest', created_at: '2026-07-12T12:00:00Z' },
      { id: 'm1', sender_id: 'r1', recipient_id: 'me', body: 'older', created_at: '2026-07-12T11:00:00Z' },
    ];
    const order = vi.fn().mockReturnThis();
    mockSupabase.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      order,
      limit: vi.fn().mockResolvedValue({ data: rows, error: null }),
    });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useMessageThread('r1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(order).toHaveBeenCalledWith('created_at', { ascending: false });
    // Server returned newest-first; the hook renders oldest-first.
    expect(result.current.data.map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});

describe('useConversations', () => {
  const NO_FUNCTION = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.my_conversations' } };

  it('asks the database for one row per counterpart, and gives the list its shape, newest first', async () => {
    mockSupabase.rpc.mockResolvedValue({
      data: [
        {
          counterpart_id: 's2', full_name: 'Student Two', role: 'student',
          last_id: 'm1', last_sender_id: 's2', last_recipient_id: 'me', last_body: 'older s2',
          last_session_id: null, last_read_at: '2026-04-30T10:30:00Z', last_at: '2026-04-30T10:00:00Z', unread: 0,
        },
        {
          counterpart_id: 's1', full_name: 'Student One', role: 'student',
          last_id: 'm3', last_sender_id: 'me', last_recipient_id: 's1', last_body: 'latest',
          last_session_id: null, last_read_at: null, last_at: '2026-04-30T12:00:00Z', unread: '1',
        },
      ],
      error: null,
    });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useConversations(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockSupabase.rpc).toHaveBeenCalledWith('my_conversations');
    expect(mockSupabase.from).not.toHaveBeenCalled();
    expect(result.current.data).toEqual([
      {
        otherProfileId: 's1',
        otherFullName: 'Student One',
        otherRole: 'student',
        lastMessage: {
          id: 'm3', sender_id: 'me', recipient_id: 's1', body: 'latest',
          session_id: null, read_at: null, created_at: '2026-04-30T12:00:00Z',
        },
        // A bigint may travel as a string.
        unreadCount: 1,
      },
      {
        otherProfileId: 's2',
        otherFullName: 'Student Two',
        otherRole: 'student',
        lastMessage: {
          id: 'm1', sender_id: 's2', recipient_id: 'me', body: 'older s2',
          session_id: null, read_at: '2026-04-30T10:30:00Z', created_at: '2026-04-30T10:00:00Z',
        },
        unreadCount: 0,
      },
    ]);
  });

  it('keeps a row that names only the counterpart, the last body, its time and the unread count', async () => {
    mockSupabase.rpc.mockResolvedValue({
      data: [{ counterpart_id: 's1', full_name: 'Student One', last_body: 'hey', last_at: '2026-04-30T12:00:00Z', unread: 2 }],
      error: null,
    });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useConversations(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([
      {
        otherProfileId: 's1',
        otherFullName: 'Student One',
        otherRole: null,
        lastMessage: {
          id: null, sender_id: null, recipient_id: null, body: 'hey',
          session_id: null, read_at: null, created_at: '2026-04-30T12:00:00Z',
        },
        unreadCount: 2,
      },
    ]);
  });

  it('rolls up the messages itself when the database has no such function', async () => {
    mockSupabase.rpc.mockResolvedValue(NO_FUNCTION);
    const db = fakePostgrest({
      messages: [
        { id: 'm3', sender_id: 'me',  recipient_id: 's1', body: 'latest', session_id: null, read_at: null, created_at: '2026-04-30T12:00:00Z' },
        { id: 'm2', sender_id: 's1',  recipient_id: 'me', body: 'earlier from s1', session_id: null, read_at: null, created_at: '2026-04-30T11:00:00Z' },
        { id: 'm1', sender_id: 's2',  recipient_id: 'me', body: 'older s2', session_id: null, read_at: '2026-04-30T10:30:00Z', created_at: '2026-04-30T10:00:00Z' },
      ],
      profiles: [
        { id: 's1', full_name: 'Student One', role: 'student' },
        { id: 's2', full_name: 'Student Two', role: 'student' },
      ],
    });
    mockSupabase.from.mockImplementation(db.from);

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useConversations(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [read] = db.requestsTo('messages');
    expect(read.select).toBe('id, sender_id, recipient_id, body, session_id, read_at, created_at');
    expect(read.filters).toContainEqual(['or', 'sender_id.eq.me,recipient_id.eq.me']);
    expect(db.requestsTo('profiles')[0].filters).toContainEqual(['in', 'id', ['s1', 's2']]);

    const data = result.current.data;
    expect(data).toHaveLength(2);
    // s1 conversation is newest (m3 at 12:00).
    expect(data[0].otherProfileId).toBe('s1');
    expect(data[0].otherFullName).toBe('Student One');
    expect(data[0].lastMessage.id).toBe('m3');
    // s1 has one unread (m2 was sent to me, not yet read).
    expect(data[0].unreadCount).toBe(1);
    // s2 has no unread (read_at was set).
    expect(data[1].otherProfileId).toBe('s2');
    expect(data[1].unreadCount).toBe(0);
  });

  // Review item L18: the list was the newest 2000 messages, which PostgREST
  // answers with 1000. A conversation older than the account's thousand
  // newest messages was not in the list, nor were its unread messages.
  it('keeps a conversation that sits behind 1,300 newer messages, with its unread count', async () => {
    mockSupabase.rpc.mockResolvedValue(NO_FUNCTION);
    const at = (minutes) => new Date(Date.UTC(2026, 3, 1) + minutes * 60_000).toISOString();
    const recent = Array.from({ length: 1300 }, (_, i) => ({
      id: `m-${String(i + 100).padStart(5, '0')}`,
      sender_id: i % 2 ? 'me' : 's1',
      recipient_id: i % 2 ? 's1' : 'me',
      body: `chat ${i}`,
      session_id: null,
      read_at: '2026-05-01T00:00:00Z',
      created_at: at(1000 + i),
    }));
    const old = [
      { id: 'm-00001', sender_id: 's-old', recipient_id: 'me', body: 'are you there?', session_id: null, read_at: null, created_at: at(1) },
      { id: 'm-00002', sender_id: 's-old', recipient_id: 'me', body: 'hello?', session_id: null, read_at: null, created_at: at(2) },
    ];
    const db = fakePostgrest({
      messages: [...recent, ...old],
      profiles: [
        { id: 's1', full_name: 'Student One', role: 'student' },
        { id: 's-old', full_name: 'Quiet Athlete', role: 'student' },
      ],
    });
    mockSupabase.from.mockImplementation(db.from);

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useConversations(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(db.requestsTo('messages')).toHaveLength(2);
    expect(result.current.data.map((c) => [c.otherProfileId, c.unreadCount, c.lastMessage.body])).toEqual([
      ['s1', 0, 'chat 1299'],
      ['s-old', 2, 'hello?'],
    ]);
  });

  it('fails on any other error, and reads nothing else', async () => {
    mockSupabase.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'permission denied' } });
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useConversations(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });
});

describe('useSendMessage', () => {
  it('inserts a message with sender_id from auth and trimmed body', async () => {
    const insert = vi.fn().mockReturnThis();
    const select = vi.fn().mockReturnThis();
    const single = vi.fn().mockResolvedValue({
      data: { id: 'm1', sender_id: 'me', recipient_id: 'r1', body: 'hello', read_at: null, created_at: 'now' },
      error: null,
    });
    mockSupabase.from.mockReturnValue({ insert, select, single });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useSendMessage(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({ recipientProfileId: 'r1', body: '  hello  ' });
    });

    expect(mockSupabase.from).toHaveBeenCalledWith('messages');
    expect(insert).toHaveBeenCalledWith({
      sender_id: 'me',
      recipient_id: 'r1',
      body: 'hello',
    });
  });

  it('rejects an empty body without hitting the network', async () => {
    mockSupabase.from.mockReturnValue({ insert: vi.fn() });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useSendMessage(), { wrapper: Wrapper });

    await expect(
      result.current.mutateAsync({ recipientProfileId: 'r1', body: '   ' }),
    ).rejects.toThrow(/empty/i);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });
});

describe('useDeleteMessage', () => {
  it('issues a DELETE filtered by the message id', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const del = vi.fn().mockReturnValue({ eq });
    mockSupabase.from.mockReturnValue({ delete: del });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useDeleteMessage(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync('m42');
    });

    expect(mockSupabase.from).toHaveBeenCalledWith('messages');
    expect(del).toHaveBeenCalled();
    expect(eq).toHaveBeenCalledWith('id', 'm42');
  });

  it('rejects without an id and never hits the network', async () => {
    mockSupabase.from.mockReturnValue({ delete: vi.fn() });
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useDeleteMessage(), { wrapper: Wrapper });

    await expect(result.current.mutateAsync(null)).rejects.toThrow(/missing/i);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });
});
