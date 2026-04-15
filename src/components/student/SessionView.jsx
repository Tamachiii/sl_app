import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import Header from '../layout/Header';
import { useSession } from '../../hooks/useSession';
import { useSetLogs, useEnsureSetLogs } from '../../hooks/useSetLogs';
import {
  useSessionConfirmation,
  useConfirmSession,
  useUnconfirmSession,
} from '../../hooks/useSessionConfirmation';
import SetRow from './SetRow';
import Spinner from '../ui/Spinner';
import { formatSlotPrescription, formatRestSeconds, groupSlotsBySuperset } from '../../lib/volume';

export default function SessionView() {
  const { sessionId } = useParams();
  const { data: session, isLoading: sessLoading } = useSession(sessionId);
  const slots = session?.exercise_slots || [];
  const { data: logs, isLoading: logsLoading } = useSetLogs(sessionId, slots);
  const slotGroups = useMemo(() => groupSlotsBySuperset(slots), [slots]);
  const ensureLogs = useEnsureSetLogs();
  const { data: confirmation, isLoading: confLoading } = useSessionConfirmation(sessionId);
  const confirmSession = useConfirmSession();
  const unconfirmSession = useUnconfirmSession();

  const [notes, setNotes] = useState('');

  // Auto-create set_log rows on first open
  useEffect(() => {
    if (slots.length > 0 && logs !== undefined) {
      ensureLogs.mutate({ sessionId, slots });
    }
  }, [sessionId, slots.length, logs !== undefined]);

  if (sessLoading || logsLoading) {
    return (
      <>
        <Header title="Session" showBack />
        <div className="flex justify-center py-12"><Spinner /></div>
      </>
    );
  }

  function getLogsForSlot(slotId) {
    return (logs || [])
      .filter((l) => l.exercise_slot_id === slotId)
      .sort((a, b) => a.set_number - b.set_number);
  }

  const isConfirmed = !!confirmation;
  const isArchived = !!session?.archived_at;

  function handleConfirm() {
    confirmSession.mutate({ sessionId, notes: notes.trim() || null }, {
      onSuccess: () => setNotes(''),
    });
  }

  function handleUnconfirm() {
    if (confirm('Undo confirmation for this session?')) {
      unconfirmSession.mutate({ sessionId });
    }
  }

  return (
    <>
      <Header title={session?.title || 'Session'} showBack />
      <div className="p-4 space-y-4">
        {session?.scheduled_date && (
          <p className="text-sm text-gray-500">
            {new Date(session.scheduled_date).toLocaleDateString(undefined, {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </p>
        )}
        {slotGroups.map((group) => {
          const renderSlot = (slot) => {
            const ex = slot.exercise;
            const slotLogs = getLogsForSlot(slot.id);
            return (
              <div key={slot.id} className="bg-white rounded-xl shadow-sm p-4 space-y-2">
                <div>
                  <span className="font-medium text-gray-900 text-sm">{ex.name}</span>
                  <span className={`ml-2 text-xs font-medium px-1.5 py-0.5 rounded ${
                    ex.type === 'pull' ? 'bg-pull/10 text-pull' : 'bg-push/10 text-push'
                  }`}>
                    {ex.type}
                  </span>
                </div>
                <p className="text-xs text-gray-400">
                  {formatSlotPrescription(slot)}
                  {slot.weight_kg ? ` @ ${slot.weight_kg}kg` : ' (BW)'}
                  {slot.rest_seconds != null && (
                    <span className="ml-2">· Rest {formatRestSeconds(slot.rest_seconds)}</span>
                  )}
                </p>
                <div className="space-y-1">
                  {slotLogs.map((log) => (
                    <SetRow
                      key={log.id}
                      log={log}
                      locked={isConfirmed}
                      restSeconds={slot.rest_seconds}
                    />
                  ))}
                </div>
              </div>
            );
          };
          if (group.slots.length > 1) {
            return (
              <div
                key={group.key}
                className="rounded-xl border-2 border-primary/30 bg-primary/5 p-2 space-y-2"
              >
                <div className="px-2 pt-1">
                  <span className="text-xs font-semibold uppercase tracking-wide text-primary">
                    Superset
                  </span>
                  <span className="ml-2 text-xs text-gray-500">
                    Alternate between exercises each set
                  </span>
                </div>
                {group.slots.map(renderSlot)}
              </div>
            );
          }
          return renderSlot(group.slots[0]);
        })}

        {!confLoading && (
          <div
            className={`rounded-xl shadow-sm p-4 space-y-3 ${
              isConfirmed ? 'bg-green-50 border border-green-200' : 'bg-white'
            }`}
          >
            {isConfirmed ? (
              <>
                <div className="flex items-start gap-2">
                  <svg
                    className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                  <div className="flex-1">
                    <p className="text-sm font-medium text-green-800">Session confirmed</p>
                    <p className="text-xs text-green-700">
                      {new Date(confirmation.confirmed_at).toLocaleString()}
                    </p>
                    {confirmation.notes && (
                      <p className="mt-2 text-sm text-gray-700 whitespace-pre-wrap">
                        {confirmation.notes}
                      </p>
                    )}
                  </div>
                </div>
                {isArchived ? (
                  <p className="text-xs text-gray-500 text-center">
                    Archived by your coach — confirmation is locked.
                  </p>
                ) : (
                  <button
                    onClick={handleUnconfirm}
                    disabled={unconfirmSession.isPending}
                    className="w-full text-xs text-gray-500 hover:text-danger underline"
                  >
                    Undo confirmation
                  </button>
                )}
              </>
            ) : (
              <>
                <div>
                  <h3 className="font-medium text-gray-900 text-sm">Confirm session</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Let your coach know you've completed this session.
                  </p>
                </div>
                <label htmlFor="confirm-notes" className="sr-only">
                  Notes for your coach
                </label>
                <textarea
                  id="confirm-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional notes for your coach…"
                  rows={3}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <button
                  onClick={handleConfirm}
                  disabled={confirmSession.isPending}
                  className="w-full bg-primary text-white rounded-lg py-2.5 text-sm font-semibold disabled:opacity-50"
                >
                  {confirmSession.isPending ? 'Confirming…' : 'Confirm session'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
