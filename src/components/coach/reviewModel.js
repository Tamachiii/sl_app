// What the coach's review says of a session, in the app's language
// (design/parc/screens/Revue.dc.html): the figures at the top, and the sets of
// each exercise as rows — the sets done as planned in one row, the others one
// by one. Pure: `ctx` is `{ t, lang }` of useI18n. Strings in the `parcReview`
// namespace; the work of a set is written by the athlete's session screen
// (student/sessionModel), so the two say a set the same way.
import { hasLoggedActual } from '../../lib/volume';
import { formatRpe } from '../../lib/rpe';
import { formatNumber, localeOf, pluralKey } from '../../lib/i18n/format';
import { actualText, targetText } from '../student/sessionModel';

/**
 * The figures of the session: the prescribed sets done against the plan,
 * the sets the athlete added and did (said apart: counted in, they read
 * "4 of 3"), the average RPE of the sets done, and how many times the
 * session left the plan — an exercise swapped or skipped, and each set done
 * with other values (the sets of a swapped exercise are the swap, not more;
 * a failed set is said as failed, not as a change).
 */
export function reviewTotals({ slots, logs, deviations }) {
  const all = logs || [];
  const swapped = new Set(
    (deviations || []).filter((d) => d.kind === 'swap').map((d) => d.exercise_slot_id),
  );
  const planned = (slots || []).reduce((n, slot) => n + (Number(slot.sets) || 0), 0);
  const done = all.filter((l) => !l.is_student_added && l.done).length;
  const extra = all.filter((l) => l.is_student_added && l.done).length;
  const rpes = all.filter((l) => l.done && l.rpe != null).map((l) => Number(l.rpe));
  const avgRpe = rpes.length > 0 ? rpes.reduce((a, b) => a + b, 0) / rpes.length : null;
  const changes =
    (deviations || []).length +
    all.filter((l) => l.done && hasLoggedActual(l) && !swapped.has(l.exercise_slot_id)).length;
  return { planned, done, extra, avgRpe, changes };
}

function listText(items, lang) {
  try {
    return new Intl.ListFormat(localeOf(lang), { type: 'conjunction' }).format(items);
  } catch {
    // A browser without ListFormat reads the commas.
    return items.join(', ');
  }
}

// « Série 4 », « Séries 1 à 3 », « Séries 1, 2 et 4 ».
function numbersText(numbers, { t, lang }) {
  const fmt = (n) => formatNumber(lang, n);
  if (numbers.length === 1) return t('parcReview.setOne', { n: fmt(numbers[0]) });
  const contiguous = numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1);
  if (contiguous && numbers.length >= 3) {
    return t('parcReview.setsRange', { from: fmt(numbers[0]), to: fmt(numbers[numbers.length - 1]) });
  }
  return t('parcReview.setsList', { list: listText(numbers.map(fmt), lang) });
}

// « RPE 8 », « RPE 7 à 8 », nothing without one.
export function rpeText(rpes, { t, lang }) {
  if (rpes.length === 0) return null;
  const lo = Math.min(...rpes);
  const hi = Math.max(...rpes);
  return lo === hi
    ? t('parcReview.rpe', { value: formatRpe(lo, lang) })
    : t('parcReview.rpeRange', { from: formatRpe(lo, lang), to: formatRpe(hi, lang) });
}

/**
 * The rows of an exercise's sets, in the order of their first set:
 * `{ key, kind, numbers, title, caption, rpe }`. `kind` is what the row is
 * drawn as — `done` (the sets done as planned, one row per target), `failed`,
 * `skipped`, `offPlan`, `added`, `notDone`. On a swapped exercise the sets
 * are what was done instead, and say their values.
 */
export function setRows(logs, ctx, { swapped = false } = {}) {
  const { t, lang } = ctx;
  const fmt = (n) => formatNumber(lang, n);
  const planned = (log) => t('parcReview.planned', { what: targetText(log, ctx) });
  const rows = [];
  const doneGroups = new Map();
  const sorted = [...(logs || [])].sort((a, b) => a.set_number - b.set_number);
  for (const log of sorted) {
    const n = log.set_number;
    const rpe = log.rpe != null ? Number(log.rpe) : null;
    const one = (kind, title, caption) =>
      rows.push({ key: log.id, kind, numbers: [n], title, caption, rpes: rpe != null ? [rpe] : [] });
    if (log.skipped) {
      one('skipped', t('parcReview.skippedSet', { n: fmt(n) }), log.is_student_added ? null : planned(log));
    } else if (log.failed) {
      // « 2 répétitions sur 3 »: how far the set went, when it says so.
      const reached =
        log.actual_reps != null && log.target_reps != null
          ? t(pluralKey(lang, Number(log.actual_reps), 'parcReview.failedReps'), {
              done: fmt(log.actual_reps),
              planned: fmt(log.target_reps),
            })
          : null;
      one('failed', t('parcReview.failed', { n: fmt(n) }), reached ?? (hasLoggedActual(log) ? actualText(log, ctx) : planned(log)));
    } else if (log.is_student_added) {
      one('added', t('parcReview.added', { n: fmt(n) }), actualText(log, ctx));
    } else if (!log.done) {
      one('notDone', t('parcReview.notDone', { n: fmt(n) }), planned(log));
    } else if (hasLoggedActual(log) && !swapped) {
      // What was done; the plan is the line under the exercise's name.
      one('offPlan', t('parcReview.offPlan', { n: fmt(n) }), t('parcReview.offPlanWhat', { done: actualText(log, ctx) }));
    } else {
      const what = swapped ? actualText(log, ctx) : targetText(log, ctx);
      const group = doneGroups.get(what);
      if (group) {
        group.numbers.push(n);
        if (rpe != null) group.rpes.push(rpe);
      } else {
        const row = { key: log.id, kind: 'done', numbers: [n], what, rpes: rpe != null ? [rpe] : [] };
        doneGroups.set(what, row);
        rows.push(row);
      }
    }
  }
  return rows
    .map((row) =>
      row.kind === 'done'
        ? {
            ...row,
            title: numbersText(row.numbers, ctx),
            caption: swapped ? row.what : t('parcReview.asPlanned', { what: row.what }),
          }
        : row,
    )
    .map(({ rpes, what: _what, ...row }) => ({ ...row, rpe: rpeText(rpes, ctx) }))
    .sort((a, b) => a.numbers[0] - b.numbers[0]);
}
