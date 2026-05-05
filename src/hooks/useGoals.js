import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';

/**
 * Coach-facing: list all goals for a given student.
 * `studentProfileId` is the profiles.id (== auth.uid() for that student),
 * not the students.id row id — see resolveStudentProfileId below.
 */
export function useStudentGoals(studentProfileId) {
  return useQuery({
    queryKey: ['goals', 'student', studentProfileId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('goals')
        .select('*, exercise:exercise_library(*), goal_progress(*)')
        .eq('student_id', studentProfileId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: !!studentProfileId,
  });
}

/**
 * Resolve a students.id row into its profiles.id. Coach pages receive the
 * students.id via the URL and need the profile id to create goals.
 */
export function useStudentProfileId(studentRowId) {
  return useQuery({
    queryKey: ['student-profile-id', studentRowId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('students')
        .select('profile_id')
        .eq('id', studentRowId)
        .single();
      if (error) throw error;
      return data.profile_id;
    },
    enabled: !!studentRowId,
  });
}

/** Student-facing: list the signed-in student's own goals + progress. */
export function useMyGoals() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['goals', 'mine', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('goals')
        .select('*, exercise:exercise_library(*), goal_progress(*)')
        .eq('student_id', user.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: !!user?.id,
  });
}

function invalidateGoals(qc) {
  qc.invalidateQueries({ queryKey: ['goals'] });
}

export function useCreateGoal() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (input) => {
      const { data, error } = await supabase
        .from('goals')
        .insert({ ...input, coach_id: user.id })
        .select('*, exercise:exercise_library(*)')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => invalidateGoals(qc),
  });
}

export function useUpdateGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...updates }) => {
      const { data, error } = await supabase
        .from('goals')
        .update(updates)
        .eq('id', id)
        .select('*, exercise:exercise_library(*)')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => invalidateGoals(qc),
  });
}

export function useDeleteGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const { error } = await supabase.from('goals').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => invalidateGoals(qc),
  });
}

export function useAddGoalProgress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ goalId, weight_kg, sets, reps, notes }) => {
      const { data, error } = await supabase
        .from('goal_progress')
        .insert({
          goal_id: goalId,
          weight_kg,
          sets: sets ?? null,
          reps: reps ?? null,
          notes: notes || null,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => invalidateGoals(qc),
  });
}

/**
 * Delete a single `goal_progress` row. The student is the only writer for
 * `goal_progress` (RLS: `Students manage own goal progress FOR ALL`), so a
 * straight DELETE under their auth context is sufficient. Coaches can read
 * but not delete a student's logged attempts — by design, attempts are the
 * student's record to curate.
 */
export function useDeleteGoalProgress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const { error } = await supabase.from('goal_progress').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => invalidateGoals(qc),
  });
}

export function useToggleGoalAchieved() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, achieved }) => {
      const { data, error } = await supabase
        .from('goals')
        .update({
          achieved,
          achieved_at: achieved ? new Date().toISOString() : null,
        })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => invalidateGoals(qc),
  });
}

/** Format a goal target into a short human-readable label. */
export function formatGoalTarget(goal) {
  if (!goal) return '';
  if (goal.kind === 'one_rm') {
    return `1RM @ ${goal.target_weight_kg}kg`;
  }
  return `${goal.target_sets} × ${goal.target_reps} @ ${goal.target_weight_kg}kg`;
}
