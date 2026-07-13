import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import { isoDate } from '../lib/day';

/**
 * The signed-in student's recent bodyweight entries (newest first). Feeds the
 * profile card and the relative-strength figure on the records surface.
 * Bounded to the last 60 entries — enough for a trend, cheap to fetch.
 */
export function useBodyweightLogs() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['bodyweight-logs', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('bodyweight_logs')
        .select('id, weight_kg, logged_on')
        .eq('student_id', user.id)
        .order('logged_on', { ascending: false })
        .limit(60);
      if (error) throw error;
      // numeric comes back as a string — normalize to Number for the UI/math.
      return (data || []).map((r) => ({ ...r, weight_kg: Number(r.weight_kg) }));
    },
    enabled: !!user?.id,
    staleTime: 1000 * 60,
  });
}

/**
 * Log (or correct) today's bodyweight — upsert on (student_id, logged_on) so a
 * second entry the same day overwrites rather than tripping the UNIQUE. Online
 * only (a new-row insert can't safely queue offline); the caller gates on
 * connectivity where needed.
 */
export function useLogBodyweight() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async ({ weightKg, loggedOn }) => {
      const row = {
        student_id: user.id,
        weight_kg: weightKg,
        // LOCAL calendar date (isoDate), never toISOString().slice — the
        // latter is UTC, so near midnight in a non-UTC zone it files the
        // entry under the wrong day and the (student_id, logged_on) upsert
        // key lands on the wrong row.
        logged_on: loggedOn || isoDate(new Date()),
      };
      const { data, error } = await supabase
        .from('bodyweight_logs')
        .upsert(row, { onConflict: 'student_id,logged_on' })
        .select('id, weight_kg, logged_on')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bodyweight-logs', user?.id] });
      // Relative-strength on the records surface reads the latest bodyweight.
      qc.invalidateQueries({ queryKey: ['student-records'] });
    },
  });
}
