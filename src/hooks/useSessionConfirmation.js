import {
  keepPreviousData,
  queryOptions,
  useInfiniteQuery,
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
import { fetchAllRows } from '../lib/supabasePaging';
import { reviewCountsByStudent } from '../lib/coachRoster';

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

// ── The coach's confirmations: the inbox, the counts, the history ─────────
//
// Every confirmed session of every athlete grows without end, and PostgREST
// answers one request with 1000 rows at most, saying nothing when it cuts. So
// nothing here reads "every confirmation of the coach" in one request: the
// sessions that wait for a review are read in full, page after page (they are
// what the coach has to act on, and a backlog is short); the per-athlete
// numbers come from the database when it can count them; the rest of the
// history — reviewed, archived — is read a page at a time, when the coach
// asks for it.
//
// Every read names the coach (`student.coach_id`), like the roster
// (`useStudents`): RLS says what this account may read, and that includes the
// sessions in which it is the ATHLETE. The filter sits four embeds deep, and an
// embedded filter only drops the confirmation when every embed on the way is
// `!inner`. Trashed programs drop out (`deleted_at`).
//
// Filtered THROUGH the session→week→program→student chain — never "fetch every
// program tree, then .in(all session ids)", whose GET URL grew ~37 bytes per
// session and hard-failed after a few hundred of them.
//
// Every key starts with `CONFIRMATIONS_ROOT`: a review, an archive, a feedback
// sent and a session moved drop `['all-confirmations']`, which reaches them all.

export const CONFIRMATIONS_ROOT = 'all-confirmations';

/** Confirmations per page of the history ("All", the archived drawer). */
export const HISTORY_PAGE_SIZE = 30;

// What PostgREST answers when it knows no function of that name and those
// arguments: a database without migration 26 (coach_list_rpcs).
const NO_SUCH_FUNCTION = 'PGRST202';

const CONFIRMATION_SELECT = `
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
`;

// The path the filters of a count walk, and nothing else: a head request
// sends no rows, but its filters still need their embeds.
const COUNT_SELECT =
  'id, session:sessions!inner(archived_at, week:weeks!inner(program:programs!inner(deleted_at, student:students!inner(id, coach_id))))';

// The coach's confirmations, before what narrows them to one list.
function coachConfirmations(coachId, { select = CONFIRMATION_SELECT, options } = {}) {
  return supabase
    .from('session_confirmations')
    .select(select, options)
    .eq('session.week.program.student.coach_id', coachId)
    .is('session.week.program.deleted_at', null);
}

// One athlete (`students.id`, what the feed's filter and the roster use), and
// the archived sessions or the others.
function narrowed(query, { studentId, archived }) {
  let q = studentId ? query.eq('session.week.program.student.id', studentId) : query;
  q = archived ? q.not('session.archived_at', 'is', null) : q.is('session.archived_at', null);
  return q;
}

// The shape SessionsFeed renders a card from.
function flattenConfirmation(c) {
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
    // `students.id` — not the athlete's profile id, which is the
    // confirmation's own `student_id`.
    student_id: student?.id,
    student_name: student?.profile?.full_name || 'Student',
  };
}

function newestFirst(a, b) {
  if (a.confirmed_at !== b.confirmed_at) return a.confirmed_at < b.confirmed_at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * The coach's inbox: every confirmed session neither reviewed nor archived,
 * across the athletes they coach, newest first — the "Needs review" view of
 * the Sessions feed, and what the roster counts when the database cannot.
 *
 * Read in full, a thousand rows at a time (lib/supabasePaging): one request
 * for the whole history used to stop at 1000 rows, newest first, so an old
 * session still waiting for its review fell out of the inbox once the coach's
 * athletes had confirmed a thousand sessions since.
 *
 * Query options, so that `useReviewCounts` can ask the cache for the same
 * entry when it has to count the inbox itself.
 */
export function reviewInboxQueryOptions(coachId) {
  return queryOptions({
    queryKey: [CONFIRMATIONS_ROOT, 'inbox', coachId],
    queryFn: async () => {
      const rows = await fetchAllRows(() =>
        coachConfirmations(coachId)
          .is('session.reviewed_at', null)
          .is('session.archived_at', null),
      );
      return rows.map(flattenConfirmation).sort(newestFirst);
    },
    enabled: !!coachId,
  });
}

export function useReviewInbox() {
  const { user } = useAuth();
  return useQuery(reviewInboxQueryOptions(user?.id));
}

/**
 * How many sessions wait for the coach's review, per athlete:
 * `{ [students.id]: n }`, an athlete with none left out. The roster's "N to
 * review" chips and the Sessions tab's number (hooks/useToReviewCount) are
 * this one entry, so the two cannot disagree.
 *
 * Counted by the database — `coach_review_counts()`, one row per athlete,
 * `(student_id, to_review)` — when it has the function (migration 26, which is
 * optional). Without it (PGRST202) the inbox is read and counted here: the
 * same predicate, so the same numbers. Any other error is the read's failure,
 * never an empty count.
 */
export function useReviewCounts() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const coachId = user?.id;
  return useQuery({
    queryKey: [CONFIRMATIONS_ROOT, 'review-counts', coachId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('coach_review_counts');
      if (!error) {
        const counts = {};
        for (const row of data || []) {
          const n = Number(row?.to_review);
          if (row?.student_id && n > 0) counts[row.student_id] = n;
        }
        return counts;
      }
      if (error.code !== NO_SUCH_FUNCTION) throw error;
      return reviewCountsByStudent(await qc.fetchQuery(reviewInboxQueryOptions(coachId)));
    },
    enabled: !!coachId,
  });
}

/**
 * How many confirmations the feed holds for one athlete, or for all of them
 * (`studentId` null): `{ active, archived }` — what decides the feed's empty
 * states and the "Show N archived" button without reading the rows. Two head
 * requests (`count: 'exact'`), never a length of rows.
 *
 * While another athlete's numbers are read, the previous ones stay as
 * placeholder data (`isPlaceholderData`): the page keeps its controls and
 * treats the numbers as unknown.
 */
export function useConfirmationTotals(studentId) {
  const { user } = useAuth();
  const coachId = user?.id;
  return useQuery({
    queryKey: [CONFIRMATIONS_ROOT, 'totals', coachId, studentId || null],
    queryFn: async () => {
      const count = (archived) =>
        narrowed(coachConfirmations(coachId, { select: COUNT_SELECT, options: { count: 'exact', head: true } }), {
          studentId,
          archived,
        });
      const [active, archived] = await Promise.all([count(false), count(true)]);
      if (active.error) throw active.error;
      if (archived.error) throw archived.error;
      return { active: active.count ?? 0, archived: archived.count ?? 0 };
    },
    enabled: !!coachId,
    placeholderData: keepPreviousData,
  });
}

/**
 * The feed's history, a page at a time: the confirmations that are not
 * archived ("All": reviewed or not), or the archived ones (`archived`), of one
 * athlete or of all, newest first. `data` is the pages read so far, in one
 * list; `fetchNextPage` reads the next `HISTORY_PAGE_SIZE`, and
 * `hasNextPage` is false once a page comes back short.
 *
 * `.range()` pages by offset, ordered on `confirmed_at` then `id` so that the
 * order is total. A confirmation that arrives between two pages moves the
 * later ones down by one: the row read twice is kept once. An invalidation
 * reads every page that was loaded again.
 *
 * `enabled` is how the feed keeps it from being sent until the view that
 * shows it is open.
 */
export function useConfirmationHistory({ studentId = null, archived = false, enabled = true } = {}) {
  const { user } = useAuth();
  const coachId = user?.id;
  return useInfiniteQuery({
    queryKey: [CONFIRMATIONS_ROOT, 'history', coachId, studentId || null, archived ? 'archived' : 'active'],
    queryFn: async ({ pageParam }) => {
      const { data, error } = await narrowed(coachConfirmations(coachId), { studentId, archived })
        .order('confirmed_at', { ascending: false })
        .order('id', { ascending: false })
        .range(pageParam, pageParam + HISTORY_PAGE_SIZE - 1);
      if (error) throw error;
      return (data || []).map(flattenConfirmation);
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, _pages, lastPageParam) =>
      lastPage.length < HISTORY_PAGE_SIZE ? undefined : lastPageParam + HISTORY_PAGE_SIZE,
    select: (data) => {
      const seen = new Set();
      return data.pages.flat().filter((c) => {
        if (seen.has(c.id)) return false;
        seen.add(c.id);
        return true;
      });
    },
    enabled: !!coachId && enabled,
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
      // as the coach's confirmations above, and it halves the round trips.
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
