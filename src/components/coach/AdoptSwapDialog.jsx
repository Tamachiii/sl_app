import Dialog from '../ui/Dialog';
import { useAdoptSwap, useAdoptSwapPreview } from '../../hooks/useAdoptSwap';

/**
 * Coach confirm dialog for adopting a student's swap into the program. Shows
 * the blast radius (how many UPCOMING sessions the rewrite touches) via the
 * dry-run RPC before committing — the concrete expression of the approval gate.
 * English-only, matching the rest of coach/SessionReview.
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
  const { data: count, isLoading } = useAdoptSwapPreview(slotId, substituteId, open);
  const adopt = useAdoptSwap();
  const n = count ?? 0;

  const nothingToApply = !isLoading && n === 0;
  const blast = isLoading
    ? 'Checking upcoming sessions…'
    : n === 0
      ? `No upcoming sessions still prescribe ${originalName}. Nothing to change forward.`
      : `This updates ${n} upcoming session${n === 1 ? '' : 's'}. Past sessions keep their history.`;
  // Targets are carried, not reset — the coach must retune loads for the new
  // movement. Surface it at the one click where they can act on it.
  const retuneNote =
    !isLoading && n > 0
      ? `Set targets carry over from ${originalName} — open each upcoming session to retune loads for ${substituteName}.`
      : null;

  function handleAdopt() {
    adopt.mutate(
      { slotId, substituteId, sessionId },
      { onSuccess: (res) => { onAdopted?.(res?.applied ?? 0); onClose(); } },
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title="Adopt swap">
      <div className="space-y-4">
        <p className="text-[14px] text-gray-900">
          Make <span className="font-semibold">{substituteName}</span> the prescription instead of{' '}
          <span className="font-semibold">{originalName}</span>?
        </p>
        <p className="sl-mono text-[12px] text-ink-400">{blast}</p>
        {retuneNote && (
          <p className="sl-mono text-[11px] text-ink-400">{retuneNote}</p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleAdopt}
            disabled={adopt.isPending || nothingToApply}
            className="sl-btn-primary flex-1 text-[13px] disabled:opacity-50"
            style={{ padding: '10px 16px' }}
          >
            {adopt.isPending ? 'Adopting…' : nothingToApply ? 'Nothing to adopt' : 'Adopt'}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={adopt.isPending}
            className="flex-1 sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200 justify-center disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}
