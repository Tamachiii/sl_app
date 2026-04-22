import { useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';
import { useStudents } from '../../hooks/useStudents';
import { useProgram, useEnsureProgram } from '../../hooks/useProgram';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import WeekTimeline from './WeekTimeline';
import StudentGoalsSection from './StudentGoalsSection';
import StudentStatsSection from './StudentStatsSection';

function initialsOf(fullName) {
  return (fullName || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

function StudentSelector({ students, studentId, onChange, t }) {
  return (
    <label className="block">
      <span className="sl-label text-ink-400 block mb-1.5">{t('coach.home.pickStudent')}</span>
      <select
        value={studentId || ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 sl-mono text-[13px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
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

function StudentHeader({ student, program, t }) {
  const fullName = student.profile?.full_name || 'Student';
  const weekCount = program?.weeks?.length ?? 0;
  const weeksLabel = weekCount === 0
    ? ''
    : t(weekCount === 1 ? 'coach.home.weeksOne' : 'coach.home.weeksMany', { n: weekCount });

  return (
    <div className="sl-card px-4 py-4 md:px-6 md:py-5">
      <div className="flex items-center gap-3">
        <div
          className="w-12 h-12 rounded-full flex items-center justify-center sl-display text-[15px] shrink-0"
          style={{
            background: 'color-mix(in srgb, var(--color-accent) 15%, transparent)',
            color: 'var(--color-accent)',
            border: '1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)',
          }}
          aria-hidden="true"
        >
          {initialsOf(fullName) || '—'}
        </div>
        <div className="min-w-0">
          <h2 className="sl-display text-[22px] md:text-[26px] text-gray-900 leading-none truncate">
            {fullName}
          </h2>
          {weeksLabel && (
            <p className="sl-mono text-[11px] text-ink-400 mt-1.5">{weeksLabel.toUpperCase()}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function ProgramSection({ studentId, program, t }) {
  if (!program) {
    return <div className="flex justify-center py-6"><Spinner /></div>;
  }
  if (!program.weeks?.length) {
    return (
      <div className="space-y-2">
        <EmptyState message={t('coach.home.noProgramWeeks')} />
        <WeekTimeline studentId={studentId} program={program} />
      </div>
    );
  }
  return <WeekTimeline studentId={studentId} program={program} />;
}

function SelectedStudentView({ student, t }) {
  const { data: program, isSuccess } = useProgram(student.id);
  const ensureProgram = useEnsureProgram();
  const ensuredRef = useRef(false);

  useEffect(() => {
    if (isSuccess && program === null && !ensuredRef.current && !ensureProgram.isPending) {
      ensuredRef.current = true;
      ensureProgram.mutate({ studentId: student.id });
    }
  }, [isSuccess, program, student.id, ensureProgram]);

  // Reset the ensured-flag when switching students.
  useEffect(() => {
    ensuredRef.current = false;
  }, [student.id]);

  return (
    <div className="space-y-6">
      <StudentHeader student={student} program={program} t={t} />

      <section aria-labelledby="program-heading" className="space-y-2">
        <h3 id="program-heading" className="sl-label text-ink-400">
          {t('coach.home.program')}
        </h3>
        <ProgramSection studentId={student.id} program={program} t={t} />
      </section>

      <section aria-labelledby="goals-heading" className="space-y-2">
        <h3 id="goals-heading" className="sl-label text-ink-400">
          {t('coach.home.goals')}
        </h3>
        <StudentGoalsSection studentId={student.id} />
      </section>

      <section aria-labelledby="stats-heading" className="space-y-2">
        <h3 id="stats-heading" className="sl-label text-ink-400">
          {t('coach.home.stats')}
        </h3>
        <StudentStatsSection studentId={student.id} />
      </section>
    </div>
  );
}

export default function CoachHome() {
  const { t } = useI18n();
  const { studentId } = useParams();
  const navigate = useNavigate();
  const { data: students, isLoading } = useStudents();

  const selected = (students || []).find((s) => s.id === studentId) || null;

  function handleSelect(id) {
    if (id) navigate(`/coach/students/${id}`);
    else navigate('/coach/students');
  }

  return (
    <div className="p-4 pb-6 md:p-8 space-y-5">
      <div className="pt-3 pb-1">
        <div className="sl-label text-ink-400">{t('coach.home.kicker')}</div>
        <h1 className="sl-display text-[28px] md:text-[40px] text-gray-900 leading-none mt-1">
          {t('coach.home.athletes')}
        </h1>
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
