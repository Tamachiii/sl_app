import { memo, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import WeekTimeline from './WeekTimeline';
import { useProgram, useEnsureProgram } from '../../hooks/useProgram';

const StudentCard = memo(function StudentCard({ student }) {
  const { data: program, isSuccess } = useProgram(student.id);
  const ensureProgram = useEnsureProgram();
  const ensuredRef = useRef(false);

  useEffect(() => {
    if (isSuccess && program === null && !ensuredRef.current && !ensureProgram.isPending) {
      ensuredRef.current = true;
      ensureProgram.mutate({ studentId: student.id });
    }
  }, [isSuccess, program, student.id, ensureProgram]);

  const fullName = student.profile?.full_name || 'Student';
  const initials = fullName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <div className="sl-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
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
          <div className="min-w-0">
            <h3 className="sl-display text-[18px] text-gray-900 truncate">{fullName}</h3>
            <p className="sl-mono text-[11px] text-ink-400 mt-0.5">
              {program?.weeks?.length ? `${program.weeks.length} WEEKS` : 'NO PROGRAM'}
            </p>
          </div>
        </div>
        <Link
          to={`/coach/student/${student.id}/goals`}
          className="sl-pill shrink-0 bg-ink-100 text-ink-700 hover:bg-ink-200"
        >
          goals
        </Link>
      </div>
      {program && (
        <WeekTimeline
          studentId={student.id}
          program={program}
        />
      )}
    </div>
  );
});

export default StudentCard;
