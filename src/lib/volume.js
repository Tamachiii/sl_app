/**
 * Slot prescription helpers — handle both rep-based and time-based exercises.
 *
 * Per-set targets live on the slot's `set_logs` rows
 * (`target_reps`, `target_duration_seconds`, `target_weight_kg`,
 * `target_rest_seconds`). When every set's target matches, callers can render
 * the compact "3 × 10 @ 80kg" string. Otherwise a per-set list is shown.
 */

function logsForSlot(slot) {
  return (slot?.set_logs || []).slice().sort((a, b) => a.set_number - b.set_number);
}

// A log only counts as a real "target source" once one of its target_*
// columns is populated. Pre-migration mock data may include set_logs without
// any targets — those should fall through to the slot's deprecated scalars.
function logHasTarget(l) {
  return (
    (l && (l.target_reps != null || l.target_duration_seconds != null || l.target_weight_kg != null || l.target_rest_seconds != null))
  );
}

/**
 * Returns true when every set in the slot prescribes the same reps (or
 * duration), weight, and rest. Slots without per-set logs (legacy / freshly
 * loaded) read as uniform.
 */
export function isSlotUniform(slot) {
  const logs = logsForSlot(slot).filter(logHasTarget);
  if (logs.length <= 1) return true;
  const head = logs[0];
  for (let i = 1; i < logs.length; i++) {
    const l = logs[i];
    if ((l.target_reps ?? null) !== (head.target_reps ?? null)) return false;
    if ((l.target_duration_seconds ?? null) !== (head.target_duration_seconds ?? null)) return false;
    const w1 = l.target_weight_kg == null ? null : Number(l.target_weight_kg);
    const w0 = head.target_weight_kg == null ? null : Number(head.target_weight_kg);
    if (w1 !== w0) return false;
    if ((l.target_rest_seconds ?? null) !== (head.target_rest_seconds ?? null)) return false;
  }
  return true;
}

/**
 * Resolve the slot's "uniform" rest target — the head log's
 * target_rest_seconds when present, otherwise the deprecated slot column.
 * Returns a number or null.
 */
export function getSlotTargetRest(slot) {
  const logs = logsForSlot(slot).filter(logHasTarget);
  const head = logs[0];
  const v = head ? head.target_rest_seconds : slot?.rest_seconds;
  return v == null ? null : Number(v);
}

/**
 * True when the student logged an off-plan actual on this set — i.e. they
 * recorded reps or load that differed from the prescription. A NULL on both
 * actual_* columns means "followed the plan", so this also doubles as the
 * "did they deviate?" predicate for the off-plan read-out.
 */
export function hasLoggedActual(log) {
  return !!log && (log.actual_reps != null || log.actual_weight_kg != null);
}

/**
 * Group consecutive slots that share a superset_group into a single rendering
 * unit. Slots without a group, or with a group that doesn't match the previous
 * slot, start a fresh group of one. Order is preserved.
 *
 * Returns: [{ key, slots: [...] }]
 *   - key: superset_group uuid for grouped slots, or the slot's id otherwise
 *   - slots: 1+ slots; >1 means it's a real superset.
 */
export function groupSlotsBySuperset(slots) {
  const groups = [];
  for (const slot of slots) {
    const last = groups[groups.length - 1];
    if (slot.superset_group && last && last.key === slot.superset_group) {
      last.slots.push(slot);
    } else if (slot.superset_group) {
      groups.push({ key: slot.superset_group, slots: [slot] });
    } else {
      groups.push({ key: slot.id, slots: [slot] });
    }
  }
  return groups;
}

/**
 * Compute pull/push volume for a session.
 * Each slot must have slot.exercise joined (with difficulty, type, volume_weight).
 *
 * Per-set: tonnage = difficulty × Σ(target_reps) × volume_weight per slot,
 * summed per type. When per-set logs aren't loaded yet, falls back to the
 * legacy `sets × reps` formula.
 *
 * Time-under-tension entries (duration_seconds set, reps null) are skipped —
 * a 30s plank isn't directly comparable to a 10-rep set on the same scale,
 * so we leave them out of the bar rather than distort it.
 */
export function computeSessionVolume(slots) {
  const volume = { pull: 0, push: 0 };
  for (const slot of slots) {
    const ex = slot.exercise;
    if (!ex) continue;
    const logs = logsForSlot(slot).filter(logHasTarget);
    let totalReps = 0;
    if (logs.length > 0) {
      for (const l of logs) {
        if (l.target_reps == null) continue;
        totalReps += l.target_reps;
      }
    } else {
      if (slot.reps == null) continue;
      totalReps = (slot.sets || 0) * slot.reps;
    }
    if (totalReps <= 0) continue;
    volume[ex.type] += ex.difficulty * totalReps * Number(ex.volume_weight);
  }
  return volume;
}
