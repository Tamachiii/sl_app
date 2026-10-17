import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The coach's app as the shell mounts it on a launch drawn from the device —
// the session and the role this device remembers, so the pages render before
// auth-js has read the session (hooks/useAuth.jsx): the messages channel of
// AppShell, the unread badge of the nav, the conversation list read through
// my_conversations(), and the thread with one athlete. The realtime client
// and PostgREST are the fakes of src/test, which keep what the real ones keep:
// a join carries the token the client holds when it is sent.

const { realtime, db } = await vi.hoisted(async () => {
  const { createFakeRealtime } = await import('../test/fakeRealtime');
  const fake = createFakeRealtime();
  fake.from = vi.fn();
  fake.rpc = vi.fn();
  return { realtime: fake, db: { messages: [] } };
});
vi.mock('../lib/supabase', () => ({ supabase: realtime }));
vi.mock('./useAuth', () => ({ useAuth: () => ({ user: { id: 'coach' } }) }));

import { fakePostgrest } from '../test/fakePostgrest';
import {
  useConversations,
  useMessageThread,
  useMessagesRealtime,
  useUnreadMessageCount,
} from './useMessages';

const COACH = 'coach';
const ATHLETE = 'athlete';

// PostgREST's form of a timestamptz, and the Postgres text Realtime hands over.
const at = (minute) => `2026-10-17T10:${String(minute).padStart(2, '0')}:00.25+00:00`;
const pgText = (iso) => (iso ? iso.replace('T', ' ').replace('+00:00', '+00') : iso);
const asEvent = (row) => ({ ...row, read_at: pgText(row.read_at), created_at: pgText(row.created_at) });

function message(id, sender, minute, extra = {}) {
  return {
    id,
    sender_id: sender,
    recipient_id: sender === COACH ? ATHLETE : COACH,
    body: `body of ${id}`,
    session_id: null,
    read_at: null,
    created_at: at(minute),
    ...extra,
  };
}

// my_conversations() over the rows of the fake table, as the function answers.
function myConversations() {
  const byOther = new Map();
  const newestFirst = [...db.messages].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  for (const m of newestFirst) {
    const other = m.sender_id === COACH ? m.recipient_id : m.sender_id;
    if (!byOther.has(other)) {
      byOther.set(other, {
        counterpart_id: other, full_name: 'Test Athlete', last_body: m.body, last_at: m.created_at, unread: 0,
        last_id: m.id, last_sender_id: m.sender_id, last_recipient_id: m.recipient_id,
        last_session_id: m.session_id, last_read_at: m.read_at,
      });
    }
    if (m.recipient_id === COACH && !m.read_at) byOther.get(other).unread += 1;
  }
  return [...byOther.values()];
}

function mountCoachShell() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  function Wrapper({ children }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  const view = renderHook(() => {
    useMessagesRealtime();
    return {
      unread: useUnreadMessageCount(),
      conversations: useConversations(),
      thread: useMessageThread(ATHLETE),
    };
  }, { wrapper: Wrapper });
  return { ...view, channel: () => realtime.live().find((c) => c.name.startsWith(`messages-${COACH}`)) };
}

beforeEach(() => {
  realtime.reset();
  db.messages = [
    message('m-old', ATHLETE, 0, { read_at: at(1) }),
    message('m-reply', COACH, 5),
  ];
  const postgrest = fakePostgrest({
    messages: (request) => (request.options?.head
      ? { count: db.messages.filter((m) => m.recipient_id === COACH && !m.read_at).length }
      : { rows: db.messages }),
  });
  realtime.from.mockImplementation(postgrest.from);
  realtime.rpc.mockImplementation(async (name) => (
    name === 'my_conversations' ? { data: myConversations(), error: null } : { data: null, error: { code: 'PGRST202' } }
  ));
});

describe("the coach's messages on a launch drawn from the device", () => {
  it("hear the athlete's message and the athlete reading the coach's reply, though the session is read after the shell has mounted", async () => {
    realtime.launchBeforeSession();
    const { result, channel, unmount } = mountCoachShell();

    // auth-js reads the stored session; then the server answers the join.
    await act(async () => { await realtime.readSession(); });
    act(() => { channel().status('SUBSCRIBED'); });
    await waitFor(() => {
      expect(result.current.unread.data).toBe(0);
      expect(result.current.conversations.data?.[0]?.lastMessage.id).toBe('m-reply');
      expect(result.current.thread.data?.map((m) => m.id)).toEqual(['m-old', 'm-reply']);
    });

    // The athlete writes to the coach: the badge and the list say so.
    const ping = message('m-ping', ATHLETE, 8);
    db.messages.push(ping);
    act(() => { channel().emit('INSERT', asEvent(ping)); });
    await waitFor(() => expect(result.current.unread.data).toBe(1));
    expect(result.current.conversations.data[0]).toMatchObject({
      otherProfileId: ATHLETE,
      unreadCount: 1,
      lastMessage: { id: 'm-ping' },
    });
    expect(result.current.thread.data.map((m) => m.id)).toEqual(['m-old', 'm-reply', 'm-ping']);

    // The athlete opens the thread: the coach's reply shows as read.
    const readAt = at(9);
    db.messages = db.messages.map((m) => (m.id === 'm-reply' ? { ...m, read_at: readAt } : m));
    act(() => { channel().emit('UPDATE', asEvent({ ...message('m-reply', COACH, 5), read_at: readAt })); });
    await waitFor(() => {
      expect(result.current.thread.data.find((m) => m.id === 'm-reply').read_at).toBe(readAt);
    });
    expect(result.current.unread.data).toBe(1);
    unmount();
  });
});
