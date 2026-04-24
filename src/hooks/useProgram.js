import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';

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
        .select('id, student_id, name, sort_order, is_active, created_at, weeks(id)')
        .eq('student_id', studentId)
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

export function useDeleteProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ programId }) => {
      const { error } = await supabase.from('programs').delete().eq('id', programId);
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
 * { programName, activeWeek } in a single pass. RLS scopes the programs
 * query to this coach's students.
 *
 * "Active week" mirrors the student-side `findActiveWeek`: first week with
 * an unconfirmed non-archived session, falling back to the last week.
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
            sessions(id, archived_at))
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
        summary[p.student_id] = {
          programName: p.name || null,
          activeWeek: active
            ? { week_number: active.week_number, label: active.label }
            : null,
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
