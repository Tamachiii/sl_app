import { useEffect, useMemo } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import {
  useProgramsForStudent,
  useProgram,
  useEnsureProgram,
} from '../../hooks/useProgram';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import WeekTimeline from './WeekTimeline';
import ProgramSwitcher from './ProgramSwitcher';

export default function StudentProgrammingSection() {
  const { student } = useOutletContext();
  const studentId = student.id;

  const [searchParams, setSearchParams] = useSearchParams();
  const { data: programs, isSuccess } = useProgramsForStudent(studentId);
  const ensureProgram = useEnsureProgram();

  const activeProgram = useMemo(
    () => (programs || []).find((p) => p.is_active) ?? (programs || [])[0] ?? null,
    [programs],
  );

  const urlProgramId = searchParams.get('program');
  const urlProgramExists = urlProgramId && (programs || []).some((p) => p.id === urlProgramId);
  const selectedProgramId = urlProgramExists ? urlProgramId : activeProgram?.id ?? null;

  // Drop a stale ?program= from the URL (e.g. after deletion) so back/forward
  // doesn't resurrect a dead id.
  useEffect(() => {
    if (urlProgramId && !urlProgramExists && isSuccess && (programs || []).length > 0) {
      const next = new URLSearchParams(searchParams);
      next.delete('program');
      setSearchParams(next, { replace: true });
    }
  }, [urlProgramId, urlProgramExists, isSuccess, programs, searchParams, setSearchParams]);

  const { data: selectedProgram } = useProgram(selectedProgramId);

  function handleSelectProgram(programId) {
    const next = new URLSearchParams(searchParams);
    if (programId && programId !== activeProgram?.id) {
      next.set('program', programId);
    } else {
      next.delete('program');
    }
    setSearchParams(next, { replace: true });
  }

  function handleProgramDeleted(deletedId) {
    if (deletedId === selectedProgramId) {
      const next = new URLSearchParams(searchParams);
      next.delete('program');
      setSearchParams(next, { replace: true });
    }
  }

  const hasPrograms = Array.isArray(programs) && programs.length > 0;
  const list = isSuccess ? (programs || []) : [];

  // No auto-seed: merely opening an athlete must not INSERT a program row.
  // The coach creates the first block explicitly.
  if (isSuccess && !hasPrograms) {
    return (
      <div className="sl-card p-3 md:p-4 space-y-3">
        <EmptyState message="No program yet for this athlete." />
        <button
          type="button"
          onClick={() => ensureProgram.mutate({ studentId })}
          disabled={ensureProgram.isPending}
          className="w-full sl-btn-primary text-[13px] disabled:opacity-50"
          style={{ padding: '10px 16px' }}
        >
          Create first program
        </button>
      </div>
    );
  }

  return (
    <div className="sl-card p-3 md:p-4 space-y-3">
      {hasPrograms && (
        <ProgramSwitcher
          studentId={studentId}
          programs={list}
          selectedId={selectedProgramId}
          onSelect={handleSelectProgram}
          onProgramDeleted={handleProgramDeleted}
        />
      )}

      {hasPrograms && selectedProgram && <div className="sl-hairline -mx-3 md:-mx-4" />}

      {!selectedProgram ? (
        <div className="flex justify-center py-4"><Spinner /></div>
      ) : (
        <WeekTimeline studentId={studentId} program={selectedProgram} />
      )}
    </div>
  );
}
