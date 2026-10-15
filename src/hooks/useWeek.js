import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { invalidateCoachDashboard } from './useProgram';
import { useI18n } from './useI18n';
import { mutationScope, laterWriteQueued } from '../lib/mutationScope';
import { mutationErrorKey } from '../lib/mutationErrors';
import { pushToast } from '../lib/toast';

export function useWeek(weekId) {
  return useQuery({
    queryKey: ['week', weekId],
    queryFn: async () => {
      // One nested read, not a week fetch followed by a dependent session
      // fetch. Both levels are sorted here rather than via `order` on the
      // embed, so the ordering doesn't depend on PostgREST's referenced-table
      // ordering behaviour.
      const { data: week, error } = await supabase
        .from('weeks')
        .select(`
          *,
          sessions(
            *,
            exercise_slots(
              *,
              exercise:exercise_library(*)
            )
          )
        `)
        .eq('id', weekId)
        .single();
      if (error) throw error;

      const sessions = (week.sessions || [])
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order);
      for (const sess of sessions) {
        sess.exercise_slots = (sess.exercise_slots || []).sort(
          (a, b) => a.sort_order - b.sort_order
        );
      }

      return { ...week, sessions };
    },
    enabled: !!weekId,
  });
}

/**
 * Just the owning program id for a week. Deliberately separate from `useWeek`
 * (which pulls the whole session + slot tree) so surfaces that only need to
 * answer "which program is this week in?" — e.g. CopyDialog's same-athlete
 * mode — don't pay for the heavy read.
 */
export function useProgramIdForWeek(weekId) {
  return useQuery({
    queryKey: ['week-program-id', weekId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('weeks')
        .select('program_id')
        .eq('id', weekId)
        .single();
      if (error) throw error;
      return data.program_id;
    },
    enabled: !!weekId,
  });
}

export function useCreateWeek() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ programId, weekNumber, label }) => {
      const { data, error } = await supabase
        .from('weeks')
        .insert({ program_id: programId, week_number: weekNumber, label })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['program'] });
      qc.invalidateQueries({ queryKey: ['programs'] });
      qc.invalidateQueries({ queryKey: ['active-program'] });
      // The student's Home/Sessions views read the program tree too.
      qc.invalidateQueries({ queryKey: ['student-program-details'] });
      invalidateCoachDashboard(qc);
    },
  });
}

/**
 * The ORDER of a block is written by three mutations: the sessions of a phase
 * (`useReorderSessions`), a session across phases (`useMoveSession`) and the
 * phases themselves (`useReorderWeeks`). The program sheet sends all three
 * from one drag handler, and each is ONE call of a database function that
 * does the whole renumbering or none of it.
 *
 * Each hook takes the id of the block (`blockId`, a program's id) and runs
 * under one scope per block, so two drags reach the database one after the
 * other, in the order they were made. The database would stay consistent
 * without it — every function locks its parent first. What the scope keeps in
 * step is the list on screen: a drag sends the full list of ids as it is
 * shown, so the order it was read from has to be the one the drag before it
 * asked for. Hence the three rules the hooks share: each draws its order at
 * once (`onMutate`), none puts an order back while a later drag waits
 * (`restoreBlockOrder`), and only the last drag of a run reads the server
 * again (`refreshBlockOrder`).
 *
 * `blockId` MUST NOT CHANGE during the life of a hook. TanStack Query hands
 * the options of a re-rendered hook — the scope with them — to the write that
 * hook still has pending, and then looks for that write's turn in a queue it
 * was never put in: it is not sent until the next focus or reconnection, and
 * not at all after a reload. So the component that calls these hooks is
 * mounted once per block (`key={program.id}` on `ProgramSheet`, in
 * `StudentProgrammingSection`); a hook that unmounts leaves its writes in the
 * cache as they were made, and they are sent.
 */
function blockOrderScope(blockId) {
  return mutationScope('block-order', blockId);
}

// The sessions of a phase in the order of `orderedIds`, numbered the way the
// database functions leave them: 0 to n-1.
function placeSessions(sessions, orderedIds) {
  const byId = new Map((sessions || []).map((sess) => [sess.id, sess]));
  return orderedIds
    .map((id, idx) => {
      const sess = byId.get(id);
      return sess ? { ...sess, sort_order: idx } : null;
    })
    .filter(Boolean);
}

// After a refusal: the sheet as `onMutate` found it. Not while a later drag of
// this block waits for its turn — the snapshot is the WHOLE block from before
// this drag, so it would take the later drag's order off the screen, and the
// next one would send a list without it. The last drag of the run reads the
// server again, which settles what a failed one left on screen.
function restoreBlockOrder(qc, scope, ctx) {
  if (!ctx || laterWriteQueued(qc, scope)) return;
  for (const [key, data] of ctx.snapshots) qc.setQueryData(key, data);
}

// What reads the order of a block: the sheet (['program']), a week read on its
// own (['week']), the athlete's queue (['student-program-details'] — it follows
// sessions.sort_order and weeks.week_number) and the strip of the roster.
function refreshBlockOrder(qc, scope) {
  // Not while a later drag of this block waits for its turn: its order is on
  // screen already, and this refetch would put back the one before it.
  if (laterWriteQueued(qc, scope)) return;
  qc.invalidateQueries({ queryKey: ['program'] });
  qc.invalidateQueries({ queryKey: ['week'] });
  qc.invalidateQueries({ queryKey: ['student-program-details'] });
  invalidateCoachDashboard(qc);
}

/**
 * Reorder the sessions of ONE week. `orderedIds` is the week's full list of
 * session ids in their new order — archived rows included, because
 * `sessions_week_sort_order_unique` spans them too.
 *
 * One call of `reorder_sessions` (migration 2026_10_13_11): the database parks
 * and places every row in a single statement, so the phase ends in the order
 * of the list or stays as it was. Sent as one request per row in two passes —
 * what this hook used to do — a request that was lost left sessions numbered
 * 100000 and more, in the athlete's queue too: position is the block's order
 * since 2026_08_22, and this is the coach's only control over it.
 *
 * A list that is not exactly the sessions of the phase is refused with
 * `reorder_ids_mismatch` — a page that was loaded before a session was added,
 * moved or deleted. Nothing is retried: the cache goes back to what it was,
 * the refetch that follows shows the phase as it is, and the coach drags
 * again.
 */
export function useReorderSessions(blockId) {
  const qc = useQueryClient();
  const scope = blockOrderScope(blockId);

  return useMutation({
    scope,
    mutationFn: async ({ weekId, orderedIds }) => {
      const { error } = await supabase.rpc('reorder_sessions', {
        p_week_id: weekId,
        p_ids: orderedIds,
      });
      if (error) throw error;
      return { weekId };
    },
    onMutate: async ({ weekId, orderedIds }) => {
      await qc.cancelQueries({ queryKey: ['program'] });
      const snapshots = qc.getQueriesData({ queryKey: ['program'] });
      for (const [key, prog] of snapshots) {
        if (!prog?.weeks?.some((w) => w.id === weekId)) continue;
        qc.setQueryData(key, {
          ...prog,
          weeks: prog.weeks.map((w) =>
            w.id === weekId ? { ...w, sessions: placeSessions(w.sessions, orderedIds) } : w,
          ),
        });
      }
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => restoreBlockOrder(qc, scope, ctx),
    onSettled: () => refreshBlockOrder(qc, scope),
  });
}

/**
 * Move a session into ANOTHER phase (week) of the same block — the gesture of
 * dragging it across a divider on the sheet.
 *
 * Re-homing the row and renumbering both weeks must not be separable: split
 * across two round trips, a failure between them leaves the session holding a
 * position that collides in its new week, or renumbered out of a week it no
 * longer belongs to. `move_session` (2026_08_22) does both in one statement.
 * SECURITY INVOKER, so it rides the coach's own RLS.
 *
 * Takes the FULL ordered id list of each affected week AFTER the move, same
 * contract as `useReorderSessions` — the client is holding the list, so the
 * ordering logic stays in one place. It waits its turn in the scope of the
 * block like the two reorders: sent side by side, a move and a reorder reach
 * the database in either order, each with the full list of a phase the other
 * one changes.
 *
 * And like them it draws the move at once. The next drag is made from the
 * list on screen, and may be made before this one is answered: with the
 * session still shown in the phase it left, a reorder of that phase would be
 * refused (`reorder_ids_mismatch`) and a second move would renumber from
 * lists that `move_session` does not check.
 */
export function useMoveSession(blockId) {
  const qc = useQueryClient();
  const scope = blockOrderScope(blockId);

  return useMutation({
    scope,
    mutationFn: async ({ sessionId, destWeekId, sourceIds, destIds }) => {
      const { error } = await supabase.rpc('move_session', {
        p_session_id: sessionId,
        p_dest_week_id: destWeekId,
        p_source_ids: sourceIds,
        p_dest_ids: destIds,
      });
      if (error) throw error;
      return { sessionId, destWeekId };
    },
    onMutate: async ({ sessionId, destWeekId, sourceIds, destIds }) => {
      await qc.cancelQueries({ queryKey: ['program'] });
      const snapshots = qc.getQueriesData({ queryKey: ['program'] });
      for (const [key, prog] of snapshots) {
        const weeks = prog?.weeks || [];
        const source = weeks.find((w) => (w.sessions || []).some((sess) => sess.id === sessionId));
        // Only a block that holds both ends of the move, and not a session
        // that is in its destination already.
        if (!source || source.id === destWeekId || !weeks.some((w) => w.id === destWeekId)) continue;
        const moved = source.sessions.find((sess) => sess.id === sessionId);
        qc.setQueryData(key, {
          ...prog,
          weeks: weeks.map((w) => {
            if (w.id === source.id) return { ...w, sessions: placeSessions(w.sessions, sourceIds) };
            if (w.id === destWeekId) {
              return { ...w, sessions: placeSessions([...(w.sessions || []), moved], destIds) };
            }
            return w;
          }),
        });
      }
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => restoreBlockOrder(qc, scope, ctx),
    onSettled: () => refreshBlockOrder(qc, scope),
  });
}

export function useCreateSession() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ weekId, title, dayNumber, sortOrder }) => {
      const { data, error } = await supabase
        .from('sessions')
        .insert({
          week_id: weekId,
          // Null without a title, not a word frozen into it: an untitled
          // session is named where it is shown (by its position in the sheet).
          title: title || null,
          // `?? null`, NOT `|| 1`: the weekday is an optional RECOMMENDATION
          // (nullable since 2026_08_21) and `null || 1` silently made every
          // session born on Monday, defeating the caller that deliberately
          // passes null and tying every new session at the same sort rank.
          day_number: dayNumber ?? null,
          sort_order: sortOrder ?? 0,
        })
        .select()
        .single();
      if (error) throw error;
      return { data, weekId };
    },
    onSuccess: ({ weekId }) => {
      qc.invalidateQueries({ queryKey: ['week', weekId] });
      qc.invalidateQueries({ queryKey: ['program'] });
      invalidateCoachDashboard(qc);
    },
  });
}

export function useUpdateWeek() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...updates }) => {
      const { data, error } = await supabase
        .from('weeks')
        .update(updates)
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return { data, id };
    },
    onSuccess: ({ id }) => {
      qc.invalidateQueries({ queryKey: ['week', id] });
      qc.invalidateQueries({ queryKey: ['program'] });
      // A week edit can move week_number, which the roster strip renders.
      invalidateCoachDashboard(qc);
    },
  });
}

export function useDeleteWeek() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (weekId) => {
      const { error } = await supabase.from('weeks').delete().eq('id', weekId);
      if (error) throw error;
      return weekId;
    },
    onSuccess: (weekId) => {
      qc.invalidateQueries({ queryKey: ['program'] });
      qc.invalidateQueries({ queryKey: ['week', weekId] });
      invalidateCoachDashboard(qc);
    },
  });
}

/**
 * Reorder the phases of a block. `orderedIds` is EVERY phase of the program in
 * the order wanted; index 0 becomes `week_number` 1.
 *
 * One call of `reorder_weeks` (migration 2026_10_13_11), for the reason given
 * at `useReorderSessions`: `UNIQUE (program_id, week_number)` is not
 * deferrable, so the rows are parked and then placed, and both steps belong in
 * one statement. A list that is not exactly the phases of the program is
 * refused with `reorder_ids_mismatch`.
 *
 * `blockId` only names the scope a call waits in. The program whose phases
 * are renumbered is the `programId` of each call, sent with its list.
 */
export function useReorderWeeks(blockId) {
  const qc = useQueryClient();
  const scope = blockOrderScope(blockId);

  return useMutation({
    scope,
    mutationFn: async ({ programId, orderedIds }) => {
      const { error } = await supabase.rpc('reorder_weeks', {
        p_program_id: programId,
        p_ids: orderedIds,
      });
      if (error) throw error;
      return { programId };
    },
    onMutate: async ({ programId, orderedIds }) => {
      await qc.cancelQueries({ queryKey: ['program'] });
      const snapshots = qc.getQueriesData({ queryKey: ['program'] });
      for (const [key, prog] of snapshots) {
        if (!prog || prog.id !== programId) continue;
        const byId = new Map((prog.weeks || []).map((w) => [w.id, w]));
        const reordered = orderedIds
          .map((id, idx) => {
            const w = byId.get(id);
            return w ? { ...w, week_number: idx + 1 } : null;
          })
          .filter(Boolean);
        qc.setQueryData(key, { ...prog, weeks: reordered });
      }
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => restoreBlockOrder(qc, scope, ctx),
    onSettled: () => refreshBlockOrder(qc, scope),
  });
}

export function useUpdateSession() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...updates }) => {
      const { data, error } = await supabase
        .from('sessions')
        .update(updates)
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return { data, id, weekId: data.week_id };
    },
    onSuccess: ({ id, weekId }) => {
      qc.invalidateQueries({ queryKey: ['week', weekId] });
      qc.invalidateQueries({ queryKey: ['session', id] });
      // The Program Sheet renders session titles and day pills straight from
      // ['program'] — without this a rename or a day move writes through to the
      // DB but the sheet keeps showing the old value until it refetches.
      qc.invalidateQueries({ queryKey: ['program'] });
      // Title/day_number ride along in the coach's Confirmed-feed payload and
      // in the dashboard strip, so both go stale on a rename or a day move.
      qc.invalidateQueries({ queryKey: ['all-confirmations'] });
      invalidateCoachDashboard(qc);
    },
  });
}

/**
 * Archive or unarchive a session. Archived sessions are hidden from the
 * coach's default week view and from the Confirmed-sessions list so the
 * coach can keep the active worklist clean after reviewing.
 */
export function useArchiveSession() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, archived }) => {
      const { data, error } = await supabase
        .from('sessions')
        .update({ archived_at: archived ? new Date().toISOString() : null })
        .eq('id', sessionId)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['week', data.week_id] });
      qc.invalidateQueries({ queryKey: ['session', data.id] });
      // Archiving moves the session between the sheet's active list and its
      // "N archived" drawer, both of which read ['program'].
      qc.invalidateQueries({ queryKey: ['program'] });
      // Archiving hides the session from the coach's Confirmed feed.
      qc.invalidateQueries({ queryKey: ['all-confirmations'] });
      // …and pulls it out of the athlete's queue, which reads its own tree.
      qc.invalidateQueries({ queryKey: ['student-program-details'] });
      // The athlete's stats count sessions by `archived_at` (planned, done,
      // the calendar): Stats open in the next section must not keep the
      // count from before the archive (review item P11).
      qc.invalidateQueries({ queryKey: ['student-progress-stats'] });
      invalidateCoachDashboard(qc);
    },
  });
}

/**
 * Archive (or restore) SEVERAL sessions at once — the coach's cleanup gesture.
 *
 * Archiving is the cleanup verb rather than deleting because the DB refuses to
 * delete a session that has logged sets (`block_session_delete_with_logged_sets`),
 * so for anything the athlete actually trained archiving is the only answer.
 * It also keeps the record, which is the point.
 *
 * Sequential, not parallel: these are a handful of hand-picked rows, and a
 * partial failure is far easier to reason about when the writes are ordered —
 * `done` says exactly how many landed before the error. It stops at the first
 * request that fails, and the error it throws carries that count as
 * `error.partial`.
 *
 * The coach is told ONCE, by this hook: "2 of 5 archived" when some rows
 * landed — the sheet is about to show two sessions gone and three still
 * there, and "could not save" alone would be wrong about the two — and the
 * usual line of `mutationErrorKey` when none did. Hence `skipErrorToast`: the
 * toast of the mutation cache would be a second one for the same failure.
 */
export function useArchiveSessions() {
  const qc = useQueryClient();
  const { t } = useI18n();

  return useMutation({
    meta: { skipErrorToast: true },
    mutationFn: async ({ sessionIds, archived }) => {
      const archived_at = archived ? new Date().toISOString() : null;
      let done = 0;
      try {
        for (const id of sessionIds) {
          const { error } = await supabase
            .from('sessions')
            .update({ archived_at })
            .eq('id', id);
          if (error) throw error;
          done += 1;
        }
      } catch (error) {
        // Also for a request that throws instead of answering with an error.
        if (error && typeof error === 'object') error.partial = done;
        throw error;
      }
      return { done };
    },
    onError: (error, { sessionIds, archived }) => {
      const done = error?.partial ?? 0;
      if (done === 0) {
        pushToast(mutationErrorKey(error), { kind: 'error' });
        return;
      }
      const counts = { done, total: sessionIds.length };
      pushToast(
        archived
          ? t('coachDuplicateRpc.archivePartial', counts)
          : t('coachDuplicateRpc.restorePartial', counts),
        { kind: 'error' },
      );
    },
    onSettled: () => {
      // onSettled, not onSuccess: a partial failure still moved rows, so the
      // caches must refresh either way or the sheet shows a mix of stale and
      // fresh state.
      qc.invalidateQueries({ queryKey: ['program'] });
      qc.invalidateQueries({ queryKey: ['all-confirmations'] });
      qc.invalidateQueries({ queryKey: ['student-program-details'] });
      // The stats read `archived_at` too (review item P11).
      qc.invalidateQueries({ queryKey: ['student-progress-stats'] });
      invalidateCoachDashboard(qc);
    },
  });
}

export function useDeleteSession() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (sessionId) => {
      // Need week_id to invalidate properly
      const { data } = await supabase.from('sessions').select('week_id').eq('id', sessionId).single();
      const weekId = data?.week_id;
      
      const { error } = await supabase
        .from('sessions')
        .delete()
        .eq('id', sessionId);
      if (error) throw error;
      return weekId;
    },
    onSuccess: (weekId) => {
      if (weekId) qc.invalidateQueries({ queryKey: ['week', weekId] });
      else qc.invalidateQueries({ queryKey: ['week'] });
      // The deleted row must leave the Program Sheet's week list too.
      qc.invalidateQueries({ queryKey: ['program'] });
      qc.invalidateQueries({ queryKey: ['all-confirmations'] });
      invalidateCoachDashboard(qc);
    },
  });
}
