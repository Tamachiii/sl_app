import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Header from '../layout/Header';
import { useAuth } from '../../hooks/useAuth';
import { useStudentWeeks } from '../../hooks/useStudentWeeks';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import { useMyConfirmedSessionIds } from '../../hooks/useSessionConfirmation';

export default function StudentHome() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data: confirmedIds } = useMyConfirmedSessionIds();
  const { data, isLoading } = useStudentWeeks(user?.id);
  const [showArchived, setShowArchived] = useState(false);

  const archivedCount = useMemo(
    () =>
      (data || []).reduce(
        (n, w) => n + (w.sessions || []).filter((s) => s.archived_at).length,
        0
      ),
    [data]
  );

  // Drop weeks that end up empty after filtering (all sessions archived).
  const visibleWeeks = useMemo(() => {
    if (!data) return [];
    if (showArchived) return data;
    return data
      .map((w) => ({ ...w, sessions: (w.sessions || []).filter((s) => !s.archived_at) }))
      .filter((w) => w.sessions.length > 0);
  }, [data, showArchived]);

  return (
    <>
      <Header title="My Program" />
      <div className="p-4 space-y-3">
        {isLoading && (
          <div className="flex justify-center py-12"><Spinner /></div>
        )}
        {!isLoading && (!data || data.length === 0) && (
          <EmptyState message="No program assigned yet" />
        )}
        {visibleWeeks.map((week) => (
          <div key={week.id} className="bg-white rounded-xl shadow-sm p-4">
            <h3 className="font-semibold text-gray-900 mb-2">
              Week {week.week_number}
              {week.label && <span className="text-gray-400 font-normal ml-2">{week.label}</span>}
            </h3>
            <div className="space-y-1">
              {(week.sessions || []).map((sess) => {
                const confirmed = confirmedIds?.has(sess.id);
                const archived = !!sess.archived_at;
                return (
                  <button
                    key={sess.id}
                    onClick={() => navigate(`/student/session/${sess.id}`)}
                    className={`w-full flex items-center justify-between gap-2 text-left rounded-lg px-3 py-2.5 text-sm transition-colors ${
                      archived
                        ? 'bg-gray-100 text-gray-500 opacity-75 hover:bg-gray-200'
                        : 'bg-gray-50 text-gray-700 hover:bg-primary/5'
                    }`}
                  >
                    <span className="flex flex-col">
                      <span>{sess.title || `Session ${sess.sort_order + 1}`}</span>
                      {sess.scheduled_date && (
                        <span className="text-xs text-gray-400">
                          {new Date(sess.scheduled_date).toLocaleDateString(undefined, {
                            weekday: 'short',
                            month: 'short',
                            day: 'numeric',
                          })}
                        </span>
                      )}
                    </span>
                    <span className="flex items-center gap-1.5">
                      {archived && (
                        <span className="text-xs font-medium text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                          Archived
                        </span>
                      )}
                      {confirmed && (
                        <span
                          aria-label="Confirmed"
                          className="flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 px-1.5 py-0.5 rounded"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                          </svg>
                          Done
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {archivedCount > 0 && (
          <button
            onClick={() => setShowArchived((v) => !v)}
            className="w-full text-xs text-gray-500 hover:text-gray-700 py-2"
          >
            {showArchived
              ? `Hide ${archivedCount} archived`
              : `Show ${archivedCount} archived`}
          </button>
        )}
      </div>
    </>
  );
}
