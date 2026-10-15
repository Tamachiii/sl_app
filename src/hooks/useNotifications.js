import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { watchPostgresChanges } from '../lib/realtimeChannel';
import { createRefresher } from '../lib/realtimeCache';
import {
  NOTIFICATIONS_ROOT as ROOT,
  NOTIFICATIONS_PAGE_SIZE as PAGE_SIZE,
  applyNotificationChange,
  notificationBindings,
  notificationKeys,
} from '../lib/notificationCache';
import { useAuth } from './useAuth';

/**
 * Recent notifications for the signed-in user, newest first. Capped at
 * PAGE_SIZE — the bell popover is a "what's new" snapshot, not a full feed.
 * If we ever need pagination we'll add `useNotificationsPage(offset)`.
 */
export function useNotifications() {
  const { user } = useAuth();
  return useQuery({
    queryKey: notificationKeys.list(user?.id),
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
    queryKey: notificationKeys.unreadCount(user?.id),
    // Pipe React Query's signal through so the HEAD count request aborts
    // cleanly on unmount instead of racing.
    queryFn: async ({ signal }) => {
      const { count, error } = await supabase
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('recipient_id', user.id)
        .is('read_at', null)
        .abortSignal(signal);
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
 * Single global realtime channel mounted in AppShell, on the rows addressed to
 * the signed-in user and on deletions. An event patches the list and the count
 * (`lib/notificationCache`) and reads nothing; a change the cache cannot place
 * reads the count again, by its exact key. The channel survives a dropped
 * connection and a suspended page, and the bell is read again when it is
 * back: see `watchPostgresChanges`.
 */
export function useNotificationsRealtime() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const me = user?.id;

  useEffect(() => {
    if (!me) return undefined;
    const refresher = createRefresher(qc);
    const stop = watchPostgresChanges({
      topic: `notifications-${me}`,
      filters: notificationBindings(me),
      onChange: (payload) => applyNotificationChange(qc, me, payload, refresher.refresh),
      onResync: () => qc.invalidateQueries({ queryKey: [ROOT] }),
    });
    return () => {
      stop();
      refresher.dispose();
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
    case 'session_deviation': {
      // Coach-side: deep-link to the session review, where the Off-plan band
      // shows what the student changed.
      const path = p.student_row_id && p.session_id
        ? `/coach/student/${p.student_row_id}/session/${p.session_id}/review`
        : null;
      return {
        i18nKey: 'notifications.sessionDeviation',
        params: {
          student: p.student_name || '—',
          session: p.session_title || '—',
        },
        path,
      };
    }
    case 'swap_adopted': {
      // Student-side: the coach adopted your swap into the plan. Deep-link to
      // the session it came from.
      const path = p.session_id ? `/student/session/${p.session_id}` : null;
      return {
        i18nKey: 'notifications.swapAdopted',
        params: {
          original: p.original_exercise || '—',
          substitute: p.substitute_exercise || '—',
        },
        path,
      };
    }
    case 'skip_adopted': {
      // Student-side: the coach dropped the exercise from upcoming sessions.
      const path = p.session_id ? `/student/session/${p.session_id}` : null;
      return {
        i18nKey: 'notifications.skipAdopted',
        params: { original: p.original_exercise || '—' },
        path,
      };
    }
    case 'promote_requested': {
      // Coach-side: the student asked to make a deviation permanent. Deep-link
      // to the review, where Adopt / Remove / Decline live.
      const path = p.student_row_id && p.session_id
        ? `/coach/student/${p.student_row_id}/session/${p.session_id}/review`
        : null;
      return {
        i18nKey: 'notifications.promoteRequested',
        params: {
          student: p.student_name || '—',
          session: p.session_title || '—',
        },
        path,
      };
    }
    case 'promote_declined': {
      // Student-side: the coach kept the original prescription.
      const path = p.session_id ? `/student/session/${p.session_id}` : null;
      return {
        i18nKey: 'notifications.promoteDeclined',
        params: { original: p.original_exercise || '—' },
        path,
      };
    }
    case 'program_submitted': {
      // Coach-side: a student submitted a self-authored draft for approval.
      // Deep-link to that athlete's page, where Approve / Send back live in the
      // program menu of the Programming section.
      const path = p.student_row_id
        ? `/coach/students/${p.student_row_id}`
        : null;
      return {
        i18nKey: 'notifications.programSubmitted',
        params: {
          student: p.student_name || '—',
          program: p.program_name || '—',
        },
        path,
      };
    }
    case 'program_approved': {
      // Student-side: the coach approved your draft. It lands approved-but-
      // INACTIVE (the coach activates it separately), so deep-link to the
      // sessions list — which lists every non-deleted program — rather than the
      // home screen, which only renders the active program.
      return {
        i18nKey: 'notifications.programApproved',
        params: { program: p.program_name || '—' },
        path: '/student/sessions',
      };
    }
    case 'program_sent_back': {
      // Student-side: the coach returned the draft for changes.
      return {
        i18nKey: 'notifications.programSentBack',
        params: { program: p.program_name || '—' },
        path: '/student/author',
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
