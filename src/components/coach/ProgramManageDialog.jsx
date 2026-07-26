import { useEffect, useState } from 'react';
import {
  useRenameProgram,
  useDeleteProgram,
  useSetActiveProgram,
  useApproveProgram,
  useSendBackProgram,
} from '../../hooks/useProgram';
import { useDuplicateProgram } from '../../hooks/useDuplicate';
import Dialog from '../ui/Dialog';

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
    <Dialog open={true} onClose={onClose} title={t('coach.home.manageProgram')}>
      <div className="space-y-4">
        <label className="block">
          <span className="sl-label text-ink-400 block mb-1.5">
            {t('coach.home.programNameLabel')}
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            spellCheck="true"
            autoCapitalize="words"
            className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 sl-mono text-[16px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
          />
        </label>

        {isDraft && (
          <div
            className="rounded-lg p-3 space-y-2"
            style={{
              background: 'color-mix(in srgb, var(--color-accent) 10%, transparent)',
              border: '1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)',
            }}
          >
            <p className="sl-label text-ink-700">
              {isSubmitted ? t('coach.home.submittedForApproval') : t('coach.home.draftInProgress')}
            </p>
            <p className="sl-mono text-[11px] text-ink-500">
              {isSubmitted ? t('coach.home.submittedHint') : t('coach.home.draftInProgressHint')}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleApprove}
                disabled={approvalBusy}
                className="sl-btn-primary flex-1 text-[13px] disabled:opacity-50"
                style={{ padding: '10px 16px' }}
              >
                {approve.isPending ? t('common.saving') : t('coach.home.approve')}
              </button>
              {isSubmitted && (
                <button
                  type="button"
                  onClick={handleSendBack}
                  disabled={approvalBusy}
                  className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200 flex-1 justify-center disabled:opacity-50"
                >
                  {sendBack.isPending ? t('common.saving') : t('coach.home.sendBack')}
                </button>
              )}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={handleRename}
            disabled={!dirty || rename.isPending}
            className="sl-btn-primary w-full text-[13px] disabled:opacity-50"
            style={{ padding: '10px 16px' }}
          >
            {rename.isPending ? t('common.saving') : t('coach.home.rename')}
          </button>

          {!program.is_active && !isDraft && (
            <button
              type="button"
              onClick={handleSetActive}
              disabled={setActive.isPending}
              className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200 w-full justify-center disabled:opacity-50"
            >
              {setActive.isPending ? t('common.saving') : t('coach.home.setActive')}
            </button>
          )}

          <div>
            <button
              type="button"
              onClick={handleDuplicate}
              disabled={duplicate.isPending}
              className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200 w-full justify-center disabled:opacity-50"
            >
              {duplicate.isPending ? t('common.saving') : t('coach.home.duplicate')}
            </button>
            <p className="sl-mono text-[11px] text-ink-400 mt-1.5">
              {t('coach.home.duplicateHint')}
            </p>
          </div>

          {confirmingDelete ? (
            <div
              className="rounded-lg p-3 space-y-2"
              style={{
                background: 'color-mix(in srgb, var(--color-danger) 10%, transparent)',
                border: '1px solid color-mix(in srgb, var(--color-danger) 35%, transparent)',
              }}
            >
              <p className="text-[13px] text-gray-900">
                {t('coach.home.confirmTrashProgram', { name: program.name })}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={del.isPending}
                  className="flex-1 rounded-lg py-2 sl-mono text-[12px] text-white disabled:opacity-50"
                  style={{ background: 'var(--color-danger)' }}
                >
                  {del.isPending ? t('common.saving') : t('coach.home.moveToTrash').toUpperCase()}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="flex-1 sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200 justify-center"
                >
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              disabled={!canDelete}
              title={!canDelete ? t('coach.home.cannotDeleteActive') : undefined}
              className="sl-pill w-full justify-center disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: 'color-mix(in srgb, var(--color-danger) 10%, transparent)',
                color: 'var(--color-danger)',
              }}
            >
              {t('coach.home.moveToTrash')}
            </button>
          )}

          {!canDelete && (
            <p className="sl-mono text-[11px] text-ink-400">
              {t('coach.home.cannotDeleteActive')}
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
