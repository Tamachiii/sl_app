import { useParams } from 'react-router-dom';
import Header from '../layout/Header';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import { useStudentConfirmations } from '../../hooks/useSessionConfirmation';

export default function ConfirmedSessions() {
  const { studentId } = useParams();
  const { data: confirmations, isLoading } = useStudentConfirmations(studentId);

  if (isLoading) {
    return (
      <>
        <Header title="Confirmed sessions" showBack />
        <div className="flex justify-center py-12"><Spinner /></div>
      </>
    );
  }

  return (
    <>
      <Header title="Confirmed sessions" showBack />
      <div className="p-4 space-y-3">
        {(!confirmations || confirmations.length === 0) && (
          <EmptyState message="No confirmed sessions yet" />
        )}
        {confirmations?.map((c) => (
          <div key={c.id} className="bg-white rounded-xl shadow-sm p-4 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-medium text-gray-900">
                {c.session_title || `Session ${c.day_number}`}
              </h3>
              <span className="flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 px-1.5 py-0.5 rounded">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
                Confirmed
              </span>
            </div>
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
          </div>
        ))}
      </div>
    </>
  );
}
