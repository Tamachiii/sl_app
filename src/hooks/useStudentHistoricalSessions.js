import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';

/**
 * Scheduled sessions from the signed-in student's NON-active program blocks.
 * Feeds a secondary calendar overlay so students can still see when they
 * trained in previous periodization blocks. Active-program sessions are
 * already served by useStudentProgressStats — this hook is purely history.
 *
 * Returns an array of `{ session_id, title, date, completed, historical: true }`
 * — the same shape as `stats.sessionCalendar` plus a `historical` flag so the
 * calendar can style these days distinctly.
 */
export function useStudentHistoricalSessions() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['student-historical-sessions', user?.id],
    queryFn: async () => {
      const { data: student, error: stErr } = await supabase
        .from('students')
        .select('id')
        .eq('profile_id', user.id)
        .single();
      if (stErr) throw stErr;

      const { data: programs, error: pErr } = await supabase
        .from('programs')
        .select(`
          id,
          weeks(
            sessions(id, title, scheduled_date, archived_at)
          )
        `)
        .eq('student_id', student.id)
        .eq('is_active', false);
      if (pErr) throw pErr;

      const dated = [];
      for (const prog of programs || []) {
        for (const w of prog.weeks || []) {
          for (const s of w.sessions || []) {
            if (!s.scheduled_date) continue;
            dated.push(s);
          }
        }
      }

      // Any confirmations for these sessions → mark them completed on the
      // calendar (same rule as the active-program calendar: archived OR
      // confirmed counts as done).
      const sessionIds = dated.map((s) => s.id);
      const confirmedIds = new Set();
      if (sessionIds.length) {
        const { data: confs, error: cErr } = await supabase
          .from('session_confirmations')
          .select('session_id')
          .in('session_id', sessionIds);
        if (cErr) throw cErr;
        for (const c of confs || []) confirmedIds.add(c.session_id);
      }

      return dated.map((s) => ({
        session_id: s.id,
        title: s.title,
        date: s.scheduled_date,
        completed: confirmedIds.has(s.id) || !!s.archived_at,
        historical: true,
      }));
    },
    enabled: !!user?.id,
  });
}
