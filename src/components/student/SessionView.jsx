import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import Header from '../layout/Header';
import { useSession } from '../../hooks/useSession';
import { useSetLogs, useEnsureSetLogs } from '../../hooks/useSetLogs';
import SetRow from './SetRow';
import Spinner from '../ui/Spinner';

export default function SessionView() {
  const { sessionId } = useParams();
  const { data: session, isLoading: sessLoading } = useSession(sessionId);
  const slots = session?.exercise_slots || [];
  const { data: logs, isLoading: logsLoading } = useSetLogs(sessionId, slots);
  const ensureLogs = useEnsureSetLogs();

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

  return (
    <>
      <Header title={session?.title || 'Session'} showBack />
      <div className="p-4 space-y-4">
        {slots.map((slot) => {
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
                {slot.sets} x {slot.reps}
                {slot.weight_kg ? ` @ ${slot.weight_kg}kg` : ' (BW)'}
              </p>
              <div className="space-y-1">
                {slotLogs.map((log) => (
                  <SetRow key={log.id} log={log} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
