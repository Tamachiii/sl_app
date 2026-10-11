import { useState } from 'react';
import Dialog from '../ui/Dialog';
import { useExerciseUsage } from '../../hooks/useExerciseLibrary';
import { useI18n } from '../../hooks/useI18n';

/**
 * Stands in front of deleting a library exercise. It first reads where the
 * exercise is used (`useExerciseUsage`: program slots, goals, athlete swaps)
 * and offers the delete only for an exercise nothing uses.
 *
 * An exercise in use is not deletable, here or in the database: slots and
 * swaps hold it with a RESTRICT foreign key, and so do goals once the goals
 * migration is applied. Until then a delete would have taken the athletes'
 * goals, and the progress logged on them, with it — which is why the rule is
 * applied on this side too rather than left to the database's answer.
 *
 * `exercise` is the row to delete, or null while the dialog is closed. The
 * dialog itself stays mounted, like the app's other dialogs, so that closing
 * goes through `<dialog>.close()` and focus returns to the row's button. Its
 * body (`UsageCheck`) is mounted by each open.
 */
export default function ExerciseDeleteDialog({ exercise, onClose, onDelete }) {
  const { t } = useI18n();
  return (
    <Dialog
      open={!!exercise}
      onClose={onClose}
      title={exercise ? t('coach.library.confirmDelete', { name: exercise.name }) : undefined}
    >
      {exercise && (
        <UsageCheck key={exercise.id} exercise={exercise} onClose={onClose} onDelete={onDelete} />
      )}
    </Dialog>
  );
}

/**
 * Four states, all on a usage read made SINCE THIS OPEN: whatever the cache
 * might still hold from an earlier open says nothing about now, and "nothing
 * uses it" is what deletes. "Since this open" is two facts about the query,
 * both needed: a fetch has finished since this body mounted
 * (`isFetchedAfterMount`, which a failed fetch also sets), and the answer it
 * holds is not older than the mount (`openedAt` against `dataUpdatedAt`).
 *
 *   - read, nothing uses it: the confirmation, with Delete.
 *   - read, in use: the counts, and no Delete.
 *   - not read (the read failed, or waits for the network): says so, with
 *     "Check again". Nothing is known, so nothing is deleted.
 *   - reading: Delete is there but disabled, so the button a finger is aiming
 *     at does not change under it when the answer arrives.
 *
 * The successful read is tested first and nothing un-reads it: a refetch on
 * window focus that fails later leaves the counts on screen.
 */
function UsageCheck({ exercise, onClose, onDelete }) {
  const { t } = useI18n();
  const [openedAt] = useState(() => Date.now());
  const usage = useExerciseUsage(exercise.id);

  const fetchedSinceOpen = usage.isFetchedAfterMount;
  const counts = fetchedSinceOpen && usage.dataUpdatedAt >= openedAt ? usage.data : undefined;
  const inUse = !!counts && counts.slots + counts.goals + counts.swaps > 0;
  const unused = !!counts && !inUse;
  const failed =
    !counts && ((fetchedSinceOpen && usage.errorUpdatedAt >= openedAt) || usage.isPaused);

  function handleDelete() {
    onDelete(exercise.id);
    onClose();
  }

  let status = t('coachLibraryDelete.checking');
  if (inUse) status = t('coachLibraryDelete.inUse');
  else if (unused) status = t('coachLibraryDelete.unused');
  else if (failed) status = t('coachLibraryDelete.failed');

  return (
    <div className="space-y-4">
      {/* One live region for every state, so each change is announced. */}
      <p role="status" className="sl-mono text-[12px] text-ink-400 leading-relaxed">
        {status}
      </p>

      {inUse && (
        <>
          <dl className="rounded-lg bg-ink-100 px-3 py-2 space-y-1">
            <UsageRow label={t('coachLibraryDelete.slots')} count={counts.slots} />
            <UsageRow label={t('coachLibraryDelete.goals')} count={counts.goals} />
            {counts.swaps > 0 && (
              <UsageRow label={t('coachLibraryDelete.swaps')} count={counts.swaps} />
            )}
          </dl>
          <p className="sl-mono text-[12px] text-ink-400 leading-relaxed">
            {t('coachLibraryDelete.inUseHelp')}
          </p>
        </>
      )}

      <div className="flex gap-2">
        {failed && (
          <button
            type="button"
            onClick={() => usage.refetch()}
            disabled={usage.isFetching}
            className="flex-1 sl-btn-primary text-[13px] disabled:opacity-50"
            style={{ padding: '10px 16px' }}
          >
            {usage.isFetching ? t('coachLibraryDelete.retrying') : t('coachLibraryDelete.retry')}
          </button>
        )}
        {!failed && !inUse && (
          <button
            type="button"
            onClick={handleDelete}
            disabled={!unused}
            className="flex-1 rounded-lg py-2.5 sl-display text-[13px] text-white disabled:opacity-50"
            style={{ background: 'var(--color-danger)' }}
          >
            {t('common.delete')}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="flex-1 bg-ink-100 text-ink-700 rounded-lg py-2.5 sl-display text-[13px] hover:bg-ink-200"
        >
          {inUse ? t('coachLibraryDelete.ok') : t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

function UsageRow({ label, count }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="sl-mono text-[12px] text-ink-600">{label}</dt>
      <dd className="sl-display text-[15px] text-gray-900">{count}</dd>
    </div>
  );
}
