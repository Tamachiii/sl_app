import { Link } from 'react-router-dom';
import Header from '../layout/Header';
import { useStudents } from '../../hooks/useStudents';
import { useAllConfirmations } from '../../hooks/useSessionConfirmation';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';

export default function CoachDashboard() {
  const { data: students, isLoading: studentsLoading } = useStudents();
  const { data: confirmations, isLoading: confsLoading } = useAllConfirmations();

  const recentActivity = (confirmations || [])
    .filter((c) => !c.archived_at)
    .slice(0, 5);

  return (
    <>
      <Header title="Dashboard" />
      <div className="p-4 space-y-6">

        {/* Students section */}
        <section aria-labelledby="students-heading">
          <h2
            id="students-heading"
            className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2"
          >
            Students
            {students && (
              <span className="ml-1.5 text-gray-400 font-normal normal-case tracking-normal">
                ({students.length})
              </span>
            )}
          </h2>

          {studentsLoading && (
            <div className="flex justify-center py-6"><Spinner /></div>
          )}

          {!studentsLoading && (!students || students.length === 0) && (
            <EmptyState message="No students yet" />
          )}

          <div className="space-y-2">
            {students?.map((s) => (
              <Link
                key={s.id}
                to={`/coach/sessions?student=${s.id}`}
                className="flex items-center justify-between bg-white rounded-xl shadow-sm p-3 hover:shadow-md transition-shadow"
              >
                <span className="font-medium text-gray-900 text-sm">
                  {s.profile?.full_name || 'Student'}
                </span>
                <svg
                  className="w-4 h-4 text-gray-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </Link>
            ))}
          </div>
        </section>

        {/* Recent Activity section */}
        <section aria-labelledby="activity-heading">
          <h2
            id="activity-heading"
            className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2"
          >
            Recent Activity
          </h2>

          {confsLoading && (
            <div className="flex justify-center py-6"><Spinner /></div>
          )}

          {!confsLoading && recentActivity.length === 0 && (
            <EmptyState message="No recent confirmations" />
          )}

          <div className="space-y-2">
            {recentActivity.map((c) => (
              <Link
                key={c.id}
                to={`/coach/student/${c.student_id}/session/${c.session_id}/review`}
                className="block bg-white rounded-xl shadow-sm p-3 hover:shadow-md transition-shadow"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-primary truncate">
                    {c.student_name}
                  </span>
                  <span className="text-xs text-gray-400 shrink-0">
                    {new Date(c.confirmed_at).toLocaleDateString()}
                  </span>
                </div>
                <p className="text-sm font-medium text-gray-900 mt-0.5">
                  {c.session_title || `Session ${c.day_number}`}
                </p>
                <p className="text-xs text-gray-400">
                  Week {c.week_number}
                  {c.week_label ? ` — ${c.week_label}` : ''} · Day {c.day_number}
                </p>
              </Link>
            ))}
          </div>
        </section>

      </div>
    </>
  );
}
