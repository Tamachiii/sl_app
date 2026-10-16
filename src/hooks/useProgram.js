import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import { startOfWeekMonday } from '../lib/day';
import { buildQueue, buildDayStrip, flattenSessions } from '../lib/sessionQueue';
import { fetchAllRows } from '../lib/supabasePaging';
import { mutationScope, laterWriteQueued } from '../lib/mutationScope';

/**
 * List all programs for a student (periodization blocks), ordered by sort_order.
 * Returns shallow metadata — no weeks/sessions. Use `useProgram(programId)` to
 * fetch a single program's full tree.
 */
export function useProgramsForStudent(studentId) {
  return useQuery({
    queryKey: ['programs', studentId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('programs')
        .select('id, student_id, name, sort_order, is_active, status, submitted_at, created_at, weeks(id)')
        .eq('student_id', studentId)
        .is('deleted_at', null)
        .order('sort_order', { ascending: true });
      if (error) throw error;
      return data || [];
    },
    enabled: !!studentId,
  });
}

/**
 * Fetch a single program with its weeks and their sessions by program id.
 * This is the detail fetch that `ProgramSheet` consumes.
 */
export function useProgram(programId) {
  return useQuery({
    queryKey: ['program', programId],
    queryFn: async () => {
      // Sessions carry their display fields (not just `id`) so the Programming
      // tab can list a whole block — week → its sessions → an exercise count —
      // without a per-week fetch. `exercise_slots(id)` is an id-only embed
      // purely to count against; widening it further would balloon the payload.
      const { data, error } = await supabase
        .from('programs')
        .select(`
          *,
          weeks(
            *,
            sessions(id, title, day_number, sort_order, scheduled_date, archived_at, performed_at, exercise_slots(id))
          )
        `)
        .eq('id', programId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      data.weeks = (data.weeks || [])
        .sort((a, b) => a.week_number - b.week_number)
        .map((w) => ({
          ...w,
          sessions: (w.sessions || [])
            .slice()
            .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
        }));
      return data;
    },
    enabled: !!programId,
  });
}

/**
 * Convenience resolver: the currently-active program for a student, with weeks.
 * Used by CopyDialog (destination = the student's active program) and anywhere
 * the "one program per student" shortcut is still appropriate.
 */
export function useActiveProgram(studentId) {
  return useQuery({
    queryKey: ['active-program', studentId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('programs')
        .select('*, weeks(*, sessions(id))')
        .eq('student_id', studentId)
        .eq('is_active', true)
        .is('deleted_at', null)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      data.weeks = (data.weeks || []).sort((a, b) => a.week_number - b.week_number);
      return data;
    },
    enabled: !!studentId,
  });
}

/**
 * The coach dashboard's week strips are derived from their own summary query,
 * so any edit that moves a session or renames a program has to drop it too —
 * otherwise the dashboard keeps rendering the pre-edit strip until remount.
 * Exported because the session/week mutations in `useWeek` need the same drop.
 */
export function invalidateCoachDashboard(qc) {
  qc.invalidateQueries({ queryKey: ['coach-dashboard-programs'] });
}

function invalidateProgramQueries(qc, studentId) {
  qc.invalidateQueries({ queryKey: ['programs', studentId] });
  qc.invalidateQueries({ queryKey: ['programs-trash', studentId] });
  qc.invalidateQueries({ queryKey: ['active-program', studentId] });
  qc.invalidateQueries({ queryKey: ['program'] });
  // Student-side views read through is_active; refresh them too.
  qc.invalidateQueries({ queryKey: ['student-program-details'] });
  qc.invalidateQueries({ queryKey: ['student-progress-stats'] });
  invalidateCoachDashboard(qc);
}

/**
 * Creates a default program for a student if none exists. The first program
 * is always active (so the student sees it).
 */
export function useEnsureProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ studentId }) => {
      const { data, error } = await supabase
        .from('programs')
        .insert({ student_id: studentId, name: 'Program 1', is_active: true, sort_order: 0 })
        .select('*, weeks(*, sessions(id))')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, vars) => {
      invalidateProgramQueries(qc, vars.studentId);
    },
  });
}

/**
 * Create a new program for a student. The row is always inserted INACTIVE;
 * with `setActive: true` it is then made the active one by `activate_program`
 * (see `useSetActiveProgram`).
 *
 * The order is the point. The block the athlete trains is switched off by the
 * same statement that switches the new one on, and by nothing before it: a
 * request that fails on the way — the read, the insert or the activation —
 * leaves that block active. At worst the new program exists, inactive, and the
 * mutation fails so the coach is told. Switching the current block off first
 * left the athlete with NO active block when the insert was lost, and every
 * set they logged was then refused (`program_active_for_session()`).
 */
export function useCreateProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ studentId, name, setActive = false }) => {
      // Pick next sort_order.
      const { data: existing, error: listErr } = await supabase
        .from('programs')
        .select('sort_order')
        .eq('student_id', studentId)
        .order('sort_order', { ascending: false })
        .limit(1);
      if (listErr) throw listErr;
      const nextSort = (existing?.[0]?.sort_order ?? -1) + 1;

      const { data, error } = await supabase
        .from('programs')
        .insert({
          student_id: studentId,
          name,
          sort_order: nextSort,
          is_active: false,
        })
        .select()
        .single();
      if (error) throw error;
      if (!setActive) return data;

      const { error: activateErr } = await supabase.rpc('activate_program', {
        p_program_id: data.id,
      });
      if (activateErr) throw activateErr;
      return { ...data, is_active: true };
    },
    onSuccess: (newProg, vars) => {
      // Seed the list cache synchronously so the parent's `onSelect(newProg.id)`
      // callback sees the new program in the list before the invalidation refetch
      // lands — otherwise CoachHome's stale-?program cleanup strips it.
      qc.setQueryData(['programs', vars.studentId], (old) => {
        if (!Array.isArray(old)) return old;
        // A newcomer that is active took the place of every other block.
        const others = newProg.is_active
          ? old.map((p) => (p.is_active ? { ...p, is_active: false } : p))
          : old;
        return [...others, { ...newProg, weeks: [] }];
      });
    },
    // After a failure too: with `setActive`, the program can exist by the time
    // its activation is refused.
    onSettled: (_d, _e, vars) => {
      invalidateProgramQueries(qc, vars.studentId);
    },
  });
}

/**
 * Coach approves a student-authored draft (Phase 3.4c): the approve_program RPC
 * materializes set_logs from the slot scalars and flips status to 'approved'.
 */
export function useApproveProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ programId }) => {
      const { data, error } = await supabase.rpc('approve_program', { p_program_id: programId });
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, vars) => invalidateProgramQueries(qc, vars.studentId),
  });
}

/** Coach sends a submitted draft back for revision (clears submitted_at). */
export function useSendBackProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ programId }) => {
      const { data, error } = await supabase.rpc('send_back_program', { p_program_id: programId });
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, vars) => invalidateProgramQueries(qc, vars.studentId),
  });
}

export function useRenameProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ programId, name }) => {
      const { data, error } = await supabase
        .from('programs')
        .update({ name })
        .eq('id', programId)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, vars) => {
      invalidateProgramQueries(qc, vars.studentId);
    },
  });
}

/**
 * "Delete" is archive-first: stamp deleted_at (and clear is_active — a
 * trashed row must never hold the one-active-per-student slot) instead of
 * a hard DELETE that used to cascade a student's entire logged history
 * away in one click. Restore from the trash NULLs it back out.
 */
export function useDeleteProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ programId }) => {
      const { error } = await supabase
        .from('programs')
        .update({ deleted_at: new Date().toISOString(), is_active: false })
        .eq('id', programId);
      if (error) throw error;
      return programId;
    },
    onSuccess: (_d, vars) => {
      invalidateProgramQueries(qc, vars.studentId);
    },
  });
}

/** Programs currently in the trash, newest first. */
// `enabled` lets a caller defer this fetch until the trash UI is actually
// reachable — the trash is a rare corner, so the Programming tab should not
// pay for it on every visit.
export function useTrashedPrograms(studentId, { enabled = true } = {}) {
  return useQuery({
    queryKey: ['programs-trash', studentId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('programs')
        .select('id, student_id, name, deleted_at, weeks(id)')
        .eq('student_id', studentId)
        .not('deleted_at', 'is', null)
        .order('deleted_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: !!studentId && enabled,
  });
}

export function useRestoreProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ programId }) => {
      // Restored programs come back INACTIVE — the coach re-activates
      // explicitly, so a restore can never bump the current active block.
      const { error } = await supabase
        .from('programs')
        .update({ deleted_at: null })
        .eq('id', programId);
      if (error) throw error;
      return programId;
    },
    onSuccess: (_d, vars) => {
      invalidateProgramQueries(qc, vars.studentId);
    },
  });
}

/**
 * Permanent delete, offered only from the trash. Client-side gate (for a
 * friendly message) + DB BEFORE DELETE trigger (the real guarantee) both
 * refuse while the program contains any logged set — hard delete exists
 * for scaffolding mistakes, never for training history.
 */
export function useHardDeleteProgram() {
  const qc = useQueryClient();
  return useMutation({
    // TrashDialog renders its own inline "can't delete — has logged training"
    // message on failure, so opt out of the global error toast to avoid
    // double-messaging the same guard.
    meta: { skipErrorToast: true },
    mutationFn: async ({ programId }) => {
      const { count, error: cErr } = await supabase
        .from('set_logs')
        .select('id, exercise_slots!inner(sessions!inner(weeks!inner(program_id)))', {
          count: 'exact',
          head: true,
        })
        .eq('exercise_slots.sessions.weeks.program_id', programId)
        .or(
          'done.eq.true,failed.eq.true,skipped.eq.true,rpe.not.is.null,actual_reps.not.is.null,actual_weight_kg.not.is.null'
        );
      if (cErr) throw cErr;
      if ((count ?? 0) > 0) {
        const err = new Error('program has logged sets');
        err.code = 'PROGRAM_HAS_LOGGED_SETS';
        throw err;
      }
      const { error } = await supabase
        .from('programs')
        .delete()
        .eq('id', programId)
        .not('deleted_at', 'is', null); // only ever from the trash
      if (error) throw error;
      return programId;
    },
    onSuccess: (_d, vars) => {
      invalidateProgramQueries(qc, vars.studentId);
    },
  });
}

/**
 * Make a program the active one for its student: ONE request, the
 * `activate_program` function (migration 2026_10_13_11), which switches the
 * athlete's other blocks off and this one on in a single statement — both
 * happen or neither.
 *
 * It used to be two requests, the others off and then this one on. With the
 * second one lost the athlete had no active block at all, and the database
 * refused every set they logged, the ones waiting in their offline queue
 * included.
 *
 * Resolves to what the function answers:
 * `{ program_id, student_id, already_active, deactivated }`. A program that is
 * active already is not an error. A draft, a program in the trash and one the
 * coach cannot reach are refused before anything is written.
 */
export function useSetActiveProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ programId }) => {
      const { data, error } = await supabase.rpc('activate_program', {
        p_program_id: programId,
      });
      if (error) throw error;
      return data;
    },
    // After a refusal too: what the function refuses is a program the list on
    // screen still offers — put in the trash or deleted from another tab — so
    // that list is the thing to read again.
    onSettled: (_d, _e, vars) => {
      invalidateProgramQueries(qc, vars.studentId);
    },
  });
}

/**
 * Rewrite sort_order for an ordered list of programs within the same student.
 *
 * Still one request per program, in two passes (park at TMP_BASE+idx, then
 * assign idx): `programs.sort_order` has no unique key, so no order of
 * arrival can be refused and the database has no function for it — unlike
 * the sessions of a phase and the phases of a block (`useReorderSessions`,
 * `useReorderWeeks`). What two drags could still do is cross: the requests
 * of the second landing among those of the first, for an order nobody chose.
 * So the hook takes the athlete (`studentRowId`, the `students` row) and runs
 * under one scope per athlete: a drag waits for the one before it. The list
 * that is renumbered is the one each call sends, with its `studentId`.
 *
 * `studentRowId` MUST NOT CHANGE during the life of the hook, for the reason
 * given at `blockOrderScope` in `useWeek.js`: a re-rendered hook re-points the
 * write it has pending at the new scope, where it is never given its turn.
 * `ProgramSwitcher` is mounted once per athlete (`key={studentId}` in
 * `StudentProgrammingSection`).
 */
export function useReorderPrograms(studentRowId) {
  const qc = useQueryClient();
  const scope = mutationScope('program-order', studentRowId);

  return useMutation({
    scope,
    mutationFn: async ({ studentId, orderedIds }) => {
      const TMP_BASE = 100000;

      // Writes within a pass are independent; only the passes are ordered.
      async function writeAll(orderFor) {
        const results = await Promise.all(
          orderedIds.map((id, i) =>
            supabase.from('programs').update({ sort_order: orderFor(i) }).eq('id', id),
          ),
        );
        for (const { error } of results) if (error) throw error;
      }

      await writeAll((i) => TMP_BASE + i);
      await writeAll((i) => i);

      return { studentId };
    },
    onMutate: async ({ studentId, orderedIds }) => {
      await qc.cancelQueries({ queryKey: ['programs', studentId] });
      const snapshot = qc.getQueryData(['programs', studentId]);
      if (Array.isArray(snapshot)) {
        const byId = new Map(snapshot.map((p) => [p.id, p]));
        const reordered = orderedIds
          .map((id, idx) => {
            const p = byId.get(id);
            return p ? { ...p, sort_order: idx } : null;
          })
          .filter(Boolean);
        qc.setQueryData(['programs', studentId], reordered);
      }
      return { snapshot };
    },
    onError: (_err, { studentId }, ctx) => {
      // Not while a later drag waits either: the snapshot is the list from
      // before this drag, without the order the later one has put on screen.
      if (laterWriteQueued(qc, scope)) return;
      if (ctx?.snapshot !== undefined) {
        qc.setQueryData(['programs', studentId], ctx.snapshot);
      }
    },
    onSettled: (_d, _e, { studentId }) => {
      // Not while a later drag waits for its turn: its order is on screen
      // already, and this refetch would put back the one before it.
      if (laterWriteQueued(qc, scope)) return;
      qc.invalidateQueries({ queryKey: ['programs', studentId] });
    },
  });
}

/**
 * Coach dashboard summary: for each student the coach manages, resolve
 * { programName, position, total, daysSinceLast, weekDays } in a single pass.
 *
 * ONE read: the active blocks of the coach's athletes, sessions included. The
 * read names the coach: `students!inner(coach_id)` plus a filter on it. RLS
 * alone answers "every program I may read", and that includes the programs
 * in which this account is the ATHLETE (a coach who also trains under another
 * coach, or under a forged link) — which are not this coach's roster. Same
 * rule as `useStudents`, so the summary cannot hold an athlete the roster does
 * not list.
 *
 * Which sessions are done comes from the tree itself: a session is confirmed
 * exactly while `sessions.performed_at` is set — `sync_session_performed_at`
 * writes it when the confirmation is inserted and empties it when it is
 * deleted, and migration 2026_08_21 filled it in for the confirmations made
 * before. A second read of the confirmations used to say it, unbounded: past a
 * thousand confirmations on the coach's active blocks PostgREST cut it without
 * a word, and done sessions came back as "next" on the cards.
 *
 * Progress is the athlete's place in the QUEUE ("session 7 of 24"), not an
 * ordinal week number — the block is an ordered list the athlete works through
 * at their own pace, so "W3" said nothing about how far along they were.
 * `daysSinceLast` is how long since they last trained, which is the signal
 * that replaces "missed a day": a recommended day passing is not a problem,
 * a fortnight of silence is.
 *
 * `weekDays` is the current Mon–Sun strip from the SHARED `buildDayStrip`, so
 * the coach's view of a week and the athlete's own can't drift. Powers the
 * `StudentWeekStrip` on each athlete card without an N+1 fetch.
 */
export function useCoachDashboardPrograms() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['coach-dashboard-programs', user?.id],
    queryFn: async () => {
      const { data: programs, error } = await supabase
        .from('programs')
        .select(`
          student_id, name,
          student:students!inner(coach_id),
          weeks(id, week_number, label,
            sessions(id, title, day_number, sort_order, scheduled_date, archived_at, performed_at))
        `)
        .eq('is_active', true)
        .eq('student.coach_id', user.id);
      if (error) throw error;

      const monday = startOfWeekMonday(new Date());

      const summary = {};
      for (const p of programs || []) {
        const weeks = (p.weeks || [])
          .slice()
          .sort((a, b) => a.week_number - b.week_number);

        const allSessions = weeks.flatMap((w) => w.sessions || []);
        const confirmedIds = new Set(allSessions.filter((s) => s.performed_at).map((s) => s.id));
        const queue = buildQueue(weeks, confirmedIds);
        const weekDays = buildDayStrip({
          sessions: allSessions,
          upcoming: queue.upcoming.map((e) => e.session),
          confirmedIds,
          monday,
        }).map((slot) => ({
          dayNumber: slot.dayNumber,
          state: slot.state,
          session: slot.session
            ? { id: slot.session.id, title: slot.session.title, archived_at: slot.session.archived_at }
            : null,
        }));

        summary[p.student_id] = {
          programName: p.name || null,
          position: queue.position,
          totalSessions: queue.total,
          nextSessionTitle: queue.upcoming[0]?.session?.title || null,
          daysSinceLast: queue.daysSinceLast,
          weekDays,
        };
      }
      return summary;
    },
    enabled: !!user?.id,
  });
}

/**
 * Where each session of this coach's athletes stands in its block, as the
 * Programming sheet numbers it: `{ [sessionId]: { n, total } }` — the 1-based
 * place of the session among the non-archived sessions of its block, read
 * across phases in their order, and how many there are. An archived session
 * has no place. Every block that is not in the trash, active or not: the
 * Sessions feed lists confirmations of past blocks too, and names them "Session
 * 7/24" where it used to print "W3 · D2" — a week number and a weekday that
 * stopped meaning anything once a phase could run any number of sessions and a
 * day became optional (review item L14).
 *
 * The coach is named in the request, through an inner join on `students`:
 * RLS also lets an account read the blocks in which it is the ATHLETE.
 * Programs are read by pages of a thousand (lib/supabasePaging); the sessions
 * ride inside them.
 *
 * The key sits under `coach-dashboard-programs`, so every write that drops the
 * dashboard (`invalidateCoachDashboard` — sessions added, moved, archived,
 * copied; phases reordered) drops this one too. A missing answer is no
 * position: the feed then names the phase alone.
 */
export function useCoachSessionPositions() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['coach-dashboard-programs', 'session-positions', user?.id],
    queryFn: async () => {
      const programs = await fetchAllRows(() =>
        supabase
          .from('programs')
          .select('id, student:students!inner(coach_id), weeks(id, week_number, sessions(id, sort_order, archived_at))')
          .eq('student.coach_id', user.id)
          .is('deleted_at', null),
      );
      const positions = {};
      for (const program of programs) {
        const placed = flattenSessions(program.weeks).filter(({ session }) => !session.archived_at);
        placed.forEach(({ session }, i) => {
          positions[session.id] = { n: i + 1, total: placed.length };
        });
      }
      return positions;
    },
    enabled: !!user?.id,
  });
}

