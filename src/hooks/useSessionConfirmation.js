import {
  useQuery,
  useMutation,
  useQueryClient,
  useIsMutating,
  onlineManager,
} from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import { useOnlineStatus } from './useOnlineStatus';
import { writeTrainingListSession } from './useStudentProgramDetails';
import { writeCached } from '../lib/cacheWrite';
import { MUTATION_KEYS, MUTATION_FNS } from '../lib/offlineMutations';

// The athlete's list of confirmed sessions, whoever it is keyed for.
const MY_CONFIRMED = ['my-confirmed-session-ids'];
// The copies of the athlete's blocks (hooks/useStudentProgramDetails.js).
const TRAINING_LIST = ['student-program-details'];
// What the two keys of MUTATION_KEYS that write a confirmation start with.
const CONFIRMATION_WRITES = ['session-confirmation'];

/**
 * Fetch the confirmation (if any) for a single session.
 * Returns `null` when the session hasn't been confirmed yet.
 *
 * `refetchOnMount` is React Query's option, passed through. The coach's review
 * sets it to `'always'`: this key is cached for two minutes and persisted
 * across reloads, the athlete can undo a confirmation in between, and the
 * review offers its feedback form on the strength of this row.
 */
export function useSessionConfirmation(sessionId, { refetchOnMount } = {}) {
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
    ...(refetchOnMount === undefined ? {} : { refetchOnMount }),
  });
}

/**
 * Coach-facing: every confirmed session across the coach's students, newest
 * first. The coach is named in the query (`student.coach_id`), like the
 * roster it feeds (`useStudents`): RLS says what this account may read, and
 * the feed is narrower than that — the sessions of the athletes it coaches.
 *
 * One embedded-join query, filtered THROUGH the session→week→program→student
 * chain — NOT the old "fetch every program tree ever, then .in(all session
 * ids)" pattern, whose GET URL grew ~37 bytes per session and hard-failed
 * (URL too long) after a few hundred accumulated sessions. This scales with
 * the number of CONFIRMATIONS, not lifetime session count, and never builds
 * an id list.
 */
export function useAllConfirmations() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['all-confirmations', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('session_confirmations')
        .select(`
          id, session_id, student_id, confirmed_at, performed_on, notes,
          session:sessions!inner(
            title, day_number, archived_at, reviewed_at,
            week:weeks!inner(
              week_number, label,
              program:programs!inner(
                deleted_at,
                student:students!inner(
                  id, coach_id,
                  profile:profiles!students_profile_id_fkey(full_name)
                )
              )
            )
          )
        `)
        .eq('session.week.program.student.coach_id', user.id)
        // Trashed programs' confirmations drop out of the feed.
        .is('session.week.program.deleted_at', null)
        .order('confirmed_at', { ascending: false });
      if (error) throw error;

      // Flatten to the shape SessionsFeed / the Athletes roster already consume.
      return (data || []).map((c) => {
        const s = c.session;
        const w = s?.week;
        const prog = w?.program;
        const student = prog?.student;
        return {
          id: c.id,
          session_id: c.session_id,
          confirmed_at: c.confirmed_at,
          // The day the athlete actually trained. Falls back to the
          // confirmation timestamp for rows written before 2026_08_21 (and for
          // any client that doesn't send it).
          performed_on: c.performed_on,
          notes: c.notes,
          session_title: s?.title,
          day_number: s?.day_number,
          archived_at: s?.archived_at,
          reviewed_at: s?.reviewed_at,
          week_number: w?.week_number,
          week_label: w?.label,
          student_id: student?.id,
          student_name: student?.profile?.full_name || 'Student',
        };
      });
    },
    enabled: !!user?.id,
  });
}

/**
 * Lightweight query: the set of session ids that the current student has
 * confirmed. Cheap to check from the StudentTraining list.
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
      // Cache a plain ARRAY (survives JSON persistence to IndexedDB — a Set
      // would silently dehydrate to {}); `select` below hands consumers the
      // Set they expect. Without persisted confirmations an offline cold
      // start would regress Home to week 1 and misreport adherence.
      return (data || []).map((r) => r.session_id);
    },
    select: (ids) => new Set(ids),
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
      // Filter THROUGH the session join rather than fetching the week's
      // session ids and feeding them back as an `.in(...)` list — same reason
      // as useAllConfirmations, and it halves the round trips.
      const { data, error } = await supabase
        .from('session_confirmations')
        .select('session_id, sessions!inner(week_id)')
        .eq('sessions.week_id', weekId);
      if (error) throw error;
      // Cache a plain ARRAY, not a Set: a Set dehydrates to {} through the
      // persister. `select` hands consumers the Set they expect.
      return (data || []).map((c) => c.session_id);
    },
    select: (ids) => new Set(ids),
    enabled: !!weekId,
  });
}

/**
 * Every confirmed session id across ONE program — the Program Sheet lists a
 * whole block at once, so a per-week lookup would be an N+1. Same shape and
 * caching rules as `useWeekConfirmedSessionIds`: filter through the session →
 * week join rather than fanning ids back in, and cache a plain array because a
 * Set dehydrates to {} through the persister.
 */
export function useProgramConfirmedSessionIds(programId) {
  return useQuery({
    queryKey: ['program-confirmed-session-ids', programId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('session_confirmations')
        .select('session_id, sessions!inner(weeks!inner(program_id))')
        .eq('sessions.weeks.program_id', programId);
      if (error) throw error;
      return (data || []).map((c) => c.session_id);
    },
    select: (ids) => new Set(ids),
    enabled: !!programId,
  });
}

// ── Confirming, and taking a confirmation back ────────────────────────────
//
// A confirmation is made at the end of a workout, in a gym: more often than
// not the write waits for a network, sometimes until the app has been closed
// and opened again. So everything the athlete is shown about "this session is
// done" is written at the tap, and three reads say it:
//
//   ['session-confirmation', sessionId]   the card on the session page;
//   ['my-confirmed-session-ids', …]       which session is "Next" on the
//                                         training list, the place in the
//                                         block, the "Done" drawer;
//   ['student-program-details', …]        the day a done session was trained
//                                         (`sessions.performed_at`), which
//                                         dates and orders the drawer and
//                                         feeds the greeting.
//
// Writing only the first left the session that had just been finished as the
// "Next" one of the list, with its Start button, until the confirmation
// reached the database — hours later, for a write parked offline (P25).
//
// There is NO `onSettled` on these two mutations. Asking the database again
// for everything a confirmation changes, once the write has settled, belongs
// to the defaults that `registerOfflineMutationDefaults` registers for their
// keys (lib/offlineMutations.js), which also serve a confirmation replayed
// after a relaunch, with no hook around it. An option set here REPLACES the
// default of the same name — it does not run next to it.

// What `sync_session_performed_at` puts on the session when the confirmation
// reaches the database: the day trained as a moment (`performed_on::timestamptz`
// — midnight, in UTC there), or the moment of the confirmation when no day was
// sent. Written the way PostgREST prints it, so the list does not move when the
// real row replaces the guess.
function performedAtOf(performedOn, confirmedAt) {
  return performedOn ? `${performedOn}T00:00:00+00:00` : confirmedAt;
}

// Puts the session into the list of confirmed sessions the device holds, or
// takes it out. Answers whether a list changed — a list that does not exist is
// not made (see `writeCached`), and one that already says so is left alone.
function listAsConfirmed(qc, sessionId, confirmed) {
  let changed = false;
  writeCached(qc, MY_CONFIRMED, (ids) => {
    if (!Array.isArray(ids) || ids.includes(sessionId) === confirmed) return undefined;
    changed = true;
    return confirmed ? [...ids, sessionId] : ids.filter((id) => id !== sessionId);
  });
  return changed;
}

// Writes the day a session was trained into the copies of the block, and
// answers what this write has to remember to take it back.
function writePerformedAt(qc, sessionId, performedAt) {
  const before = writeTrainingListSession(qc, sessionId, () => ({ performed_at: performedAt }));
  return before ? { written: performedAt, previous: before.performed_at ?? null } : null;
}

// A read on its way was sent before this write: it would land on top of it.
function cancelReads(qc, sessionId) {
  return Promise.all([
    qc.cancelQueries({ queryKey: ['session-confirmation', sessionId] }),
    qc.cancelQueries({ queryKey: MY_CONFIRMED }),
    qc.cancelQueries({ queryKey: TRAINING_LIST }),
  ]);
}

// Is another confirmation or undo of the same session still on its way? These
// writes leave one at a time, in the order they were made (the `offline-writes`
// scope), so any other one that is pending was made AFTER the one that asks.
// React Query hands a handler the variables object of its own mutation:
// identity tells this write from the others.
function hasNewerWrite(qc, variables) {
  return qc
    .getMutationCache()
    .findAll({ mutationKey: CONFIRMATION_WRITES, status: 'pending' })
    .some((m) => m.state.variables !== variables && m.state.variables?.sessionId === variables?.sessionId);
}

// A write that failed takes back what IT put on screen — unless a newer write
// to the same session is waiting: confirm, undo, confirm again without a
// network is three writes, and what the athlete sees is the state after the
// last of them. Putting the first one's "before" back would show a session as
// not confirmed while its confirmation is in the queue.
function takeBack(qc, variables, context) {
  if (!context?.sessionId || hasNewerWrite(qc, variables)) return;
  const { sessionId, previous, list, trained } = context;
  // `?? null`: a confirmation that had never been read is `undefined`, which
  // `setQueryData` does not write — the card would stay on "Session confirmed"
  // after a confirmation the database refused. "Not confirmed" is what the
  // page shows for an unknown confirmation anyway, and the read that follows
  // the failure says what it really is.
  qc.setQueryData(['session-confirmation', sessionId], previous ?? null);
  if (list) listAsConfirmed(qc, sessionId, list === 'removed');
  if (trained) {
    writeTrainingListSession(qc, sessionId, (session) =>
      Object.is(session.performed_at, trained.written) ? { performed_at: trained.previous } : undefined,
    );
  }
}

export function useConfirmSession() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const studentId = user?.id;

  // Wrap the inner mutate so callers don't have to pass studentId (still
  // serialized into the persisted variables so a resumed-after-reload mutation
  // has every field it needs without re-reading from useAuth).
  const m = useMutation({
    mutationKey: MUTATION_KEYS.confirmSession,
    mutationFn: MUTATION_FNS.confirmSession,
    onMutate: async ({ sessionId, studentId: sid, notes, performedOn }) => {
      await cancelReads(qc, sessionId);
      const key = ['session-confirmation', sessionId];
      const previous = qc.getQueryData(key);
      const confirmedAt = new Date().toISOString();
      qc.setQueryData(key, {
        session_id: sessionId,
        student_id: sid,
        notes: notes || null,
        performed_on: performedOn || null,
        confirmed_at: confirmedAt,
      });
      // What is kept for the rollback is stored with a write that waits: a
      // few values, not the lists.
      return {
        sessionId,
        previous,
        list: listAsConfirmed(qc, sessionId, true) ? 'added' : null,
        trained: writePerformedAt(qc, sessionId, performedAtOf(performedOn, confirmedAt)),
      };
    },
    onError: (_err, variables, context) => takeBack(qc, variables, context),
  });
  return {
    ...m,
    mutate: (vars, options) => m.mutate({ ...vars, studentId }, options),
    mutateAsync: (vars, options) => m.mutateAsync({ ...vars, studentId }, options),
  };
}

export function useUnconfirmSession() {
  const qc = useQueryClient();

  return useMutation({
    mutationKey: MUTATION_KEYS.unconfirmSession,
    mutationFn: MUTATION_FNS.unconfirmSession,
    onMutate: async ({ sessionId }) => {
      await cancelReads(qc, sessionId);
      const key = ['session-confirmation', sessionId];
      const previous = qc.getQueryData(key);
      qc.setQueryData(key, null);
      return {
        sessionId,
        previous,
        list: listAsConfirmed(qc, sessionId, false) ? 'removed' : null,
        // The trigger empties `performed_at` when the confirmation goes.
        trained: writePerformedAt(qc, sessionId, null),
      };
    },
    onError: (_err, variables, context) => takeBack(qc, variables, context),
  });
}

/**
 * Is the confirmation of this session held on the device until a network
 * returns?
 *
 * Read from the queue, not from the hook that sent the write: a confirmation
 * made offline is usually still waiting after the page was left, and after the
 * app was closed and opened again — where it is a mutation restored from
 * IndexedDB that no `useConfirmSession` knows.
 *
 * "Paused" alone is not it. React Query also calls a write paused while it
 * stands behind another one of its scope — a note being saved — for a few
 * hundred milliseconds on a perfectly good network. `onlineManager` is asked
 * as well as the device because it is the one that parks a write.
 */
export function useConfirmationWaiting(sessionId) {
  const online = useOnlineStatus();
  const parked = useIsMutating({
    mutationKey: MUTATION_KEYS.confirmSession,
    predicate: (m) => m.state.isPaused && m.state.variables?.sessionId === sessionId,
  });
  return parked > 0 && !(online && onlineManager.isOnline());
}
