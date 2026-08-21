import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import { isoDate } from '../lib/day';

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
            sessions(id, title, scheduled_date, archived_at, performed_at)
          )
        `)
        .eq('student_id', student.id)
        .eq('is_active', false)
        .is('deleted_at', null);
      if (pErr) throw pErr;

      // The day it was actually trained wins over the day it was planned for,
      // and a session trained without any coach-set date now shows up at all —
      // it used to be invisible on the calendar.
      const dated = [];
      for (const prog of programs || []) {
        for (const w of prog.weeks || []) {
          for (const s of w.sessions || []) {
            const date = s.performed_at
              ? isoDate(new Date(s.performed_at))
              : s.scheduled_date?.slice(0, 10) || null;
            if (!date) continue;
            dated.push({ ...s, date });
          }
        }
      }

      // Any confirmations for these sessions → mark them completed on the
      // calendar (same rule as the active-program calendar: archived OR
      // confirmed counts as done). Filtered THROUGH the program join for the
      // student's non-active blocks rather than an unbounded .in(sessionIds)
      // list (which grows with history and eventually blows the URL length).
      const confirmedIds = new Set();
      if (dated.length) {
        const { data: confs, error: cErr } = await supabase
          .from('session_confirmations')
          .select('session_id, sessions!inner(weeks!inner(programs!inner(student_id, is_active, deleted_at)))')
          .eq('sessions.weeks.programs.student_id', student.id)
          .eq('sessions.weeks.programs.is_active', false)
          .is('sessions.weeks.programs.deleted_at', null);
        if (cErr) throw cErr;
        for (const c of confs || []) confirmedIds.add(c.session_id);
      }

      return dated.map((s) => ({
        session_id: s.id,
        title: s.title,
        date: s.date,
        completed: confirmedIds.has(s.id) || !!s.archived_at,
        historical: true,
      }));
    },
    enabled: !!user?.id,
  });
}
