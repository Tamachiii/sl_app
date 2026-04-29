import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';

export function useStudents() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['students'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('students')
        .select(`
          *,
          profile:profiles!students_profile_id_fkey(full_name)
        `)
        .order('created_at');
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });
}

/**
 * Resolve the signed-in user's `students.id` row id. Lets student-side pages
 * pass it into shared hooks (e.g. `useProgramsForStudent`) that the coach
 * already drives by id. Returns `undefined` while loading.
 */
export function useMyStudentId() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['my-student-id', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('students')
        .select('id')
        .eq('profile_id', user.id)
        .single();
      if (error) throw error;
      return data.id;
    },
    enabled: !!user?.id,
  });
}

/**
 * Student-facing: resolve the signed-in student's coach profile (id +
 * full_name) so messaging / "view my coach" surfaces don't have to refetch
 * piecewise. Returns `null` if the student has no coach assigned (shouldn't
 * happen in production but guards dev seeds).
 */
export function useMyCoach() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['my-coach', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('students')
        .select('coach:profiles!students_coach_id_fkey(id, full_name)')
        .eq('profile_id', user.id)
        .single();
      if (error) throw error;
      return data?.coach || null;
    },
    enabled: !!user?.id,
  });
}
