import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';

/**
 * Fetch the confirmation (if any) for a single session.
 * Returns `null` when the session hasn't been confirmed yet.
 */
export function useSessionConfirmation(sessionId) {
  return useQuery({
    queryKey: ['session-confirmation', sessionId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('session_confirmations')
        .select('*')
        .eq('session_id', sessionId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!sessionId,
  });
}

/**
 * Coach-facing: fetch all confirmed sessions across ALL of the coach's students.
 * Uses RLS to scope programs to the current coach automatically.
 */
export function useAllConfirmations() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['all-confirmations', user?.id],
    queryFn: async () => {
      // 1. Resolve student names
      const { data: students, error: sErr } = await supabase
        .from('students')
        .select('id, profile:profiles!students_profile_id_fkey(full_name)');
      if (sErr) throw sErr;

      const studentNames = {};
      for (const s of students || []) {
        studentNames[s.id] = s.profile?.full_name || 'Student';
      }

      // 2. Fetch all programs (RLS scopes to this coach's students automatically)
      const { data: programs, error: pErr } = await supabase
        .from('programs')
        .select(`
          id, student_id,
          weeks(id, week_number, label,
            sessions(id, title, day_number, archived_at)
          )
        `);
      if (pErr) throw pErr;

      // 3. Build session metadata map
      const sessionIds = [];
      const sessionMeta = {};
      for (const prog of programs || []) {
        for (const w of prog.weeks || []) {
          for (const s of w.sessions || []) {
            sessionIds.push(s.id);
            sessionMeta[s.id] = {
              session_id: s.id,
              session_title: s.title,
              day_number: s.day_number,
              archived_at: s.archived_at,
              week_number: w.week_number,
              week_label: w.label,
              student_id: prog.student_id,
              student_name: studentNames[prog.student_id] || 'Student',
            };
          }
        }
      }

      if (sessionIds.length === 0) return [];

      // 4. Fetch all confirmations for those sessions
      const { data: confirmations, error: cErr } = await supabase
        .from('session_confirmations')
        .select('*')
        .in('session_id', sessionIds)
        .order('confirmed_at', { ascending: false });
      if (cErr) throw cErr;

      return (confirmations || []).map((c) => ({ ...c, ...sessionMeta[c.session_id] }));
    },
    enabled: !!user?.id,
  });
}

/**
 * Lightweight query: the set of session ids that the current student has
 * confirmed. Cheap to check from the StudentHome list.
 */
export function useMyConfirmedSessionIds() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-confirmed-session-ids', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('session_confirmations')
        .select('session_id')
        .eq('student_id', user.id);
      if (error) throw error;
      return new Set((data || []).map((r) => r.session_id));
    },
    enabled: !!user?.id,
  });
}

/**
 * Coach-facing: which sessions in a given week have been confirmed.
 */
export function useWeekConfirmedSessionIds(weekId) {
  return useQuery({
    queryKey: ['week-confirmed-session-ids', weekId],
    queryFn: async () => {
      // First fetch sessions in this week so we can filter confirmations.
      const { data: sessions, error: sErr } = await supabase
        .from('sessions')
        .select('id')
        .eq('week_id', weekId);
      if (sErr) throw sErr;

      const ids = (sessions || []).map((s) => s.id);
      if (ids.length === 0) return new Set();

      const { data: confs, error: cErr } = await supabase
        .from('session_confirmations')
        .select('session_id')
        .in('session_id', ids);
      if (cErr) throw cErr;

      return new Set((confs || []).map((c) => c.session_id));
    },
    enabled: !!weekId,
  });
}

function invalidateConfirmationQueries(qc) {
  qc.invalidateQueries({ queryKey: ['session-confirmation'] });
  qc.invalidateQueries({ queryKey: ['my-confirmed-session-ids'] });
  qc.invalidateQueries({ queryKey: ['week-confirmed-session-ids'] });
  qc.invalidateQueries({ queryKey: ['student-confirmations'] });
}

export function useConfirmSession() {
  const qc = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ sessionId, notes }) => {
      const { data, error } = await supabase
        .from('session_confirmations')
        .insert({
          session_id: sessionId,
          student_id: user.id,
          notes: notes || null,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => invalidateConfirmationQueries(qc),
  });
}

export function useUnconfirmSession() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId }) => {
      const { error } = await supabase
        .from('session_confirmations')
        .delete()
        .eq('session_id', sessionId);
      if (error) throw error;
    },
    onSuccess: () => invalidateConfirmationQueries(qc),
  });
}
