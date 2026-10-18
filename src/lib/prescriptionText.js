// What the coach prescribed for an exercise, written for reading in the app's
// language: « 5 × 5 à 20 kg », « 4 × 8, poids du corps », « 5 tenues de 8 s »,
// « 2 × 8 à 100 kg, 6 à 100 kg ». Read from the per-set targets of the slot's
// `set_logs` when it has them (lib/volume: the targets live there), else from
// the slot's own columns. Strings in the `parcPrescription` namespace.
import { formatNumber, pluralKey } from './i18n/format';

// Beyond this many groups of identical sets the exercise is said in one word.
const MAX_GROUPS = 3;

function targetsOf(slot) {
  const logs = (slot?.set_logs || [])
    .filter(
      (l) =>
        l.target_reps != null ||
        l.target_duration_seconds != null ||
        l.target_weight_kg != null,
    )
    .slice()
    .sort((a, b) => a.set_number - b.set_number);
  if (logs.length > 0) {
    return logs.map((l) => ({
      reps: l.target_reps ?? null,
      seconds: l.target_duration_seconds ?? null,
      kg: l.target_weight_kg == null ? 0 : Number(l.target_weight_kg),
    }));
  }
  const sets = Number(slot?.sets) || 0;
  if (sets === 0) return [];
  const one = {
    reps: slot.reps ?? null,
    seconds: slot.duration_seconds ?? null,
    kg: slot.weight_kg == null ? 0 : Number(slot.weight_kg),
  };
  return Array.from({ length: sets }, () => one);
}

/** One group of `count` identical sets. */
function groupText({ count, reps, seconds, kg }, { t, lang }) {
  const load = kg > 0 ? formatNumber(lang, kg) : null;
  if (seconds != null && reps == null) {
    const hold = t(pluralKey(lang, count, 'parcPrescription.hold'), {
      count: formatNumber(lang, count),
      s: formatNumber(lang, seconds),
    });
    return load ? t('parcPrescription.loaded', { work: hold, kg: load }) : hold;
  }
  const work = count === 1 ? formatNumber(lang, reps) : `${formatNumber(lang, count)}\u00a0×\u00a0${formatNumber(lang, reps)}`;
  return load ? t('parcPrescription.loaded', { work, kg: load }) : t('parcPrescription.bodyweight', { work });
}

/**
 * The prescription of a slot in one line, or '' when it holds none. `ctx` is
 * `{ t, lang }` of useI18n.
 */
export function prescriptionText(slot, ctx) {
  const sets = targetsOf(slot);
  if (sets.length === 0) return '';
  const groups = [];
  for (const set of sets) {
    const last = groups[groups.length - 1];
    if (last && last.reps === set.reps && last.seconds === set.seconds && last.kg === set.kg) last.count += 1;
    else groups.push({ ...set, count: 1 });
  }
  if (groups.length > MAX_GROUPS) {
    return ctx.t('parcPrescription.varied', { n: formatNumber(ctx.lang, sets.length) });
  }
  return groups.map((group) => groupText(group, ctx)).join(', ');
}
