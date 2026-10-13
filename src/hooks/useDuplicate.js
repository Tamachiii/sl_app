import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { pushToast } from '../lib/toast';
import { invalidateCoachDashboard } from './useProgram';
import { useI18n } from './useI18n';

/**
 * Duplicating a session, a phase or a block, and copying sessions into another
 * phase. Each hook is ONE call of a database function (migration
 * 2026_10_13_12_copy_rpcs): the copy is made in one statement, completely or
 * not at all. Sent as one request per row or per table — what these hooks did,
 * thirty to forty requests for a block — a request that was lost left a
 * session without its exercises, or exercises without their sets, in the block
 * the athlete trains.
 *
 * What a copy is, is decided there and nowhere here: the prescription (titles,
 * recommended weekdays, exercises, the targets of the prescribed sets) and
 * nothing of what was trained. `docs/INVARIANTS.md` has the list, and
 * `supabase/tests/copy-rpcs.test.js` holds every column to it.
 *
 * Three rules the four share:
 *
 * - A hook returns the answer of its function as it is — an object, the id of
 *   what was made under a fixed key (`session_id`, `session_ids`, `week_id`,
 *   `program_id`). `useDuplicateProgram` adds one key to it, `id`.
 * - A refusal is sent once and never again by the hook: nothing was written,
 *   the error reaches the toast of the mutation cache, and there is nothing to
 *   clean up.
 * - The caches are read again in `onSettled`, after a refusal too: what the
 *   functions refuse is something the page still shows — a session deleted in
 *   another tab (`session_not_found`), a phase moved while the call waited
 *   (`copy_source_changed`).
 */

// Everything that shows what a block holds: the sheet (['program']), a phase
// read on its own (['week']), a session and its sets (a duplicate moves the
// sessions after it down by one), the athlete's queue and the strip of the
// roster.
function refreshBlocks(qc) {
  qc.invalidateQueries({ queryKey: ['program'] });
  qc.invalidateQueries({ queryKey: ['week'] });
  qc.invalidateQueries({ queryKey: ['session'] });
  qc.invalidateQueries({ queryKey: ['set-logs'] });
  qc.invalidateQueries({ queryKey: ['student-program-details'] });
  invalidateCoachDashboard(qc);
}

// The lists of programs, of every athlete: a row is a block and counts its
// phases, so a new phase and a new block both change one — and the phase may
// have gone to another athlete's block.
function refreshProgramLists(qc) {
  qc.invalidateQueries({ queryKey: ['programs'] });
}

/**
 * `slots_left_out` counts the exercises a copy does not hold. A slot takes an
 * exercise of the library of its program's coach, so the exercises a former
 * coach left in an athlete's older blocks cannot be copied; the function makes
 * the copy without them and says how many. Without a change of coach it is 0.
 * The coach has to be told: the copy looks complete and is not.
 */
function useLeftOutNotice() {
  const { t } = useI18n();
  return (answer) => {
    const n = answer?.slots_left_out ?? 0;
    if (n > 0) pushToast(t('coachDuplicateRpc.leftOut', { n }), { kind: 'info' });
  };
}

/**
 * Duplicate a phase with its sessions, as the LAST phase of its block — or of
 * `programId`, which is how "copy this phase to…" reaches another block or
 * another athlete. Archived sessions stay archived, and a named phase gets the
 * suffix of the function (" (copy)").
 *
 * Answer: `{ week_id, program_id, week_number, label, sessions, slots,
 * set_logs, slots_left_out }`.
 */
export function useDuplicateWeek() {
  const qc = useQueryClient();
  const sayLeftOut = useLeftOutNotice();

  return useMutation({
    mutationFn: async ({ weekId, programId }) => {
      const { data, error } = await supabase.rpc('duplicate_week', {
        p_week_id: weekId,
        p_dest_program_id: programId ?? null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (answer) => sayLeftOut(answer),
    onSettled: () => {
      refreshBlocks(qc);
      refreshProgramLists(qc);
    },
  });
}

/**
 * Duplicate an ENTIRE block for the same athlete — every phase, session,
 * exercise and prescribed set — to seed the next block from a finished one.
 *
 * The copy is ALWAYS inactive, so it can never take the place of the block the
 * athlete trains; the coach activates it when ready. It is last in the
 * athlete's list, its phases numbered from 1 with their names as they are.
 *
 * Returns the answer of the function — `{ program_id, student_id, name,
 * sort_order, weeks, sessions, slots, set_logs, slots_left_out }`, the last
 * five being counts — with `id` next to `program_id`: the callers select the
 * copy by it, as they select any program.
 */
export function useDuplicateProgram() {
  const qc = useQueryClient();
  const sayLeftOut = useLeftOutNotice();

  return useMutation({
    mutationFn: async ({ programId }) => {
      const { data, error } = await supabase.rpc('duplicate_program', {
        p_program_id: programId,
      });
      if (error) throw error;
      return { ...data, id: data?.program_id };
    },
    onSuccess: (copy, vars) => {
      // The list the copy went to is the one the function names; `studentId`
      // is the page's word for the same athlete.
      const studentId = copy.student_id ?? vars.studentId;
      // Seed the list at once, so that the caller's `onSelect(copy.id)` finds
      // the copy in it before the refetch lands (as useCreateProgram does —
      // CoachHome otherwise strips a ?program it does not know). A row of
      // `useProgramsForStudent`, as the function leaves a copy: approved,
      // inactive, not submitted. Its phases come with the refetch.
      if (studentId && copy.id) {
        qc.setQueryData(['programs', studentId], (old) => {
          if (!Array.isArray(old) || old.some((p) => p.id === copy.id)) return old;
          return [
            ...old,
            {
              id: copy.id,
              student_id: studentId,
              name: copy.name,
              sort_order: copy.sort_order,
              is_active: false,
              status: 'approved',
              submitted_at: null,
              weeks: [],
            },
          ];
        });
      }
      sayLeftOut(copy);
    },
    onSettled: () => {
      refreshBlocks(qc);
      refreshProgramLists(qc);
    },
  });
}

/**
 * Copy SEVERAL sessions into one phase — the coach's "reuse this work with
 * another athlete" gesture. One copy per entry of `sessionIds`, in that order,
 * at the END of the phase, with the titles as they are and none archived.
 *
 * All of them or none: an entry that cannot be read refuses the whole list
 * (`session_not_found`). There is deliberately no insert-at-position picker:
 * the coach drags sessions into place on the sheet.
 *
 * Answer: `{ session_ids, week_id, slots, set_logs, slots_left_out }`,
 * `session_ids` in the order of the list.
 */
export function useCopySessions() {
  const qc = useQueryClient();
  const sayLeftOut = useLeftOutNotice();

  return useMutation({
    mutationFn: async ({ sessionIds, weekId }) => {
      const { data, error } = await supabase.rpc('copy_sessions', {
        p_session_ids: sessionIds,
        p_dest_week_id: weekId,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (answer) => sayLeftOut(answer),
    onSettled: () => refreshBlocks(qc),
  });
}

/**
 * Duplicate a session in its own phase. The copy stands RIGHT AFTER its
 * source — the sessions that follow move down by one — is never archived, and
 * is titled with the suffix of the function (" (copy)", after "Session" when
 * the source has no title).
 *
 * Answer: `{ session_id, week_id, sort_order, title, slots, set_logs,
 * slots_left_out }`.
 */
export function useDuplicateSession() {
  const qc = useQueryClient();
  const sayLeftOut = useLeftOutNotice();

  return useMutation({
    mutationFn: async ({ sessionId }) => {
      const { data, error } = await supabase.rpc('duplicate_session', {
        p_session_id: sessionId,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (answer) => sayLeftOut(answer),
    onSettled: () => refreshBlocks(qc),
  });
}
