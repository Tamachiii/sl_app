import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';

/**
 * Fetches the program tree for the student surface:
 * weeks → sessions → exercise_slots (with exercise metadata).
 *
 * By default, only the active program is returned (used by StudentHome,
 * which always operates on the current periodization block). Pass
 * `{ allPrograms: true }` to also include past programs — used by the
 * Sessions page so students can browse archived/past-program work.
 *
 * Each week carries a `program` field `{ id, name, sort_order, is_active }`
 * so consumers can group or filter without an extra round-trip.
 */
export function useStudentProgramDetails(userId, { allPrograms = false } = {}) {
  return useQuery({
    queryKey: ['student-program-details', userId, allPrograms ? 'all' : 'active'],
    queryFn: async () => {
      const { data: student, error: sErr } = await supabase
        .from('students')
        .select('id')
        .eq('profile_id', userId)
        .single();
      if (sErr) throw sErr;

      let q = supabase
        .from('programs')
        .select(`
          id, name, sort_order, is_active,
          weeks(
            id, week_number, label,
            sessions(
              id, title, day_number, sort_order, scheduled_date, archived_at,
              exercise_slots(
                id, sets, reps, duration_seconds, weight_kg, sort_order,
                record_video_set_numbers,
                exercise:exercise_library(id, name, type),
                set_logs(set_number, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
              )
            )
          )
        `)
        .eq('student_id', student.id);
      if (!allPrograms) q = q.eq('is_active', true);
      const { data: programs, error: pErr } = await q;
      if (pErr) throw pErr;

      const weeks = [];
      for (const prog of programs || []) {
        const program = {
          id: prog.id,
          name: prog.name,
          sort_order: prog.sort_order,
          is_active: !!prog.is_active,
        };
        for (const w of prog.weeks || []) {
          w.program = program;
          w.sessions = (w.sessions || [])
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
            .sort((a, b) => a.sort_order - b.sort_order);
          weeks.push(w);
        }
      }
      // Sort weeks chronologically: program order first (sort_order ASC =
      // earliest periodization block first), then week number within a
      // program. Components reverse for "newest first" displays.
      weeks.sort((a, b) => {
        const ap = a.program?.sort_order ?? 0;
        const bp = b.program?.sort_order ?? 0;
        if (ap !== bp) return ap - bp;
        return a.week_number - b.week_number;
      });
      return weeks;
    },
    enabled: !!userId,
  });
}
