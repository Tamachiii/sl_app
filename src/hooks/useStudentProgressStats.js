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
 *   - weightHistory[]   [{ exercise_id, exercise_name, exercise_type, entries[] }]
 *     entries: [{ date, weight_kg, session_title }] — max weight per confirmed session, asc date
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
                id, sets, reps, duration_seconds, weight_kg,
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
      // slot metadata keyed by slot id — needed for weight history
      const slotMeta = {};

      for (const prog of programs || []) {
        for (const w of prog.weeks || []) {
          const weekSessions = (w.sessions || []).filter((s) => !s.archived_at);
          weeks.push({ ...w, sessions: weekSessions });
          for (const s of weekSessions) {
            allSessions.push(s);
            for (const slot of s.exercise_slots || []) {
              allSlotIds.push(slot.id);
              slotMeta[slot.id] = {
                exercise_id: slot.exercise.id,
                exercise_name: slot.exercise.name,
                exercise_type: slot.exercise.type,
                session_id: s.id,
                session_title: s.title,
                day_number: s.day_number,
                week_number: w.week_number,
              };
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

      // Build confirmed_at lookup per session_id for weight history dating.
      const confirmedAtBySession = {};
      for (const c of confirmations) {
        confirmedAtBySession[c.session_id] = c.confirmed_at;
      }

      // 4. Fetch set logs (including weight_kg now).
      const setLogs = allSlotIds.length
        ? (
            await supabase
              .from('set_logs')
              .select('id, exercise_slot_id, done, rpe, weight_kg, logged_at')
              .in('exercise_slot_id', allSlotIds)
          ).data || []
        : [];

      // ─── Derived aggregates ───────────────────────────────────────────────

      const totalSessions = allSessions.length;
      const totalSessionsConfirmed = allSessions.filter((s) => confirmedIds.has(s.id)).length;
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

      // ─── Weight history per exercise ──────────────────────────────────────
      // Only include sets that:
      //   • have weight_kg logged
      //   • belong to a confirmed session (so we have a reliable date)
      //
      // For each exercise, group by session_id and take the MAX weight per
      // session. Return entries sorted ascending by confirmed_at date.

      // exerciseMap: exercise_id → { name, type, bySession: { session_id → { weight_kg, date, session_title } } }
      const exerciseMap = {};

      for (const log of setLogs) {
        const weight = log.weight_kg != null ? Number(log.weight_kg) : null;
        if (weight == null) continue;

        const meta = slotMeta[log.exercise_slot_id];
        if (!meta) continue;

        const confirmedAt = confirmedAtBySession[meta.session_id];
        if (!confirmedAt) continue; // not yet confirmed — skip

        if (!exerciseMap[meta.exercise_id]) {
          exerciseMap[meta.exercise_id] = {
            name: meta.exercise_name,
            type: meta.exercise_type,
            bySession: {},
          };
        }

        const existing = exerciseMap[meta.exercise_id].bySession[meta.session_id];
        if (!existing || weight > existing.weight_kg) {
          exerciseMap[meta.exercise_id].bySession[meta.session_id] = {
            weight_kg: weight,
            date: confirmedAt,
            session_title: meta.session_title,
            day_number: meta.day_number,
            week_number: meta.week_number,
          };
        }
      }

      const weightHistory = Object.entries(exerciseMap)
        .map(([exercise_id, data]) => ({
          exercise_id,
          exercise_name: data.name,
          exercise_type: data.type,
          entries: Object.values(data.bySession).sort(
            (a, b) => new Date(a.date) - new Date(b.date)
          ),
        }))
        .filter((e) => e.entries.length > 0)
        // Sort by exercise name for stable ordering
        .sort((a, b) => a.exercise_name.localeCompare(b.exercise_name));

      return {
        totalSessions,
        totalSessionsConfirmed,
        totalSets,
        totalSetsDone,
        weeksActive,
        avgRpe,
        weeklyVolume,
        recentConfirmations,
        weightHistory,
      };
    },
    enabled: !!user?.id,
  });
}
