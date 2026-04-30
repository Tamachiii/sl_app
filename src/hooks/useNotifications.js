import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';

const ROOT = 'notifications';
const PAGE_SIZE = 30;

/**
 * Recent notifications for the signed-in user, newest first. Capped at
 * PAGE_SIZE — the bell popover is a "what's new" snapshot, not a full feed.
 * If we ever need pagination we'll add `useNotificationsPage(offset)`.
 */
export function useNotifications() {
  const { user } = useAuth();
  return useQuery({
    queryKey: [ROOT, 'list', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('notifications')
        .select('id, kind, payload, read_at, created_at')
        .eq('recipient_id', user.id)
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE);
      if (error) throw error;
      return data || [];
    },
    enabled: !!user?.id,
  });
}

/** Cheap COUNT(*) for the bell badge. */
export function useUnreadNotificationCount() {
  const { user } = useAuth();
  return useQuery({
    queryKey: [ROOT, 'unread-count', user?.id],
    queryFn: async () => {
      const { count, error } = await supabase
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('recipient_id', user.id)
        .is('read_at', null);
      if (error) throw error;
      return count || 0;
    },
    enabled: !!user?.id,
    staleTime: 30_000,
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (notificationId) => {
      const { error } = await supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', notificationId)
        .eq('recipient_id', user.id)
        .is('read_at', null);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [ROOT] });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('recipient_id', user.id)
        .is('read_at', null);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [ROOT] });
    },
  });
}

/**
 * Single global realtime channel mounted in AppShell. Bails out on
 * CHANNEL_ERROR / TIMED_OUT (e.g. table missing) so we don't loop the
 * handshake — a reload re-attempts the subscription.
 */
export function useNotificationsRealtime() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const me = user?.id;

  useEffect(() => {
    if (!me) return undefined;
    let cancelled = false;
    const channel = supabase
      .channel(`notifications-${me}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notifications' },
        (payload) => {
          if (cancelled) return;
          const row = payload.new || payload.old || {};
          if (row.recipient_id === me) {
            qc.invalidateQueries({ queryKey: [ROOT] });
          }
        },
      )
      .subscribe((status) => {
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
 * Maps a notification row to (i18n key, params, deep-link path). Adding
 * a new kind = adding a new branch here + an i18n key + a DB trigger.
 */
export function describeNotification(notif) {
  if (!notif) return { i18nKey: 'notifications.unknown', params: {}, path: null };
  const p = notif.payload || {};
  switch (notif.kind) {
    case 'session_completed': {
      const path = p.student_row_id && p.session_id
        ? `/coach/student/${p.student_row_id}/session/${p.session_id}/review`
        : null;
      return {
        i18nKey: 'notifications.sessionCompleted',
        params: {
          student: p.student_name || '—',
          session: p.session_title || '—',
        },
        path,
      };
    }
    case 'session_feedback': {
      // Student-side: deep-link straight to the reviewed session in
      // read-only/normal mode (the session view itself decides).
      const path = p.session_id ? `/student/session/${p.session_id}` : null;
      return {
        i18nKey: 'notifications.sessionFeedback',
        params: {
          coach: p.coach_name || '—',
          session: p.session_title || '—',
        },
        path,
      };
    }
    default:
      return {
        i18nKey: 'notifications.unknown',
        params: { kind: notif.kind },
        path: null,
      };
  }
}

/** Same date format helper as messages — short time today, short date else. */
export function formatNotificationStamp(iso, lang = 'en') {
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
