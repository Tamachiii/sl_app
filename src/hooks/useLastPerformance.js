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
 * SWAP-AWARE (both directions):
 *   - Current session: if a slot is swapped, the student is doing the
 *     SUBSTITUTE, so the hint keys on the substitute's history (the substitute
 *     id is added to the fetch set via `currentDeviations`).
 *   - Prior sessions: a set logged on a swapped slot really belonged to the
 *     substitute exercise, not the coach's prescription. We remap each prior
 *     set to its effective exercise before reducing, and on a swap keep ONLY
 *     the logged actuals — the pinned target_* are the ORIGINAL exercise's
 *     numbers, foreign to the substitute.
 *
 * Because a prior slot swapped to one of our target exercises lives under a
 * DIFFERENT exercise_id, we fetch recent done sets across all exercises (no
 * exercise_id filter) and remap/filter in JS. "Last time" only needs the most
 * recent prior session per exercise, and the query is ordered newest-first,
 * capped at the same 20000 rows as useStudentRecords — enough recent history
 * that even a rarely-programmed lift on a very-high-volume athlete keeps its
 * hint (the old per-exercise-filtered query couldn't see swap-ins).
 *
 * NOTE — intentional difference from useStudentProgressStats: on a swapped set
 * with no logged actual, Stats still ESTIMATES volume from the slot's prescribed
 * reps (the student did the slot's rep scheme, just a different movement). This
 * hint instead reports MEASURED performance, so a swap without actuals yields no
 * "last time" — the prescription isn't a performance to beat. Same rationale in
 * useStudentRecords.
 *
 * Student-only surface: the "Students read own set logs" / own-deviations RLS
 * policies already scope both reads to the signed-in student, so — unlike the
 * coach-capable useStudentRecords — no students.id resolution or student_id
 * filter is needed. Soft-deleted programs are excluded through the program join.
 *
 * Returns a plain object keyed by exercise_library id (see buildLastPerformance)
 * so the result survives the React Query IndexedDB persister.
 */
export function useLastPerformance(sessionId, slots, currentScheduledDate, currentDeviations) {
  const { user } = useAuth();

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
    queryKey: ['last-performance', sessionId, exerciseIds],
    queryFn: async () => {
      if (exerciseIds.length === 0) return {};

      // Recent DONE set_logs across ALL exercises — no exercise_id filter,
      // because a prior slot swapped to one of our targets sits under a
      // different exercise_id and would otherwise be missed.
      const { data, error } = await supabase
        .from('set_logs')
        .select(`
          set_number, logged_at, target_reps, target_weight_kg, actual_reps, actual_weight_kg,
          exercise_slots!inner(
            id, exercise_id, session_id,
            sessions!inner(scheduled_date, weeks!inner(programs!inner(deleted_at)))
          )
        `)
        .eq('done', true)
        .is('exercise_slots.sessions.weeks.programs.deleted_at', null)
        // Most recent first so the row cap keeps the relevant tail. Matches the
        // sibling useStudentRecords cap so a heavy-volume athlete's rarely-
        // programmed lift still keeps its "last time".
        .order('logged_at', { ascending: false })
        .limit(20000);
      if (error) throw error;

      // The student's prior swaps: slotId → substitute exercise id. RLS scopes
      // slot_deviations to the signed-in student, so no student_id filter is
      // needed; a swap on a trashed program's slot simply won't match any row.
      const { data: devs, error: devErr } = await supabase
        .from('slot_deviations')
        .select('exercise_slot_id, substitute_exercise_id')
        .eq('kind', 'swap')
        // Explicit high cap so a heavy-deviation student can't have swaps
        // silently truncated at PostgREST's default 1000-row limit.
        .limit(20000);
      if (devErr) throw devErr;
      const swapBySlot = new Map(
        (devs || [])
          .filter((d) => d.substitute_exercise_id)
          .map((d) => [d.exercise_slot_id, d.substitute_exercise_id]),
      );

      const rows = [];
      for (const l of data || []) {
        const slotId = l.exercise_slots?.id;
        const origId = l.exercise_slots?.exercise_id;
        const swappedTo = swapBySlot.get(slotId);
        const effectiveId = swappedTo || origId;
        if (!effectiveId || !exerciseIds.includes(effectiveId)) continue;
        rows.push({
          exerciseId: effectiveId,
          sessionId: l.exercise_slots?.session_id,
          scheduledDate: l.exercise_slots?.sessions?.scheduled_date || null,
          loggedAt: l.logged_at,
          setNumber: l.set_number,
          // On a swap the pinned target_* belong to the ORIGINAL exercise, so
          // drop them and let effectiveReps/effectiveWeight use actuals only.
          target_reps: swappedTo ? null : l.target_reps,
          target_weight_kg: swappedTo ? null : l.target_weight_kg,
          actual_reps: l.actual_reps,
          actual_weight_kg: l.actual_weight_kg,
        });
      }

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
