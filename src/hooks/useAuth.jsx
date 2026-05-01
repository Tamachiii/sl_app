import { createContext, useContext, useEffect, useState, useMemo, useCallback } from 'react';
import { supabase } from '../lib/supabase';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  async function fetchProfile(userId) {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();
    if (error) {
      console.error('Failed to fetch profile:', error.message);
      setProfile(null);
      return;
    }
    setProfile(data);
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      const u = session?.user ?? null;
      setUser(u);
      if (u) {
        fetchProfile(u.id).finally(() => setIsLoading(false));
      } else {
        setIsLoading(false);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        const u = session?.user ?? null;
        setUser(u);
        if (u) {
          fetchProfile(u.id);
        } else {
          setProfile(null);
        }
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  const signIn = useCallback(async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
  }, []);

  /**
   * Patch the signed-in user's `profiles` row and refresh the in-memory
   * `profile` state on success. Callers pass only the columns they want to
   * update (e.g. `{ full_name }`); the DB-side trigger pins `id`, `role`
   * and `created_at` so a malicious payload can't escalate role.
   */
  const updateProfile = useCallback(
    async (patch) => {
      if (!user?.id) return { error: new Error('Not signed in') };
      const { data, error } = await supabase
        .from('profiles')
        .update(patch)
        .eq('id', user.id)
        .select()
        .single();
      if (!error && data) setProfile(data);
      return { error };
    },
    [user?.id]
  );

  /**
   * Update the signed-in user's auth password. Wraps Supabase's
   * `auth.updateUser` so the Profile page doesn't have to import supabase
   * directly. Returns `{ error }` shaped like the rest of this context.
   */
  const updatePassword = useCallback(async (newPassword) => {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    return { error };
  }, []);

  const role = profile?.role ?? null;

  const value = useMemo(
    () => ({ user, profile, role, isLoading, signIn, signOut, updateProfile, updatePassword }),
    [user, profile, role, isLoading, signIn, signOut, updateProfile, updatePassword]
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  // Return a no-op fallback when no provider is mounted (e.g. isolated tests).
  // In production, ProtectedRoute always ensures AuthProvider is an ancestor.
  if (!ctx) return {};
  return ctx;
}
