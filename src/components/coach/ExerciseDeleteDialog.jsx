import { useState } from 'react';
import { useExerciseUsage, isActiveExercise } from '../../hooks/useExerciseLibrary';
import { useI18n } from '../../hooks/useI18n';
import { formatNumber } from '../../lib/i18n/format';
import { Button, Sheet } from '../parc';

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
 * What it offers instead for an exercise in use is to archive it — when the
 * page passes `onArchive(id)` and the exercise is not archived already: it
 * leaves the pickers and stays on everything that uses it.
 *
 * `exercise` is the row to delete, or null while the sheet is closed. The
 * sheet itself stays mounted, so that closing goes through `<dialog>.close()`
 * and focus returns to the button that opened it. Its body (`UsageCheck`) is
 * mounted by each open.
 */
export default function ExerciseDeleteDialog({ exercise, onClose, onDelete, onArchive }) {
  const { t } = useI18n();
  return (
    <Sheet
      open={!!exercise}
      onClose={onClose}
      title={exercise ? t('parcLibrary.deleteTitle', { name: exercise.name }) : undefined}
    >
      {exercise && (
        <UsageCheck
          key={exercise.id}
          exercise={exercise}
          onClose={onClose}
          onDelete={onDelete}
          onArchive={onArchive}
        />
      )}
    </Sheet>
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
 *   - read, in use: the counts, and no Delete. "Archive instead" when the
 *     page can archive and the exercise is not archived yet. It takes the
 *     place the disabled Delete held while reading, so the one write a tap
 *     aimed at that button can make when the answer lands is an archive —
 *     which the library's drawer undoes — and never a delete.
 *   - not read (the read failed, or waits for the network): says so, with
 *     "Check again". Nothing is known, so nothing is deleted.
 *   - reading: Delete is there but disabled, so the button a finger is aiming
 *     at does not change under it when the answer arrives.
 *
 * The successful read is tested first and nothing un-reads it: a refetch on
 * window focus that fails later leaves the counts on screen.
 */
function UsageCheck({ exercise, onClose, onDelete, onArchive }) {
  const { t } = useI18n();
  const [openedAt] = useState(() => Date.now());
  const usage = useExerciseUsage(exercise.id);

  const fetchedSinceOpen = usage.isFetchedAfterMount;
  const counts = fetchedSinceOpen && usage.dataUpdatedAt >= openedAt ? usage.data : undefined;
  const inUse = !!counts && counts.slots + counts.goals + counts.swaps > 0;
  const unused = !!counts && !inUse;
  const failed =
    !counts && ((fetchedSinceOpen && usage.errorUpdatedAt >= openedAt) || usage.isPaused);
  const archiveInstead = inUse && !!onArchive && isActiveExercise(exercise);

  function handleDelete() {
    onDelete(exercise.id);
    onClose();
  }

  function handleArchive() {
    onArchive(exercise.id);
    onClose();
  }

  let status = t('coachLibraryDelete.checking');
  if (inUse) status = t('coachLibraryDelete.inUse');
  else if (unused) status = t('coachLibraryDelete.unused');
  else if (failed) status = t('coachLibraryDelete.failed');

  return (
    <div className="flex flex-col gap-4">
      {/* One live region for every state, so each change is announced. */}
      <p role="status" className="pk-body">
        {status}
      </p>

      {inUse && (
        <>
          <dl className="pk-group">
            <UsageRow label={t('coachLibraryDelete.slots')} count={counts.slots} />
            <UsageRow label={t('coachLibraryDelete.goals')} count={counts.goals} />
            {counts.swaps > 0 && (
              <UsageRow label={t('coachLibraryDelete.swaps')} count={counts.swaps} />
            )}
          </dl>
          <p className="pk-caption">{t('coachLibraryDelete.inUseHelp')}</p>
          {archiveInstead && <p className="pk-caption">{t('coachLibraryArchive.archiveInsteadHelp')}</p>}
        </>
      )}

      <div className="flex flex-col gap-1">
        {archiveInstead && (
          <Button variant="primary" size="lg" onClick={handleArchive}>
            {t('coachLibraryArchive.archiveInstead')}
          </Button>
        )}
        {failed && (
          <Button variant="primary" size="lg" onClick={() => usage.refetch()} disabled={usage.isFetching}>
            {usage.isFetching ? t('coachLibraryDelete.retrying') : t('coachLibraryDelete.retry')}
          </Button>
        )}
        {!failed && !inUse && (
          <Button variant="danger" size="lg" onClick={handleDelete} disabled={!unused}>
            {t('parcLibrary.deleteAction')}
          </Button>
        )}
        <Button variant="text" onClick={onClose}>
          {t('parcLibrary.keep')}
        </Button>
      </div>
    </div>
  );
}

function UsageRow({ label, count }) {
  const { lang } = useI18n();
  return (
    <div className="pk-row">
      <dt className="pk-body min-w-0 flex-1">{label}</dt>
      <dd className="pk-condensed pk-tnum m-0 text-[24px] font-extrabold">{formatNumber(lang, count)}</dd>
    </div>
  );
}
