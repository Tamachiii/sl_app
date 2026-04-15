import { useParams } from 'react-router-dom';
import Header from '../layout/Header';
import Spinner from '../ui/Spinner';
import { useSession } from '../../hooks/useSession';
import { useSetLogs } from '../../hooks/useSetLogs';
import { useSessionConfirmation } from '../../hooks/useSessionConfirmation';
import SlotProgress from './SlotProgress';
import { formatSlotPrescription, groupSlotsBySuperset } from '../../lib/volume';

/**
 * Coach-facing read-only view of a session the student has completed.
 * Mirrors SessionEditor layout but strips every edit control and adds the
 * confirmation banner + per-slot set/RPE progress.
 */
export default function SessionReview() {
  const { sessionId } = useParams();
  const { data: session, isLoading } = useSession(sessionId);
  const slots = session?.exercise_slots || [];
  const { data: setLogs } = useSetLogs(sessionId, slots);
  const { data: confirmation } = useSessionConfirmation(sessionId);

  if (isLoading) {
    return (
      <>
        <Header title="Session review" showBack />
        <div className="flex justify-center py-12"><Spinner /></div>
      </>
    );
  }

  return (
    <>
      <Header title={session?.title || 'Session review'} showBack />
      <div className="p-4 space-y-4">
        {confirmation ? (
          <div className="rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-800">
            <div className="flex items-center gap-2 font-medium">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
              Confirmed by student
            </div>
            <p className="text-xs text-green-700 mt-0.5">
              {new Date(confirmation.confirmed_at).toLocaleString()}
            </p>
            {confirmation.notes && (
              <p className="mt-1 text-sm text-gray-700 whitespace-pre-wrap">{confirmation.notes}</p>
            )}
          </div>
        ) : (
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
            Not yet confirmed by the student.
          </div>
        )}

        {groupSlotsBySuperset(slots).map((group) => {
          const renderSlot = (slot) => {
            const ex = slot.exercise;
            const slotLogs = (setLogs || []).filter((l) => l.exercise_slot_id === slot.id);
            return (
              <div key={slot.id} className="bg-white rounded-xl shadow-sm p-4 space-y-2">
                <div>
                  <span className="font-medium text-gray-900 text-sm">{ex.name}</span>
                  <span
                    className={`ml-2 text-xs font-medium px-1.5 py-0.5 rounded ${
                      ex.type === 'pull' ? 'bg-pull/10 text-pull' : 'bg-push/10 text-push'
                    }`}
                  >
                    {ex.type}
                  </span>
                  <span className="ml-1 text-xs text-gray-400">D{ex.difficulty}</span>
                </div>
                <p className="text-xs text-gray-400">
                  Planned: {formatSlotPrescription(slot)}
                  {slot.weight_kg ? ` @ ${slot.weight_kg}kg` : ' (BW)'}
                </p>
                <SlotProgress logs={slotLogs} plannedSets={slot.sets} />
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
                </div>
                {group.slots.map(renderSlot)}
              </div>
            );
          }
          return renderSlot(group.slots[0]);
        })}
      </div>
    </>
  );
}
