import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Header from '../layout/Header';
import { useAuth } from '../../hooks/useAuth';
import { useStudentProgramDetails } from '../../hooks/useStudentProgramDetails';
import { useMyConfirmedSessionIds } from '../../hooks/useSessionConfirmation';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import { formatSlotPrescription } from '../../lib/volume';

/** A compact read-only row showing one exercise slot's prescription. */
function SlotSummary({ slot }) {
  const ex = slot.exercise;
  if (!ex) return null;
  return (
    <div className="flex items-center gap-2 text-xs text-gray-600">
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          ex.type === 'pull' ? 'bg-pull' : 'bg-push'
        }`}
      />
      <span className="font-medium text-gray-800 truncate">{ex.name}</span>
      <span className="text-gray-400 shrink-0">
        {formatSlotPrescription(slot)}
        {slot.weight_kg ? ` @ ${slot.weight_kg} kg` : ''}
      </span>
    </div>
  );
}

/** Expandable session card showing the full exercise list. */
function SessionCard({ session, confirmed, onStart }) {
  const [open, setOpen] = useState(false);
  const slots = session.exercise_slots || [];

  return (
    <div className="bg-white rounded-xl shadow-sm overflow-hidden">
      {/* Header row */}
      <button
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">
            {session.title || `Session ${session.sort_order + 1}`}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">
            {slots.length} exercise{slots.length !== 1 ? 's' : ''}
            {confirmed && (
              <span className="ml-2 text-green-600 font-medium">· Done</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {confirmed ? (
            <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <span className="text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-full">
              Start
            </span>
          )}
          <svg
            className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {/* Expanded exercise list */}
      {open && (
        <div className="border-t border-gray-100">
          {slots.length === 0 ? (
            <p className="px-4 py-3 text-xs text-gray-400">No exercises assigned yet.</p>
          ) : (
            <div className="px-4 py-3 space-y-2">
              {slots.map((slot) => (
                <SlotSummary key={slot.id} slot={slot} />
              ))}
            </div>
          )}
          <div className="px-4 pb-3">
            <button
              onClick={onStart}
              className="w-full bg-primary text-white rounded-lg py-2 text-sm font-semibold hover:opacity-90 transition-opacity"
            >
              {confirmed ? 'Review session' : 'Start session'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function StudentSessions() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data: weeks, isLoading } = useStudentProgramDetails(user?.id);
  const { data: confirmedIds = new Set() } = useMyConfirmedSessionIds();

  const [showArchived, setShowArchived] = useState(false);

  const visibleWeeks = useMemo(() => {
    if (!weeks) return [];
    return weeks
      .map((w) => ({
        ...w,
        sessions: (w.sessions || []).filter((s) => showArchived || !s.archived_at),
      }))
      .filter((w) => w.sessions.length > 0);
  }, [weeks, showArchived]);

  const archivedCount = useMemo(
    () =>
      (weeks || []).reduce(
        (n, w) => n + (w.sessions || []).filter((s) => s.archived_at).length,
        0
      ),
    [weeks]
  );

  if (isLoading) {
    return (
      <>
        <Header title="Sessions" />
        <div className="flex justify-center py-12"><Spinner /></div>
      </>
    );
  }

  return (
    <>
      <Header title="Sessions" />
      <div className="p-4 space-y-4">
        {!weeks?.length && <EmptyState message="No program assigned yet" />}

        {visibleWeeks.map((week) => (
          <section key={week.id} aria-labelledby={`week-${week.id}-heading`}>
            <h2
              id={`week-${week.id}-heading`}
              className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2"
            >
              Week {week.week_number}
              {week.label && (
                <span className="font-normal normal-case ml-1">— {week.label}</span>
              )}
            </h2>
            <div className="space-y-2">
              {week.sessions.map((session) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  confirmed={confirmedIds.has(session.id)}
                  onStart={() => navigate(`/student/session/${session.id}`)}
                />
              ))}
            </div>
          </section>
        ))}

        {archivedCount > 0 && (
          <button
            onClick={() => setShowArchived((v) => !v)}
            className="w-full text-xs text-gray-500 hover:text-gray-700 py-2"
          >
            {showArchived
              ? `Hide ${archivedCount} archived session${archivedCount !== 1 ? 's' : ''}`
              : `Show ${archivedCount} archived session${archivedCount !== 1 ? 's' : ''}`}
          </button>
        )}
      </div>
    </>
  );
}
