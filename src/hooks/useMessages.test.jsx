import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// `vi.mock` factories are hoisted to the top of the file, so any variables
// they close over must also be hoisted via `vi.hoisted` (otherwise we hit a
// TDZ "cannot access X before initialization" at import time).
const { mockSupabase } = vi.hoisted(() => ({
  mockSupabase: { from: vi.fn() },
}));

vi.mock('../lib/supabase', () => ({ supabase: mockSupabase }));
vi.mock('./useAuth', () => ({
  useAuth: () => ({ user: { id: 'me' }, profile: { id: 'me' } }),
}));

import { pairKey, formatMessageStamp, useGroupedThread, useConversations, useSendMessage } from './useMessages';

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

describe('useConversations', () => {
  it('rolls up the message list into one row per counterpart, newest-first', async () => {
    const rows = [
      { id: 'm3', sender_id: 'me',  recipient_id: 's1', body: 'latest', read_at: null, created_at: '2026-04-30T12:00:00Z' },
      { id: 'm2', sender_id: 's1',  recipient_id: 'me', body: 'earlier from s1', read_at: null, created_at: '2026-04-30T11:00:00Z' },
      { id: 'm1', sender_id: 's2',  recipient_id: 'me', body: 'older s2', read_at: '2026-04-30T10:30:00Z', created_at: '2026-04-30T10:00:00Z' },
    ];
    const profiles = [
      { id: 's1', full_name: 'Student One', role: 'student' },
      { id: 's2', full_name: 'Student Two', role: 'student' },
    ];

    // Two from() calls happen: messages first, then profiles. Wire them up
    // with a counter so each call returns its own builder.
    let call = 0;
    mockSupabase.from.mockImplementation(() => {
      call += 1;
      if (call === 1) {
        // messages query
        return {
          select: vi.fn().mockReturnThis(),
          or: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({ data: rows, error: null }),
        };
      }
      // profiles query
      return {
        select: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: profiles, error: null }),
      };
    });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useConversations(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
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
