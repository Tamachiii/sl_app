import { useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { watchPostgresChanges } from '../lib/realtimeChannel';
import { createRefresher } from '../lib/realtimeCache';
import {
  MESSAGES_ROOT,
  THREAD_LIMIT,
  applyMessageChange,
  applyMessageDelete,
  applyMessageUpsert,
  compareConversations,
  messageBindings,
  messageKeys,
} from '../lib/messageCache';
import { useAuth } from './useAuth';

export { pairKey } from '../lib/messageCache';

/**
 * Full thread between the signed-in user and `otherProfileId`, oldest first.
 * Server returns newest-first; we reverse client-side so the composer
 * naturally appends to the bottom.
 */
export function useMessageThread(otherProfileId) {
  const { user } = useAuth();
  const me = user?.id;
  return useQuery({
    queryKey: messageKeys.thread(me, otherProfileId),
    queryFn: async () => {
      const orFilter = `and(sender_id.eq.${me},recipient_id.eq.${otherProfileId}),and(sender_id.eq.${otherProfileId},recipient_id.eq.${me})`;
      const { data, error } = await supabase
        .from('messages')
        .select('id, sender_id, recipient_id, body, session_id, read_at, created_at')
        .or(orFilter)
        .order('created_at', { ascending: false })
        .limit(THREAD_LIMIT);
      if (error) throw error;
      // Newest-first from the server so the window keeps the LATEST 500 rows
      // of a long thread (ascending would pin it to the oldest 500 forever);
      // reversed so render order stays oldest-first.
      return (data || []).reverse();
    },
    enabled: !!me && !!otherProfileId,
  });
}

/**
 * All conversations the signed-in user is part of, one row per counterpart.
 * Returns `[{ otherProfileId, otherFullName, lastMessage, unreadCount }]`
 * sorted newest-first by last message.
 *
 * Implementation detail: pulls every message touching me, then folds in JS.
 * Acceptable for the volumes coaches see (a coach with 50 students chatting
 * heavily still produces well under 10k rows). If the table grows, swap this
 * for a SQL view or RPC that returns the rollup.
 */
export function useConversations() {
  const { user } = useAuth();
  const me = user?.id;
  return useQuery({
    queryKey: messageKeys.conversations(me),
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from('messages')
        .select('id, sender_id, recipient_id, body, session_id, read_at, created_at')
        .or(`sender_id.eq.${me},recipient_id.eq.${me}`)
        .order('created_at', { ascending: false })
        .limit(2000);
      if (error) throw error;

      const byOther = new Map();
      for (const m of rows || []) {
        const other = m.sender_id === me ? m.recipient_id : m.sender_id;
        let conv = byOther.get(other);
        if (!conv) {
          conv = { otherProfileId: other, lastMessage: m, unreadCount: 0 };
          byOther.set(other, conv);
        }
        if (m.recipient_id === me && !m.read_at) conv.unreadCount += 1;
      }
      const otherIds = Array.from(byOther.keys());
      if (otherIds.length === 0) return [];

      const { data: profiles, error: pErr } = await supabase
        .from('profiles')
        .select('id, full_name, role')
        .in('id', otherIds);
      if (pErr) throw pErr;
      const byProfile = new Map((profiles || []).map((p) => [p.id, p]));

      return Array.from(byOther.values())
        .map((c) => ({
          ...c,
          otherFullName: byProfile.get(c.otherProfileId)?.full_name || null,
          otherRole: byProfile.get(c.otherProfileId)?.role || null,
        }))
        .sort(compareConversations);
    },
    enabled: !!me,
  });
}

/**
 * Lightweight unread-total query for the nav-tab badge. Counts rows where I am
 * the recipient and `read_at IS NULL`.
 */
export function useUnreadMessageCount() {
  const { user } = useAuth();
  const me = user?.id;
  return useQuery({
    queryKey: messageKeys.unreadCount(me),
    // `signal` from React Query lets us cancel the HEAD request cleanly when
    // the consumer unmounts or the route changes — supabase-js honors the
    // AbortSignal and aborts the underlying fetch instead of letting it
    // race in the background.
    queryFn: async ({ signal }) => {
      const { count, error } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('recipient_id', me)
        .is('read_at', null)
        .abortSignal(signal);
      if (error) throw error;
      return count || 0;
    },
    enabled: !!me,
    staleTime: 30_000,
  });
}

export function useSendMessage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    // The composers render their own inline send error — don't also toast.
    meta: { skipErrorToast: true },
    mutationFn: async ({ recipientProfileId, body, sessionId = null }) => {
      const trimmed = (body || '').trim();
      if (!trimmed) throw new Error('Message body is empty.');
      const row = {
        sender_id: user.id,
        recipient_id: recipientProfileId,
        body: trimmed,
      };
      // Only attach session_id when set — keeps the row payload identical to
      // pre-feedback inserts for ordinary chat messages and lets the test
      // suite continue asserting the unattached shape.
      if (sessionId) row.session_id = sessionId;
      const { data, error } = await supabase
        .from('messages')
        .insert(row)
        .select('id, sender_id, recipient_id, body, session_id, read_at, created_at')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      // The new row goes into the entries that show it — its thread, the
      // conversation list, the session's feedback — where the channel puts it
      // too; nothing under the messages root is read again for it.
      const refresher = createRefresher(qc);
      applyMessageUpsert(qc, user.id, data, { insert: true, refresh: refresher.refresh });
      refresher.flush();
      // A session-attached message IS the coach's session feedback: the review
      // screen and the Confirmed feed both key off "has feedback", so they go
      // stale on send.
      if (data?.session_id) {
        qc.invalidateQueries({ queryKey: ['all-confirmations'] });
        qc.invalidateQueries({ queryKey: ['session', data.session_id] });
      }
    },
  });
}

/**
 * Delete a message the signed-in user sent. RLS only permits this when
 * sender_id = auth.uid() AND session_id IS NULL — coach session-feedback rows
 * stay pinned (see schema.sql: "Sender deletes own message"). On success the
 * bubble leaves the cached thread here, and the other side's through the
 * channel's binding on deletions.
 */
export function useDeleteMessage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (messageId) => {
      if (!messageId) throw new Error('Missing message id.');
      const { error } = await supabase.from('messages').delete().eq('id', messageId);
      if (error) throw error;
      return messageId;
    },
    onSuccess: (messageId) => {
      const refresher = createRefresher(qc);
      applyMessageDelete(qc, user.id, messageId, { refresh: refresher.refresh });
      refresher.flush();
    },
  });
}

/**
 * Fetch the (at most one) coach-feedback message attached to `sessionId`, or
 * null if none exists. Used by SessionReview to swap the composer for a
 * read-only "feedback sent" card so the coach can't submit twice.
 *
 * Why a `messages` lookup is sufficient: the INSERT policy on `messages`
 * permits `session_id IS NOT NULL` only when sender = that session's coach
 * and recipient = its student, and a UNIQUE partial index on `session_id`
 * caps it to one row. So a hit here is, by construction, the coach's
 * feedback for this session.
 */
export function useSessionFeedback(sessionId) {
  return useQuery({
    queryKey: messageKeys.sessionFeedback(sessionId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('messages')
        .select('id, sender_id, recipient_id, body, session_id, created_at')
        .eq('session_id', sessionId)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data || null;
    },
    enabled: !!sessionId,
  });
}

/**
 * Set of session_ids the signed-in student has received coach feedback on.
 * RLS already scopes `messages` to the pair, and the UNIQUE partial index on
 * `session_id WHERE session_id IS NOT NULL` makes this a 1:1 lookup. Used by
 * the Sessions list / Home next-up card to render a "Feedback" badge so the
 * student can spot which sessions have a follow-up to read.
 */
export function useMyFeedbackSessionIds() {
  const { user } = useAuth();
  const me = user?.id;
  return useQuery({
    queryKey: messageKeys.feedbackSessionIds(me),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('messages')
        .select('session_id')
        .eq('recipient_id', me)
        .not('session_id', 'is', null);
      if (error) throw error;
      // Plain array in the cache (a Set dehydrates to {} through the
      // persister); `select` hands consumers the Set.
      return (data || []).map((r) => r.session_id);
    },
    select: (ids) => new Set(ids),
    enabled: !!me,
  });
}

/**
 * Fetch lightweight session metadata (title, scheduled_date) for the unique
 * `session_id`s referenced by visible feedback messages. Returns a Map keyed
 * by session id — empty map until the query resolves. The thread query
 * already has session_id; this hook fills in the title/date the reference
 * card needs without round-tripping a full session payload.
 */
export function useSessionRefsForMessages(messages) {
  const ids = useMemo(() => {
    const set = new Set();
    for (const m of messages || []) {
      if (m.session_id) set.add(m.session_id);
    }
    return Array.from(set).sort();
  }, [messages]);

  const { data } = useQuery({
    queryKey: [MESSAGES_ROOT, 'session-refs', ids],
    queryFn: async () => {
      if (ids.length === 0) return [];
      const { data: rows, error } = await supabase
        .from('sessions')
        .select('id, title, scheduled_date, archived_at, day_number')
        .in('id', ids);
      if (error) throw error;
      return rows || [];
    },
    enabled: ids.length > 0,
    staleTime: 60_000,
  });

  return useMemo(() => {
    const map = new Map();
    for (const r of data || []) map.set(r.id, r);
    return map;
  }, [data]);
}

/**
 * Mark every message in the thread between me and `otherProfileId` (where I
 * am the recipient and read_at is null) as read. Single round-trip — RLS
 * scopes the update to messages I'm allowed to flip — which answers with the
 * rows it changed: they are marked read in the cache, the thread and both
 * counts, and nothing is read again. The channel brings the same rows as N
 * events, which then change nothing.
 */
export function useMarkThreadRead() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (otherProfileId) => {
      const { data, error } = await supabase
        .from('messages')
        .update({ read_at: new Date().toISOString() })
        .eq('sender_id', otherProfileId)
        .eq('recipient_id', user.id)
        .is('read_at', null)
        .select('id, read_at');
      if (error) throw error;
      return data || [];
    },
    onSuccess: (rows, otherProfileId) => {
      const refresher = createRefresher(qc);
      for (const row of rows) {
        applyMessageUpsert(
          qc,
          user.id,
          { ...row, sender_id: otherProfileId, recipient_id: user.id },
          { insert: false, refresh: refresher.refresh },
        );
      }
      refresher.flush();
    },
  });
}

/**
 * Subscribe to realtime changes on `messages`: the rows the signed-in user
 * receives, the rows they send, and deletions (`messageBindings`). An event
 * patches the entries that show its message — its pair's thread, the
 * conversation list, the unread count, the session's feedback — and reads
 * nothing (`lib/messageCache`); a change the cache cannot place reads the
 * counts again, by their exact keys, once for a burst.
 *
 * Mounted once at the app shell so a single channel serves every page that
 * cares about messages — avoids subscription churn on route changes. The
 * channel survives a dropped connection and a suspended page, and the
 * messages root is read again when it is back: see `watchPostgresChanges`.
 */
export function useMessagesRealtime() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const me = user?.id;

  useEffect(() => {
    if (!me) return undefined;
    const refresher = createRefresher(qc);
    const stop = watchPostgresChanges({
      topic: `messages-${me}`,
      filters: messageBindings(me),
      onChange: (payload) => applyMessageChange(qc, me, payload, refresher.refresh),
      // The session titles under the root are read from `sessions`, which no
      // message event changes.
      onResync: () => qc.invalidateQueries({
        queryKey: [MESSAGES_ROOT],
        predicate: (query) => query.queryKey[1] !== 'session-refs',
      }),
    });
    return () => {
      stop();
      refresher.dispose();
    };
  }, [me, qc]);
}

/**
 * Convenience: format a created_at timestamp for thread bubbles. Same-day
 * → HH:MM, otherwise short date.
 */
export function formatMessageStamp(iso, lang = 'en') {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear()
    && d.getMonth() === today.getMonth()
    && d.getDate() === today.getDate();
  const locale = lang === 'fr' ? 'fr-FR' : lang === 'de' ? 'de-DE' : 'en-US';
  return sameDay
    ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

/**
 * Group a thread's messages into runs by sender (no day-break logic — the
 * thread feed is short enough that bubble color + name plus per-message stamp
 * is enough). Returns memoizable shape so consumers don't recompute.
 */
export function useGroupedThread(messages) {
  return useMemo(() => {
    const groups = [];
    let current = null;
    for (const m of messages || []) {
      if (!current || current.senderId !== m.sender_id) {
        current = { senderId: m.sender_id, messages: [m] };
        groups.push(current);
      } else {
        current.messages.push(m);
      }
    }
    return groups;
  }, [messages]);
}
