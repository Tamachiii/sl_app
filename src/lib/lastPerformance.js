// "Last time" reference for the logging surface: what the student did for a
// given exercise the last time they performed it, so progressive overload has
// a target to beat right where sets are logged.
//
// Reuses the effective-load model from lib/records (a done set's actual weight/
// reps override the prescribed target). Swap attribution is handled upstream in
// useLastPerformance, which remaps each row to its effective (substitute)
// exercise before calling this — so rows arriving here already carry the
// exercise the student actually performed.

import { effectiveWeight, effectiveReps } from './records';

/**
 * Reduce a student's DONE set_logs into one entry per exercise: the sets they
 * performed in their most recent PRIOR session for that exercise.
 *
 * Each input row is a flattened set_log:
 *   { exerciseId, sessionId, scheduledDate, loggedAt, setNumber,
 *     target_reps, target_weight_kg, actual_reps, actual_weight_kg }
 *
 * "Prior" excludes `currentSessionId`, and — when `currentScheduledDate` is
 * known — any session dated on/after it, so opening a session never surfaces a
 * "last time" that postdates it (rows with no scheduledDate fall back to
 * loggedAt ordering and are kept). Only the single most recent qualifying
 * session per exercise is returned, its sets in set order.
 *
 * Returns a plain object keyed by exerciseId (JSON-serializable so it survives
 * the React Query IndexedDB persister — a Map would not).
 */
export function buildLastPerformance(rows, { currentSessionId, currentScheduledDate } = {}) {
  // exerciseId -> (sessionId -> { sessionId, scheduledDate, performedAt, sets })
  const byExercise = new Map();

  for (const r of rows || []) {
    if (!r || !r.exerciseId || !r.sessionId) continue;
    if (r.sessionId === currentSessionId) continue;
    if (
      currentScheduledDate &&
      r.scheduledDate &&
      r.scheduledDate >= currentScheduledDate
    ) {
      continue;
    }
    const reps = effectiveReps(r);
    if (reps <= 0) continue; // duration-only / unlogged sets carry no rep target
    const weight = effectiveWeight(r);

    let sessions = byExercise.get(r.exerciseId);
    if (!sessions) {
      sessions = new Map();
      byExercise.set(r.exerciseId, sessions);
    }
    let sess = sessions.get(r.sessionId);
    if (!sess) {
      sess = {
        sessionId: r.sessionId,
        scheduledDate: r.scheduledDate || null,
        performedAt: null,
        sets: [],
      };
      sessions.set(r.sessionId, sess);
    }
    sess.sets.push({ setNumber: r.setNumber ?? null, weight, reps, loggedAt: r.loggedAt || null });
    if (r.loggedAt && (!sess.performedAt || r.loggedAt > sess.performedAt)) {
      sess.performedAt = r.loggedAt;
    }
  }

  const out = {};
  for (const [exerciseId, sessions] of byExercise) {
    const list = Array.from(sessions.values());
    // Most recent session first: by scheduled date, then by when it was logged.
    list.sort((a, b) => {
      const d = (b.scheduledDate || '').localeCompare(a.scheduledDate || '');
      if (d !== 0) return d;
      return (b.performedAt || '').localeCompare(a.performedAt || '');
    });
    const last = list[0];
    if (!last || last.sets.length === 0) continue;
    last.sets.sort(
      (a, b) =>
        (a.setNumber ?? 0) - (b.setNumber ?? 0) ||
        (a.loggedAt || '').localeCompare(b.loggedAt || '')
    );
    out[exerciseId] = {
      performedAt: last.performedAt,
      scheduledDate: last.scheduledDate,
      sets: last.sets.map((s) => ({ weight: s.weight, reps: s.reps })),
    };
  }
  return out;
}

/**
 * Compact one-line summary of a prior performance's sets, collapsing runs of
 * identical (weight, reps) sets:
 *   uniform 3×8 @ 100      → "3 × 8 @ 100kg"
 *   mixed 8@100, 8@100, 6  → "2 × 8 @ 100kg · 6 @ 100kg"
 *   bodyweight 10, 8       → "10 · 8"
 * Beyond `maxGroups` distinct groups it appends "+N".
 */
export function formatLastPerformance(perf, { maxGroups = 4 } = {}) {
  if (!perf || !Array.isArray(perf.sets) || perf.sets.length === 0) return '';
  const groups = [];
  for (const s of perf.sets) {
    const prev = groups[groups.length - 1];
    if (prev && prev.weight === s.weight && prev.reps === s.reps) prev.count++;
    else groups.push({ weight: s.weight, reps: s.reps, count: 1 });
  }
  const parts = groups.slice(0, maxGroups).map((g) => {
    const weightSuffix = g.weight > 0 ? ` @ ${g.weight}kg` : '';
    return g.count > 1 ? `${g.count} × ${g.reps}${weightSuffix}` : `${g.reps}${weightSuffix}`;
  });
  if (groups.length > maxGroups) parts.push(`+${groups.length - maxGroups}`);
  return parts.join(' · ');
}

/**
 * Whole CALENDAR days between an ISO timestamp and `now` (default today),
 * never negative. Feeds the relative-time label ("yesterday", "5 days ago"),
 * which is rendered via Intl.RelativeTimeFormat with numeric:'auto' — a
 * CALENDAR-word formatter — so this must count calendar days, not elapsed
 * 24h spans (an evening session viewed the next morning is "yesterday", not
 * "today"). Both instants are anchored to LOCAL midnight and rounded, so a
 * DST-short/long day (23h/25h) still yields the right whole-day count. `now`
 * is injectable so the pure function stays testable.
 */
export function daysSince(iso, now) {
  if (!iso) return null;
  const then = new Date(iso);
  if (!Number.isFinite(then.getTime())) return null;
  const ref = now || new Date();
  const thenMid = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const refMid = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  return Math.max(0, Math.round((refMid.getTime() - thenMid.getTime()) / 86400000));
}
