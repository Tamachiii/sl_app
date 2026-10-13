import { createContext, useContext, useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { setErrorReporterUser } from '../lib/errorReporter';
import { replayQueuedWrites } from '../lib/queryClient';
import { readStoredUser } from '../lib/storedSession';
import { readCachedProfile, writeCachedProfile, forgetCachedProfile } from '../lib/profileCache';

const AuthContext = createContext(null);

// How often the role of a signed-in account is asked for again while it is
// not known (see the effect of the provider).
export const ROLE_RETRY_MS = 10 * 1000;

// `navigator.onLine === false` is the reliable half of that property: no
// network interface at all. `true` promises nothing.
const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

// No read of the profile was made for the account that is signed in.
const NOT_READ = Object.freeze({ userId: null, state: 'none', done: Promise.resolve() });

// Two rows of `profiles` that say the same.
function sameRow(a, b) {
  if (!a || !b) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

// WHO IS SIGNED IN, AND WHAT THE APP WAITS FOR
//
// Two things are known before anything is asked: the session this device
// stores (lib/storedSession.js) and the profile it remembers for that account
// (lib/profileCache.js). The provider starts from them, so an app opened by
// its owner renders at once — with or without a network.
//
// It used to start from nothing and wait for two answers. `auth.getSession()`
// first: with an expired token and no network that is fifty seconds of
// spinner, and then "no session" — the app sent its owner to a login form that
// cannot work offline. Then the profile, a request that was never kept: with a
// valid token and no network it failed after seven seconds, the role was
// unknown, and the launch ended on the same login form.
//
// What auth-js says afterwards is listened to, with three rules:
//   - Only SIGNED_OUT signs the user out. A session that cannot be read — the
//     token has expired and its refresh got no answer — is not a sign-out:
//     auth-js keeps the stored session in that case, and removes it itself
//     (with a SIGNED_OUT) when the server refused the refresh.
//   - An event about the account that is already signed in changes nothing.
//     auth-js emits SIGNED_IN on every return to the tab and TOKEN_REFRESHED
//     every hour; each used to hand a new `user` object to every component
//     that reads it and to send a request for the profile.
//   - A profile that is known is never replaced by a failed read.
//
// `isLoading` is "not known yet who is signed in, or in which role" — what
// ProtectedRoute holds the pages back for. It is false from the first render
// when the device knows both, and never waits for a request that cannot be
// made: offline, an account whose role this device has not seen yet goes
// through without one (the index route waits for it, routes.jsx).
export function AuthProvider({ children }) {
  const [known] = useState(() => {
    const storedUser = readStoredUser();
    return { user: storedUser, profile: storedUser ? readCachedProfile(storedUser.id) : null };
  });
  const [user, setUser] = useState(known.user);
  const [profile, setProfile] = useState(known.profile);
  const [isLoading, setIsLoading] = useState(() => !(known.user && (known.profile || isOffline())));

  // The same three, for what runs outside a render: the answers of auth-js and
  // of the profile read arrive in callbacks, where state is a render behind.
  const who = useRef(known.user);
  const hasProfile = useRef(!!known.profile);
  // The read of the profile for the signed-in account: one per account and per
  // launch, made again only when it failed.
  const profileRead = useRef(NOT_READ);
  // Whether auth-js held a usable session the last time it said anything.
  const sessionKnown = useRef(false);

  const ensureProfile = useCallback((userId) => {
    const last = profileRead.current;
    if (last.userId === userId && last.state !== 'failed') return last.done;
    // Nothing can answer, and supabase-js would first wait for a token refresh
    // that cannot be made either. Asked again when the device is back.
    if (isOffline()) return Promise.resolve();

    const read = { userId, state: 'reading', done: null };
    profileRead.current = read;
    read.done = (async () => {
      let data = null;
      let error = null;
      try {
        ({ data, error } = await supabase.from('profiles').select('*').eq('id', userId).single());
      } catch (thrown) {
        error = thrown;
      }
      if (error || !data) {
        // What is known stays: a role read last week is still the role.
        read.state = 'failed';
        console.error('Failed to fetch profile:', error?.message);
        return;
      }
      read.state = 'read';
      // The account changed while the request was out: the answer is not about
      // whoever is signed in now.
      if (who.current?.id !== userId) return;
      writeCachedProfile(data);
      hasProfile.current = true;
      setProfile((shown) => (sameRow(shown, data) ? shown : data));
    })();
    return read.done;
  }, []);

  // Say who is signed in. The same account keeps the object the app already
  // holds, unless `replace` says the user itself changed (a new address).
  const setWho = useCallback((next, replace = false) => {
    const previousId = who.current?.id ?? null;
    const nextId = next?.id ?? null;
    if (previousId === nextId) {
      if (replace && next) {
        who.current = next;
        setUser(next);
      }
      return;
    }
    who.current = next;
    setUser(next);
    // Another account, or nobody: what this device knows of that one.
    profileRead.current = NOT_READ;
    const remembered = nextId ? readCachedProfile(nextId) : null;
    hasProfile.current = !!remembered;
    setProfile(remembered);
  }, []);

  const signedInAs = useCallback(
    (nextUser, replace = false) => {
      setWho(nextUser, replace);
      const read = ensureProfile(nextUser.id);
      // The pages wait for the role when it is not known and can be asked.
      if (hasProfile.current || isOffline()) setIsLoading(false);
      else read.finally(() => setIsLoading(false));
    },
    [setWho, ensureProfile],
  );

  const nobody = useCallback(() => {
    sessionKnown.current = false;
    setWho(null);
    forgetCachedProfile();
    setIsLoading(false);
  }, [setWho]);

  // auth-js could not say whether there is a session. The device can: the
  // stored session is still there unless auth-js removed it.
  const asStored = useCallback(() => {
    const storedUser = readStoredUser();
    if (storedUser) signedInAs(storedUser);
    else nobody();
  }, [signedInAs, nobody]);

  useEffect(() => {
    // The account the device already knows: its profile is read once, behind
    // the pages when the role is remembered, in front of them when it is not.
    const stored = who.current;
    if (stored) {
      const read = ensureProfile(stored.id);
      if (!hasProfile.current && !isOffline()) read.finally(() => setIsLoading(false));
    }

    supabase.auth.getSession().then(
      ({ data, error }) => {
        const session = data?.session ?? null;
        if (session) {
          sessionKnown.current = true;
          signedInAs(session.user);
        } else if (error) {
          // The token had expired and could not be refreshed.
          asStored();
        } else {
          nobody();
        }
      },
      // A lock that timed out, a storage that refused: no answer either.
      () => asStored(),
    );

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        // A session APPEARS: someone signs in where nobody was, or a token is
        // refreshed — which is also how a refresh that kept failing on a bad
        // network finally ends. The writes queued on this device were held
        // back for exactly that (they are not sent without a session, see
        // lib/offlineMutations.js), so this is the moment to replay them.
        // INITIAL_SESSION is left out: at start-up the restored cache runs the
        // same replay itself. Neither is SIGNED_IN with a session already
        // known a reason — supabase-js emits that one on every return to the
        // tab.
        const appeared =
          !!session &&
          event !== 'INITIAL_SESSION' &&
          (!sessionKnown.current || event === 'TOKEN_REFRESHED');
        sessionKnown.current = !!session;

        if (event === 'SIGNED_OUT') {
          nobody();
        } else if (session?.user) {
          signedInAs(session.user, event === 'USER_UPDATED');
        }
        // Anything else carries no session without being a sign-out — the
        // INITIAL_SESSION of a launch whose token could not be refreshed. It
        // says nothing about who is signed in.

        // Not awaited, like the profile read above: supabase-js runs this
        // callback while it holds its auth lock, and the replay reads the
        // session, which waits for that lock.
        if (appeared) replayQueuedWrites();
      }
    );

    // A profile read that failed, or could not be made, is made again when it
    // can be: at once when the network returns, and every few seconds for as
    // long as the role is not known at all — a signed-in user whose role is
    // unknown is looking at a spinner. (Each event of auth-js about the
    // account is one more occasion: `signedInAs` asks as well.)
    const askAgain = () => {
      if (who.current) ensureProfile(who.current.id);
    };
    const askForRole = () => {
      if (!hasProfile.current) askAgain();
    };
    window.addEventListener('online', askAgain);
    const asking = setInterval(askForRole, ROLE_RETRY_MS);

    return () => {
      subscription.unsubscribe();
      window.removeEventListener('online', askAgain);
      clearInterval(asking);
    };
  }, [ensureProfile, signedInAs, asStored, nobody]);

  const signIn = useCallback(async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    nobody();
  }, [nobody]);

  /**
   * Patch the signed-in user's `profiles` row and refresh the in-memory
   * `profile` state on success. Callers pass only the columns they want to
   * update (e.g. `{ full_name }`); the DB-side trigger pins `id`, `role`
   * and `created_at` so a malicious payload can't escalate role.
   */
  const updateProfile = useCallback(async (patch) => {
    const userId = who.current?.id;
    if (!userId) return { error: new Error('Not signed in') };
    const { data, error } = await supabase
      .from('profiles')
      .update(patch)
      .eq('id', userId)
      .select()
      .single();
    if (!error && data && who.current?.id === userId) {
      writeCachedProfile(data);
      hasProfile.current = true;
      setProfile(data);
    }
    return { error };
  }, []);

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

  // Keep the error reporter's identity in sync so telemetry rows carry the
  // right user_id/role (and RLS accepts the insert).
  useEffect(() => {
    setErrorReporterUser(user ? { id: user.id, role } : null);
  }, [user, role]);

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
