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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['exercise-library'] }),
  });
}
