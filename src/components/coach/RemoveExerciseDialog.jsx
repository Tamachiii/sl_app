import { useI18n } from '../../hooks/useI18n';
import { useAdoptSkip, useAdoptSkipPreview } from '../../hooks/useAdoptSwap';
import { formatNumber, pluralKey } from '../../lib/i18n/format';
import { Button, Sheet } from '../parc';

/**
 * The sheet that asks before a student's SKIP is adopted — the exercise
 * dropped from the sessions to come. Destructive (the future slots are
 * deleted), so the blast radius is shown and the action is a danger button.
 */
export default function RemoveExerciseDialog({ open, onClose, slotId, sessionId, exerciseName, onAdopted }) {
  const { t, lang } = useI18n();
  const { data: count, isLoading } = useAdoptSkipPreview(slotId, open);
  const adopt = useAdoptSkip();
  const n = count ?? 0;
  const nothingToApply = !isLoading && n === 0;

  const blast = isLoading
    ? t('parcReview.checking')
    : n === 0
      ? t('parcReview.removeNone', { name: exerciseName })
      : t(pluralKey(lang, n, 'parcReview.removeCount'), { name: exerciseName, n: formatNumber(lang, n) });

  function handleAdopt() {
    adopt.mutate(
      { slotId, sessionId },
      { onSuccess: (res) => { onAdopted?.(res?.applied ?? 0); onClose(); } },
    );
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('parcReview.removeForward')}>
      <div className="flex flex-col gap-3">
        <p className="pk-body">{t('parcReview.removeQuestion', { name: exerciseName })}</p>
        <p className="pk-caption" role="status">{blast}</p>
        <div className="mt-2 flex flex-col gap-1">
          <Button variant="danger" size="lg" onClick={handleAdopt} disabled={adopt.isPending || nothingToApply}>
            {adopt.isPending
              ? t('parcReview.removing')
              : nothingToApply
                ? t('parcReview.nothingToRemove')
                : t('parcReview.removeAction')}
          </Button>
          <Button variant="text" onClick={onClose} disabled={adopt.isPending}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
