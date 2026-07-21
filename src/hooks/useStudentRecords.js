import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import { isoDate } from '../lib/day';
import { buildRecords } from '../lib/records';

const RECENT_WINDOW_DAYS = 14;

/**
 * A resolver for the student's bodyweight at a given set's date, from their
 * bodyweight_logs series (ascending). Returns the latest entry on/before the
 * set's LOCAL date; failing that the earliest entry (a documented-approximate
 * pre-history proxy); null when the series is empty. Feeds relative strength.
 */
function makeBodyweightAt(bwRows) {
  const series = (bwRows || [])
    .map((r) => ({ on: r.logged_on, kg: Number(r.weight_kg) }))
    .filter((r) => r.on && r.kg > 0)
    .sort((a, b) => a.on.localeCompare(b.on));
  return (loggedAtIso) => {
    if (series.length === 0) return null;
    if (!loggedAtIso) return series[series.length - 1].kg; // undated → latest
    const d = isoDate(new Date(loggedAtIso));
    let match = null;
    for (const e of series) {
      if (e.on <= d) match = e;
      else break;
    }
    return match ? match.kg : series[0].kg;
  };
}

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
 * SWAP-AWARE: a set logged on a swapped slot really belonged to the SUBSTITUTE
 * exercise, so its PR is credited there — using ONLY the logged actuals, since
 * the slot's pinned target_* are the coach's original exercise's numbers,
 * foreign to the substitute.
 *
 * NOTE — intentional difference from useStudentProgressStats: Stats ESTIMATES
 * volume from the slot's prescribed reps even on a swap-with-no-actual (the
 * student did that rep scheme, just a different movement). A PR is a MEASURED
 * fact, so a swap without a logged actual sets no record here — crediting the
 * substitute from the coach's prescription would fabricate a PR. Same rationale
 * in useLastPerformance.
 */
export function useStudentRecords(studentRowId) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['student-records', studentRowId ?? user?.id],
    queryFn: async () => {
      let resolvedId = studentRowId;
      // bodyweight_logs.student_id references profiles.id, so we need the
      // student's PROFILE id: the signed-in user in the student flow, or the
      // students row's profile_id in the coach flow.
      let bwProfileId = studentRowId ? null : user.id;
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
      } else {
        const { data: student, error: sErr } = await supabase
          .from('students')
          .select('profile_id')
          .eq('id', studentRowId)
          .maybeSingle();
        if (sErr) throw sErr;
        bwProfileId = student?.profile_id ?? null;
      }

      // These three reads are independent of one another (only the student id
      // they all filter on had to be resolved first), so they go out together.
      //   1. every done set,
      //   2. the swap deviations that re-point some of them at a substitute —
      //      so a swapped set's PR follows what the student actually did.
      //      Scoped through the same program join (coach reads via their RLS
      //      policy, student via own-rows), never an unbounded slot-id .in(),
      //   3. the bodyweight series behind the ×BW figure. Empty or unknown →
      //      records simply render without it (graceful degrade).
      const [logRes, devRes, bwRes] = await Promise.all([
        supabase
          .from('set_logs')
          .select(`
            done, logged_at, target_reps, target_weight_kg, actual_reps, actual_weight_kg,
            exercise_slots!inner(
              id,
              exercise:exercise_library!inner(id, name, type, load_mode),
              sessions!inner(weeks!inner(programs!inner(student_id, deleted_at)))
            )
          `)
          .eq('done', true)
          .eq('exercise_slots.sessions.weeks.programs.student_id', resolvedId)
          .is('exercise_slots.sessions.weeks.programs.deleted_at', null)
          .limit(20000),
        supabase
          .from('slot_deviations')
          .select(`
            exercise_slot_id,
            substitute:exercise_library(id, name, type, load_mode),
            exercise_slots!inner(sessions!inner(weeks!inner(programs!inner(student_id, deleted_at))))
          `)
          .eq('kind', 'swap')
          .eq('exercise_slots.sessions.weeks.programs.student_id', resolvedId)
          .is('exercise_slots.sessions.weeks.programs.deleted_at', null)
          .limit(20000),
        bwProfileId
          ? supabase
              .from('bodyweight_logs')
              .select('weight_kg, logged_on')
              .eq('student_id', bwProfileId)
              .order('logged_on', { ascending: true })
              .limit(20000)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (logRes.error) throw logRes.error;
      if (devRes.error) throw devRes.error;
      if (bwRes.error) throw bwRes.error;
      const data = logRes.data;
      const devs = devRes.data;
      const bwRows = bwRes.data || [];

      const swapBySlot = new Map();
      for (const d of devs || []) {
        if (d.substitute) swapBySlot.set(d.exercise_slot_id, d.substitute);
      }

      // Lift the effective exercise onto each log for buildRecords. On a swapped
      // slot the effective exercise is the substitute, and the pinned target_*
      // (the original's load) are dropped so only the logged actuals count.
      const logs = (data || []).map((l) => {
        const swap = swapBySlot.get(l.exercise_slots?.id);
        return {
          done: l.done,
          logged_at: l.logged_at,
          target_reps: swap ? null : l.target_reps,
          target_weight_kg: swap ? null : l.target_weight_kg,
          actual_reps: l.actual_reps,
          actual_weight_kg: l.actual_weight_kg,
          exercise: swap || l.exercise_slots?.exercise || null,
        };
      });


      const recentSince = new Date();
      recentSince.setDate(recentSince.getDate() - RECENT_WINDOW_DAYS);
      return buildRecords(logs, { recentSince, bodyweightAt: makeBodyweightAt(bwRows) });
    },
    enabled: !!(studentRowId || user?.id),
    staleTime: 1000 * 60,
  });
}
