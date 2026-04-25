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
