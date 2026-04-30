import { Link } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { useStudents } from '../../hooks/useStudents';
import { useAllConfirmations } from '../../hooks/useSessionConfirmation';
import { useCoachDashboardPrograms } from '../../hooks/useProgram';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import UserMenu from '../ui/UserMenu';
import StudentWeekStrip from './StudentWeekStrip';

function StudentListItem({ student, summary, t }) {
  const fullName = student.profile?.full_name || 'Student';
  const initials = fullName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');

  const bits = [];
  if (summary?.activeWeek?.week_number) {
    bits.push(`W${summary.activeWeek.week_number}`);
  }
  if (summary?.programName) bits.push(summary.programName);
  const subtitle = bits.join(' · ').toUpperCase();

  return (
    <Link
      to={`/coach/students/${student.id}`}
      aria-label={t('coach.dashboard.openStudent', { name: fullName })}
      className="block sl-card p-3 hover:bg-ink-50 transition-colors"
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center sl-display text-[13px] shrink-0"
          style={{
            background: 'color-mix(in srgb, var(--color-accent) 15%, transparent)',
            color: 'var(--color-accent)',
            border: '1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)',
          }}
          aria-hidden="true"
        >
          {initials || '—'}
        </div>
        <div className="min-w-0 flex-1">
          <p className="sl-display text-[16px] text-gray-900 truncate">{fullName}</p>
          {subtitle && (
            <p className="sl-mono text-[11px] text-ink-400 mt-1.5 truncate">{subtitle}</p>
          )}
        </div>
      </div>
      {summary?.weekDays && (
        <StudentWeekStrip weekDays={summary.weekDays} className="mt-3" />
      )}
    </Link>
  );
}

export default function CoachDashboard() {
  const { t } = useI18n();
  const { profile, signOut } = useAuth();
  const { data: students, isLoading: studentsLoading } = useStudents();
  const { data: confirmations, isLoading: confsLoading } = useAllConfirmations();
  const { data: summary } = useCoachDashboardPrograms();

  const recentActivity = (confirmations || [])
    .filter((c) => !c.archived_at)
    .slice(0, 5);

  return (
    <div className="p-4 pb-6 md:p-8 space-y-5">
      <div className="pt-3 pb-1 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="sl-label text-ink-400">{t('coach.dashboard.kicker')}</div>
          <h1 className="sl-display text-[28px] md:text-[40px] text-gray-900 leading-none mt-1">
            {t('coach.dashboard.title')}
          </h1>
        </div>
        <UserMenu fullName={profile?.full_name} onSignOut={signOut} />
      </div>

      <section aria-labelledby="athletes-heading" className="space-y-2">
        <h2 id="athletes-heading" className="sl-label text-ink-400">
          {t('coach.dashboard.athletes')}
        </h2>

        {studentsLoading && (
          <div className="flex justify-center py-6"><Spinner /></div>
        )}

        {!studentsLoading && (!students || students.length === 0) && (
          <EmptyState message={t('coach.home.noStudentsExt')} />
        )}

        <div className="space-y-2 md:grid md:grid-cols-2 md:gap-2 md:space-y-0">
          {(students || []).map((s) => (
            <StudentListItem key={s.id} student={s} summary={summary?.[s.id]} t={t} />
          ))}
        </div>
      </section>

      <section aria-labelledby="activity-heading" className="space-y-2">
        <h2 id="activity-heading" className="sl-label text-ink-400">
          {t('coach.dashboard.recentActivity')}
        </h2>

        {confsLoading && (
          <div className="flex justify-center py-6"><Spinner /></div>
        )}

        {!confsLoading && recentActivity.length === 0 && (
          <EmptyState message={t('coach.dashboard.noConfirmations')} />
        )}

        <div className="space-y-2 md:grid md:grid-cols-2 md:gap-2 md:space-y-0">
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
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
