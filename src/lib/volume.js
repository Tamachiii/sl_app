/**
 * Compute pull/push volume for a session.
 * Each slot must have slot.exercise joined (with difficulty, type, volume_weight).
 * Formula: difficulty × sets × reps × volume_weight, summed per type.
 */
export function computeSessionVolume(slots) {
  const volume = { pull: 0, push: 0 };
  for (const slot of slots) {
    const ex = slot.exercise;
    const v = ex.difficulty * slot.sets * slot.reps * Number(ex.volume_weight);
    volume[ex.type] += v;
  }
  return volume;
}
