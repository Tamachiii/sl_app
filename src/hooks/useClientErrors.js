import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';

/**
 * Coach-only: the most recent client-error reports, for in-app triage. RLS
 * restricts SELECT to coaches, so this is a no-op for students. Bounded to
 * the newest `limit` rows so the dashboard stays cheap.
 */
export function useClientErrors(limit = 20) {
  const { role } = useAuth();
  return useQuery({
    queryKey: ['client-errors', limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('client_errors')
        .select('id, user_id, role, message, url, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data || [];
    },
    enabled: role === 'coach',
    staleTime: 1000 * 60,
  });
}
