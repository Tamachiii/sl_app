import { useI18n } from '../../hooks/useI18n';
import { useAdoptSwap, useAdoptSwapPreview } from '../../hooks/useAdoptSwap';
import { formatNumber, pluralKey } from '../../lib/i18n/format';
import { Button, Sheet } from '../parc';

/**
 * The sheet that asks before a student's swap is adopted into the program.
 * Shows the blast radius (how many UPCOMING sessions the rewrite touches) via
 * the dry-run RPC before committing — the concrete expression of the approval
 * gate.
 */
export default function AdoptSwapDialog({
  open,
  onClose,
  slotId,
  sessionId,
  substituteId,
  originalName,
  substituteName,
  onAdopted,
}) {
  const { t, lang } = useI18n();
  const { data: count, isLoading } = useAdoptSwapPreview(slotId, substituteId, open);
  const adopt = useAdoptSwap();
  const n = count ?? 0;

  const nothingToApply = !isLoading && n === 0;
  const blast = isLoading
    ? t('parcReview.checking')
    : n === 0
      ? t('parcReview.adoptNone', { orig: originalName })
      : t(pluralKey(lang, n, 'parcReview.adoptCount'), { n: formatNumber(lang, n) });
  // Targets are carried, not reset — the coach must retune loads for the new
  // movement. Surface it at the one click where they can act on it.
  const retuneNote =
    !isLoading && n > 0 ? t('parcReview.retune', { orig: originalName, sub: substituteName }) : null;

  function handleAdopt() {
    adopt.mutate(
      { slotId, substituteId, sessionId },
      { onSuccess: (res) => { onAdopted?.(res?.applied ?? 0); onClose(); } },
    );
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('parcReview.adoptTitle')}>
      <div className="flex flex-col gap-3">
        <p className="pk-body">{t('parcReview.adoptQuestion', { sub: substituteName, orig: originalName })}</p>
        <p className="pk-caption" role="status">{blast}</p>
        {retuneNote && <p className="pk-caption">{retuneNote}</p>}
        <div className="mt-2 flex flex-col gap-1">
          <Button variant="primary" size="lg" onClick={handleAdopt} disabled={adopt.isPending || nothingToApply}>
            {adopt.isPending
              ? t('parcReview.adopting')
              : nothingToApply
                ? t('parcReview.nothingToAdopt')
                : t('parcReview.adoptAction')}
          </Button>
          <Button variant="text" onClick={onClose} disabled={adopt.isPending}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
