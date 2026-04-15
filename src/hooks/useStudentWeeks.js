import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';

/**
 * Fetches all weeks (with sessions) for the currently signed-in student.
 * Flattens weeks from all programs and sorts by week_number.
 */
export function useStudentWeeks(userId) {
  return useQuery({
    queryKey: ['student-weeks', userId],
    queryFn: async () => {
      // Get the student row for this user
      const { data: student, error: sErr } = await supabase
        .from('students')
        .select('id')
        .eq('profile_id', userId)
        .single();
      if (sErr) throw sErr;

      // Get program with weeks and sessions
      const { data: programs, error: pErr } = await supabase
        .from('programs')
        .select(`
          id, name,
          weeks(
            id, week_number, label,
            sessions(id, title, sort_order, scheduled_date)
          )
        `)
        .eq('student_id', student.id)
        .order('created_at', { ascending: true });
      if (pErr) throw pErr;

      // Flatten weeks from all programs, sorted
      const weeks = [];
      for (const prog of programs) {
        for (const w of prog.weeks || []) {
          w.sessions = (w.sessions || []).sort((a, b) => a.sort_order - b.sort_order);
          weeks.push(w);
        }
      }
      weeks.sort((a, b) => a.week_number - b.week_number);
      return weeks;
    },
    enabled: !!userId,
  });
}
