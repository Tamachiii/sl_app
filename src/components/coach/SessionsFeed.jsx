import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Header from '../layout/Header';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import { useAllConfirmations } from '../../hooks/useSessionConfirmation';

export default function SessionsFeed() {
  const { data: confirmations, isLoading } = useAllConfirmations();
  const [showArchived, setShowArchived] = useState(false);

  const { active, archived } = useMemo(() => {
    const a = [];
    const b = [];
    for (const c of confirmations || []) {
      (c.archived_at ? b : a).push(c);
    }
    return { active: a, archived: b };
  }, [confirmations]);

  if (isLoading) {
    return (
      <>
        <Header title="Sessions" />
        <div className="flex justify-center py-12"><Spinner /></div>
      </>
    );
  }

  function renderCard(c) {
    const isArchived = !!c.archived_at;
    return (
      <Link
        key={c.id}
        to={`/coach/student/${c.student_id}/session/${c.session_id}/review`}
        className={`block rounded-xl shadow-sm p-4 space-y-1 hover:shadow-md transition-shadow ${
          isArchived ? 'bg-gray-50 border border-gray-200 opacity-75' : 'bg-white'
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-primary truncate">
            {c.student_name}
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            {isArchived && (
              <span className="text-xs font-medium text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                Archived
              </span>
            )}
            <span className="flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 px-1.5 py-0.5 rounded">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
              Confirmed
            </span>
          </div>
        </div>
        <h3 className={`font-medium text-sm ${isArchived ? 'text-gray-600' : 'text-gray-900'}`}>
          {c.session_title || `Session ${c.day_number}`}
        </h3>
        <p className="text-xs text-gray-500">
          Week {c.week_number}
          {c.week_label ? ` — ${c.week_label}` : ''} · Day {c.day_number}
        </p>
        <p className="text-xs text-gray-400">
          {new Date(c.confirmed_at).toLocaleString()}
        </p>
        {c.notes && (
          <p className="mt-2 text-sm text-gray-700 whitespace-pre-wrap">{c.notes}</p>
        )}
      </Link>
    );
  }

  return (
    <>
      <Header title="Sessions" />
      <div className="p-4 space-y-3">
        {active.length === 0 && archived.length === 0 && (
          <EmptyState message="No confirmed sessions yet" />
        )}
        {active.length === 0 && archived.length > 0 && !showArchived && (
          <EmptyState message="No sessions to review — all confirmed sessions are archived." />
        )}

        {active.map(renderCard)}

        {archived.length > 0 && (
          <button
            onClick={() => setShowArchived((v) => !v)}
            className="w-full text-xs text-gray-500 hover:text-gray-700 py-2"
          >
            {showArchived
              ? `Hide ${archived.length} archived`
              : `Show ${archived.length} archived`}
          </button>
        )}

        {showArchived && archived.map(renderCard)}
      </div>
    </>
  );
}
