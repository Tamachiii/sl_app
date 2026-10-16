import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import { fetchAllRows } from '../lib/supabasePaging';

/**
 * The tonnage of one DONE set, by the rule of the Stats page's performed
 * tonnage (`useStudentProgressStats`): the reps lifted — `actual_reps`, else
 * `target_reps`, and none at all on a slot held for a time
 * (`duration_seconds`, whatever was typed in its reps) — times the load —
 * `actual_weight_kg`, else `target_weight_kg`, and 1 kg for a set with no load
 * or a load of 0, the bodyweight stand-in of the Stats page.
 *
 * One difference is left: on a slot the athlete SWAPPED for another exercise,
 * the Stats page takes the logged actual load alone (the target is the
 * original exercise's), which needs the swaps; here a swapped set with no
 * actual load still counts its target.
 *
 * `set_logs.weight_kg` is not read: nothing has written it since the actuals
 * replaced it, so it was null on every set logged since, and the old total fell
 * back to the exercise's `volume_weight` — a multiplier of 1 — counting 5 × 5
 * at 100 kg as 25.
 */
function setTonnage(log) {
  if (log.exercise_slot?.duration_seconds != null) return 0;
  const reps = Number(log.actual_reps ?? log.target_reps ?? 0);
  if (!(reps > 0)) return 0;
  const load = Number(log.actual_weight_kg ?? log.target_weight_kg);
  return reps * (load > 0 ? load : 1);
}

/**
 * Returns the signed-in student's all-time totals for the Profile page:
 *   - sessionsCompleted: count of `session_confirmations` rows
 *   - setsDone:          count of `set_logs` rows where `done = true`
 *   - totalVolumeKg:     the TONNAGE of every done set, by the rule of the
 *                        Stats page (`setTonnage` above)
 *
 * "Lifetime" is every block the athlete trained, past ones included — but not
 * a block in the coach's trash (`programs.deleted_at`): the Stats page, the
 * training list and the history leave it out, and so do the three reads here.
 *
 * The two COUNTS are server-side (`head: true`), so they are exact no matter
 * how much history a student accumulates. Volume is still computed client-side
 * from a slim `set_logs` projection — no view or RPC for one stat — and that
 * projection is read to its end, a page at a time (lib/supabasePaging):
 * PostgREST caps a response at `db-max-rows` (1000), and a silently truncated
 * read here doesn't error, it just under-reports a lifetime total.
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

      // What a done set lifted, and the slot that says whether it counts reps.
      // No join to the exercise: its `volume_weight` is a multiplier, not a
      // load, and an inner join to a library the athlete cannot read dropped
      // the set from the total.
      const volumeSelect = `
        id,
        actual_reps,
        actual_weight_kg,
        target_reps,
        target_weight_kg,
        exercise_slot:exercise_slots!inner(
          duration_seconds,
          session:sessions!inner(week:weeks!inner(program:programs!inner(student_id, deleted_at)))
        )
      `;
      const PROGRAM = 'exercise_slot.session.week.program';

      // 2. Both counts come back as server-side counts with no rows attached,
      //    so neither can be truncated by the row cap. Confirmations are
      //    1-per-session by table constraint, so counting them counts sessions.
      const [confRes, setsRes] = await Promise.all([
        supabase
          .from('session_confirmations')
          .select('session_id, sessions!inner(weeks!inner(programs!inner(student_id, deleted_at)))', {
            count: 'exact',
            head: true,
          })
          .eq('sessions.weeks.programs.student_id', student.id)
          .is('sessions.weeks.programs.deleted_at', null),
        supabase
          .from('set_logs')
          .select(volumeSelect, { count: 'exact', head: true })
          .eq('done', true)
          .eq(`${PROGRAM}.student_id`, student.id)
          .is(`${PROGRAM}.deleted_at`, null),
      ]);
      if (confRes.error) throw confRes.error;
      if (setsRes.error) throw setsRes.error;
      const sessionsCompleted = confRes.count ?? 0;
      const setsDone = setsRes.count ?? 0;

      // 3. Volume needs the rows themselves, every one of them.
      const doneLogs = await fetchAllRows(() =>
        supabase
          .from('set_logs')
          .select(volumeSelect)
          .eq('done', true)
          .eq(`${PROGRAM}.student_id`, student.id)
          .is(`${PROGRAM}.deleted_at`, null),
      );

      const totalVolumeKg = doneLogs.reduce((sum, log) => sum + setTonnage(log), 0);

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
