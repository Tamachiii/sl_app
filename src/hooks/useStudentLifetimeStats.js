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
 * The two COUNTS are server-side (`head: true`), so they are exact no matter
 * how much history a student accumulates. Volume is still computed client-side
 * from a slim `set_logs` projection — no view or RPC for one stat — but it
 * PAGES rather than issuing one open-ended select: PostgREST caps an
 * unbounded response at `db-max-rows` (1000 by default), and a silently
 * truncated page here doesn't error, it just under-reports a lifetime total.
 */
export function useStudentLifetimeStats() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['student-lifetime-stats', user?.id],
    queryFn: async () => {
      // 1. Resolve the student row id from the signed-in user. A profile with
      //    no students row (not yet linked to a coach) has no history rather
      //    than being an error.
      const { data: student, error: stErr } = await supabase
        .from('students')
        .select('id')
        .eq('profile_id', user.id)
        .maybeSingle();
      if (stErr) throw stErr;
      if (!student) return { sessionsCompleted: 0, setsDone: 0, totalVolumeKg: 0 };

      const volumeSelect = `
        weight_kg,
        target_reps,
        exercise_slot:exercise_slots!inner(
          exercise:exercise_library!inner(volume_weight),
          session:sessions!inner(week:weeks!inner(program:programs!inner(student_id)))
        )
      `;

      // 2. Both counts come back as server-side counts with no rows attached,
      //    so neither can be truncated by the row cap. Confirmations are
      //    1-per-session by table constraint, so counting them counts sessions.
      const [confRes, setsRes] = await Promise.all([
        supabase
          .from('session_confirmations')
          .select('session_id, sessions!inner(weeks!inner(programs!inner(student_id)))', {
            count: 'exact',
            head: true,
          })
          .eq('sessions.weeks.programs.student_id', student.id),
        supabase
          .from('set_logs')
          .select(volumeSelect, { count: 'exact', head: true })
          .eq('done', true)
          .eq('exercise_slot.session.week.program.student_id', student.id),
      ]);
      if (confRes.error) throw confRes.error;
      if (setsRes.error) throw setsRes.error;
      const sessionsCompleted = confRes.count ?? 0;
      const setsDone = setsRes.count ?? 0;

      // 3. Volume needs the rows themselves, so page until a short read.
      //    PAGE_SIZE below the server's default cap keeps every page a full
      //    page until the last one, which is what makes "short read" a
      //    reliable terminator.
      const PAGE_SIZE = 1000;
      const doneLogs = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data: page, error: lErr } = await supabase
          .from('set_logs')
          .select(volumeSelect)
          .eq('done', true)
          .eq('exercise_slot.session.week.program.student_id', student.id)
          .order('id', { ascending: true })
          .range(from, from + PAGE_SIZE - 1);
        if (lErr) throw lErr;
        doneLogs.push(...(page || []));
        if (!page || page.length < PAGE_SIZE) break;
      }

      // Volume = sum over done sets of (effective weight × target reps).
      // Effective weight: prefer the actual logged weight; fall back to the
      // exercise's volume_weight (e.g. bodyweight pull-ups). Reps without a
      // target_reps target contribute 0 — they're typically time-based.
      const totalVolumeKg = doneLogs.reduce((sum, log) => {
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
