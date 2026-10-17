import { useEffect, useState } from 'react';
import {
  useRenameProgram,
  useDeleteProgram,
  useSetActiveProgram,
  useApproveProgram,
  useSendBackProgram,
} from '../../hooks/useProgram';
import { useDuplicateProgram } from '../../hooks/useDuplicate';
import { Button, Sheet } from '../parc';

export default function ManageProgramDialog({ program, studentId, t, onClose, onDeleted, onDuplicated }) {
  const [name, setName] = useState(program?.name ?? '');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const rename = useRenameProgram();
  const setActive = useSetActiveProgram();
  const duplicate = useDuplicateProgram();
  const approve = useApproveProgram();
  const sendBack = useSendBackProgram();
  const del = useDeleteProgram();

  useEffect(() => {
    setName(program?.name ?? '');
    setConfirmingDelete(false);
  }, [program?.id]);

  if (!program) return null;

  const trimmed = name.trim();
  const dirty = trimmed && trimmed !== program.name;
  // Never trash the ACTIVE program: doing so strands the student on an empty
  // home (no active program), and restore brings it back inactive. The coach
  // activates another program first — the sole-program case simply can't be
  // trashed, which is the safe outcome.
  const canDelete = !program.is_active;

  function handleRename() {
    if (!dirty) return;
    rename.mutate(
      { programId: program.id, studentId, name: trimmed },
      { onSuccess: () => onClose() },
    );
  }

  function handleSetActive() {
    setActive.mutate(
      { programId: program.id, studentId },
      { onSuccess: () => onClose() },
    );
  }

  function handleDuplicate() {
    duplicate.mutate(
      { programId: program.id, studentId },
      {
        onSuccess: (newProgram) => {
          onDuplicated?.(newProgram?.id);
          onClose();
        },
      },
    );
  }

  function handleDelete() {
    del.mutate(
      { programId: program.id, studentId },
      {
        onSuccess: () => {
          setConfirmingDelete(false);
          onDeleted?.(program.id);
          onClose();
        },
      },
    );
  }

  function handleApprove() {
    approve.mutate({ programId: program.id, studentId }, { onSuccess: () => onClose() });
  }

  function handleSendBack() {
    sendBack.mutate({ programId: program.id, studentId }, { onSuccess: () => onClose() });
  }

  const isDraft = program.status === 'draft';
  const isSubmitted = isDraft && !!program.submitted_at;
  // Approve and Send-back are mutually exclusive terminal actions on the same
  // draft — disable BOTH while either is in flight so a coach can't fire the
  // pair and hand the student contradictory notifications.
  const approvalBusy = approve.isPending || sendBack.isPending;

  return (
    <Sheet open onClose={onClose} title={t('parcProgram.manageTitle')}>
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="pk-caption">{t('parcProgram.nameLabel')}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            spellCheck="true"
            autoCapitalize="words"
            className="pk-field"
          />
        </label>

        {isDraft && (
          <section className="flex flex-col gap-2 rounded-group bg-blue-soft p-4">
            <h3 className="pk-headline">
              {isSubmitted ? t('parcProgram.submittedForApproval') : t('parcProgram.draftInProgress')}
            </h3>
            <p className="pk-body">
              {isSubmitted ? t('coach.home.submittedHint') : t('coach.home.draftInProgressHint')}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={handleApprove} disabled={approvalBusy}>
                {approve.isPending ? t('common.saving') : t('coach.home.approve')}
              </Button>
              {isSubmitted && (
                <Button onClick={handleSendBack} disabled={approvalBusy}>
                  {sendBack.isPending ? t('common.saving') : t('coach.home.sendBack')}
                </Button>
              )}
            </div>
          </section>
        )}

        <div className="flex flex-col gap-2">
          <Button variant="primary" size="lg" onClick={handleRename} disabled={!dirty || rename.isPending}>
            {rename.isPending ? t('common.saving') : t('parcProgram.rename')}
          </Button>

          {!program.is_active && !isDraft && (
            <Button size="lg" onClick={handleSetActive} disabled={setActive.isPending}>
              {setActive.isPending ? t('common.saving') : t('parcProgram.setActive')}
            </Button>
          )}

          <Button size="lg" onClick={handleDuplicate} disabled={duplicate.isPending}>
            {duplicate.isPending ? t('common.saving') : t('parcProgram.duplicate')}
          </Button>
          <p className="pk-caption">{t('parcProgram.duplicateHint')}</p>

          {confirmingDelete ? (
            <section className="flex flex-col gap-2 rounded-group bg-red-soft p-4">
              <h3 className="pk-headline">{t('parcProgram.confirmTrashTitle', { name: program.name })}</h3>
              <p className="pk-body">{t('parcProgram.confirmTrashMessage')}</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="danger" onClick={handleDelete} disabled={del.isPending}>
                  {del.isPending ? t('common.saving') : t('parcProgram.moveToTrash')}
                </Button>
                <Button variant="text" onClick={() => setConfirmingDelete(false)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </section>
          ) : (
            <Button
              variant="text"
              className="text-red"
              onClick={() => setConfirmingDelete(true)}
              disabled={!canDelete}
            >
              {t('parcProgram.moveToTrash')}
            </Button>
          )}

          {!canDelete && <p className="pk-caption">{t('parcProgram.cannotTrashActive')}</p>}
        </div>
      </div>
    </Sheet>
  );
}
