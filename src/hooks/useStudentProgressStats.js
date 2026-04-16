import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import { computeSessionVolume } from '../lib/volume';

/**
 * Aggregates everything the Student Dashboard needs in a single fetch:
 *   - weeks[] with sessions + slots + exercise metadata (for volume maths)
 *   - confirmedSessionIds (Set)
 *   - setLogsBySlotId (for counting done sets + avg RPE)
 *
 * Returns an object with derived stats:
 *   - totalSessionsConfirmed, totalSessions
 *   - totalSetsDone, totalSets
 *   - weeksActive  (weeks that have >= 1 confirmation)
 *   - avgRpe        (across sets with rpe logged)
 *   - recentConfirmations[] (last 5, newest first)
 *   - weeklyVolume[]   [{ week_number, label, pull, push, sessions_confirmed, sessions_total }]
 */
export function useStudentProgressStats() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['student-progress-stats', user?.id],
    queryFn: async () => {
      // 1. Resolve the student row for this user.
      const { data: student, error: stErr } = await supabase
        .from('students')
        .select('id')
        .eq('profile_id', user.id)
        .single();
      if (stErr) throw stErr;

      // 2. Fetch program(s) → weeks → sessions → slots → exercise meta.
      const { data: programs, error: pErr } = await supabase
        .from('programs')
        .select(`
          id,
          weeks(
            id, week_number, label,
            sessions(
              id, title, day_number, sort_order, scheduled_date, archived_at,
              exercise_slots(
                id, sets, reps, duration_seconds,
                exercise:exercise_library(id, name, type, difficulty, volume_weight)
              )
            )
          )
        `)
        .eq('student_id', student.id);
      if (pErr) throw pErr;

      // Flatten weeks / sessions / slots.
      const weeks = [];
      const allSessions = [];
      const allSlotIds = [];
      for (const prog of programs || []) {
        for (const w of prog.weeks || []) {
          const weekSessions = (w.sessions || []).filter((s) => !s.archived_at);
          weeks.push({ ...w, sessions: weekSessions });
          for (const s of weekSessions) {
            allSessions.push(s);
            for (const slot of s.exercise_slots || []) {
              allSlotIds.push(slot.id);
            }
          }
        }
      }
      weeks.sort((a, b) => a.week_number - b.week_number);

      // 3. Fetch confirmations for this student's sessions.
      const sessionIds = allSessions.map((s) => s.id);
      const confirmations = sessionIds.length
        ? (
            await supabase
              .from('session_confirmations')
              .select('id, session_id, confirmed_at, notes')
              .in('session_id', sessionIds)
              .order('confirmed_at', { ascending: false })
          ).data || []
        : [];
      const confirmedIds = new Set(confirmations.map((c) => c.session_id));

      // 4. Fetch set logs for this student's slots.
      const setLogs = allSlotIds.length
        ? (
            await supabase
              .from('set_logs')
              .select('id, exercise_slot_id, done, rpe, logged_at')
              .in('exercise_slot_id', allSlotIds)
          ).data || []
        : [];

      // Aggregates.
      const totalSessions = allSessions.length;
      const totalSessionsConfirmed = allSessions.filter((s) => confirmedIds.has(s.id)).length;
      const totalSetsDone = setLogs.filter((l) => l.done).length;
      // totalSets counts the prescribed set_count across all slots.
      let totalSets = 0;
      for (const s of allSessions) {
        for (const slot of s.exercise_slots || []) {
          totalSets += slot.sets || 0;
        }
      }

      const rpeSamples = setLogs.filter((l) => l.done && l.rpe != null).map((l) => l.rpe);
      const avgRpe = rpeSamples.length
        ? rpeSamples.reduce((a, b) => a + b, 0) / rpeSamples.length
        : null;

      // Weekly volume + confirmation counts.
      const weeklyVolume = weeks.map((w) => {
        let pull = 0;
        let push = 0;
        let sessionsConfirmed = 0;
        for (const s of w.sessions || []) {
          if (confirmedIds.has(s.id)) sessionsConfirmed += 1;
          const v = computeSessionVolume(s.exercise_slots || []);
          pull += v.pull;
          push += v.push;
        }
        return {
          week_id: w.id,
          week_number: w.week_number,
          label: w.label,
          pull,
          push,
          sessions_confirmed: sessionsConfirmed,
          sessions_total: (w.sessions || []).length,
        };
      });

      const weeksActive = weeklyVolume.filter((w) => w.sessions_confirmed > 0).length;

      // Recent confirmations get session title/week info attached.
      const sessionMeta = {};
      for (const w of weeks) {
        for (const s of w.sessions || []) {
          sessionMeta[s.id] = {
            session_title: s.title,
            day_number: s.day_number,
            week_number: w.week_number,
            week_label: w.label,
          };
        }
      }
      const recentConfirmations = confirmations
        .slice(0, 5)
        .map((c) => ({ ...c, ...sessionMeta[c.session_id] }));

      return {
        totalSessions,
        totalSessionsConfirmed,
        totalSets,
        totalSetsDone,
        weeksActive,
        avgRpe,
        weeklyVolume,
        recentConfirmations,
      };
    },
    enabled: !!user?.id,
  });
}
