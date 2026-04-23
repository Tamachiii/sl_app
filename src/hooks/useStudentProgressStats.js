import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import { computeSessionVolume } from '../lib/volume';

/**
 * Aggregates everything the Student Dashboard needs in a single fetch:
 *   - weeks[] with sessions + slots + exercise metadata (for volume maths)
 *   - confirmedSessionIds (Set)
 *   - setLogsBySlotId (for counting done sets, avg RPE, and weight history)
 *
 * Returns an object with derived stats:
 *   - totalSessionsConfirmed, totalSessions
 *   - totalSetsDone, totalSets
 *   - weeksActive       (weeks that have >= 1 confirmation)
 *   - avgRpe            (across sets with rpe logged)
 *   - recentConfirmations[] (last 5, newest first)
 *   - weeklyVolume[]    [{ week_number, label, pull, push, sessions_confirmed, sessions_total }]
 *   - sessionCalendar[] [{ session_id, title, date, completed }] — sessions w/ scheduled_date
 *
 * Pass a `studentId` (students.id row id) to stat any student — used by the
 * coach Students view. Omit it to stat the signed-in user (student flow).
 */
export function useStudentProgressStats(studentId) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['student-progress-stats', studentId ?? user?.id],
    queryFn: async () => {
      // 1. Resolve the student row. Coach view passes studentId directly;
      //    student view looks it up via profile_id.
      let resolvedStudentId = studentId;
      if (!resolvedStudentId) {
        const { data: student, error: stErr } = await supabase
          .from('students')
          .select('id')
          .eq('profile_id', user.id)
          .single();
        if (stErr) throw stErr;
        resolvedStudentId = student.id;
      }

      // 2. Fetch the active program → weeks → sessions → slots → exercise meta.
      //    Stats are scoped to the currently-active program (the block the
      //    student is training right now). Prior blocks don't roll into these
      //    aggregates so progress feels block-local.
      const { data: programs, error: pErr } = await supabase
        .from('programs')
        .select(`
          id,
          weeks(
            id, week_number, label,
            sessions(
              id, title, day_number, sort_order, scheduled_date, archived_at,
              exercise_slots(
                id, sets, reps, duration_seconds, weight_kg,
                exercise:exercise_library(id, name, type, difficulty, volume_weight)
              )
            )
          )
        `)
        .eq('student_id', resolvedStudentId)
        .eq('is_active', true);
      if (pErr) throw pErr;

      // Flatten weeks / sessions / slots.
      const weeks = [];
      const allSessions = [];
      const allSlotIds = [];

      for (const prog of programs || []) {
        for (const w of prog.weeks || []) {
          // Include archived sessions in every aggregate — completed work
          // shouldn't vanish from stats if the coach later archives the session.
          const allWeekSessions = w.sessions || [];

          weeks.push({ ...w, sessions: allWeekSessions, volumeSessions: allWeekSessions });

          for (const s of allWeekSessions) {
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

      const setLogs = allSlotIds.length
        ? (
            await supabase
              .from('set_logs')
              .select('id, exercise_slot_id, done, rpe, logged_at')
              .in('exercise_slot_id', allSlotIds)
          ).data || []
        : [];

      // ─── Derived aggregates ───────────────────────────────────────────────

      // A session counts as "completed" if it's confirmed OR archived (archiving
      // happens after the coach reviews a confirmed session, and legacy sessions
      // may have been archived without ever getting a confirmation row).
      const isCompleted = (s) => confirmedIds.has(s.id) || !!s.archived_at;

      const totalSessions = allSessions.length;
      const totalSessionsConfirmed = allSessions.filter(isCompleted).length;
      const totalSetsDone = setLogs.filter((l) => l.done).length;

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
      // Volume uses volumeSessions (all sessions incl. archived) so archiving a
      // session doesn't make its prescribed load vanish from the chart.
      // Progress counts use sessions (non-archived only).
      const weeklyVolume = weeks.map((w) => {
        let pull = 0;
        let push = 0;
        for (const s of w.volumeSessions || []) {
          const v = computeSessionVolume(s.exercise_slots || []);
          pull += v.pull;
          push += v.push;
        }
        let sessionsConfirmed = 0;
        for (const s of w.sessions || []) {
          if (isCompleted(s)) sessionsConfirmed += 1;
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

      // ─── Per-exercise weekly tonnage ─────────────────────────────────────
      // For each exercise used anywhere in the program, build a point per
      // week: tonnage = Σ(sets × reps × weight_kg) across every slot using
      // that exercise in that week. Uses prescribed numbers so the curve
      // shows the programmed progression even before sets are logged.
      const exerciseMeta = {};   // id → { id, name, type }
      const byExercise = {};     // id → [{ week_number, label, tonnage }]
      for (const w of weeks) {
        const perExerciseTonnage = {};
        for (const s of w.sessions || []) {
          for (const slot of s.exercise_slots || []) {
            const ex = slot.exercise;
            if (!ex) continue;
            const reps = slot.reps || 0;
            // Bodyweight exercises (null/0 weight) count as 1 kg so they
            // still produce a visible progression curve.
            const weight = slot.weight_kg && slot.weight_kg > 0 ? slot.weight_kg : 1;
            const tonnage = (slot.sets || 0) * reps * weight;
            if (tonnage <= 0) continue;
            exerciseMeta[ex.id] = { id: ex.id, name: ex.name, type: ex.type };
            perExerciseTonnage[ex.id] = (perExerciseTonnage[ex.id] || 0) + tonnage;
          }
        }
        for (const exId of Object.keys(perExerciseTonnage)) {
          if (!byExercise[exId]) byExercise[exId] = [];
          byExercise[exId].push({
            week_number: w.week_number,
            label: w.label,
            tonnage: perExerciseTonnage[exId],
          });
        }
      }
      const exerciseProgress = {
        exercises: Object.values(exerciseMeta).sort((a, b) => a.name.localeCompare(b.name)),
        byExercise,
      };

      // Recent confirmations with session metadata.
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

      // ─── Session calendar ────────────────────────────────────────────────
      // Flatten scheduled sessions for the month calendar. Each entry is
      // keyed by its scheduled_date (YYYY-MM-DD) and flagged completed or
      // upcoming. Sessions without scheduled_date are omitted.
      const sessionCalendar = [];
      for (const s of allSessions) {
        if (!s.scheduled_date) continue;
        sessionCalendar.push({
          session_id: s.id,
          title: s.title,
          date: s.scheduled_date,
          completed: isCompleted(s),
        });
      }

      return {
        totalSessions,
        totalSessionsConfirmed,
        totalSets,
        totalSetsDone,
        weeksActive,
        avgRpe,
        weeklyVolume,
        recentConfirmations,
        sessionCalendar,
        exerciseProgress,
      };
    },
    enabled: !!(studentId || user?.id),
  });
}
