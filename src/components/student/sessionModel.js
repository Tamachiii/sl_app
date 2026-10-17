// What the session screen works out from its reads, as pure functions: which
// set comes next, which exercise to show, what the editor of a set opens with,
// and how a set, a load and last time are written. No hook, no rendering;
// SessionView and its parts call these.
import { formatNumber, formatRelativeDays, pluralKey } from '../../lib/i18n/format';
import { formatRestClock } from '../parc/ActionBar';
import { daysSince } from '../../lib/lastPerformance';

// A set no longer needs the athlete's attention iff it was skipped, failed,
// completed with an RPE, or belongs to an exercise the athlete skipped (those
// sets are not shown, so they could otherwise never resolve). Feeds the
// confirm sheet's count and "nothing logged".
export function isLogResolved(log, skippedSlotIds) {
  return (
    log.skipped ||
    log.failed ||
    (log.done && log.rpe != null) ||
    skippedSlotIds.has(log.exercise_slot_id)
  );
}

// The outcome of a set as the screen draws it.
export function setOutcome(log) {
  if (log.skipped) return 'skipped';
  if (log.failed) return 'failed';
  if (log.done) return 'done';
  return 'pending';
}

// The set to do next in an exercise: the first one with no outcome yet.
export function currentLogOf(slotLogs) {
  return slotLogs.find((log) => setOutcome(log) === 'pending') ?? null;
}

// The exercise the screen opens on: the first with a set still to do, else
// the first. `logsOf(slotId)` gives the sets of an exercise in set order.
export function firstSlotToShow(slots, logsOf, skippedSlotIds) {
  const open = slots.find((slot) => !skippedSlotIds.has(slot.id) && currentLogOf(logsOf(slot.id)));
  return (open ?? slots[0])?.id ?? null;
}

// The exercise to show once a set of `slotId` is dealt with. In a superset,
// the next exercise of the pairing that has a set to do — the two are done in
// turn; otherwise `slotId` itself while it has a set to do; then the next
// exercise of the session that has one, wrapping round. null when nothing is
// left to do.
export function nextSlotToShow(slotId, slots, logsOf, skippedSlotIds) {
  const open = (slot) => !skippedSlotIds.has(slot.id) && !!currentLogOf(logsOf(slot.id));
  const index = slots.findIndex((slot) => slot.id === slotId);
  if (index < 0) return null;
  const group = slots[index].superset_group;
  if (group) {
    const pairing = slots.filter((slot) => slot.superset_group === group);
    const at = pairing.findIndex((slot) => slot.id === slotId);
    for (let step = 1; step <= pairing.length; step += 1) {
      const candidate = pairing[(at + step) % pairing.length];
      if (open(candidate)) return candidate.id;
    }
  } else if (open(slots[index])) {
    return slotId;
  }
  for (let step = 1; step <= slots.length; step += 1) {
    const candidate = slots[(index + step) % slots.length];
    if (open(candidate)) return candidate.id;
  }
  return null;
}

// The rest the coach prescribed after the sets of an exercise, when it is one
// value: a number, or null when no set has one. `undefined` when the sets
// differ (N5) — Dips with 3:00 after sets 1 to 3 and 2:00 after 4 to 6 — and
// each row then shows its own. Sets without a target (extra sets) say nothing.
export function sharedRest(slotLogs) {
  const prescribed = slotLogs.filter(
    (l) =>
      l.target_reps != null ||
      l.target_duration_seconds != null ||
      l.target_weight_kg != null ||
      l.target_rest_seconds != null,
  );
  const rests = new Set(
    prescribed.map((l) => (l.target_rest_seconds == null ? null : Number(l.target_rest_seconds))),
  );
  if (rests.size === 0) return null;
  return rests.size === 1 ? [...rests][0] : undefined;
}

// The exercise is prescribed in seconds, read as the slot summary reads it
// (lib/volume): the first set with a target, else the slot's own columns. An
// extra set has no target of its own to say it.
export function isDurationBased(slot, slotLogs) {
  const unitSource = slotLogs.find((l) => l.target_reps != null || l.target_duration_seconds != null);
  return unitSource ? unitSource.target_duration_seconds != null : slot.duration_seconds != null;
}

// The deviation of an exercise, and whether the athlete does another
// exercise in its place — the same test as the history's
// (lib/doneSetHistory), so what a row stores and what records and "Last time"
// read agree.
export function deviationOf(slot, slotDeviations) {
  const deviation = (slotDeviations || []).find((d) => d.exercise_slot_id === slot.id) || null;
  return {
    deviation,
    skipped: deviation?.kind === 'skip',
    swapped: deviation?.kind === 'swap' && !!deviation.substitute_exercise_id,
  };
}

// What the Actual editor of a set opens with where the targets on its row are
// no place to start from:
//   - every set of a swapped exercise (P59): the substitute's last
//     performance, set by set — the last of its sets for any set beyond them.
//     The rows' targets are the original exercise's and are never a load to
//     start from. Without a last performance, a set starts from the one before
//     it in this session, as it was done: the substitute done for the first
//     time is entered once and carried down.
//   - an extra set (P61), which has no targets: the set before it, as it was
//     done — its actual values, else its targets. A prescribed set without a
//     target load is done at bodyweight: 0 kg added.
// The sets of the exercise as the coach wrote it open on their own targets
// (useSetActions) and get no entry.
//
// Returns Map(log id → { reps, weightKg }). The sets come in set order.
export function editorSeeds(slotLogs, { swapped, lastPerf }) {
  const prior =
    swapped && Array.isArray(lastPerf?.sets) && lastPerf.sets.length > 0 ? lastPerf.sets : null;
  const seeds = new Map();
  let before = { reps: null, weightKg: null };
  slotLogs.forEach((log, index) => {
    let seed;
    if (swapped) {
      const last = prior ? prior[Math.min(index, prior.length - 1)] : null;
      seed = last
        ? { reps: last.reps ?? null, weightKg: last.weight ?? null }
        : { reps: before.reps ?? log.target_reps ?? null, weightKg: before.weightKg };
      seeds.set(log.id, seed);
    } else if (log.is_student_added) {
      seed = before;
      seeds.set(log.id, seed);
    } else {
      seed = {
        reps: log.target_reps ?? null,
        weightKg: log.target_weight_kg != null ? Number(log.target_weight_kg) : 0,
      };
    }
    if (!log.skipped) {
      before = {
        reps: log.actual_reps ?? seed.reps,
        weightKg: log.actual_weight_kg != null ? Number(log.actual_weight_kg) : seed.weightKg,
      };
    }
  });
  return seeds;
}

// The first letter of a sentence in capitals: « Il y a 7 jours », « Lundi ».
export function capitalize(text) {
  return text ? text.charAt(0).toLocaleUpperCase() + text.slice(1) : text;
}

// A load as the screen writes it: « 20 kg », « 17,5 kg », and « poids du
// corps » for none.
export function loadText(weightKg, { t, lang }) {
  const kg = weightKg == null ? 0 : Number(weightKg);
  return kg > 0 ? t('parcSession.kg', { kg: formatNumber(lang, kg) }) : t('parcSession.bodyweight');
}

function repsText(reps, { t, lang }) {
  return t(pluralKey(lang, reps, 'parcSession.reps'), { n: formatNumber(lang, reps) });
}

// What a set asks for, or what was done: « 5 répétitions, 20 kg », « Tenue de
// 8 s », « 5 répétitions, poids du corps ». `reps`, `seconds` and `weightKg`
// are the values to write; an exercise held for a time adds its load only
// when it has one.
export function workText({ reps, seconds, weightKg }, ctx) {
  const { t } = ctx;
  if (seconds != null && reps == null) {
    const hold = t('parcSession.hold', { n: formatNumber(ctx.lang, seconds) });
    return Number(weightKg) > 0 ? `${hold}, ${loadText(weightKg, ctx)}` : hold;
  }
  if (reps == null) return capitalize(loadText(weightKg, ctx));
  return `${repsText(reps, ctx)}, ${loadText(weightKg, ctx)}`;
}

// The target of a set, as the coach wrote it.
export function targetText(log, ctx) {
  return workText(
    {
      reps: log.target_reps ?? null,
      seconds: log.target_duration_seconds ?? null,
      weightKg: log.target_weight_kg,
    },
    ctx,
  );
}

// What was done on a set with a logged actual: the actual of each dimension,
// else its target.
export function actualText(log, ctx) {
  return workText(
    {
      reps: log.actual_reps ?? log.target_reps ?? null,
      seconds: log.actual_reps == null ? log.target_duration_seconds ?? null : null,
      weightKg: log.actual_weight_kg ?? log.target_weight_kg,
    },
    ctx,
  );
}

// A rest as it is written: « 1:30 », « 0:45 ».
export function restText(seconds) {
  return formatRestClock(Number(seconds));
}

// « Il y a 7 jours, 4 × 5 à 17,5 kg. » — the last time this exercise was
// trained, by groups of identical sets; '' when there is none.
export function lastTimeText(perf, ctx, now) {
  if (!perf || !Array.isArray(perf.sets) || perf.sets.length === 0) return '';
  const { t, lang } = ctx;
  const groups = [];
  for (const set of perf.sets) {
    const prev = groups[groups.length - 1];
    if (prev && prev.weight === set.weight && prev.reps === set.reps) prev.count += 1;
    else groups.push({ weight: set.weight, reps: set.reps, count: 1 });
  }
  const MAX_GROUPS = 4;
  const parts = groups.slice(0, MAX_GROUPS).map((g) => {
    const reps = g.count > 1 ? `${g.count} × ${formatNumber(lang, g.reps)}` : formatNumber(lang, g.reps);
    return g.weight > 0
      ? t('parcSession.lastGroupLoaded', { sets: reps, kg: formatNumber(lang, g.weight) })
      : reps;
  });
  if (groups.length > MAX_GROUPS) parts.push(`+${groups.length - MAX_GROUPS}`);
  const days = daysSince(perf.performedAt, now);
  const when = days == null ? '' : capitalize(formatRelativeDays(lang, -days));
  const work = parts.join(', ');
  return `${when ? `${when}, ` : ''}${work}.`;
}
