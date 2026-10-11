import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import { isoDate } from '../lib/day';
import { buildRecords } from '../lib/records';
import { fetchDoneSetHistory } from '../lib/doneSetHistory';
import { fetchBodyweightSeries } from './useBodyweight';

const RECENT_WINDOW_DAYS = 14;

/**
 * A resolver for the student's bodyweight at a given set's date, from their
 * bodyweight_logs series (in any order). Returns the latest entry on/before the
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
 * All-time personal records per exercise: the athlete's done sets reduced by
 * lib/records.buildRecords. Records set within the last two weeks are flagged
 * `recent` so the UI can celebrate a fresh PR.
 *
 * THE SETS ARE NOT READ HERE. They come from the athlete's shared history
 * (lib/doneSetHistory) — every done set, read to its end and kept in the query
 * cache, the same list "Last time" derives from. So a visit to the records
 * costs the history read only when nothing has it yet, when a session was
 * confirmed since, or when it is older than HISTORY_STALE_MS; a refetch on
 * focus re-reads the bodyweight series (for a coach, behind the athlete's
 * profile id) and not the history. The history's key starts with
 * 'student-records' like this query's: one invalidation of ['student-records']
 * renews both.
 *
 * The history hands the sets over oldest first, which the reduce relies on: of
 * two sets tying for a best, the EARLIER one holds the record and its date —
 * matching a best is not a new PR.
 *
 * `studentRowId` names the athlete in the coach flow: a STUDENTS-table id
 * (`programs.student_id` references `students.id`, NOT `profiles.id`), which
 * filters the history through the program join. The athlete flow omits it and
 * RLS scopes the history to the signed-in athlete — no `students` row is
 * resolved, and an athlete without one simply has no sets.
 *
 * SWAP-AWARE: a set logged on a swapped slot belongs to the SUBSTITUTE
 * exercise and arrives from the history already attributed to it, carrying
 * ONLY the logged actuals — the slot's pinned target_* are the coach's
 * original exercise's numbers, foreign to the substitute.
 *
 * NOTE — intentional difference from useStudentProgressStats: Stats ESTIMATES
 * volume from the slot's prescribed reps even on a swap-with-no-actual (the
 * student did that rep scheme, just a different movement). A PR is a MEASURED
 * fact, so a swap without a logged actual sets no record here — crediting the
 * substitute from the coach's prescription would fabricate a PR. Same rationale
 * in useLastPerformance.
 *
 * A set whose exercise the reader may not see in the library (it has an id and
 * no name) sets no record either: there would be nothing to show it under.
 */
export function useStudentRecords(studentRowId) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ['student-records', studentRowId ?? user?.id],
    queryFn: async () => {
      // The bodyweight series behind the ×BW figure. bodyweight_logs.student_id
      // references profiles.id: the signed-in user in the athlete flow, the
      // students row's profile_id in the coach flow. Empty or unknown →
      // records simply render without it (graceful degrade).
      const readBodyweight = async () => {
        if (!studentRowId) return fetchBodyweightSeries(user.id);
        const { data: student, error } = await supabase
          .from('students')
          .select('profile_id')
          .eq('id', studentRowId)
          .maybeSingle();
        if (error) throw error;
        return student?.profile_id ? fetchBodyweightSeries(student.profile_id) : [];
      };

      // Independent of one another, so they go out together.
      const [sets, bwRows] = await Promise.all([
        fetchDoneSetHistory(queryClient, { studentRowId: studentRowId ?? null, userId: user?.id ?? null }),
        readBodyweight(),
      ]);

      const logs = sets.map((s) => ({
        done: true,
        logged_at: s.loggedAt,
        target_reps: s.target_reps,
        target_weight_kg: s.target_weight_kg,
        actual_reps: s.actual_reps,
        actual_weight_kg: s.actual_weight_kg,
        exercise: s.exercise,
      }));

      const recentSince = new Date();
      recentSince.setDate(recentSince.getDate() - RECENT_WINDOW_DAYS);
      return buildRecords(logs, { recentSince, bodyweightAt: makeBodyweightAt(bwRows) });
    },
    enabled: !!(studentRowId || user?.id),
    staleTime: 1000 * 60,
  });
}
