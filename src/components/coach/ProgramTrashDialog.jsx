import { useState } from 'react';
import {
  useTrashedPrograms,
  useRestoreProgram,
  useHardDeleteProgram,
} from '../../hooks/useProgram';
import Dialog from '../ui/Dialog';

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
    <Dialog open={true} onClose={onClose} title={t('coach.home.trashTitle')}>
      {trashed.length === 0 ? (
        <p className="sl-mono text-[12px] text-ink-400">{t('coach.home.trashEmpty')}</p>
      ) : (
        <ul className="space-y-3">
          {trashed.map((p) => {
            const weekCount = (p.weeks || []).length;
            return (
              <li key={p.id} className="rounded-lg border border-ink-100 p-3 space-y-2">
                <div>
                  <span className="sl-display text-[14px] text-gray-900">{p.name}</span>
                  <span className="sl-mono text-[10px] text-ink-400 block mt-0.5">
                    {t(weekCount === 1 ? 'coach.home.weeksOne' : 'coach.home.weeksMany', { n: weekCount }).toUpperCase()}
                  </span>
                </div>
                {blockedId === p.id && (
                  <p className="sl-mono text-[11px] text-ink-400">
                    {t('coach.home.deleteForeverBlocked')}
                  </p>
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => restore.mutate({ programId: p.id, studentId })}
                    disabled={restore.isPending}
                    className="flex-1 sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200 justify-center disabled:opacity-50"
                  >
                    {t('coach.home.restore')}
                  </button>
                  {confirmingId === p.id ? (
                    <button
                      type="button"
                      onClick={() => handleHardDelete(p)}
                      disabled={hardDelete.isPending}
                      className="flex-1 rounded-lg py-2 sl-mono text-[12px] text-white disabled:opacity-50"
                      style={{ background: 'var(--color-danger)' }}
                    >
                      {t('coach.home.deleteForeverConfirm')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmingId(p.id);
                        setBlockedId(null);
                      }}
                      className="flex-1 sl-pill justify-center"
                      style={{
                        background: 'color-mix(in srgb, var(--color-danger) 10%, transparent)',
                        color: 'var(--color-danger)',
                      }}
                    >
                      {t('coach.home.deleteForever')}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
