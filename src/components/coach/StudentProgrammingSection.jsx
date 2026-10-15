import { useEffect, useMemo } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { useIsRestoring } from '@tanstack/react-query';
import {
  useProgramsForStudent,
  useProgram,
  useEnsureProgram,
} from '../../hooks/useProgram';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import ProgramSheet from './ProgramSheet';
import ProgramSwitcher from './ProgramSwitcher';
import { CoachNotFound, CoachReadProblem } from './CoachPageState';
import { useI18n } from '../../hooks/useI18n';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { readState } from '../../lib/readState';

export default function StudentProgrammingSection() {
  const { student } = useOutletContext();
  const studentId = student.id;

  const { t } = useI18n();
  const online = useOnlineStatus();
  const restoring = useIsRestoring();
  const [searchParams, setSearchParams] = useSearchParams();
  const programsRead = useProgramsForStudent(studentId);
  const { data: programs, isSuccess } = programsRead;
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

  const programRead = useProgram(selectedProgramId);
  const selectedProgram = programRead.data;

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

  // The list of blocks got no answer: nothing is known, not even whether
  // there is a block. It used to be a spinner for ever.
  const listState = programs ? 'ready' : readState([programsRead], { online, restoring });
  if (listState === 'offline' || listState === 'failed') {
    return (
      <div className="sl-card p-3 md:p-4">
        <CoachReadProblem
          compact
          state={listState}
          onRetry={() => programsRead.refetch({ cancelRefetch: false })}
          retrying={programsRead.isFetching}
        />
      </div>
    );
  }

  // The block on screen: read, gone (`useProgram` answers null for a block
  // that is not there), or not answered.
  const programGone = programRead.isSuccess && selectedProgram == null;
  const programState = selectedProgram
    ? 'ready'
    : programGone
      ? 'notFound'
      : readState([programRead], { online, restoring });

  function showCurrentBlock() {
    if (urlProgramId) {
      const next = new URLSearchParams(searchParams);
      next.delete('program');
      setSearchParams(next, { replace: true });
    }
    programsRead.refetch({ cancelRefetch: false });
  }

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

  // The two `key`s below are what keeps a queued reorder alive. The switcher's
  // reorder waits in a queue per athlete and the sheet's three in a queue per
  // block (`mutationScope`), and a hook that is re-rendered with another id
  // hands its new options — the queue's name with them — to the write it still
  // has waiting: TanStack Query then looks for that write's turn in a queue it
  // was never put in, and it is not sent. Mounted per athlete and per block, a
  // hook keeps one queue for as long as it lives; the writes it leaves behind
  // when it unmounts go out as they were made.
  return (
    <div className="sl-card p-3 md:p-4 space-y-3">
      {hasPrograms && (
        <ProgramSwitcher
          key={studentId}
          studentId={studentId}
          programs={list}
          selectedId={selectedProgramId}
          onSelect={handleSelectProgram}
          onProgramDeleted={handleProgramDeleted}
        />
      )}

      {hasPrograms && selectedProgram && <div className="sl-hairline -mx-3 md:-mx-4" />}

      {programState === 'ready' ? (
        <ProgramSheet key={selectedProgram.id} studentId={studentId} program={selectedProgram} />
      ) : programState === 'notFound' ? (
        <CoachNotFound
          compact
          title={t('coachEditorNavErrors.program.notFoundTitle')}
          body={t('coachEditorNavErrors.program.notFoundBody')}
          onLeave={showCurrentBlock}
          linkLabel={t('coachEditorNavErrors.program.showCurrent')}
        />
      ) : programState === 'loading' ? (
        <div className="flex justify-center py-4"><Spinner /></div>
      ) : (
        <CoachReadProblem
          compact
          state={programState}
          onRetry={() => programRead.refetch({ cancelRefetch: false })}
          retrying={programRead.isFetching}
        />
      )}
    </div>
  );
}
