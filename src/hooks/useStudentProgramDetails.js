import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { compareSessions } from '../lib/day';
import { writeCached } from '../lib/cacheWrite';

const ROOT = 'student-program-details';

/**
 * The key of the training list's read: the block being trained, and the names
 * of the blocks before it.
 *
 * It ends in 'active' because that is the one variant of this root the device
 * keeps — `shouldPersistQuery` in lib/queryClient.js stores no other — and a
 * list that reads anything else is empty at the next launch without a network.
 * `useStudentProgramDetails.test.jsx` holds the two together.
 */
export function studentProgramDetailsKey(userId) {
  return [ROOT, userId, 'active'];
}

/**
 * The key of ONE past block's sessions. Not stored on the device: a year of
 * coaching is hundreds of sessions, and what is stored is written out again,
 * whole, on every change of the cache.
 */
export function studentPastProgramKey(userId, programId) {
  return [ROOT, userId, 'past', programId];
}

const PROGRAM_TREE = `
  id, name, sort_order, is_active,
  weeks(
    id, week_number, label,
    sessions(
      id, title, day_number, sort_order, scheduled_date, archived_at, performed_at,
      exercise_slots(
        id, sets, reps, duration_seconds, weight_kg, sort_order,
        record_video_set_numbers,
        exercise:exercise_library(id, name, type),
        set_logs(set_number, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
      )
    )
  )
`;

// A past block as the list shows it while its drawer is closed: a name and two
// numbers. `archived_at` is all that is read of its sessions.
const PROGRAM_HEADER = 'id, name, sort_order, weeks(sessions(archived_at))';

/**
 * Programs as PostgREST nests them → the weeks of those programs, in order,
 * each carrying `program: { id, name, sort_order, is_active }` so a consumer
 * can group or filter without another request.
 */
function weeksOf(programs) {
  const weeks = [];
  for (const prog of programs || []) {
    const program = {
      id: prog.id,
      name: prog.name,
      sort_order: prog.sort_order,
      is_active: !!prog.is_active,
    };
    for (const w of prog.weeks || []) {
      weeks.push({
        ...w,
        program,
        sessions: (w.sessions || [])
          .map((s) => ({
            ...s,
            exercise_slots: (s.exercise_slots || [])
              .map((sl) => ({
                ...sl,
                set_logs: (sl.set_logs || []).slice().sort(
                  (a, b) => a.set_number - b.set_number
                ),
              }))
              .sort((a, b) => a.sort_order - b.sort_order),
          }))
          // By position, not creation order: a session written first is not
          // thereby the first one of its phase.
          .sort(compareSessions),
      });
    }
  }
  // Chronological: program order first (sort_order ASC = earliest
  // periodization block first), then week number within a program.
  weeks.sort((a, b) => {
    const ap = a.program?.sort_order ?? 0;
    const bp = b.program?.sort_order ?? 0;
    if (ap !== bp) return ap - bp;
    return a.week_number - b.week_number;
  });
  return weeks;
}

// Newest block first, which is the order the list shows them in.
function pastProgramsOf(programs) {
  return (programs || [])
    .map((prog) => {
      const sessions = (prog.weeks || []).flatMap((w) => w.sessions || []);
      return {
        id: prog.id,
        name: prog.name,
        sort_order: prog.sort_order,
        session_count: sessions.length,
        archived_count: sessions.filter((s) => s.archived_at).length,
      };
    })
    .sort((a, b) => (b.sort_order ?? 0) - (a.sort_order ?? 0));
}

// An entry written by a build that cached the bare list of weeks can still be
// on a device. It is read as what it is — the block of that day, no past
// blocks known — until the next request replaces it.
function asTrainingList(data) {
  return Array.isArray(data) ? { weeks: data, pastPrograms: [] } : data;
}

/**
 * Change one session in the copies of the athlete's blocks the device holds —
 * the training list and any past block that was opened — before the database
 * has answered a write that changes it there.
 *
 * `change(session)` answers the fields to put on the session, or nothing to
 * leave it alone. Answers what the fields that changed held before, for the
 * write that has to take them back — `null` when no copy holds the session or
 * none of them changed.
 *
 * The copies are written as guesses (`writeCached`): they keep the age of
 * their last read, so the list is still read again when the athlete comes back
 * to it. A copy that does not exist is not made.
 */
export function writeTrainingListSession(queryClient, sessionId, change) {
  let before = null;
  writeCached(queryClient, [ROOT], (data) => {
    // The list holds `{ weeks, pastPrograms }`; a past block, and a list
    // cached by an older build, the bare weeks.
    const weeks = Array.isArray(data) ? data : data?.weeks;
    if (!Array.isArray(weeks)) return undefined;
    for (let w = 0; w < weeks.length; w++) {
      const sessions = weeks[w]?.sessions || [];
      const s = sessions.findIndex((session) => session.id === sessionId);
      if (s === -1) continue;
      const fields = change(sessions[s]) || {};
      const changed = Object.keys(fields).filter((f) => !Object.is(sessions[s][f], fields[f]));
      if (changed.length === 0) return undefined;
      before ??= Object.fromEntries(changed.map((f) => [f, sessions[s][f]]));
      const nextSessions = sessions.slice();
      nextSessions[s] = { ...sessions[s], ...fields };
      const nextWeeks = weeks.slice();
      nextWeeks[w] = { ...weeks[w], sessions: nextSessions };
      return Array.isArray(data) ? nextWeeks : { ...data, weeks: nextWeeks };
    }
    return undefined;
  });
  return before;
}

/**
 * What the student's training list is made of, in one read:
 *
 *   weeks         the block being trained — weeks → sessions → exercise_slots
 *                 (with exercise metadata and per-set targets), each week
 *                 tagged with its `program`;
 *   pastPrograms  the other blocks, newest first, as
 *                 `{ id, name, sort_order, session_count, archived_count }`.
 *                 Their sessions are another read, made when one is opened:
 *                 `useStudentPastProgram`.
 *
 * Both halves live in one cache entry on purpose. It is the entry the device
 * keeps, so a launch without a network shows the queue AND the rows of the
 * past blocks as they were — and they are read together, so a block the coach
 * switched off never shows in both places.
 */
export function useStudentProgramDetails(userId) {
  return useQuery({
    queryKey: studentProgramDetailsKey(userId),
    queryFn: async () => {
      // `maybeSingle`, not `single`: an account its owner has not linked to a
      // coach yet has no row here, and `single` turns those zero rows into an
      // error (PGRST116). Zero rows is an answer — no link, so no block — and
      // the page must be able to tell it from a read that failed: one says "No
      // program assigned yet", the other offers a "Try again" that this
      // athlete could tap for ever. `profile_id` is unique, so there is never
      // more than one.
      const { data: student, error: sErr } = await supabase
        .from('students')
        .select('id')
        .eq('profile_id', userId)
        .maybeSingle();
      if (sErr) throw sErr;
      if (!student) return { weeks: [], pastPrograms: [] };

      // Trashed programs (coach-side soft delete) vanish from the student
      // surface until restored.
      const ownPrograms = (columns) =>
        supabase
          .from('programs')
          .select(columns)
          .eq('student_id', student.id)
          .is('deleted_at', null);

      const [active, past] = await Promise.all([
        ownPrograms(PROGRAM_TREE).eq('is_active', true),
        ownPrograms(PROGRAM_HEADER).eq('is_active', false),
      ]);
      if (active.error) throw active.error;
      if (past.error) throw past.error;

      return { weeks: weeksOf(active.data), pastPrograms: pastProgramsOf(past.data) };
    },
    select: asTrainingList,
    enabled: !!userId,
  });
}

/**
 * The sessions of one past block, as weeks in the shape `weeks` has above.
 * Mounted by the drawer of that block while it is open, and by nothing else:
 * a closed drawer costs no request.
 */
export function useStudentPastProgram(userId, programId) {
  return useQuery({
    queryKey: studentPastProgramKey(userId, programId),
    queryFn: async () => {
      // No filter on the athlete: the id comes from their own list, and
      // row-level security answers for the rest.
      const { data, error } = await supabase
        .from('programs')
        .select(PROGRAM_TREE)
        .eq('id', programId)
        .is('deleted_at', null)
        .maybeSingle();
      if (error) throw error;
      return weeksOf(data ? [data] : []);
    },
    enabled: !!userId && !!programId,
  });
}
