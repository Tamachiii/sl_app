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
 * loaded) read as uniform — `formatSlotPrescription` falls back to the
 * deprecated slot scalars in that case.
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
 * Format the prescribed work for an exercise slot when its sets are uniform.
 *   { sets: 3, reps: 10 }              → "3 × 10"
 *   { sets: 3, duration_seconds: 30 }  → "3 × 30s"
 * If per-set logs are heterogeneous, returns null — render a per-set list
 * instead (see SlotGroupCard).
 */
export function formatSlotPrescription(slot) {
  if (!isSlotUniform(slot)) return null;
  const logs = logsForSlot(slot).filter(logHasTarget);
  const head = logs[0];
  const isSeconds = head
    ? head.target_duration_seconds != null
    : slot.duration_seconds != null;
  const value = head
    ? (isSeconds ? head.target_duration_seconds : head.target_reps)
    : (isSeconds ? slot.duration_seconds : slot.reps);
  return isSeconds
    ? `${slot.sets} × ${value}s`
    : `${slot.sets} × ${value}`;
}

/**
 * Resolve the slot's "uniform" weight target — the head log's
 * target_weight_kg when present, otherwise the deprecated slot column.
 * Returns a number or null. Use for the compact-mode "@ NNkg" / "(BW)"
 * suffix in headers.
 */
export function getSlotTargetWeight(slot) {
  const logs = logsForSlot(slot).filter(logHasTarget);
  const head = logs[0];
  const v = head ? head.target_weight_kg : slot?.weight_kg;
  return v == null ? null : Number(v);
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
 * Single-line slot summary covering both uniform and heterogeneous sets.
 *   uniform 3×10 @ 80kg          → "3 × 10 @ 80kg"
 *   drop set 3×3@120, 3×6@100    → "3 × 3 @ 120kg · 3 × 6 @ 100kg"
 *   ramp 1×5@100, 1×3@110, 1×1@120 → "1 × 5 @ 100kg · 1 × 3 @ 110kg · 1 × 1 @ 120kg"
 *   genuinely varied (>3 groups) → "6 sets · varied"   (fallback)
 *
 * Rest is intentionally NOT a grouping key — varying rest within a slot
 * shouldn't fragment the headline; the expanded view shows it per row.
 */
export function summarizeSlotPrescription(slot) {
  if (isSlotUniform(slot)) {
    const compact = formatSlotPrescription(slot);
    if (!compact) return null;
    const w = getSlotTargetWeight(slot);
    return compact + (w ? ` @ ${w}kg` : '');
  }
  const logs = logsForSlot(slot).filter(logHasTarget);
  if (logs.length === 0) return null;
  const groups = [];
  for (const l of logs) {
    const key = `${l.target_reps}|${l.target_duration_seconds}|${l.target_weight_kg ?? ''}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.count += 1;
    } else {
      groups.push({ key, count: 1, log: l });
    }
  }
  if (groups.length > 3) return `${slot.sets} sets · varied`;
  return groups.map((g) => {
    const isSeconds = g.log.target_duration_seconds != null;
    const value = isSeconds ? `${g.log.target_duration_seconds}s` : g.log.target_reps;
    const w = g.log.target_weight_kg == null ? null : Number(g.log.target_weight_kg);
    const weightStr = w == null ? ' (BW)' : ` @ ${w}kg`;
    return `${g.count} × ${value}${weightStr}`;
  }).join(' · ');
}

/**
 * Format a single set's per-set prescription for the heterogeneous list view.
 *   { target_reps: 10, target_weight_kg: 80 }       → "10 @ 80kg"
 *   { target_duration_seconds: 30 }                  → "30s"
 *   { target_reps: 5, target_weight_kg: null }       → "5 (BW)"
 */
export function formatSetTarget(log) {
  if (!log) return '';
  const w = log.target_weight_kg;
  const weightSuffix = w == null ? ' (BW)' : ` @ ${Number(w)}kg`;
  if (log.target_duration_seconds != null) {
    return `${log.target_duration_seconds}s${weightSuffix}`;
  }
  if (log.target_reps != null) {
    return `${log.target_reps}${weightSuffix}`;
  }
  return weightSuffix.trim();
}

/**
 * Format a rest period as "1:30" (mm:ss) when >= 60s, otherwise "45s".
 */
export function formatRestSeconds(seconds) {
  if (seconds == null) return null;
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
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
