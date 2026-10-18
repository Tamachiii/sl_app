import { useEffect, useMemo } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { useIsRestoring } from '@tanstack/react-query';
import {
  useProgramsForStudent,
  useProgram,
  useEnsureProgram,
} from '../../hooks/useProgram';
import Spinner from '../ui/Spinner';
import { Button } from '../parc';
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
      <div className="rounded-group bg-surface p-4">
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
      <div className="flex flex-col items-start gap-3 rounded-group bg-surface p-4">
        <p className="pk-body">{t('parcProgram.noBlock')}</p>
        <Button
          variant="primary"
          onClick={() => ensureProgram.mutate({ studentId })}
          disabled={ensureProgram.isPending}
        >
          {t('parcProgram.createFirst')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
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

      {programState === 'ready' ? (
        <>
          {/* An athlete's draft is theirs until the coach approves it (review
              item P53): the editor opens its sessions read-only, and this says
              why and where the approval is. */}
          {selectedProgram.status === 'draft' && (
            <p role="note" className="rounded-group bg-blue-soft p-4 pk-body">
              {t('coachEditorNavErrors.draft.sheet')}
            </p>
          )}
          <ProgramSheet key={selectedProgram.id} studentId={studentId} program={selectedProgram} />
        </>
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
