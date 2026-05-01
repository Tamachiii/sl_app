import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';

/**
 * Returns the signed-in student's all-time totals for the Profile page:
 *   - sessionsCompleted: count of `session_confirmations` rows
 *   - setsDone:          count of `set_logs` rows where `done = true`
 *   - totalVolumeKg:     sum of `weight_kg * target_reps` across done sets
 *
 * The query is intentionally read-only and shallow — it deliberately does NOT
 * fold in archived-program nuance (a "lifetime" total includes everything the
 * student has ever done). RLS already scopes the rows to the signed-in user's
 * sessions and slots, so we just need three lightweight counts.
 *
 * Volume is computed client-side from a slim `set_logs` projection rather
 * than via a Postgres view: the table is small per-student, the computation
 * is trivial, and adding a view/RPC for one stat would be overkill at this
 * stage. Revisit if a single student ever crosses ~10k done sets.
 */
export function useStudentLifetimeStats() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['student-lifetime-stats', user?.id],
    queryFn: async () => {
      // 1. Resolve the student row id from the signed-in user.
      const { data: student, error: stErr } = await supabase
        .from('students')
        .select('id')
        .eq('profile_id', user.id)
        .single();
      if (stErr) throw stErr;

      // 2. Sessions completed → confirmations are 1-per-session by table
      //    constraint, so a count over confirmations is the right metric.
      //    Walk via sessions → weeks → programs (.student_id = me).
      const { data: confirmedRows, error: cErr } = await supabase
        .from('session_confirmations')
        .select('session_id, sessions!inner(weeks!inner(programs!inner(student_id)))')
        .eq('sessions.weeks.programs.student_id', student.id);
      if (cErr) throw cErr;
      const sessionsCompleted = (confirmedRows || []).length;

      // 3. Done sets + volume — pull only what we need from set_logs joined
      //    up to the slot's exercise (for volume_weight) and program filter.
      const { data: doneLogs, error: lErr } = await supabase
        .from('set_logs')
        .select(`
          weight_kg,
          target_reps,
          exercise_slot:exercise_slots!inner(
            exercise:exercise_library!inner(volume_weight),
            session:sessions!inner(week:weeks!inner(program:programs!inner(student_id)))
          )
        `)
        .eq('done', true)
        .eq('exercise_slot.session.week.program.student_id', student.id);
      if (lErr) throw lErr;

      const setsDone = (doneLogs || []).length;

      // Volume = sum over done sets of (effective weight × target reps).
      // Effective weight: prefer the actual logged weight; fall back to the
      // exercise's volume_weight (e.g. bodyweight pull-ups). Reps without a
      // target_reps target contribute 0 — they're typically time-based.
      const totalVolumeKg = (doneLogs || []).reduce((sum, log) => {
        const reps = log.target_reps ?? 0;
        if (!reps) return sum;
        const effectiveWeight =
          log.weight_kg != null
            ? Number(log.weight_kg)
            : Number(log.exercise_slot?.exercise?.volume_weight ?? 0);
        return sum + effectiveWeight * reps;
      }, 0);

      return {
        sessionsCompleted,
        setsDone,
        totalVolumeKg: Math.round(totalVolumeKg),
      };
    },
    enabled: !!user?.id,
    // Lifetime totals don't need to refetch on every focus.
    staleTime: 60_000,
  });
}
