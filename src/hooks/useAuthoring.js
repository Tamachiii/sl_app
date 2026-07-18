import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';

// ── Phase 3.4b: student program authoring (draft → coach approve) ──────────
// Online-only by design (see docs/INVARIANTS.md): these are plain
// server-generated-id INSERTs/UPDATEs on the student's OWN draft, gated in the
// UI on useOnlineStatus. They never touch set_logs — the coach's approve_program
// RPC materializes per-set targets from the slot scalars at approval time.

/** The signed-in student's current draft program (one at a time), or null. */
export function useMyDraft() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-draft', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('programs')
        .select('id, name, status, submitted_at, created_at')
        .eq('created_by', user.id)
        .eq('status', 'draft')
        .is('deleted_at', null)
        .maybeSingle();
      if (error) throw error;
      return data || null;
    },
    enabled: !!user?.id,
  });
}

/** Full draft tree (weeks → sessions → slots + exercise meta) for the builder. */
export function useDraftTree(programId) {
  return useQuery({
    queryKey: ['draft-tree', programId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('programs')
        .select(`
          id, name, status, submitted_at,
          weeks(
            id, week_number, label,
            sessions(
              id, title, day_number, sort_order,
              exercise_slots(
                id, exercise_id, sets, reps, weight_kg, duration_seconds, rest_seconds, sort_order,
                exercise:exercise_library(id, name, type)
              )
            )
          )
        `)
        .eq('id', programId)
        .maybeSingle();
      if (error) throw error;
      if (data) {
        data.weeks = (data.weeks || []).sort((a, b) => a.week_number - b.week_number);
        for (const w of data.weeks) {
          w.sessions = (w.sessions || []).sort((a, b) => a.sort_order - b.sort_order);
          for (const s of w.sessions) {
            s.exercise_slots = (s.exercise_slots || []).sort((a, b) => a.sort_order - b.sort_order);
          }
        }
      }
      return data;
    },
    enabled: !!programId,
  });
}

/** Create a draft program owned by the signed-in student (one draft allowed). */
export function useCreateDraft() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async ({ name }) => {
      const { data: st, error: sErr } = await supabase
        .from('students')
        .select('id')
        .eq('profile_id', user.id)
        .maybeSingle();
      if (sErr) throw sErr;
      if (!st) throw new Error('No student profile found');
      const { data, error } = await supabase
        .from('programs')
        .insert({
          student_id: st.id,
          created_by: user.id,
          status: 'draft',
          is_active: false,
          name: (name || '').trim() || 'My program',
          sort_order: 0,
        })
        .select('id')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-draft'] }),
  });
}

function invalidateTree(qc, programId) {
  qc.invalidateQueries({ queryKey: ['draft-tree', programId] });
}

export function useAddDraftWeek() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ programId, weekNumber }) => {
      const { data, error } = await supabase
        .from('weeks')
        .insert({ program_id: programId, week_number: weekNumber })
        .select('id')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, { programId }) => invalidateTree(qc, programId),
  });
}

export function useAddDraftSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ weekId, title, dayNumber, sortOrder }) => {
      const { data, error } = await supabase
        .from('sessions')
        .insert({ week_id: weekId, title: title || 'Session', day_number: dayNumber ?? 1, sort_order: sortOrder ?? 0 })
        .select('id')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, { programId }) => invalidateTree(qc, programId),
  });
}

export function useAddDraftSlot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, exerciseId, sets, reps, weightKg, sortOrder }) => {
      // NOTE: no set_logs are materialized here — the coach's approve_program
      // RPC does that from these slot scalars at approval time.
      const { error } = await supabase
        .from('exercise_slots')
        .insert({
          session_id: sessionId,
          exercise_id: exerciseId,
          sets: sets ?? 3,
          reps: reps ?? 5,
          weight_kg: weightKg ?? null,
          sort_order: sortOrder ?? 0,
        });
      if (error) throw error;
    },
    onSuccess: (_d, { programId }) => invalidateTree(qc, programId),
  });
}

export function useUpdateDraftSlot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ slotId, sets, reps, weightKg }) => {
      const patch = {};
      if (sets != null) patch.sets = sets;
      if (reps !== undefined) patch.reps = reps;
      if (weightKg !== undefined) patch.weight_kg = weightKg;
      const { error } = await supabase.from('exercise_slots').update(patch).eq('id', slotId);
      if (error) throw error;
    },
    onSuccess: (_d, { programId }) => invalidateTree(qc, programId),
  });
}

// Generic draft-row delete (weeks/sessions/exercise_slots cascade downward).
export function useDeleteDraftRow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ table, id }) => {
      const { error } = await supabase.from(table).delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: (_d, { programId }) => invalidateTree(qc, programId),
  });
}

/** Submit the draft for coach approval (stamps submitted_at). */
export function useSubmitDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ programId }) => {
      const { error } = await supabase
        .from('programs')
        .update({ submitted_at: new Date().toISOString() })
        .eq('id', programId);
      if (error) throw error;
    },
    onSuccess: (_d, { programId }) => {
      invalidateTree(qc, programId);
      qc.invalidateQueries({ queryKey: ['my-draft'] });
    },
  });
}

/** Discard the whole draft (hard delete — a draft has no logged training). */
export function useDeleteDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ programId }) => {
      const { error } = await supabase.from('programs').delete().eq('id', programId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-draft'] }),
  });
}
