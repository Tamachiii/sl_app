import { useEffect } from 'react';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { useStudents } from '../../hooks/useStudents';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import UserMenu from '../ui/UserMenu';
import {
  useRememberCoachStudentsPath,
  getLastCoachStudentsPath,
  clearLastCoachStudentsPath,
  studentIdFromPath,
} from '../../hooks/useRememberCoachStudentsPath';

function StudentSelector({ students, studentId, onChange, t }) {
  return (
    <label className="block">
      <span className="sl-label text-ink-400 block mb-1.5">{t('coach.home.pickStudent')}</span>
      <select
        value={studentId || ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 sl-mono text-[16px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
      >
        <option value="">— {t('coach.home.pickStudent')} —</option>
        {students.map((s) => (
          <option key={s.id} value={s.id}>
            {s.profile?.full_name || 'Student'}
          </option>
        ))}
      </select>
    </label>
  );
}

// Profile owns the "view sessions" + "message" actions and shows the avatar +
// name, so we no longer render a separate header card above the tab strip.
const TABS = [
  { key: 'profile', i18n: 'coach.tabs.profile' },
  { key: 'programming', i18n: 'coach.tabs.programming' },
  { key: 'goals', i18n: 'coach.tabs.goals' },
  { key: 'stats', i18n: 'coach.tabs.stats' },
];

function StudentTabStrip({ studentId, t }) {
  return (
    <nav
      role="tablist"
      aria-label={t('nav.students')}
      className="sl-no-scrollbar -mx-1 px-1 flex gap-2 overflow-x-auto pb-1"
    >
      {TABS.map(({ key, i18n }) => (
        <NavLink
          key={key}
          to={`/coach/students/${studentId}/${key}`}
          role="tab"
          end
          className={({ isActive }) =>
            `sl-pill shrink-0 transition-colors ${
              isActive
                ? 'text-gray-900'
                : 'bg-ink-100 text-ink-700 hover:bg-ink-200'
            }`
          }
          style={({ isActive }) =>
            isActive
              ? {
                  background: 'color-mix(in srgb, var(--color-accent) 18%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)',
                }
              : undefined
          }
        >
          {t(i18n)}
        </NavLink>
      ))}
    </nav>
  );
}

function SelectedStudentView({ student, t }) {
  return (
    <div className="space-y-4">
      <StudentTabStrip studentId={student.id} t={t} />
      <div>
        <Outlet context={{ student }} />
      </div>
    </div>
  );
}

export default function CoachHome() {
  const { t } = useI18n();
  const { profile, signOut } = useAuth();
  const { studentId } = useParams();
  const navigate = useNavigate();
  const { data: students, isLoading } = useStudents();

  const selected = (students || []).find((s) => s.id === studentId) || null;

  // Persist the current Students-tab path so tabbing between sections drops
  // the coach back into the same place — whether that was the student card,
  // a week view, or the session editor.
  useRememberCoachStudentsPath();

  // Restore the last Students-tab path when landing on /coach/students with no
  // param (nav tab click, fresh reload). Skip if the remembered student was
  // removed so we don't bounce into a dead URL.
  useEffect(() => {
    if (studentId || isLoading) return;
    const saved = getLastCoachStudentsPath();
    if (!saved) return;
    const savedStudentId = studentIdFromPath(saved);
    if (!savedStudentId) return;
    if (!(students || []).some((s) => s.id === savedStudentId)) return;
    navigate(saved, { replace: true });
  }, [studentId, isLoading, students, navigate]);

  function handleSelect(id) {
    if (id) {
      navigate(`/coach/students/${id}/programming`);
    } else {
      // Explicit "— Select a student —" pick → forget the saved path so we
      // don't immediately re-redirect via the restore effect above.
      clearLastCoachStudentsPath();
      navigate('/coach/students');
    }
  }

  return (
    <div className="p-4 pb-6 md:p-8 space-y-5">
      <div className="pt-3 pb-1 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="sl-label text-ink-400">{t('coach.home.kicker')}</div>
          <h1 className="sl-display text-[28px] md:text-[40px] text-gray-900 leading-none mt-1">
            {t('coach.home.athletes')}
          </h1>
        </div>
        <UserMenu fullName={profile?.full_name} onSignOut={signOut} />
      </div>

      {isLoading && (
        <div className="flex justify-center py-12"><Spinner /></div>
      )}

      {!isLoading && (!students || students.length === 0) && (
        <EmptyState message={t('coach.home.noStudentsExt')} />
      )}

      {!isLoading && students && students.length > 0 && (
        <>
          <StudentSelector
            students={students}
            studentId={studentId}
            onChange={handleSelect}
            t={t}
          />

          {studentId && !selected && (
            <EmptyState message={t('coach.home.noStudentsExt')} />
          )}

          {!studentId && (
            <EmptyState message={t('coach.home.selectStudent')} />
          )}

          {selected && <SelectedStudentView student={selected} t={t} />}
        </>
      )}
    </div>
  );
}
