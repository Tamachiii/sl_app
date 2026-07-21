import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import { MUTATION_KEYS, MUTATION_FNS } from '../lib/offlineMutations';

/**
 * Fetch the confirmation (if any) for a single session.
 * Returns `null` when the session hasn't been confirmed yet.
 */
export function useSessionConfirmation(sessionId) {
  return useQuery({
    queryKey: ['session-confirmation', sessionId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('session_confirmations')
        .select('*')
        .eq('session_id', sessionId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!sessionId,
  });
}

/**
 * Coach-facing: every confirmed session across the coach's students, newest
 * first. RLS scopes confirmations to this coach's students automatically.
 *
 * One embedded-join query, filtered THROUGH the session→week→program→student
 * chain — NOT the old "fetch every program tree ever, then .in(all session
 * ids)" pattern, whose GET URL grew ~37 bytes per session and hard-failed
 * (URL too long) after a few hundred accumulated sessions. This scales with
 * the number of CONFIRMATIONS, not lifetime session count, and never builds
 * an id list.
 */
export function useAllConfirmations() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['all-confirmations', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('session_confirmations')
        .select(`
          id, session_id, student_id, confirmed_at, notes,
          session:sessions!inner(
            title, day_number, archived_at, reviewed_at,
            week:weeks!inner(
              week_number, label,
              program:programs!inner(
                deleted_at,
                student:students!inner(
                  id,
                  profile:profiles!students_profile_id_fkey(full_name)
                )
              )
            )
          )
        `)
        // Trashed programs' confirmations drop out of the feed.
        .is('session.week.program.deleted_at', null)
        .order('confirmed_at', { ascending: false });
      if (error) throw error;

      // Flatten to the shape SessionsFeed / CoachDashboard already consume.
      return (data || []).map((c) => {
        const s = c.session;
        const w = s?.week;
        const prog = w?.program;
        const student = prog?.student;
        return {
          id: c.id,
          session_id: c.session_id,
          confirmed_at: c.confirmed_at,
          notes: c.notes,
          session_title: s?.title,
          day_number: s?.day_number,
          archived_at: s?.archived_at,
          reviewed_at: s?.reviewed_at,
          week_number: w?.week_number,
          week_label: w?.label,
          student_id: student?.id,
          student_name: student?.profile?.full_name || 'Student',
        };
      });
    },
    enabled: !!user?.id,
  });
}

/**
 * Lightweight query: the set of session ids that the current student has
 * confirmed. Cheap to check from the StudentHome list.
 */
export function useMyConfirmedSessionIds() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-confirmed-session-ids', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('session_confirmations')
        .select('session_id')
        .eq('student_id', user.id);
      if (error) throw error;
      // Cache a plain ARRAY (survives JSON persistence to IndexedDB — a Set
      // would silently dehydrate to {}); `select` below hands consumers the
      // Set they expect. Without persisted confirmations an offline cold
      // start would regress Home to week 1 and misreport adherence.
      return (data || []).map((r) => r.session_id);
    },
    select: (ids) => new Set(ids),
    enabled: !!user?.id,
  });
}

/**
 * Coach-facing: which sessions in a given week have been confirmed.
 */
export function useWeekConfirmedSessionIds(weekId) {
  return useQuery({
    queryKey: ['week-confirmed-session-ids', weekId],
    queryFn: async () => {
      // Filter THROUGH the session join rather than fetching the week's
      // session ids and feeding them back as an `.in(...)` list — same reason
      // as useAllConfirmations, and it halves the round trips.
      const { data, error } = await supabase
        .from('session_confirmations')
        .select('session_id, sessions!inner(week_id)')
        .eq('sessions.week_id', weekId);
      if (error) throw error;
      // Cache a plain ARRAY, not a Set: a Set dehydrates to {} through the
      // persister. `select` hands consumers the Set they expect.
      return (data || []).map((c) => c.session_id);
    },
    select: (ids) => new Set(ids),
    enabled: !!weekId,
  });
}

function invalidateConfirmationQueries(qc) {
  qc.invalidateQueries({ queryKey: ['session-confirmation'] });
  qc.invalidateQueries({ queryKey: ['my-confirmed-session-ids'] });
  qc.invalidateQueries({ queryKey: ['week-confirmed-session-ids'] });
  // Confirming is what moves adherence, tonnage and lifetime totals. Those
  // three queries reduce over set_logs INSIDE their queryFn, so nothing about
  // their keys changes when a session is confirmed and they would otherwise
  // sit on pre-confirmation numbers until their staleTime expired. Session
  // confirmation is the right chokepoint for this — deviation and set-log
  // writes fire mid-workout and would re-trigger the same heavy scans on
  // every tap.
  qc.invalidateQueries({ queryKey: ['student-progress-stats'] });
  qc.invalidateQueries({ queryKey: ['student-records'] });
  qc.invalidateQueries({ queryKey: ['student-lifetime-stats'] });
}

export function useConfirmSession() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const studentId = user?.id;

  // Wrap the inner mutate so callers don't have to pass studentId (still
  // serialized into the persisted variables so a resumed-after-reload mutation
  // has every field it needs without re-reading from useAuth).
  const m = useMutation({
    mutationKey: MUTATION_KEYS.confirmSession,
    mutationFn: MUTATION_FNS.confirmSession,
    onMutate: async ({ sessionId, studentId: sid, notes }) => {
      await qc.cancelQueries({ queryKey: ['session-confirmation', sessionId] });
      const previous = qc.getQueryData(['session-confirmation', sessionId]);
      qc.setQueryData(['session-confirmation', sessionId], {
        session_id: sessionId,
        student_id: sid,
        notes: notes || null,
        confirmed_at: new Date().toISOString(),
      });
      return { previous, sessionId };
    },
    onError: (_err, _vars, context) => {
      if (context?.sessionId) {
        qc.setQueryData(['session-confirmation', context.sessionId], context.previous);
      }
    },
    onSettled: () => invalidateConfirmationQueries(qc),
  });
  return {
    ...m,
    mutate: (vars, options) => m.mutate({ ...vars, studentId }, options),
    mutateAsync: (vars, options) => m.mutateAsync({ ...vars, studentId }, options),
  };
}

export function useUnconfirmSession() {
  const qc = useQueryClient();

  return useMutation({
    mutationKey: MUTATION_KEYS.unconfirmSession,
    mutationFn: MUTATION_FNS.unconfirmSession,
    onMutate: async ({ sessionId }) => {
      await qc.cancelQueries({ queryKey: ['session-confirmation', sessionId] });
      const previous = qc.getQueryData(['session-confirmation', sessionId]);
      qc.setQueryData(['session-confirmation', sessionId], null);
      return { previous, sessionId };
    },
    onError: (_err, _vars, context) => {
      if (context?.sessionId) {
        qc.setQueryData(['session-confirmation', context.sessionId], context.previous);
      }
    },
    onSettled: () => invalidateConfirmationQueries(qc),
  });
}
