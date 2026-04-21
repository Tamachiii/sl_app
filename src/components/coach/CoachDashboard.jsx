import { Link } from 'react-router-dom';
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
    <div className="p-4 pb-6 space-y-5">
      <div className="sl-card px-4 py-4">
        <div className="sl-label text-ink-400">Coach</div>
        <p className="sl-display text-[28px] text-gray-900 leading-none mt-1">
          Dashboard.
        </p>
        <p className="sl-mono text-[11px] text-ink-400 mt-2">
          {students ? `${students.length} ${students.length === 1 ? 'athlete' : 'athletes'}` : '—'}
          {' · '}
          {recentActivity.length} RECENT
        </p>
      </div>

      <section aria-labelledby="students-heading" className="space-y-2">
        <h2 id="students-heading" className="sl-label text-ink-400">
          Athletes
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
              className="flex items-center justify-between sl-card p-3 hover:bg-ink-50 transition-colors"
            >
              <span className="sl-display text-[15px] text-gray-900">
                {s.profile?.full_name || 'Student'}
              </span>
              <svg
                className="w-4 h-4 text-ink-400"
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

      <section aria-labelledby="activity-heading" className="space-y-2">
        <h2 id="activity-heading" className="sl-label text-ink-400">
          Recent activity
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
              className="block sl-card p-3 hover:bg-ink-50 transition-colors"
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className="sl-mono text-[11px] truncate"
                  style={{ color: 'var(--color-accent)' }}
                >
                  {c.student_name}
                </span>
                <span className="sl-mono text-[11px] text-ink-400 shrink-0">
                  {new Date(c.confirmed_at).toLocaleDateString()}
                </span>
              </div>
              <p className="sl-display text-[15px] text-gray-900 mt-0.5">
                {c.session_title || `Session ${c.day_number}`}
              </p>
              <p className="sl-mono text-[11px] text-ink-400 mt-0.5">
                W{c.week_number}
                {c.week_label ? ` · ${c.week_label}` : ''} · D{c.day_number}
              </p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
