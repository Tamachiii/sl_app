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
