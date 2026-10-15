import { useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';

/**
 * The exercise library, for both roles.
 *
 * - **A coach reads their own library**: the request carries
 *   `coach_id = <their id>`. RLS alone is wider than that — it also lets an
 *   account read the library of the coach it is an athlete OF, so a coach who
 *   trains under another coach (or under a forged link) would get that library
 *   mixed into their own pickers.
 * - **An athlete reads what RLS gives them**, their coach's library, with no
 *   filter: `coach_id = <athlete id>` would return nothing and empty the swap
 *   picker and the program builder (`SessionView`, `StudentProgramAuthor`).
 *
 * The key is `['exercise-library']` for both, on purpose: it is a persisted
 * root (`lib/queryClient.js`) and the entry an athlete's device already holds
 * is what names their exercises offline. A key per user or per role would
 * orphan it.
 *
 * One key for two requests means the cache can hold a list that was fetched
 * unfiltered — restored from a device that ran the previous client, or read
 * before the profile (and so the role) had loaded. `select` therefore applies
 * the same rule to whatever the cache holds: a coach is never handed a row
 * that is not theirs, and the list corrects itself when the role arrives
 * without waiting for a refetch.
 */
export function useExerciseLibrary() {
  const { user, role } = useAuth();
  const coachId = role === 'coach' ? user?.id : undefined;

  const select = useCallback(
    (rows) => (coachId && rows ? rows.filter((ex) => ex.coach_id === coachId) : rows),
    [coachId],
  );

  return useQuery({
    queryKey: ['exercise-library'],
    queryFn: async () => {
      let query = supabase.from('exercise_library').select('*');
      if (coachId) query = query.eq('coach_id', coachId);
      const { data, error } = await query.order('name');
      if (error) throw error;
      return data;
    },
    select,
    enabled: !!user,
  });
}

/**
 * Whether an exercise can still be picked for new work. An archived exercise
 * (`exercise_library.archived_at`) stays in the library read, because the
 * slots, goals and history that use it still need its name; a picker filters
 * its options with this. A row read before the column existed has no
 * `archived_at` and is active.
 */
export function isActiveExercise(ex) {
  return !!ex && !ex.archived_at;
}

// The three foreign keys that point at a library exercise. Each of them stops
// a delete, so the delete dialog counts all three.
const EXERCISE_REFERENCES = [
  { name: 'slots', table: 'exercise_slots', column: 'exercise_id' },
  { name: 'goals', table: 'goals', column: 'exercise_id' },
  { name: 'swaps', table: 'slot_deviations', column: 'substitute_exercise_id' },
];

/**
 * Where a library exercise is used: `{ slots, goals, swaps }` — the program
 * slots that prescribe it (in every program: trashed ones and archived
 * sessions count), the goals set on it, and the times an athlete swapped it
 * in. The server counts (`head: true`), so no row is downloaded and no number
 * is capped at a page.
 *
 * The delete dialog decides on these numbers, so they are not served from the
 * cache: nothing is kept once the dialog lets go of the key (`gcTime: 0`), and
 * every open reads again. A count that did not come back is an error, not a
 * zero — "unknown" must not read as "unused".
 *
 * The counts are what THIS coach can read. A reference they cannot see (an
 * athlete who moved to another coach and kept old sessions) still stops the
 * delete in the database, and the mutation's "in use" toast says so.
 */
export function useExerciseUsage(exerciseId) {
  return useQuery({
    queryKey: ['exercise-usage', exerciseId],
    queryFn: async () => {
      const counts = await Promise.all(
        EXERCISE_REFERENCES.map(async ({ table, column }) => {
          const { count, error } = await supabase
            .from(table)
            .select('id', { count: 'exact', head: true })
            .eq(column, exerciseId);
          if (error) throw error;
          if (!Number.isInteger(count)) {
            throw new Error(`No count came back for ${table}.${column}`);
          }
          return count;
        }),
      );
      return Object.fromEntries(EXERCISE_REFERENCES.map(({ name }, i) => [name, counts[i]]));
    },
    enabled: !!exerciseId,
    staleTime: 0,
    gcTime: 0,
  });
}

export function useCreateExercise() {
  const qc = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (exercise) => {
      const { data, error } = await supabase
        .from('exercise_library')
        .insert({ ...exercise, coach_id: user.id })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['exercise-library'] }),
  });
}

export function useUpdateExercise() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...updates }) => {
      const { data, error } = await supabase
        .from('exercise_library')
        .update(updates)
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['exercise-library'] }),
  });
}

/**
 * Archive a library exercise (`{ id, archived: true }`: `archived_at` is now)
 * or restore it (`archived: false`: `archived_at` is empty again).
 *
 * This is how an exercise leaves the coach's pickers once it is in use: the
 * slots, goals and swaps that name it hold it in the database (`ON DELETE
 * RESTRICT`), so it can no longer be deleted. Archiving changes nothing for
 * them — `useExerciseLibrary` still returns the row, which still names what
 * was trained; a picker leaves it out with `isActiveExercise`. The database
 * refuses nothing about an archived exercise.
 *
 * The row the server sends back goes into the cached library at once, so the
 * exercise changes lists when the write is through rather than when the
 * library has been read again; the read follows, and the mutation is pending
 * until it is done.
 */
export function useArchiveExercise() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, archived }) => {
      const { data, error } = await supabase
        .from('exercise_library')
        .update({ archived_at: archived ? new Date().toISOString() : null })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (row) => {
      qc.setQueryData(['exercise-library'], (rows) =>
        rows?.map((ex) => (ex.id === row.id ? { ...ex, ...row } : ex)),
      );
      return qc.invalidateQueries({ queryKey: ['exercise-library'] });
    },
  });
}

export function useDeleteExercise() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (id) => {
      const { error } = await supabase
        .from('exercise_library')
        .delete()
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['exercise-library'] });
      // A goal row embeds its exercise, and where the goals foreign key still
      // cascades, the goals on this exercise went with it.
      qc.invalidateQueries({ queryKey: ['goals'] });
    },
  });
}
