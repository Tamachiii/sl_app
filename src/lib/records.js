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
 * Total resistance the muscles moved on a set, given the exercise's load_mode:
 *   - 'added' → bodyweight is the base and `addedKg` sits on top, so the system
 *     load is bodyweight + added (null when bodyweight is unknown).
 *   - 'full' / null (unclassified) → the logged weight already IS the total load.
 */
export function systemLoad(addedKg, bodyweightKg, loadMode) {
  const added = addedKg > 0 ? Number(addedKg) : 0;
  if (loadMode === 'added') {
    if (!(bodyweightKg > 0)) return null; // unknown bodyweight → no system load
    return Number(bodyweightKg) + added;
  }
  return added;
}

// ×BW to one decimal ("1.7"); whole-kg for loads.
const round1 = (x) => Math.round(x * 10) / 10;

/**
 * Reduce a student's DONE set_logs (each carrying its exercise + logged_at)
 * into one record per exercise:
 *   - bestE1rm / at / weight / reps  — heaviest estimated 1RM from a weighted set
 *   - bestReps / at                  — most reps in a single set (bodyweight PR)
 *
 * Relative strength (×BW) is layered on WITHOUT changing the headline or PR
 * selection: `bestE1rm` stays the bodyweight-independent added/logged-load e1RM
 * (so weight gain can never manufacture or reshuffle a PR, and the est-1RM
 * headline is byte-identical to before this feature). Separately, for a
 * classified movement (`load_mode` 'full'/'added') where bodyweight is known,
 * we track the best RELATIVE strength — the MAXIMUM over all qualifying sets of
 * (system-load e1RM ÷ bodyweight at that set):
 *   - loadMode    — 'full' | 'added' | null (unclassified)
 *   - relStrength — the peak ×BW, one decimal (null when unknown/unclassified)
 *   - bwAtBest    — bodyweight at the peak-×BW set (null when we never resolved
 *                   a bodyweight for a scored set — drives the "log bodyweight"
 *                   nudge and the graceful-degrade path)
 * Tracking the ratio as a true MAX (not deriving it from the added-load PR set)
 * means the strongest relative single always wins, and a bodyweight-only set on
 * an 'added' movement (system load = bodyweight) still contributes.
 *
 * `recentSince` (a Date) flags a record set on/after it as freshly earned.
 * `bodyweightAt(loggedAtIso)` returns the student's bodyweight at a set's date
 * (default () => null → no ×BW, every existing caller/test stays byte-identical).
 */
export function buildRecords(logs, { recentSince, bodyweightAt = () => null } = {}) {
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
        loadMode: ex.load_mode ?? null,
        bestE1rm: 0,
        bestE1rmAt: null,
        bestE1rmWeight: 0,
        bestE1rmReps: 0,
        bestReps: 0,
        bestRepsAt: null,
        bestRel: 0,       // peak system-load e1RM ÷ bodyweight
        bestRelBw: null,  // bodyweight at that peak
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

    // Relative-strength track (classified movements with a resolvable bodyweight).
    if (rec.loadMode === 'full' || rec.loadMode === 'added') {
      const bw = bodyweightAt(at);
      const sys = systemLoad(w, bw, rec.loadMode);
      if (bw > 0 && sys > 0) {
        const ratio = epley1rm(sys, reps) / bw;
        if (ratio > rec.bestRel) {
          rec.bestRel = ratio;
          rec.bestRelBw = bw;
        }
      }
    }
  }

  const since = recentSince ? recentSince.getTime() : null;
  const isRecent = (at) => (since && at ? new Date(at).getTime() >= since : false);

  return Array.from(byExercise.values())
    .map((r) => {
      const bestE1rm = r.bestE1rm > 0 ? Math.round(r.bestE1rm) : null;
      return {
        ...r,
        bestE1rm,
        relStrength: r.bestRel > 0 ? round1(r.bestRel) : null,
        bwAtBest: r.bestRelBw ?? null,
        recent: isRecent(r.bestE1rmAt) || isRecent(r.bestRepsAt),
      };
    })
    // Weighted records first (they carry an e1RM), then by e1RM / reps desc.
    // Sort stays on the bodyweight-independent bestE1rm so ordering never shifts
    // when a student's weight changes.
    .sort((a, b) => (b.bestE1rm ?? 0) - (a.bestE1rm ?? 0) || b.bestReps - a.bestReps);
}
