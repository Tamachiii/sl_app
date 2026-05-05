import { useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';

// Stable key prefix so realtime updates can blast the whole subtree.
const MESSAGES_ROOT = 'messages';

/**
 * Build the (a,b)-symmetric pair key used for the thread query: order the two
 * uuids deterministically so /coach→student and /student→coach share the
 * same cache entry.
 */
export function pairKey(a, b) {
  if (!a || !b) return null;
  return a < b ? [a, b] : [b, a];
}

/**
 * Full thread between the signed-in user and `otherProfileId`, oldest first.
 * Server returns newest-first; we reverse client-side so the composer
 * naturally appends to the bottom.
 */
export function useMessageThread(otherProfileId) {
  const { user } = useAuth();
  const me = user?.id;
  return useQuery({
    queryKey: [MESSAGES_ROOT, 'thread', ...(pairKey(me, otherProfileId) || [me, otherProfileId])],
    queryFn: async () => {
      const orFilter = `and(sender_id.eq.${me},recipient_id.eq.${otherProfileId}),and(sender_id.eq.${otherProfileId},recipient_id.eq.${me})`;
      const { data, error } = await supabase
        .from('messages')
        .select('id, sender_id, recipient_id, body, session_id, read_at, created_at')
        .or(orFilter)
        .order('created_at', { ascending: true })
        .limit(500);
      if (error) throw error;
      return data || [];
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
    queryKey: [MESSAGES_ROOT, 'conversations', me],
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
        .sort(
          (a, b) =>
            new Date(b.lastMessage.created_at).getTime()
            - new Date(a.lastMessage.created_at).getTime(),
        );
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
    queryKey: [MESSAGES_ROOT, 'unread-count', me],
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [MESSAGES_ROOT] });
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
    queryKey: [MESSAGES_ROOT, 'session-feedback', sessionId],
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
 * scopes the update to messages I'm allowed to flip.
 */
export function useMarkThreadRead() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (otherProfileId) => {
      const { error } = await supabase
        .from('messages')
        .update({ read_at: new Date().toISOString() })
        .eq('sender_id', otherProfileId)
        .eq('recipient_id', user.id)
        .is('read_at', null);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [MESSAGES_ROOT] });
    },
  });
}

/**
 * Subscribe to realtime INSERT/UPDATE on `messages`. On an event that touches
 * the signed-in user (as sender or recipient), invalidate the thread + roll-
 * up + unread queries so the UI re-renders.
 *
 * Mounted once at the app shell so a single channel serves every page that
 * cares about messages — avoids subscription churn on route changes. If the
 * channel can't subscribe (e.g. the table isn't in the publication yet
 * because the migration hasn't been applied), we tear it down — otherwise
 * the channel client would retry forever.
 */
export function useMessagesRealtime() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const me = user?.id;

  useEffect(() => {
    if (!me) return undefined;
    let cancelled = false;
    const channel = supabase
      .channel(`messages-${me}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          if (cancelled) return;
          const m = payload.new || {};
          if (m.sender_id === me || m.recipient_id === me) {
            qc.invalidateQueries({ queryKey: [MESSAGES_ROOT] });
          }
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages' },
        (payload) => {
          if (cancelled) return;
          const m = payload.new || payload.old || {};
          if (m.sender_id === me || m.recipient_id === me) {
            qc.invalidateQueries({ queryKey: [MESSAGES_ROOT] });
          }
        },
      )
      .subscribe((status) => {
        // Bail out on hard errors so we don't retry the channel handshake in
        // a loop. A reload will re-attempt subscription.
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          cancelled = true;
          supabase.removeChannel(channel);
        }
      });

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
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
