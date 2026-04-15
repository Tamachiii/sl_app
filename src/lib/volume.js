/**
 * Format the prescribed work for an exercise slot in a way that handles
 * both rep-based and time-based exercises uniformly.
 *   { sets: 3, reps: 10 }              → "3 × 10"
 *   { sets: 3, duration_seconds: 30 }  → "3 × 30s"
 */
export function formatSlotPrescription(slot) {
  if (slot.duration_seconds != null) {
    return `${slot.sets} × ${slot.duration_seconds}s`;
  }
  return `${slot.sets} × ${slot.reps}`;
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
 * Formula: difficulty × sets × reps × volume_weight, summed per type.
 *
 * Time-under-tension slots (duration_seconds set, reps null) are skipped — a
 * 30s plank isn't directly comparable to a 10-rep set on the same scale, so
 * we leave them out of the bar rather than distort it.
 */
export function computeSessionVolume(slots) {
  const volume = { pull: 0, push: 0 };
  for (const slot of slots) {
    if (slot.reps == null) continue;
    const ex = slot.exercise;
    const v = ex.difficulty * slot.sets * slot.reps * Number(ex.volume_weight);
    volume[ex.type] += v;
  }
  return volume;
}
