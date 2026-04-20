import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';

/**
 * Fetches the full program tree for the Sessions page:
 * weeks → sessions → exercise_slots (with exercise metadata).
 *
 * Lighter than useStudentProgressStats — no set_log or confirmation
 * aggregation, just structure + prescription data.
 */
export function useStudentProgramDetails(userId) {
  return useQuery({
    queryKey: ['student-program-details', userId],
    queryFn: async () => {
      const { data: student, error: sErr } = await supabase
        .from('students')
        .select('id')
        .eq('profile_id', userId)
        .single();
      if (sErr) throw sErr;

      const { data: programs, error: pErr } = await supabase
        .from('programs')
        .select(`
          id,
          weeks(
            id, week_number, label,
            sessions(
              id, title, day_number, sort_order, archived_at,
              exercise_slots(
                id, sets, reps, duration_seconds, weight_kg, sort_order,
                exercise:exercise_library(id, name, type)
              )
            )
          )
        `)
        .eq('student_id', student.id)
        .order('created_at', { ascending: true });
      if (pErr) throw pErr;

      const weeks = [];
      for (const prog of programs || []) {
        for (const w of prog.weeks || []) {
          w.sessions = (w.sessions || [])
            .map((s) => ({
              ...s,
              exercise_slots: (s.exercise_slots || []).sort(
                (a, b) => a.sort_order - b.sort_order
              ),
            }))
            .sort((a, b) => a.sort_order - b.sort_order);
          weeks.push(w);
        }
      }
      weeks.sort((a, b) => a.week_number - b.week_number);
      return weeks;
    },
    enabled: !!userId,
  });
}
