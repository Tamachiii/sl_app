import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import Header from '../layout/Header';
import Spinner from '../ui/Spinner';
import { useSession } from '../../hooks/useSession';
import { useSetLogs } from '../../hooks/useSetLogs';
import { useSlotComments } from '../../hooks/useSlotComments';
import { useArchiveSession } from '../../hooks/useWeek';
import { useSessionConfirmation } from '../../hooks/useSessionConfirmation';
import SlotProgress from './SlotProgress';
import { formatSlotPrescription, formatRestSeconds, groupSlotsBySuperset } from '../../lib/volume';

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
  const { data: slotComments } = useSlotComments(sessionId, slots);
  const { data: confirmation } = useSessionConfirmation(sessionId);
  const archiveSession = useArchiveSession();
  const slotGroups = useMemo(() => groupSlotsBySuperset(slots), [slots]);
  const isArchived = !!session?.archived_at;

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
      <Header
        title={session?.title || 'Session review'}
        showBack
        actions={
          <button
            onClick={() =>
              archiveSession.mutate({ sessionId, archived: !isArchived })
            }
            disabled={archiveSession.isPending}
            className={`text-xs rounded-lg px-2.5 py-1.5 ${
              isArchived
                ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {isArchived ? 'Unarchive' : 'Archive'}
          </button>
        }
      />
      <div className="p-4 space-y-4">
        {isArchived && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            Archived on {new Date(session.archived_at).toLocaleString()}
          </div>
        )}
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

        {slotGroups.map((group) => {
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
                  {slot.rest_seconds != null && (
                    <span className="ml-2">· Rest {formatRestSeconds(slot.rest_seconds)}</span>
                  )}
                </p>
                <SlotProgress logs={slotLogs} plannedSets={slot.sets} />
                {(() => {
                  const c = (slotComments || []).find(
                    (x) => x.exercise_slot_id === slot.id
                  );
                  if (!c) return null;
                  return (
                    <div className="text-xs text-gray-700 bg-blue-50 border border-blue-100 rounded-lg px-2 py-1.5 whitespace-pre-wrap">
                      <span className="font-medium text-blue-700">Student note:</span>{' '}
                      {c.body}
                    </div>
                  );
                })()}
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
