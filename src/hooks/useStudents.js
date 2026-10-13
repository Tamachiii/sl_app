import { queryOptions, useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';

/**
 * Coach-facing: the athletes the signed-in user coaches.
 *
 * The `coach_id` filter is the definition of that list, not a shortcut for
 * RLS. `students` has TWO read policies — the rows you coach, and the row in
 * which you are the athlete — so an unfiltered read answers "every link I am
 * part of". A coach who is also somebody's athlete (an account promoted to
 * coach that still has its athlete row, or a link forged before the database
 * closed that path) would find themselves in their own roster, in the message
 * list and in the copy dialog, with no way to remove the card.
 *
 * For an athlete the list is empty, which is the right answer: MessageThread
 * calls this for both roles and only reads it as a coach.
 */
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
        .eq('coach_id', user.id)
        .order('created_at');
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });
}

/**
 * The `students.id` of an athlete's own row, as query options — the ONE cache
 * entry every reader of that id shares: `['my-student-id', userId]`.
 *
 * A component reads it with `useMyStudentId()`. A `queryFn` that needs the id
 * before its own reads asks the cache for it:
 *
 *   const studentRowId = await queryClient.ensureQueryData(myStudentIdQueryOptions(user.id));
 *
 * which answers from the cache, joins the read that is already in flight, or
 * starts it — so a page whose three queries all need the id sends ONE request
 * for it, where each of them used to send its own before doing anything else.
 *
 * Never stale: the row an account trains under is not re-created by anything
 * in the app (`students` has no INSERT or DELETE policy, and a change of coach
 * updates the row in place). The entry is not persisted, so a reload reads it
 * again.
 */
export function myStudentIdQueryOptions(userId) {
  return queryOptions({
    queryKey: ['my-student-id', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('students')
        .select('id')
        .eq('profile_id', userId)
        .single();
      if (error) throw error;
      return data.id;
    },
    staleTime: Infinity,
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
    ...myStudentIdQueryOptions(user?.id),
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
