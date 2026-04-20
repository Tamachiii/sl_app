import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Header from '../layout/Header';
import { useAuth } from '../../hooks/useAuth';
import { useStudentProgramDetails } from '../../hooks/useStudentProgramDetails';
import { useMyConfirmedSessionIds } from '../../hooks/useSessionConfirmation';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import SessionCard from './SessionCard';

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
                  archived={!!session.archived_at}
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
