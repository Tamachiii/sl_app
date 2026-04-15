import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';

export function useProgram(studentId) {
  return useQuery({
    queryKey: ['program', studentId],
    queryFn: async () => {
      const { data: programs, error } = await supabase
        .from('programs')
        .select('*, weeks(*, sessions(id))')
        .eq('student_id', studentId)
        .order('created_at', { ascending: true });
      if (error) throw error;

      if (programs.length === 0) return null;

      // Sort weeks by week_number
      const prog = programs[0];
      prog.weeks = (prog.weeks || []).sort((a, b) => a.week_number - b.week_number);
      return prog;
    },
    enabled: !!studentId,
  });
}

/**
 * Creates a default program for a student if none exists.
 * Call this from components that need to guarantee a program exists
 * (e.g. StudentCard on first visit).
 */
export function useEnsureProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ studentId }) => {
      const { data, error } = await supabase
        .from('programs')
        .insert({ student_id: studentId, name: 'Program 1' })
        .select('*, weeks(*, sessions(id))')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['program', vars.studentId] });
    },
  });
}

export function useCreateWeek() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ programId, weekNumber, label }) => {
      const { data, error } = await supabase
        .from('weeks')
        .insert({ program_id: programId, week_number: weekNumber, label })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['program'] });
    },
  });
}
