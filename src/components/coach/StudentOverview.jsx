import { useEffect, useMemo } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { useIsRestoring } from '@tanstack/react-query';
import {
  useProgramsForStudent,
  useProgram,
  useEnsureProgram,
} from '../../hooks/useProgram';
import { useReviewCounts } from '../../hooks/useSessionConfirmation';
import { useI18n } from '../../hooks/useI18n';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { readState } from '../../lib/readState';
import { buildQueue } from '../../lib/sessionQueue';
import { formatNumber, pluralKey } from '../../lib/i18n/format';
import Spinner from '../ui/Spinner';
import { Button, Count, LargeTitle } from '../parc';
import ProgramSheet from './ProgramSheet';
import ProgramSwitcher from './ProgramSwitcher';
import { CoachNotFound, CoachReadProblem } from './CoachPageState';

/**
 * The line under the block's name. The athlete comes first: the title is the
 * block, and this line is what says whose it is. Then what the block is — in
 * progress, a draft, submitted — and, once the block is read, where the
 * athlete is in the block in progress, or how many sessions another block
 * holds. The place is counted as the roster counts it (`buildQueue` over the
 * sessions that carry `performed_at`), so the roster and this page never say
 * two different things.
 */
function blockSubtitle({ name, block, program, t, lang }) {
  const parts = [name];
  const isDraft = block.status === 'draft';
  if (isDraft) {
    parts.push(block.submitted_at ? t('coachAthleteBlock.submitted') : t('coachAthleteBlock.draft'));
  } else if (block.is_active) {
    parts.push(t('coachAthleteBlock.inProgress'));
  }
  if (program && program.id === block.id) {
    const weeks = program.weeks || [];
    const performed = new Set(
      weeks.flatMap((w) => w.sessions || []).filter((s) => s.performed_at).map((s) => s.id),
    );
    const { position, total } = buildQueue(weeks, performed);
    if (total > 0) {
      parts.push(
        block.is_active && !isDraft
          ? t('coachAthleteBlock.sessionOf', { n: formatNumber(lang, position), total: formatNumber(lang, total) })
          : t(pluralKey(lang, total, 'parcProgram.sessionsCount'), { n: formatNumber(lang, total) }),
      );
    }
  }
  return parts.filter(Boolean).join(', ');
}

/**
 * The athlete's other pages, under the title: their message thread, their
 * sessions in the feed — with how many wait for a review —, their goals and
 * their stats. Two by two on a phone, where four do not hold on one row; in a
 * row from 640px.
 */
function AthleteLinks({ student, name }) {
  const { t, lang } = useI18n();
  // Coach-wide and already read by the roster and the tab bar's badge.
  const { data: reviewCounts } = useReviewCounts();
  const toReview = reviewCounts?.[student.id] ?? 0;
  const page = `/coach/students/${student.id}`;

  return (
    <nav aria-label={t('coachAthleteBlock.linksLabel', { name })} className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
      {/* The thread is keyed on the PROFILE id, not the students-row id. */}
      {student.profile_id && (
        <Button as={Link} variant="on-ground" to={`/coach/messages/${student.profile_id}`}>
          {t('parcProgram.message')}
        </Button>
      )}
      <Button as={Link} variant="on-ground" to={`/coach/sessions?student=${student.id}`}>
        {t('parcProgram.sessions')}{' '}
        <Count count={toReview} countLabel={t('parcRoster.toReview', { n: formatNumber(lang, toReview) })} />
      </Button>
      <Button as={Link} variant="on-ground" to={`${page}/goals`}>
        {t('coach.tabs.goals')}
      </Button>
      <Button as={Link} variant="on-ground" to={`${page}/stats`}>
        {t('coach.tabs.stats')}
      </Button>
    </nav>
  );
}

/**
 * The athlete page IS the athlete's block (design/parc/screens/Programme.dc.html).
 * The block's name is the page's title — a tap on it changes block, its ⋯
 * manages it —, the athlete is named on the line under it, the athlete's other
 * pages (messages, sessions, goals, stats) are links under the title, and the
 * whole block follows. It used to be a page of three collapsible sections
 * (Programming, Goals, Stats) with the block picker and its phases nested
 * inside the first: five levels between the athlete and a session, three now.
 *
 * `CoachHome` hands down the athlete, their name and the frame of the title
 * (the way back to the roster, the account menu) through the outlet.
 */
export default function StudentOverview() {
  const { student, athleteName = '', titleProps } = useOutletContext();
  const studentId = student.id;

  const { t, lang } = useI18n();
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
  const selectedBlock = list.find((p) => p.id === selectedProgramId) ?? null;

  // While no block can stand in the title — the list is on its way, could not
  // be read, or is empty — the title is the athlete.
  const athleteTitle = <LargeTitle {...titleProps} title={athleteName} />;
  const page = (header, body) => (
    <div className="flex flex-col gap-6">
      {header}
      <AthleteLinks student={student} name={athleteName} />
      {body}
    </div>
  );

  // The list of blocks got no answer: nothing is known, not even whether
  // there is a block. It used to be a spinner for ever.
  const listState = programs ? 'ready' : readState([programsRead], { online, restoring });
  if (listState === 'offline' || listState === 'failed') {
    return page(
      athleteTitle,
      <div className="rounded-group bg-surface p-4">
        <CoachReadProblem
          compact
          state={listState}
          onRetry={() => programsRead.refetch({ cancelRefetch: false })}
          retrying={programsRead.isFetching}
        />
      </div>,
    );
  }

  // No auto-seed: merely opening an athlete must not INSERT a program row.
  // The coach creates the first block explicitly.
  if (isSuccess && !hasPrograms) {
    return page(
      athleteTitle,
      <div className="flex flex-col items-start gap-3 rounded-group bg-surface p-4">
        <p className="pk-body">{t('parcProgram.noBlock')}</p>
        <Button
          variant="primary"
          onClick={() => ensureProgram.mutate({ studentId })}
          disabled={ensureProgram.isPending}
        >
          {t('parcProgram.createFirst')}
        </Button>
      </div>,
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

  const header = hasPrograms ? (
    <ProgramSwitcher
      key={studentId}
      studentId={studentId}
      programs={list}
      selectedId={selectedProgramId}
      onSelect={handleSelectProgram}
      onProgramDeleted={handleProgramDeleted}
      athleteName={athleteName}
      titleProps={titleProps}
      subtitle={
        selectedBlock
          ? blockSubtitle({ name: athleteName, block: selectedBlock, program: selectedProgram, t, lang })
          : athleteName
      }
    />
  ) : athleteTitle;

  return page(
    header,
    programState === 'ready' ? (
      <div className="flex flex-col gap-4">
        {/* An athlete's draft is theirs until the coach approves it (review
            item P53): the editor opens its sessions read-only, and this says
            why and where the approval is. */}
        {selectedProgram.status === 'draft' && (
          <p role="note" className="rounded-group bg-blue-soft p-4 pk-body">
            {t('coachEditorNavErrors.draft.sheet')}
          </p>
        )}
        <ProgramSheet key={selectedProgram.id} studentId={studentId} program={selectedProgram} />
      </div>
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
    ),
  );
}
