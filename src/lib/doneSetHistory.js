// An athlete's training history — every DONE set, attributed to the exercise
// that was actually performed — read ONCE and shared.
//
// Personal records and the "Last time" hint both reduce over this list. Each
// used to scan it for itself: the hint once per session opened and again for
// every exercise added in the coach's editor, records on every visit. That is
// a five-level join over the whole history (hundreds of kB for a regular
// athlete) downloaded to show one line per exercise. The list now lives in the
// React Query cache under one key per athlete, and both hooks derive from it.
//
// What a consumer needs to know:
//   - `fetchDoneSetHistory(queryClient, { studentRowId, userId })` is the only
//     way in. Call it from a queryFn; it resolves to the cached list, or reads
//     it. Two callers arriving together share one read.
//   - The key starts with 'student-records', so whatever invalidates
//     ['student-records'] — confirming a session, logging a bodyweight —
//     marks the history stale too, and the next derivation reads it again.
//     Nothing observes the history itself, so an invalidation costs nothing
//     until something derives from it. One that lands while the list is being
//     read is answered by one more read before the list is handed over.
//   - Between two invalidations it is trusted for HISTORY_STALE_MS. Sets
//     ticked on this device since the last read are missing from it until
//     the session is confirmed or that time has passed; "Last time" never
//     looks at the open session, so this only delays what the NEXT session
//     and the records list show.
//   - 'student-records' is not a persisted root: the list never reaches
//     IndexedDB. What is persisted is the small object "Last time" reduces
//     it to.

import { supabase } from './supabase';
import { fetchAllRows } from './supabasePaging';

/**
 * How long a history read is trusted when nothing has invalidated it — and how
 * long it is kept in memory, since a list too old to be used is only weight.
 *
 * Long enough that unlocking the phone between two sets does not download the
 * history again (the hint refetches on focus, and that refetch lands here);
 * short enough that a coach writing the next session sees a workout the
 * athlete finished a few minutes ago on another device, which no invalidation
 * on the coach's side announces.
 */
export const HISTORY_STALE_MS = 10 * 60 * 1000;

const PROGRAM = 'exercise_slots.sessions.weeks.programs';

/**
 * The cache key of an athlete's history. `athlete` is the STUDENTS-table id
 * when a coach reads, the signed-in user's id when an athlete reads their own.
 *
 * The 'student-records' root is load-bearing — see the note at the top.
 */
export function doneSetHistoryKey(athlete) {
  return ['student-records', 'history', athlete];
}

// When a set was logged, as a number that sorts; a done set without a stamp
// (rows older than the column) sorts first.
function loggedStamp(loggedAt) {
  const t = loggedAt ? new Date(loggedAt).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/**
 * The network read behind the cache: every done set of one athlete, and the
 * swaps that re-point some of them at a substitute exercise. Both go to their
 * end a page at a time (lib/supabasePaging), together.
 *
 * WHOSE rows. With a `studentRowId` (coach flow, a STUDENTS-table id) both
 * reads filter THROUGH the program join — never an unbounded id list. Without
 * the filter a coach's RLS hands back every athlete of the roster at once, and
 * records and hints would mix them. Without a `studentRowId` (athlete flow)
 * no filter is sent: the "Students read own set logs" and own-deviations
 * policies already scope both reads to the signed-in athlete. Trashed programs
 * are left out through the same join.
 *
 * Returns the sets as flat rows, oldest first (`logged_at`, then `id`, so the
 * order is the same on every load):
 *
 *   { id, slotId, sessionId, scheduledDate, setNumber, loggedAt,
 *     exerciseId, exercise, swapped,
 *     target_reps, target_weight_kg, actual_reps, actual_weight_kg }
 *
 *   - `exerciseId` is the exercise PERFORMED: the substitute on a swapped
 *     slot, the slot's own exercise otherwise.
 *   - `exercise` is `{ id, name, type, load_mode }` for it, or null when the
 *     reader may not see that library row (an exercise of a former coach).
 *     "Last time" works on the id alone; a record needs the name and skips it.
 *   - On a swapped set `target_*` are null. The slot's pinned targets are the
 *     ORIGINAL exercise's numbers, foreign to the substitute, so only what was
 *     logged counts — a swap with no logged actual is no performance at all.
 *     (Stats deliberately differs: it estimates VOLUME from the prescribed
 *     reps. A record and a number to beat are measured facts.)
 *   - `target_*` / `actual_*` keep their column names: they are what
 *     `effectiveWeight` / `effectiveReps` in lib/records read.
 *
 * Throws on the first failed page; a partial history is never returned.
 */
export async function readDoneSetHistory(studentRowId = null) {
  const ofAthlete = (query) => {
    const live = query.is(`${PROGRAM}.deleted_at`, null);
    return studentRowId ? live.eq(`${PROGRAM}.student_id`, studentRowId) : live;
  };

  const [logs, swaps] = await Promise.all([
    // All exercises, no exercise filter: a prior slot swapped to the lift we
    // are asked about sits under a different exercise_id. The library embed is
    // a plain (left) one on purpose — an exercise the reader may not see must
    // not take the set with it, the id is enough for "Last time".
    fetchAllRows(() =>
      ofAthlete(
        supabase
          .from('set_logs')
          .select(`
            id, set_number, logged_at, target_reps, target_weight_kg, actual_reps, actual_weight_kg,
            exercise_slots!inner(
              id, exercise_id, session_id,
              exercise:exercise_library(name, type, load_mode),
              sessions!inner(scheduled_date, weeks!inner(programs!inner(student_id, deleted_at)))
            )
          `)
          .eq('done', true),
      ),
    ),
    fetchAllRows(() =>
      ofAthlete(
        supabase
          .from('slot_deviations')
          .select(`
            id, exercise_slot_id, substitute_exercise_id,
            substitute:exercise_library(name, type, load_mode),
            exercise_slots!inner(sessions!inner(weeks!inner(programs!inner(student_id, deleted_at))))
          `)
          .eq('kind', 'swap'),
      ),
    ),
  ]);

  // One object per exercise, shared by all its sets.
  const exercises = new Map();
  const remember = (id, details) => {
    if (!id || !details || exercises.has(id)) return;
    exercises.set(id, {
      id,
      name: details.name,
      type: details.type,
      load_mode: details.load_mode ?? null,
    });
  };

  // slot id → the exercise done in its place (one deviation per slot).
  const substituteBySlot = new Map();
  for (const swap of swaps) {
    if (!swap.substitute_exercise_id) continue;
    substituteBySlot.set(swap.exercise_slot_id, swap.substitute_exercise_id);
    remember(swap.substitute_exercise_id, swap.substitute);
  }
  for (const log of logs) {
    remember(log.exercise_slots?.exercise_id, log.exercise_slots?.exercise);
  }

  // [when it was logged, the set] — the stamp is parsed once, not per comparison.
  const stamped = [];
  for (const log of logs) {
    const slot = log.exercise_slots;
    if (!slot) continue;
    const substituteId = substituteBySlot.get(slot.id) || null;
    const exerciseId = substituteId || slot.exercise_id;
    if (!exerciseId) continue;
    const set = {
      id: log.id,
      slotId: slot.id,
      sessionId: slot.session_id,
      scheduledDate: slot.sessions?.scheduled_date || null,
      setNumber: log.set_number ?? null,
      loggedAt: log.logged_at || null,
      exerciseId,
      exercise: exercises.get(exerciseId) || null,
      swapped: !!substituteId,
      target_reps: substituteId ? null : (log.target_reps ?? null),
      target_weight_kg: substituteId ? null : (log.target_weight_kg ?? null),
      actual_reps: log.actual_reps ?? null,
      actual_weight_kg: log.actual_weight_kg ?? null,
    };
    stamped.push([loggedStamp(set.loggedAt), set]);
  }

  // Pages arrive in id order, which for a uuid is no order. Records depend on
  // this one: of two sets that tie for a best, the EARLIER holds the record.
  stamped.sort(
    ([whenA, a], [whenB, b]) => whenA - whenB || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return stamped.map(([, set]) => set);
}

/**
 * The athlete's history from the cache, read if it is missing, invalidated or
 * older than HISTORY_STALE_MS. Resolves to the array `readDoneSetHistory`
 * describes — treat it as read-only, every consumer holds the same one.
 *
 * `studentRowId` names the athlete in the coach flow and MUST be passed there;
 * `userId` is the signed-in user, who is the athlete when it is omitted.
 */
export function fetchDoneSetHistory(queryClient, { studentRowId = null, userId = null } = {}) {
  const athlete = studentRowId ?? userId;
  if (!athlete) {
    return Promise.reject(new Error('fetchDoneSetHistory: neither a studentRowId nor a userId'));
  }
  const queryKey = doneSetHistoryKey(athlete);
  // Whether the entry is flagged: invalidated, or left by a failed read, with
  // no successful read since.
  const flagged = () => !!queryClient.getQueryCache().find({ queryKey })?.state.isInvalidated;
  return queryClient.fetchQuery({
    queryKey,
    queryFn: async () => {
      const flaggedAtStart = flagged();
      const rows = await readDoneSetHistory(studentRowId);
      // An invalidation that lands while this read is in flight restarts
      // nothing — the entry has no observer — and the read's own success then
      // clears the flag: the session confirmed in that second would be missing
      // from a list held as fresh for ten minutes. So when the flag went up
      // during the read, the read is made again before anyone gets the list.
      // Once: the flag cannot go up twice, so an invalidation during the
      // repeat — or during a read that began on an entry already flagged — is
      // not seen, and waits for HISTORY_STALE_MS like a set ticked since.
      return !flaggedAtStart && flagged() ? readDoneSetHistory(studentRowId) : rows;
    },
    staleTime: HISTORY_STALE_MS,
    gcTime: HISTORY_STALE_MS,
    // The hook deriving from the history retries; retrying here as well would
    // multiply the attempts of a read that is several requests long.
    retry: false,
    // Nothing renders from this entry, so keeping old references alive across
    // a refetch buys no re-render — it would only deep-compare the whole list.
    structuralSharing: false,
  });
}
