// Personal-record math for the strength surface.
//
// Estimated 1-rep max via the Epley formula: 1RM ≈ w × (1 + reps/30). It's the
// most common e1RM estimate and is exact at 1 rep. We compute it on the
// EFFECTIVE logged load (actual weight overrides the prescribed target on a
// done set), so a weighted-calisthenics single or a barbell top set both get a
// comparable estimate. Sets with no external load contribute a rep PR instead.

export function epley1rm(weightKg, reps) {
  if (!(weightKg > 0) || !(reps > 0)) return 0;
  // A single rep IS a 1RM — don't let Epley inflate it past the actual load.
  if (reps === 1) return weightKg;
  return weightKg * (1 + reps / 30);
}

// A done set's effective performed weight/reps (actual overrides target).
export function effectiveWeight(log) {
  const w = log.actual_weight_kg ?? log.target_weight_kg;
  return w != null && Number(w) > 0 ? Number(w) : 0;
}
export function effectiveReps(log) {
  const r = log.actual_reps ?? log.target_reps;
  return r != null && Number(r) > 0 ? Number(r) : 0;
}

/**
 * Reduce a student's DONE set_logs (each carrying its exercise + logged_at)
 * into one record per exercise:
 *   - bestE1rm / at / weight / reps  — heaviest estimated 1RM from a weighted set
 *   - bestReps / at                  — most reps in a single set (bodyweight PR)
 * `recentSince` (a Date) flags a record set on/after it as freshly earned, so
 * the UI can celebrate a new PR.
 */
export function buildRecords(logs, { recentSince } = {}) {
  const byExercise = new Map();
  for (const l of logs) {
    if (!l.done || !l.exercise) continue;
    const ex = l.exercise;
    const w = effectiveWeight(l);
    const reps = effectiveReps(l);
    if (reps <= 0) continue;
    const at = l.logged_at || null;

    let rec = byExercise.get(ex.id);
    if (!rec) {
      rec = {
        exercise_id: ex.id,
        name: ex.name,
        type: ex.type,
        bestE1rm: 0,
        bestE1rmAt: null,
        bestE1rmWeight: 0,
        bestE1rmReps: 0,
        bestReps: 0,
        bestRepsAt: null,
      };
      byExercise.set(ex.id, rec);
    }

    if (w > 0) {
      const e1rm = epley1rm(w, reps);
      if (e1rm > rec.bestE1rm) {
        rec.bestE1rm = e1rm;
        rec.bestE1rmAt = at;
        rec.bestE1rmWeight = w;
        rec.bestE1rmReps = reps;
      }
    }
    if (reps > rec.bestReps) {
      rec.bestReps = reps;
      rec.bestRepsAt = at;
    }
  }

  const since = recentSince ? recentSince.getTime() : null;
  const isRecent = (at) => (since && at ? new Date(at).getTime() >= since : false);

  return Array.from(byExercise.values())
    .map((r) => ({
      ...r,
      bestE1rm: r.bestE1rm > 0 ? Math.round(r.bestE1rm) : null,
      recent: isRecent(r.bestE1rmAt) || isRecent(r.bestRepsAt),
    }))
    // Weighted records first (they carry an e1RM), then by e1RM / reps desc.
    .sort((a, b) => (b.bestE1rm ?? 0) - (a.bestE1rm ?? 0) || b.bestReps - a.bestReps);
}
