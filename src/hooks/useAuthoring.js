import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import { MUTATION_KEYS, MUTATION_FNS } from '../lib/offlineMutations';

// ── Phase 3.4d: OFFLINE student program authoring ─────────────────────────────
// The draft is edited entirely in an optimistic React Query cache with
// CLIENT-MINTED uuids, and synced as ONE declarative whole-tree snapshot via the
// idempotent `save_draft_tree` RPC. This sidesteps the classic offline-INSERT
// iceberg (per-node inserts needing server ids + FIFO ordering + UNIQUE
// collisions): re-running a snapshot converges to exactly that tree, so stacked
// snapshots, a cold-reload hydrate, or a double-run can never duplicate rows.
// Drafts never carry set_logs — the coach's approve_program materializes those.

const newId = () => crypto.randomUUID();

/** The signed-in student's current draft program (one at a time), or null. */
export function useMyDraft() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-draft', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('programs')
        .select('id, name, status, submitted_at, created_at')
        .eq('created_by', user.id)
        .eq('status', 'draft')
        .is('deleted_at', null)
        .maybeSingle();
      if (error) throw error;
      return data || null;
    },
    enabled: !!user?.id,
  });
}

/** Full draft tree (weeks → sessions → slots + exercise meta) for the builder. */
export function useDraftTree(programId) {
  return useQuery({
    queryKey: ['draft-tree', programId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('programs')
        .select(`
          id, name, status, submitted_at,
          weeks(
            id, week_number, label,
            sessions(
              id, title, day_number, sort_order,
              exercise_slots(
                id, exercise_id, sets, reps, weight_kg, duration_seconds, rest_seconds, sort_order,
                exercise:exercise_library(id, name, type)
              )
            )
          )
        `)
        .eq('id', programId)
        .maybeSingle();
      if (error) throw error;
      if (data) {
        data.weeks = (data.weeks || []).sort((a, b) => a.week_number - b.week_number);
        for (const w of data.weeks) {
          w.sessions = (w.sessions || []).sort((a, b) => a.sort_order - b.sort_order);
          for (const s of w.sessions) {
            s.exercise_slots = (s.exercise_slots || []).sort((a, b) => a.sort_order - b.sort_order);
          }
        }
      }
      return data;
    },
    enabled: !!programId,
  });
}

/**
 * Flatten the nested draft-tree cache into the flat snapshot the RPC expects.
 * XOR guard: exercise_slots require exactly one of reps/duration — the authoring
 * UI only sets reps, so force reps ≥ 1 whenever no duration is present (a blank
 * reps field must never sync as both-null and abort the whole tree at replay).
 */
export function buildSnapshot(tree) {
  const program = { id: tree.id, name: tree.name, submitted_at: tree.submitted_at ?? null };
  const weeks = [];
  const sessions = [];
  const slots = [];
  for (const w of tree.weeks || []) {
    weeks.push({ id: w.id, program_id: tree.id, week_number: w.week_number, label: w.label ?? null });
    for (const s of w.sessions || []) {
      sessions.push({ id: s.id, week_id: w.id, title: s.title, day_number: s.day_number, sort_order: s.sort_order });
      for (const sl of s.exercise_slots || []) {
        const hasDuration = sl.duration_seconds != null;
        slots.push({
          id: sl.id,
          session_id: s.id,
          exercise_id: sl.exercise_id,
          sets: sl.sets ?? 3,
          reps: hasDuration ? (sl.reps ?? null) : (sl.reps ?? 1),
          weight_kg: sl.weight_kg ?? null,
          duration_seconds: sl.duration_seconds ?? null,
          rest_seconds: sl.rest_seconds ?? null,
          sort_order: sl.sort_order ?? 0,
        });
      }
    }
  }
  return { program, weeks, sessions, slots };
}

// Bound queue growth: drop any still-paused draft-tree saves before enqueuing a
// fresh full snapshot. Correctness never depends on this (FIFO replays of full
// snapshots converge) — it just avoids stacking N snapshots during a long
// offline session.
function coalesceSaves(qc) {
  const cache = qc.getMutationCache();
  for (const m of cache.getAll()) {
    const key = m.options.mutationKey;
    if (m.state.isPaused && Array.isArray(key) && key[0] === 'draft-tree' && key[1] === 'save') {
      cache.remove(m);
    }
  }
}

/**
 * The single keyed mutation that syncs a draft snapshot. Offline it PAUSES
 * (networkMode 'online') and replays on reconnect. Its onSuccess / onError
 * (reconcile recognized codes, toast the rest, never clobber the local tree) +
 * meta.skipErrorToast live in the registered DEFAULTS (lib/offlineMutations.js)
 * so a hydrated post-reload resume behaves identically to this live instance.
 */
export function useSaveDraftTree() {
  return useMutation({
    mutationKey: MUTATION_KEYS.saveDraftTree,
    mutationFn: MUTATION_FNS.saveDraftTree,
    scope: { id: 'draft-tree' },
  });
}

/** Discard the whole draft (offline-safe: a draft has no logged training). */
export function useDiscardDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: MUTATION_KEYS.discardDraft,
    mutationFn: MUTATION_FNS.discardDraft,
    scope: { id: 'draft-tree' },
    onSettled: () => qc.invalidateQueries({ queryKey: ['my-draft'] }),
  });
}

/**
 * Create a draft owned by the signed-in student (one draft allowed). Mints the
 * program uuid client-side, seeds both caches optimistically so the builder
 * renders immediately (offline included), and enqueues a program-only snapshot.
 * student_id is filled server-side by the RPC — no offline-impossible lookup.
 */
export function useCreateDraft() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const save = useSaveDraftTree();
  return {
    isPending: save.isPending,
    mutate: ({ name } = {}) => {
      const id = newId();
      const cleanName = (name || '').trim() || 'My program';
      const draft = { id, name: cleanName, status: 'draft', submitted_at: null, created_at: new Date().toISOString() };
      qc.setQueryData(['my-draft', user?.id], draft);
      qc.setQueryData(['draft-tree', id], { id, name: cleanName, status: 'draft', submitted_at: null, weeks: [] });
      coalesceSaves(qc);
      save.mutate({ tree: buildSnapshot({ id, name: cleanName, submitted_at: null, weeks: [] }) });
      return id;
    },
  };
}

/**
 * Local editors for a draft's tree. Each is a synchronous optimistic cache edit
 * (ordinals derived inside the updater so rapid adds never collide) followed by
 * enqueuing one fresh whole-tree snapshot. No per-edit useMutation → the offline
 * guardrail's static scan sees only the two keyed writes above.
 */
export function useDraftActions(programId) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const save = useSaveDraftTree();
  const discardMut = useDiscardDraft();

  const commit = useCallback(
    (updater) => {
      qc.cancelQueries({ queryKey: ['draft-tree', programId] });
      qc.setQueryData(['draft-tree', programId], (prev) => (prev ? updater(prev) : prev));
      const fresh = qc.getQueryData(['draft-tree', programId]);
      if (!fresh) return;
      coalesceSaves(qc);
      save.mutate({ tree: buildSnapshot(fresh) });
    },
    [qc, programId, save],
  );

  const addWeek = useCallback(() => {
    commit((t) => {
      const nextNum = (t.weeks || []).reduce((m, w) => Math.max(m, w.week_number), 0) + 1;
      return { ...t, weeks: [...(t.weeks || []), { id: newId(), week_number: nextNum, label: null, sessions: [] }] };
    });
  }, [commit]);

  const addSession = useCallback(
    (weekId) => {
      commit((t) => ({
        ...t,
        weeks: (t.weeks || []).map((w) => {
          if (w.id !== weekId) return w;
          const nextSort = (w.sessions || []).reduce((m, s) => Math.max(m, s.sort_order), -1) + 1;
          return {
            ...w,
            sessions: [
              ...(w.sessions || []),
              // day_number is a WEEKDAY (1 = Mon … 7 = Sun), not a position:
              // writing the ordinal here silently made a 5th session "Friday",
              // and an 8th fell outside 1..7 and vanished from the day strips.
              // A draft carries no weekday recommendation — sort_order is the
              // order, and the column is nullable since 2026_08_21.
              { id: newId(), title: `Day ${nextSort + 1}`, day_number: null, sort_order: nextSort, exercise_slots: [] },
            ],
          };
        }),
      }));
    },
    [commit],
  );

  const addSlot = useCallback(
    (sessionId, exercise) => {
      commit((t) => ({
        ...t,
        weeks: (t.weeks || []).map((w) => ({
          ...w,
          sessions: (w.sessions || []).map((s) => {
            if (s.id !== sessionId) return s;
            const nextSort = (s.exercise_slots || []).reduce((m, x) => Math.max(m, x.sort_order), -1) + 1;
            return {
              ...s,
              exercise_slots: [
                ...(s.exercise_slots || []),
                {
                  id: newId(),
                  exercise_id: exercise.id,
                  sets: 3,
                  reps: 5,
                  weight_kg: null,
                  duration_seconds: null,
                  rest_seconds: null,
                  sort_order: nextSort,
                  exercise: { id: exercise.id, name: exercise.name, type: exercise.type },
                },
              ],
            };
          }),
        })),
      }));
    },
    [commit],
  );

  const updateSlot = useCallback(
    (slotId, patch) => {
      commit((t) => ({
        ...t,
        weeks: (t.weeks || []).map((w) => ({
          ...w,
          sessions: (w.sessions || []).map((s) => ({
            ...s,
            exercise_slots: (s.exercise_slots || []).map((x) => (x.id === slotId ? { ...x, ...patch } : x)),
          })),
        })),
      }));
    },
    [commit],
  );

  const deleteRow = useCallback(
    (table, id) => {
      commit((t) => {
        if (table === 'weeks') return { ...t, weeks: (t.weeks || []).filter((w) => w.id !== id) };
        if (table === 'sessions') {
          return {
            ...t,
            weeks: (t.weeks || []).map((w) => ({ ...w, sessions: (w.sessions || []).filter((s) => s.id !== id) })),
          };
        }
        // exercise_slots
        return {
          ...t,
          weeks: (t.weeks || []).map((w) => ({
            ...w,
            sessions: (w.sessions || []).map((s) => ({
              ...s,
              exercise_slots: (s.exercise_slots || []).filter((x) => x.id !== id),
            })),
          })),
        };
      });
    },
    [commit],
  );

  const submit = useCallback(() => {
    const stamp = new Date().toISOString();
    qc.setQueryData(['my-draft', user?.id], (d) => (d ? { ...d, submitted_at: stamp } : d));
    commit((t) => ({ ...t, submitted_at: stamp }));
  }, [commit, qc, user?.id]);

  const discard = useCallback(
    (opts) => {
      coalesceSaves(qc);
      qc.setQueryData(['my-draft', user?.id], null);
      qc.removeQueries({ queryKey: ['draft-tree', programId] });
      discardMut.mutate({ programId }, opts);
    },
    [qc, user?.id, programId, discardMut],
  );

  return { addWeek, addSession, addSlot, updateSlot, deleteRow, submit, discard, saving: save.isPending };
}
