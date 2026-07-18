import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import { buildRecords } from '../lib/records';

const RECENT_WINDOW_DAYS = 14;

/**
 * All-time personal records per exercise. Fetches every DONE set_log with its
 * exercise + logged_at, filtered THROUGH the program join (never an unbounded
 * id-list), and reduces them via lib/records.buildRecords. Records set within
 * the last two weeks are flagged `recent` so the UI can celebrate a fresh PR.
 *
 * `studentRowId` follows the same convention as useStudentProgressStats: the
 * coach passes the STUDENTS-table id directly; the student flow omits it and
 * we resolve it from the signed-in profile (programs.student_id references
 * students.id, NOT profiles.id).
 *
 * Note: uses the same effective-load model as the stats charts — an exercise
 * SWAP still attributes to the original exercise. useStudentProgressStats is
 * now swap-aware, but records/last-performance are not yet — a separate
 * follow-up (each would need its own slot_deviations join).
 */
export function useStudentRecords(studentRowId) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['student-records', studentRowId ?? user?.id],
    queryFn: async () => {
      let resolvedId = studentRowId;
      if (!resolvedId) {
        // maybeSingle (not single): an unlinked/coach-less student has no
        // students row — that's an empty-records state, not a throw + retry
        // storm.
        const { data: student, error: sErr } = await supabase
          .from('students')
          .select('id')
          .eq('profile_id', user.id)
          .maybeSingle();
        if (sErr) throw sErr;
        if (!student) return [];
        resolvedId = student.id;
      }

      const { data, error } = await supabase
        .from('set_logs')
        .select(`
          done, logged_at, target_reps, target_weight_kg, actual_reps, actual_weight_kg,
          exercise_slots!inner(
            exercise:exercise_library!inner(id, name, type),
            sessions!inner(weeks!inner(programs!inner(student_id, deleted_at)))
          )
        `)
        .eq('done', true)
        .eq('exercise_slots.sessions.weeks.programs.student_id', resolvedId)
        .is('exercise_slots.sessions.weeks.programs.deleted_at', null)
        .limit(20000);
      if (error) throw error;

      // Lift the embedded exercise up onto each log for buildRecords.
      const logs = (data || []).map((l) => ({
        done: l.done,
        logged_at: l.logged_at,
        target_reps: l.target_reps,
        target_weight_kg: l.target_weight_kg,
        actual_reps: l.actual_reps,
        actual_weight_kg: l.actual_weight_kg,
        exercise: l.exercise_slots?.exercise || null,
      }));

      const recentSince = new Date();
      recentSince.setDate(recentSince.getDate() - RECENT_WINDOW_DAYS);
      return buildRecords(logs, { recentSince });
    },
    enabled: !!(studentRowId || user?.id),
    staleTime: 1000 * 60,
  });
}
