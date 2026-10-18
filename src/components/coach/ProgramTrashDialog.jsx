import { useState } from 'react';
import {
  useTrashedPrograms,
  useRestoreProgram,
  useHardDeleteProgram,
} from '../../hooks/useProgram';
import { Button, Sheet } from '../parc';

export default function TrashDialog({ studentId, t, onClose }) {
  // This component only mounts while the trash dialog is open, so the trashed-
  // programs fetch happens on demand rather than on every Programming-tab visit.
  const { data: trashed = [] } = useTrashedPrograms(studentId);
  const restore = useRestoreProgram();
  const hardDelete = useHardDeleteProgram();
  const [confirmingId, setConfirmingId] = useState(null);
  const [blockedId, setBlockedId] = useState(null);

  function handleHardDelete(program) {
    hardDelete.mutate(
      { programId: program.id, studentId },
      {
        onSuccess: () => setConfirmingId(null),
        onError: (err) => {
          setConfirmingId(null);
          // Client pre-check and the DB trigger both refuse while logged
          // sets exist — surface it as guidance, not as a failure.
          if (err?.code === 'PROGRAM_HAS_LOGGED_SETS' || /logged set/.test(err?.message || '')) {
            setBlockedId(program.id);
          }
        },
      },
    );
  }

  return (
    <Sheet open onClose={onClose} title={t('parcProgram.trashTitle')}>
      {trashed.length === 0 ? (
        <p className="pk-body">{t('coach.home.trashEmpty')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {trashed.map((p) => (
            <li key={p.id} className="flex flex-col gap-2 rounded-group bg-fill p-4">
              <span className="pk-headline">{p.name}</span>
              {blockedId === p.id && <p className="pk-caption">{t('coach.home.deleteForeverBlocked')}</p>}
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => restore.mutate({ programId: p.id, studentId })}
                  disabled={restore.isPending}
                >
                  {t('parcProgram.restore')}
                </Button>
                {confirmingId === p.id ? (
                  <Button variant="danger" onClick={() => handleHardDelete(p)} disabled={hardDelete.isPending}>
                    {t('parcProgram.deleteForeverConfirm')}
                  </Button>
                ) : (
                  <Button
                    variant="text"
                    className="text-red"
                    onClick={() => {
                      setConfirmingId(p.id);
                      setBlockedId(null);
                    }}
                  >
                    {t('parcProgram.deleteForever')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
