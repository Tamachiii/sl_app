import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';

export function useProgram(studentId) {
  return useQuery({
    queryKey: ['program', studentId],
    queryFn: async () => {
      // Get or create a default program for this student
      let { data: programs, error } = await supabase
        .from('programs')
        .select('*, weeks(*, sessions(id))')
        .eq('student_id', studentId)
        .order('created_at', { ascending: true });
      if (error) throw error;

      if (programs.length === 0) {
        const { data: newProg, error: createErr } = await supabase
          .from('programs')
          .insert({ student_id: studentId, name: 'Program 1' })
          .select('*, weeks(*, sessions(id))')
          .single();
        if (createErr) throw createErr;
        return newProg;
      }

      // Sort weeks by week_number
      const prog = programs[0];
      prog.weeks = (prog.weeks || []).sort((a, b) => a.week_number - b.week_number);
      return prog;
    },
    enabled: !!studentId,
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
