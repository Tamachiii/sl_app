import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import { writeCached } from '../lib/cacheWrite';
import { MUTATION_KEYS, MUTATION_FNS } from '../lib/offlineMutations';

/**
 * Fetch all slot_comments for a session's slots in a single round-trip.
 * Returns an array; callers typically index by exercise_slot_id.
 */
export function useSlotComments(sessionId, slots) {
  return useQuery({
    queryKey: ['slot-comments', sessionId],
    queryFn: async () => {
      const slotIds = (slots || []).map((s) => s.id);
      if (slotIds.length === 0) return [];
      const { data, error } = await supabase
        .from('slot_comments')
        .select('*')
        .in('exercise_slot_id', slotIds);
      if (error) throw error;
      return data || [];
    },
    enabled: !!sessionId && !!slots && slots.length > 0,
  });
}

// Is another save of the note of the same exercise still on its way? These
// writes leave in the order they were made (the `offline-writes` scope), so
// any other one that is pending was made AFTER the one that asks. React Query
// hands a handler the variables object of its own mutation: identity tells
// this write from the others.
function hasNewerSave(qc, variables) {
  return qc
    .getMutationCache()
    .findAll({ mutationKey: MUTATION_KEYS.saveSlotComment, status: 'pending' })
    .some((m) => m.state.variables !== variables && m.state.variables?.slotId === variables?.slotId);
}

// The notes of a session with the note of one exercise set to `row` — or
// without it, for `null`.
function withNote(rows, slotId, row) {
  const others = rows.filter((c) => c.exercise_slot_id !== slotId);
  return row ? [...others, row] : others;
}

/**
 * Upsert the student's comment on a slot. An empty body deletes the row so
 * the coach doesn't see an empty bubble.
 *
 * The note is written into ['slot-comments', sessionId] at the tap, like every
 * other write of a workout: it is made in a gym, and a save that waits for a
 * network left the note off the screen — "Add note" again, as if nothing had
 * been written — until it was sent (P25). When the save fails, the note the
 * exercise had before is put back, unless a newer save of the same note is
 * waiting.
 *
 * There is NO `onSettled`: reading the notes again once the write has settled
 * belongs to the defaults `registerOfflineMutationDefaults` registers for the
 * key (lib/offlineMutations.js), which also serve a note replayed after a
 * relaunch, with no hook around it. An option set here REPLACES the default of
 * the same name — it does not run next to it.
 */
export function useSaveSlotComment() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const studentId = user?.id;

  const m = useMutation({
    mutationKey: MUTATION_KEYS.saveSlotComment,
    mutationFn: MUTATION_FNS.saveSlotComment,
    onMutate: async ({ sessionId, slotId, studentId: sid, body }) => {
      if (!sessionId) return undefined;
      const key = ['slot-comments', sessionId];
      // A read on its way was sent before this write: it would land on top of it.
      await qc.cancelQueries({ queryKey: key });
      const rows = qc.getQueryData(key);
      const previous = (rows || []).find((c) => c.exercise_slot_id === slotId) ?? null;
      // The body as the database will hold it.
      const text = (body || '').trim();
      const row = text
        ? {
            ...(previous ?? { exercise_slot_id: slotId, student_id: sid }),
            body: text,
            updated_at: new Date().toISOString(),
          }
        : null;

      if (Array.isArray(rows)) {
        writeCached(qc, key, (held) => withNote(held, slotId, row));
      } else if (row) {
        // The notes of this session were never read: it was read ahead by the
        // training list and opened without a network, which is the session a
        // note is most often written in. The note is shown all the same — it
        // is the athlete's, and the only one the device knows of — and the
        // entry is flagged, so that it is read as soon as it can be.
        qc.setQueryData(key, [row]);
        qc.invalidateQueries({ queryKey: key, exact: true, refetchType: 'none' });
      }
      // Stored with a write that waits: one row, not the list.
      return { sessionId, slotId, previous };
    },
    onError: (_err, variables, context) => {
      if (!context?.sessionId || hasNewerSave(qc, variables)) return;
      writeCached(qc, ['slot-comments', context.sessionId], (held) =>
        Array.isArray(held) ? withNote(held, context.slotId, context.previous) : undefined,
      );
    },
  });
  return {
    ...m,
    mutate: (vars, options) => m.mutate({ ...vars, studentId }, options),
    mutateAsync: (vars, options) => m.mutateAsync({ ...vars, studentId }, options),
  };
}
