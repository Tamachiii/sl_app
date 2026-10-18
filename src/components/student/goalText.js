// What a goal asks for, in the app's language: « 1RM à 80 kg », « 5 × 3 à
// 80 kg ». Shared by the athlete's goals and the coach's section. `ctx` is
// `{ t, lang }` of useI18n.
import { formatNumber } from '../../lib/i18n/format';

export function goalTargetText(goal, { t, lang }) {
  if (!goal) return '';
  const kg = formatNumber(lang, Number(goal.target_weight_kg));
  if (goal.kind === 'one_rm') return t('parcGoals.oneRm', { kg });
  return t('parcGoals.format', {
    sets: formatNumber(lang, goal.target_sets),
    reps: formatNumber(lang, goal.target_reps),
    kg,
  });
}
