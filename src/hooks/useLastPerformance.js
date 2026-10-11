import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from './useAuth';
import { isoDate } from '../lib/day';
import { buildLastPerformance } from '../lib/lastPerformance';
import { fetchDoneSetHistory } from '../lib/doneSetHistory';

/**
 * For every exercise in the OPEN session, the student's most recent PRIOR
 * performance of that exercise (the done sets from their latest earlier
 * session). Feeds the "Last time" hint on the logging surface so the student
 * has a target to beat.
 *
 * THE HISTORY IS NOT READ HERE. "Last time" needs one prior session per
 * exercise, but that session can be anywhere in the athlete's history, under
 * any exercise_id (see the swaps below) — so it takes the WHOLE history, which
 * is the athlete's shared list in lib/doneSetHistory: every done set, read to
 * its end once and kept in the query cache, the same list personal records
 * reduce. This query only picks the open session's exercises out of it. The
 * key still names the session and its exercises, so opening another session,
 * or adding an exercise in the coach's editor, starts a new query — which
 * finds the history in the cache and sends nothing. The history is read again
 * after a confirmed session (it sits under ['student-records'], which the
 * confirmation invalidates) or once it is older than HISTORY_STALE_MS.
 *
 * SWAP-AWARE (both directions):
 *   - Current session: if a slot is swapped, the student is doing the
 *     SUBSTITUTE, so the hint keys on the substitute's history (the substitute
 *     id replaces the prescribed one via `currentDeviations`).
 *   - Prior sessions: a set logged on a swapped slot really belonged to the
 *     substitute exercise, not the coach's prescription. The history hands
 *     each set over under the exercise actually performed, and on a swap with
 *     ONLY the logged actuals — the pinned target_* are the ORIGINAL
 *     exercise's numbers, foreign to the substitute.
 *
 * The sets arrive oldest first, which this hook does not rely on:
 * buildLastPerformance finds the latest session and orders its sets itself.
 *
 * NOTE — intentional difference from useStudentProgressStats: on a swapped set
 * with no logged actual, Stats still ESTIMATES volume from the slot's prescribed
 * reps (the student did the slot's rep scheme, just a different movement). This
 * hint instead reports MEASURED performance, so a swap without actuals yields no
 * "last time" — the prescription isn't a performance to beat. Same rationale in
 * useStudentRecords.
 *
 * Works for BOTH roles. Omit `studentRowId` (student flow) and the "Students
 * read own set logs" / own-deviations RLS policies already scope the history to
 * the signed-in student. Pass a STUDENTS-table id (coach flow, same convention
 * as useStudentRecords / useStudentProgressStats) and both history reads filter
 * THROUGH the program join — without it a coach's RLS would hand back every
 * athlete's logs at once and the hint would mix athletes. It is passed on to
 * fetchDoneSetHistory, which keys the history on the athlete as this query is.
 * Soft-deleted programs are excluded through the same join.
 *
 * Returns a plain object keyed by exercise_library id (see buildLastPerformance)
 * so the result survives the React Query IndexedDB persister. That small object
 * is what gets persisted — never the history it was picked from.
 */
export function useLastPerformance(
  sessionId,
  slots,
  currentScheduledDate,
  currentDeviations,
  deviationsReady = true,
  studentRowId = null,
) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Effective exercise per open slot: a current-session SWAP means the student
  // is performing the substitute, so the hint should reflect the substitute's
  // history rather than the (now unused) prescribed exercise.
  const currentSwapBySlot = new Map(
    (currentDeviations || [])
      .filter((d) => d.kind === 'swap' && d.substitute_exercise_id)
      .map((d) => [d.exercise_slot_id, d.substitute_exercise_id]),
  );
  const exerciseIds = [
    ...new Set(
      (slots || [])
        .map((s) => currentSwapBySlot.get(s.id) || s.exercise?.id)
        .filter(Boolean),
    ),
  ].sort();

  return useQuery({
    // studentRowId is part of the key: a coach moving between athletes must not
    // read one athlete's hint out of another's cache entry.
    queryKey: ['last-performance', studentRowId ?? 'self', sessionId, exerciseIds],
    queryFn: async () => {
      if (exerciseIds.length === 0) return {};

      const history = await fetchDoneSetHistory(queryClient, {
        studentRowId: studentRowId ?? null,
        userId: user?.id ?? null,
      });
      const wanted = new Set(exerciseIds);

      return buildLastPerformance(
        history.filter((set) => wanted.has(set.exerciseId)),
        {
          currentSessionId: sessionId,
          // Fall back to today (LOCAL date) when the open session is undated
          // (legacy day_number sessions have no scheduled_date). Without a
          // boundary, a future-scheduled session the student logged ahead would
          // outrank genuine priors and surface as "last time".
          currentScheduledDate: currentScheduledDate || isoDate(new Date()),
        },
      );
    },
    // `exerciseIds` is part of the key and shifts the moment a current-session
    // swap resolves. Firing before the deviations query has settled would show
    // the PRESCRIBED exercise's numbers on a slot that is being done as
    // something else, then replace them. Gate on SETTLED, not success: a failed
    // deviations fetch degrades to the un-swapped hint rather than to no hint
    // at all.
    // A coach has no need of their own auth id here beyond being signed in;
    // the athlete is named by studentRowId.
    enabled: !!user?.id && !!sessionId && exerciseIds.length > 0 && !!deviationsReady,
    staleTime: 1000 * 60,
  });
}
