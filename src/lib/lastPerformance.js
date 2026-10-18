// "Last time" reference for the logging surface: what the student did for a
// given exercise the last time they performed it, so progressive overload has
// a target to beat right where sets are logged.
//
// Reuses the effective-load model from lib/records (a done set's actual weight/
// reps override the prescribed target). Swap attribution is handled upstream,
// in lib/doneSetHistory: the athlete's shared history hands each set over under
// its effective (substitute) exercise, and useLastPerformance passes those rows
// on as they are — so rows arriving here already carry the exercise the student
// actually performed.

import { effectiveWeight, effectiveReps } from './records';

// When a set was logged, as a number: the stamps arrive as strings of more
// than one form ('Z', '.000Z', '+00:00'), which do not sort as text. NaN for a
// set without one (rows older than the column).
function stampOf(loggedAt) {
  return loggedAt ? new Date(loggedAt).getTime() : NaN;
}

// Latest first; a session with no stamp after every session that has one.
function byLatestFirst(a, b) {
  const aHas = !Number.isNaN(a.latest);
  const bHas = !Number.isNaN(b.latest);
  if (aHas !== bHas) return aHas ? -1 : 1;
  if (aHas && a.latest !== b.latest) return b.latest - a.latest;
  // Equal stamps, or none at all: only so that the answer is the same on
  // every load.
  const d = (b.scheduledDate || '').localeCompare(a.scheduledDate || '');
  if (d !== 0) return d;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

/**
 * Reduce a student's DONE set_logs into one entry per exercise: the sets they
 * performed in their most recent PRIOR session for that exercise.
 *
 * Each input row is a flattened set_log:
 *   { exerciseId, sessionId, scheduledDate, loggedAt, setNumber,
 *     target_reps, target_weight_kg, actual_reps, actual_weight_kg }
 *
 * The order is the order of training: per exercise, the session whose latest
 * set of it was logged last is "last time". The recommended `scheduledDate`
 * takes no part — a session trained ahead of its date, or a copy that carries
 * no date, is placed where it was trained.
 *
 * "Prior" leaves out two kinds of session: `currentSessionId` itself, and every
 * session that STARTED AFTER it — whose first logged set (of any exercise) is
 * later than the current session's first. So an old session opened again shows
 * what came before it, not what came after. A current session with no logged
 * set in `rows`, and a session with no stamp, cut nothing: nothing tells when
 * they started. The current session's rows are read for that start only; they
 * never become an entry.
 *
 * `exerciseIds`, when given, are the exercises that get an entry; the rows of
 * the others still say when their session started. Pass the whole history.
 *
 * Only the single most recent qualifying session per exercise is returned, its
 * sets in set order: `{ performedAt, scheduledDate, sets: [{ weight, reps }] }`,
 * `performedAt` being the stamp of its latest set as it was stored.
 *
 * Returns a plain object keyed by exerciseId (JSON-serializable so it survives
 * the React Query IndexedDB persister — a Map would not).
 */
export function buildLastPerformance(rows, { currentSessionId, exerciseIds } = {}) {
  const only = exerciseIds ? new Set(exerciseIds) : null;
  // sessionId -> the stamp of its first logged set, any exercise
  const startOf = new Map();
  // exerciseId -> (sessionId -> { sessionId, scheduledDate, performedAt, latest, sets })
  const byExercise = new Map();

  for (const r of rows || []) {
    if (!r || !r.sessionId) continue;
    const at = stampOf(r.loggedAt);
    if (!Number.isNaN(at)) {
      const first = startOf.get(r.sessionId);
      if (first === undefined || at < first) startOf.set(r.sessionId, at);
    }
    if (!r.exerciseId || r.sessionId === currentSessionId) continue;
    if (only && !only.has(r.exerciseId)) continue;
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
        latest: NaN,
        sets: [],
      };
      sessions.set(r.sessionId, sess);
    }
    sess.sets.push({ setNumber: r.setNumber ?? null, weight, reps, at });
    if (!Number.isNaN(at) && (Number.isNaN(sess.latest) || at > sess.latest)) {
      sess.latest = at;
      sess.performedAt = r.loggedAt;
    }
  }

  const currentStart = currentSessionId != null ? startOf.get(currentSessionId) : undefined;
  const startedBefore = (sess) =>
    currentStart === undefined || !(startOf.get(sess.sessionId) > currentStart);

  const out = {};
  for (const [exerciseId, sessions] of byExercise) {
    const list = Array.from(sessions.values()).filter(startedBefore);
    list.sort(byLatestFirst);
    const last = list[0];
    if (!last || last.sets.length === 0) continue;
    last.sets.sort(
      (a, b) =>
        (a.setNumber ?? 0) - (b.setNumber ?? 0) ||
        (Number.isNaN(a.at) ? 0 : a.at) - (Number.isNaN(b.at) ? 0 : b.at)
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
