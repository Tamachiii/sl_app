import Dialog from '../ui/Dialog';
import { useAdoptSkip, useAdoptSkipPreview } from '../../hooks/useAdoptSwap';

/**
 * Coach confirm dialog for adopting a student's SKIP — dropping the exercise
 * from upcoming sessions. Destructive (the future slots are deleted), so the
 * blast radius is shown and the CTA is styled as a danger action.
 * English-only, matching coach/SessionReview.
 */
export default function RemoveExerciseDialog({ open, onClose, slotId, sessionId, exerciseName, onAdopted }) {
  const { data: count, isLoading } = useAdoptSkipPreview(slotId, open);
  const adopt = useAdoptSkip();
  const n = count ?? 0;
  const nothingToApply = !isLoading && n === 0;

  const blast = isLoading
    ? 'Checking upcoming sessions…'
    : n === 0
      ? `No upcoming sessions still prescribe ${exerciseName}. Nothing to remove.`
      : `Removes ${exerciseName} from ${n} upcoming session${n === 1 ? '' : 's'}. Past sessions keep their history.`;

  function handleAdopt() {
    adopt.mutate(
      { slotId, sessionId },
      { onSuccess: (res) => { onAdopted?.(res?.applied ?? 0); onClose(); } },
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title="Remove from upcoming">
      <div className="space-y-4">
        <p className="text-[14px] text-gray-900">
          Stop prescribing <span className="font-semibold">{exerciseName}</span> going forward?
        </p>
        <p className="sl-mono text-[12px] text-ink-400">{blast}</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleAdopt}
            disabled={adopt.isPending || nothingToApply}
            className="flex-1 rounded-lg py-2.5 sl-display text-[13px] text-white disabled:opacity-50"
            style={{ background: 'var(--color-danger)', padding: '10px 16px' }}
          >
            {adopt.isPending ? 'Removing…' : nothingToApply ? 'Nothing to remove' : 'Remove forward'}
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
