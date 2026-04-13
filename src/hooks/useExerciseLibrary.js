import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';

export function useExerciseLibrary() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['exercise-library'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('exercise_library')
        .select('*')
        .order('name');
      if (error) throw error;
      return data;
    },
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
