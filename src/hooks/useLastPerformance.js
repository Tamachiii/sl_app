import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import { isoDate } from '../lib/day';
import { buildLastPerformance } from '../lib/lastPerformance';

/**
 * For every exercise in the OPEN session, the student's most recent PRIOR
 * performance of that exercise (the done sets from their latest earlier
 * session). Feeds the "Last time" hint on the logging surface so the student
 * has a target to beat.
 *
 * Student-only surface: the "Students read own set logs" RLS policy already
 * scopes set_logs to the signed-in student, so — unlike the coach-capable
 * useStudentRecords — no students.id resolution or student_id filter is needed.
 * Soft-deleted programs are excluded through the program join.
 *
 * Returns a plain object keyed by exercise_library id (see buildLastPerformance)
 * so the result survives the React Query IndexedDB persister.
 */
export function useLastPerformance(sessionId, slots, currentScheduledDate) {
  const { user } = useAuth();
  const exerciseIds = [
    ...new Set((slots || []).map((s) => s.exercise?.id).filter(Boolean)),
  ].sort();

  return useQuery({
    queryKey: ['last-performance', sessionId, exerciseIds],
    queryFn: async () => {
      if (exerciseIds.length === 0) return {};
      const { data, error } = await supabase
        .from('set_logs')
        .select(`
          set_number, logged_at, target_reps, target_weight_kg, actual_reps, actual_weight_kg,
          exercise_slots!inner(
            exercise_id, session_id,
            sessions!inner(scheduled_date, weeks!inner(programs!inner(deleted_at)))
          )
        `)
        .eq('done', true)
        .in('exercise_slots.exercise_id', exerciseIds)
        .is('exercise_slots.sessions.weeks.programs.deleted_at', null)
        // Most recent first so the 2000-row cap keeps the relevant tail.
        .order('logged_at', { ascending: false })
        .limit(2000);
      if (error) throw error;

      const rows = (data || []).map((l) => ({
        exerciseId: l.exercise_slots?.exercise_id,
        sessionId: l.exercise_slots?.session_id,
        scheduledDate: l.exercise_slots?.sessions?.scheduled_date || null,
        loggedAt: l.logged_at,
        setNumber: l.set_number,
        target_reps: l.target_reps,
        target_weight_kg: l.target_weight_kg,
        actual_reps: l.actual_reps,
        actual_weight_kg: l.actual_weight_kg,
      }));
      return buildLastPerformance(rows, {
        currentSessionId: sessionId,
        // Fall back to today (LOCAL date) when the open session is undated
        // (legacy day_number sessions have no scheduled_date). Without a
        // boundary, a future-scheduled session the student logged ahead would
        // outrank genuine priors and surface as "last time".
        currentScheduledDate: currentScheduledDate || isoDate(new Date()),
      });
    },
    enabled: !!user?.id && !!sessionId && exerciseIds.length > 0,
    staleTime: 1000 * 60,
  });
}
