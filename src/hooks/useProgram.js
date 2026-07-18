import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import {
  parseISODate,
  isoDate,
  addDays,
  startOfWeekMonday,
  preferSession,
} from '../lib/day';

/**
 * List all programs for a student (periodization blocks), ordered by sort_order.
 * Returns shallow metadata — no weeks/sessions. Use `useProgram(programId)` to
 * fetch a single program's full tree.
 */
export function useProgramsForStudent(studentId) {
  return useQuery({
    queryKey: ['programs', studentId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('programs')
        .select('id, student_id, name, sort_order, is_active, status, submitted_at, created_at, weeks(id)')
        .eq('student_id', studentId)
        .is('deleted_at', null)
        .order('sort_order', { ascending: true });
      if (error) throw error;
      return data || [];
    },
    enabled: !!studentId,
  });
}

/**
 * Fetch a single program with its weeks (and session ids) by program id.
 * This is the detail fetch that `WeekTimeline` consumes.
 */
export function useProgram(programId) {
  return useQuery({
    queryKey: ['program', programId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('programs')
        .select('*, weeks(*, sessions(id))')
        .eq('id', programId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      data.weeks = (data.weeks || []).sort((a, b) => a.week_number - b.week_number);
      return data;
    },
    enabled: !!programId,
  });
}

/**
 * Convenience resolver: the currently-active program for a student, with weeks.
 * Used by CopyDialog (destination = the student's active program) and anywhere
 * the "one program per student" shortcut is still appropriate.
 */
export function useActiveProgram(studentId) {
  return useQuery({
    queryKey: ['activeProgram', studentId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('programs')
        .select('*, weeks(*, sessions(id))')
        .eq('student_id', studentId)
        .eq('is_active', true)
        .is('deleted_at', null)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      data.weeks = (data.weeks || []).sort((a, b) => a.week_number - b.week_number);
      return data;
    },
    enabled: !!studentId,
  });
}

function invalidateProgramQueries(qc, studentId) {
  qc.invalidateQueries({ queryKey: ['programs', studentId] });
  qc.invalidateQueries({ queryKey: ['programs-trash', studentId] });
  qc.invalidateQueries({ queryKey: ['activeProgram', studentId] });
  qc.invalidateQueries({ queryKey: ['program'] });
  // Student-side views read through is_active; refresh them too.
  qc.invalidateQueries({ queryKey: ['student-program-details'] });
  qc.invalidateQueries({ queryKey: ['student-progress-stats'] });
}

/**
 * Creates a default program for a student if none exists. The first program
 * is always active (so the student sees it).
 */
export function useEnsureProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ studentId }) => {
      const { data, error } = await supabase
        .from('programs')
        .insert({ student_id: studentId, name: 'Program 1', is_active: true, sort_order: 0 })
        .select('*, weeks(*, sessions(id))')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, vars) => {
      invalidateProgramQueries(qc, vars.studentId);
    },
  });
}

/**
 * Create a new program for a student. Pass `setActive: true` to make it the
 * active one immediately (deactivates the current active program first, to
 * respect the partial unique index).
 */
export function useCreateProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ studentId, name, setActive = false }) => {
      // Pick next sort_order.
      const { data: existing, error: listErr } = await supabase
        .from('programs')
        .select('sort_order')
        .eq('student_id', studentId)
        .order('sort_order', { ascending: false })
        .limit(1);
      if (listErr) throw listErr;
      const nextSort = (existing?.[0]?.sort_order ?? -1) + 1;

      if (setActive) {
        const { error: deactErr } = await supabase
          .from('programs')
          .update({ is_active: false })
          .eq('student_id', studentId)
          .eq('is_active', true);
        if (deactErr) throw deactErr;
      }

      const { data, error } = await supabase
        .from('programs')
        .insert({
          student_id: studentId,
          name,
          sort_order: nextSort,
          is_active: setActive,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (newProg, vars) => {
      // Seed the list cache synchronously so the parent's `onSelect(newProg.id)`
      // callback sees the new program in the list before the invalidation refetch
      // lands — otherwise CoachHome's stale-?program cleanup strips it.
      qc.setQueryData(['programs', vars.studentId], (old) => {
        if (!Array.isArray(old)) return old;
        return [...old, { ...newProg, weeks: [] }];
      });
      invalidateProgramQueries(qc, vars.studentId);
    },
  });
}

/**
 * Coach approves a student-authored draft (Phase 3.4c): the approve_program RPC
 * materializes set_logs from the slot scalars and flips status to 'approved'.
 */
export function useApproveProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ programId }) => {
      const { data, error } = await supabase.rpc('approve_program', { p_program_id: programId });
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, vars) => invalidateProgramQueries(qc, vars.studentId),
  });
}

/** Coach sends a submitted draft back for revision (clears submitted_at). */
export function useSendBackProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ programId }) => {
      const { data, error } = await supabase.rpc('send_back_program', { p_program_id: programId });
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, vars) => invalidateProgramQueries(qc, vars.studentId),
  });
}

export function useRenameProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ programId, name }) => {
      const { data, error } = await supabase
        .from('programs')
        .update({ name })
        .eq('id', programId)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, vars) => {
      invalidateProgramQueries(qc, vars.studentId);
    },
  });
}

/**
 * "Delete" is archive-first: stamp deleted_at (and clear is_active — a
 * trashed row must never hold the one-active-per-student slot) instead of
 * a hard DELETE that used to cascade a student's entire logged history
 * away in one click. Restore from the trash NULLs it back out.
 */
export function useDeleteProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ programId }) => {
      const { error } = await supabase
        .from('programs')
        .update({ deleted_at: new Date().toISOString(), is_active: false })
        .eq('id', programId);
      if (error) throw error;
      return programId;
    },
    onSuccess: (_d, vars) => {
      invalidateProgramQueries(qc, vars.studentId);
    },
  });
}

/** Programs currently in the trash, newest first. */
export function useTrashedPrograms(studentId) {
  return useQuery({
    queryKey: ['programs-trash', studentId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('programs')
        .select('id, student_id, name, deleted_at, weeks(id)')
        .eq('student_id', studentId)
        .not('deleted_at', 'is', null)
        .order('deleted_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: !!studentId,
  });
}

export function useRestoreProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ programId }) => {
      // Restored programs come back INACTIVE — the coach re-activates
      // explicitly, so a restore can never bump the current active block.
      const { error } = await supabase
        .from('programs')
        .update({ deleted_at: null })
        .eq('id', programId);
      if (error) throw error;
      return programId;
    },
    onSuccess: (_d, vars) => {
      invalidateProgramQueries(qc, vars.studentId);
    },
  });
}

/**
 * Permanent delete, offered only from the trash. Client-side gate (for a
 * friendly message) + DB BEFORE DELETE trigger (the real guarantee) both
 * refuse while the program contains any logged set — hard delete exists
 * for scaffolding mistakes, never for training history.
 */
export function useHardDeleteProgram() {
  const qc = useQueryClient();
  return useMutation({
    // TrashDialog renders its own inline "can't delete — has logged training"
    // message on failure, so opt out of the global error toast to avoid
    // double-messaging the same guard.
    meta: { skipErrorToast: true },
    mutationFn: async ({ programId }) => {
      const { count, error: cErr } = await supabase
        .from('set_logs')
        .select('id, exercise_slots!inner(sessions!inner(weeks!inner(program_id)))', {
          count: 'exact',
          head: true,
        })
        .eq('exercise_slots.sessions.weeks.program_id', programId)
        .or(
          'done.eq.true,failed.eq.true,skipped.eq.true,rpe.not.is.null,actual_reps.not.is.null,actual_weight_kg.not.is.null'
        );
      if (cErr) throw cErr;
      if ((count ?? 0) > 0) {
        const err = new Error('program has logged sets');
        err.code = 'PROGRAM_HAS_LOGGED_SETS';
        throw err;
      }
      const { error } = await supabase
        .from('programs')
        .delete()
        .eq('id', programId)
        .not('deleted_at', 'is', null); // only ever from the trash
      if (error) throw error;
      return programId;
    },
    onSuccess: (_d, vars) => {
      invalidateProgramQueries(qc, vars.studentId);
    },
  });
}

/**
 * Make a program the active one for its student. Deactivates the current
 * active program in the same mutation to respect the partial unique index.
 */
export function useSetActiveProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ programId, studentId }) => {
      const { error: deactErr } = await supabase
        .from('programs')
        .update({ is_active: false })
        .eq('student_id', studentId)
        .eq('is_active', true);
      if (deactErr) throw deactErr;

      const { data, error } = await supabase
        .from('programs')
        .update({ is_active: true })
        .eq('id', programId)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, vars) => {
      invalidateProgramQueries(qc, vars.studentId);
    },
  });
}

/**
 * Rewrite sort_order for an ordered list of programs within the same student.
 * Two-pass update (park at TMP_BASE+idx, then assign idx) mirrors
 * `useReorderWeeks` — sort_order has no unique constraint but we keep the
 * same pattern so the code reads the same way.
 */
export function useReorderPrograms() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ studentId, orderedIds }) => {
      const TMP_BASE = 100000;

      for (let i = 0; i < orderedIds.length; i++) {
        const { error } = await supabase
          .from('programs')
          .update({ sort_order: TMP_BASE + i })
          .eq('id', orderedIds[i]);
        if (error) throw error;
      }

      for (let i = 0; i < orderedIds.length; i++) {
        const { error } = await supabase
          .from('programs')
          .update({ sort_order: i })
          .eq('id', orderedIds[i]);
        if (error) throw error;
      }

      return { studentId };
    },
    onMutate: async ({ studentId, orderedIds }) => {
      await qc.cancelQueries({ queryKey: ['programs', studentId] });
      const snapshot = qc.getQueryData(['programs', studentId]);
      if (Array.isArray(snapshot)) {
        const byId = new Map(snapshot.map((p) => [p.id, p]));
        const reordered = orderedIds
          .map((id, idx) => {
            const p = byId.get(id);
            return p ? { ...p, sort_order: idx } : null;
          })
          .filter(Boolean);
        qc.setQueryData(['programs', studentId], reordered);
      }
      return { snapshot };
    },
    onError: (_err, { studentId }, ctx) => {
      if (ctx?.snapshot !== undefined) {
        qc.setQueryData(['programs', studentId], ctx.snapshot);
      }
    },
    onSettled: (_d, _e, { studentId }) => {
      qc.invalidateQueries({ queryKey: ['programs', studentId] });
    },
  });
}

/**
 * Coach dashboard summary: for each student the coach manages, resolve
 * { programName, activeWeek, weekDays } in a single pass. RLS scopes the
 * programs query to this coach's students.
 *
 * "Active week" mirrors the student-side `findActiveWeek`: first week with
 * an unconfirmed non-archived session, falling back to the last week.
 *
 * `weekDays` is a 7-slot M..S array for the CURRENT CALENDAR week (Mon–Sun),
 * carrying the mapped session and its confirmation flag. Mirroring the
 * student home strip: sessions with a scheduled_date place on their true
 * calendar date — from any training week, and only when that date falls in
 * the current week — while undated sessions keep the legacy day_number
 * placement from the active training week. Same-day collisions resolve via
 * `preferSession`. Powers the `StudentWeekStrip` on each athlete card
 * without an N+1 fetch.
 */
export function useCoachDashboardPrograms() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['coach-dashboard-programs', user?.id],
    queryFn: async () => {
      const { data: programs, error: pErr } = await supabase
        .from('programs')
        .select(`
          student_id, name,
          weeks(id, week_number, label,
            sessions(id, title, day_number, scheduled_date, archived_at))
        `)
        .eq('is_active', true);
      if (pErr) throw pErr;

      const sessionIds = [];
      for (const p of programs || []) {
        for (const w of p.weeks || []) {
          for (const s of w.sessions || []) sessionIds.push(s.id);
        }
      }

      let confirmedIds = new Set();
      if (sessionIds.length > 0) {
        const { data: confs, error: cErr } = await supabase
          .from('session_confirmations')
          .select('session_id')
          .in('session_id', sessionIds);
        if (cErr) throw cErr;
        confirmedIds = new Set((confs || []).map((c) => c.session_id));
      }

      const monday = startOfWeekMonday(new Date());

      const summary = {};
      for (const p of programs || []) {
        const weeks = (p.weeks || [])
          .slice()
          .sort((a, b) => a.week_number - b.week_number);
        let active = null;
        for (const w of weeks) {
          const hasOpen = (w.sessions || []).some(
            (s) => !s.archived_at && !confirmedIds.has(s.id)
          );
          if (hasOpen) { active = w; break; }
        }
        if (!active && weeks.length > 0) active = weeks[weeks.length - 1];

        // Dated sessions place by true calendar date — from ANY training week,
        // so a "week 1" session dated next Monday never bleeds into this week.
        const byDate = new Map();
        for (const w of weeks) {
          for (const s of w.sessions || []) {
            if (!s.scheduled_date || !parseISODate(s.scheduled_date)) continue;
            const key = s.scheduled_date.slice(0, 10);
            byDate.set(key, preferSession(byDate.get(key), s, confirmedIds));
          }
        }

        // Undated sessions have no calendar anchor: keep the legacy
        // day_number placement, from the active training week only.
        const undatedByDay = {};
        for (const s of active?.sessions || []) {
          if (s.scheduled_date && parseISODate(s.scheduled_date)) continue;
          const d = s.day_number;
          if (d < 1 || d > 7) continue;
          undatedByDay[d] = preferSession(undatedByDay[d], s, confirmedIds);
        }

        const weekDays = Array.from({ length: 7 }, (_, i) => {
          const dated = byDate.get(isoDate(addDays(monday, i))) ?? null;
          // Dated placement wins ties, but preferSession keeps an archived
          // or confirmed dated session from hiding a pending undated one.
          const s = preferSession(dated, undatedByDay[i + 1] ?? null, confirmedIds);
          return {
            dayNumber: i + 1,
            session: s
              ? { id: s.id, title: s.title, archived_at: s.archived_at }
              : null,
            confirmed: s ? confirmedIds.has(s.id) : false,
          };
        });

        summary[p.student_id] = {
          programName: p.name || null,
          activeWeek: active
            ? { week_number: active.week_number, label: active.label }
            : null,
          weekDays,
        };
      }
      return summary;
    },
    enabled: !!user?.id,
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['program'] });
      qc.invalidateQueries({ queryKey: ['programs'] });
      qc.invalidateQueries({ queryKey: ['activeProgram'] });
    },
  });
}
