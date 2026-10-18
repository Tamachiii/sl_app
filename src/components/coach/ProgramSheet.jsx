import { useId, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from '@dnd-kit/sortable';
import {
  useCreateWeek,
  useReorderWeeks,
  useUpdateWeek,
  useDeleteWeek,
  useCreateSession,
  useUpdateSession,
  useReorderSessions,
  useMoveSession,
  useArchiveSession,
  useArchiveSessions,
} from '../../hooks/useWeek';
import { useDuplicateWeek, useDuplicateSession, useCopySessions } from '../../hooks/useDuplicate';
import { useProgramConfirmedSessionIds } from '../../hooks/useSessionConfirmation';
import { useProgramLoggedSessionIds } from '../../hooks/useSession';
import { useI18n } from '../../hooks/useI18n';
import { compareSessions } from '../../lib/day';
import { planSessionDrag } from '../../lib/sessionMove';
import { formatNumber, pluralKey } from '../../lib/i18n/format';
import SessionRow, { SortableSessionRow } from './SessionRow';
import PhaseDivider, { SortablePhaseDivider, phaseRangeText } from './PhaseDivider';
import CopyDialog from '../ui/CopyDialog';
import { ActionBar, Button, ConfirmSheet, Icon, ListGroup, Row } from '../parc';

function activeSessions(week) {
  return (week.sessions || []).filter((s) => !s.archived_at).sort(compareSessions);
}

// The sessions a phase opens with that are all done: shown as one row that
// opens them (design/parc/screens/Programme.dc.html, « Séances 1 à 6, toutes
// faites »), from two on. What is left to train comes first to the eye.
const DONE_RUN_MIN = 2;

/**
 * The Programming tab's body: the whole training block as ONE continuous,
 * reorderable list (design/parc/screens/Programme.dc.html): a section per
 * phase — its name, the places its sessions hold — and a row per session.
 *
 * It used to be a stack of week cards with one expanded at a time, plus a
 * separate flat layout when a block had a single week — so the surface changed
 * shape underneath the coach as they added a second week, and the block's most
 * important property (the order the athlete will train in) was only visible one
 * week at a time. Weeks are now PHASES: a named divider inside the list, no
 * number, optional. Flat and multi-phase are the same layout.
 *
 * The accordion is gone rather than ported. Measured against production, the
 * largest block is 19 sessions and the average is 8 — a list that fits in one
 * screen's worth of scrolling, where collapsing costs a tap and hides the very
 * thing the page exists to show.
 */
export default function ProgramSheet({ studentId, program }) {
  const ctx = useI18n();
  const { t, lang } = ctx;
  const navigate = useNavigate();
  const location = useLocation();
  const createWeek = useCreateWeek();
  const updateWeek = useUpdateWeek();
  const deleteWeek = useDeleteWeek();
  const duplicateWeek = useDuplicateWeek();
  const createSession = useCreateSession();
  const updateSession = useUpdateSession();
  const duplicateSession = useDuplicateSession();
  // The three writes a drag can end in. Each takes the block so that they
  // share one queue: two drags reach the database in the order they were made.
  // A sheet shows ONE block for as long as it is mounted — its parent gives it
  // `key={program.id}` — because a hook whose block changed under it would
  // lose the write it has waiting (`blockOrderScope` in hooks/useWeek).
  const reorderWeeks = useReorderWeeks(program.id);
  const reorderSessions = useReorderSessions(program.id);
  const moveSession = useMoveSession(program.id);
  const archiveSession = useArchiveSession();
  const archiveSessions = useArchiveSessions();
  const copySessions = useCopySessions();
  const { data: confirmedIds } = useProgramConfirmedSessionIds(program.id);
  // Started but not confirmed — see SessionRow for what the two decide.
  const { data: loggedIds } = useProgramLoggedSessionIds(program.id);

  const weeks = useMemo(() => program.weeks || [], [program.weeks]);
  // An athlete's draft is theirs until the coach approves it (review item
  // P53): the sheet shows it and offers no write — no day, no duplicate, no
  // session or phase added, no rename, no menu, no select, no reorder, no
  // restore. A row still opens its session, in the editor's read-only state.
  // Migration 20 refuses those writes in the database too (`draft_read_only`);
  // before it, a coach's write was replaced by the athlete's next save.
  const readOnly = program.status === 'draft';

  const [reorderingPhases, setReorderingPhases] = useState(false);
  const [reorderingSessions, setReorderingSessions] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [showCopySelection, setShowCopySelection] = useState(false);
  const [copyPhaseId, setCopyPhaseId] = useState(null);
  const [deletePhaseId, setDeletePhaseId] = useState(null);
  // The phases whose run of done sessions the coach opened.
  const [openRuns, setOpenRuns] = useState(() => new Set());

  // One pass builds everything the list renders, including a position that runs
  // ACROSS phases: with a single list that is the number the coach reads, and
  // it is what an untitled session is named after.
  const model = useMemo(() => {
    let n = 0;
    const phases = weeks.map((week) => {
      const sessions = activeSessions(week);
      return {
        week,
        sessions,
        positions: sessions.map(() => ++n),
        exCount: sessions.reduce((sum, s) => sum + (s.exercise_slots || []).length, 0),
      };
    });
    const archived = weeks
      .flatMap((w) => (w.sessions || []).filter((s) => s.archived_at))
      .sort(compareSessions);
    return { phases, archived, total: n };
  }, [weeks]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function exitSelect() {
    setSelecting(false);
    setSelectedIds(new Set());
  }

  function toggleSelected(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function addSessionTo(week) {
    if (!week) return;
    const all = week.sessions || [];
    // max(sort_order)+1 across ALL sessions, archived included —
    // UNIQUE(week_id, sort_order) rejects a value an archived row still holds.
    const nextSortOrder = all.length > 0
      ? Math.max(...all.map((s) => s.sort_order ?? 0)) + 1
      : 0;
    createSession.mutate({
      weekId: week.id,
      // No title: an untitled session is named by its position in the block,
      // which follows it through every reorder and archive. "Session 7" written
      // into the title was true on the day it was added and on no other.
      // No recommended weekday by default either: a weekday is advice now, and
      // auto-assigning one made every session look due on a date nobody chose.
      dayNumber: null,
      sortOrder: nextSortOrder,
    });
  }

  function handleAddPhase() {
    const nextNum = weeks.length > 0 ? Math.max(...weeks.map((w) => w.week_number)) + 1 : 1;
    createWeek.mutate({ programId: program.id, weekNumber: nextNum });
  }

  // An empty block asks for a SESSION, not a phase: grouping is optional, so
  // the first phase is created implicitly and stays unnamed until the coach
  // decides otherwise. Chained because the session needs the new phase's id.
  function handleAddFirstSession() {
    createWeek.mutate(
      { programId: program.id, weekNumber: 1 },
      {
        onSuccess: (week) =>
          createSession.mutate({
            weekId: week.id,
            dayNumber: null,
            sortOrder: 0,
          }),
      },
    );
  }

  // One DndContext serves both sortable levels, so dispatch on the active mode:
  // phase dividers while reordering phases, session rows otherwise.
  function handleDragEnd({ active, over }) {
    if (!over || active.id === over.id) return;

    if (reorderingPhases) {
      const oldIdx = weeks.findIndex((w) => w.id === active.id);
      const newIdx = weeks.findIndex((w) => w.id === over.id);
      if (oldIdx === -1 || newIdx === -1) return;
      reorderWeeks.mutate({
        programId: program.id,
        orderedIds: arrayMove(weeks, oldIdx, newIdx).map((w) => w.id),
      });
      return;
    }

    const plan = planSessionDrag(weeks, active.id, over.id);
    if (!plan) return;
    if (plan.type === 'reorder') {
      // The FULL list of the phase, archived sessions at its end: the database
      // refuses a list that is not exactly the sessions of the phase.
      reorderSessions.mutate({ weekId: plan.weekId, orderedIds: plan.orderedIds });
    } else {
      // Crossing a divider re-homes the session AND renumbers both phases —
      // one RPC, because a half-applied move leaves a session in a phase whose
      // positions no longer make room for it.
      moveSession.mutate(plan);
    }
  }

  const phaseCount = weeks.length;
  const deletingPhase = weeks.find((w) => w.id === deletePhaseId) || null;
  const copyingPhase = weeks.find((w) => w.id === copyPhaseId) || null;
  const idle = !reorderingPhases && !reorderingSessions && !selecting;
  // `performed_at` is the confirmation mirrored on the session row: it comes
  // with the sheet's own query, so a confirmed row never opens the editor
  // while the confirmations are still loading.
  const isConfirmed = (s) => !!confirmedIds?.has(s.id) || !!s.performed_at;
  const n = (value) => formatNumber(lang, value);

  function renderRow(s, position) {
    if (reorderingSessions) {
      return (
        <SortableSessionRow
          key={s.id}
          session={s}
          position={position}
          confirmed={isConfirmed(s)}
          trained={!!loggedIds?.has(s.id)}
        />
      );
    }
    return (
      <SessionRow
        key={s.id}
        session={s}
        studentId={studentId}
        confirmed={isConfirmed(s)}
        trained={!!loggedIds?.has(s.id)}
        position={position}
        onSetDay={(day) => updateSession.mutate({ id: s.id, day_number: day })}
        onDuplicate={() => duplicateSession.mutate({
          sessionId: s.id,
          // The copy's title in the coach's language. An untitled session
          // gets no suffix, so its copy stays untitled and is named by its
          // position too: the function would write "Session (copy)", in
          // English and frozen.
          titleSuffix: s.title?.trim() ? ` ${t('coachSheetUx.copySuffix')}` : '',
        })}
        // Only the row being copied waits: one copy on its way used to grey
        // out the button of every row.
        duplicating={duplicateSession.isPending && duplicateSession.variables?.sessionId === s.id}
        selecting={selecting}
        selected={selectedIds.has(s.id)}
        onToggleSelect={() => toggleSelected(s.id)}
        readOnly={readOnly}
      />
    );
  }

  const selectedCount = selectedIds.size;
  const selectedLabel =
    selectedCount === 0
      ? t('parcProgram.selectedNone')
      : t(pluralKey(lang, selectedCount, 'parcProgram.selected'), { n: n(selectedCount) });

  return (
    <div className="flex flex-col gap-6">
      {(reorderingPhases || reorderingSessions || selecting) && (
        <div className="flex items-center justify-between gap-3">
          <p className="pk-caption">
            {selecting
              ? t('parcProgram.selectHint')
              : reorderingSessions && phaseCount > 1
                ? t('parcProgram.reorderSessionsHint')
                : t('parcProgram.reorderHint')}
          </p>
          <Button
            variant="on-ground"
            className="shrink-0"
            onClick={() => {
              setReorderingPhases(false);
              setReorderingSessions(false);
              exitSelect();
            }}
          >
            {t('parcProgram.finish')}
          </Button>
        </div>
      )}

      {phaseCount === 0 && readOnly ? (
        <p className="rounded-group bg-surface p-4 pk-body">{t('coachSheetUx.draftEmpty')}</p>
      ) : phaseCount === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-group bg-surface p-4">
          <p className="pk-body">{t('parcProgram.emptyBlock')}</p>
          <Button
            variant="primary"
            onClick={handleAddFirstSession}
            disabled={createWeek.isPending || createSession.isPending}
          >
            <Icon name="plus" size={18} />
            {t('parcProgram.addSession')}
          </Button>
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          {reorderingPhases ? (
            <SortableContext items={weeks.map((w) => w.id)} strategy={verticalListSortingStrategy}>
              <ul className="pk-group" aria-label={t('parcProgram.reorderPhases')}>
                {model.phases.map(({ week, sessions }) => (
                  <SortablePhaseDivider key={week.id} week={week} sessionCount={sessions.length} />
                ))}
              </ul>
            </SortableContext>
          ) : (
            <SortableContext
              items={model.phases.flatMap((p) => p.sessions.map((s) => s.id))}
              strategy={verticalListSortingStrategy}
            >
              {model.phases.map(({ week, sessions, positions }) => {
                // The run of done sessions the phase opens with, folded while
                // nothing is being chosen or moved.
                let run = 0;
                while (run < sessions.length && isConfirmed(sessions[run])) run += 1;
                const folded = idle && run >= DONE_RUN_MIN && !openRuns.has(week.id);
                const range = sessions.length > 0
                  ? { from: positions[0], to: positions[positions.length - 1] }
                  : null;
                return (
                  <PhaseSection key={week.id}>
                    {(titleId) => (
                      <>
                        <PhaseDivider
                          week={week}
                          titleId={titleId}
                          range={range}
                          canReorder={phaseCount > 1}
                          onRename={(label) => updateWeek.mutate({ id: week.id, label })}
                          onAddSession={() => addSessionTo(week)}
                          onDuplicate={() => duplicateWeek.mutate({ weekId: week.id })}
                          onCopy={() => setCopyPhaseId(week.id)}
                          onDelete={() => setDeletePhaseId(week.id)}
                          onReorder={() => {
                            exitSelect();
                            setReorderingSessions(false);
                            setReorderingPhases(true);
                          }}
                          readOnly={readOnly}
                        />
                        {sessions.length > 0 && (
                          <ul className="pk-group">
                            {folded ? (
                              <>
                                <li>
                                  <button
                                    type="button"
                                    aria-expanded={false}
                                    onClick={() => {
                                      setOpenRuns((prev) => new Set(prev).add(week.id));
                                      // The row that was pressed goes away: the
                                      // focus moves to the first session it held.
                                      const first = sessions[0].id;
                                      requestAnimationFrame(() =>
                                        document.querySelector(`[data-session-open="${first}"]`)?.focus(),
                                      );
                                    }}
                                    className="pk-row w-full bg-transparent text-left"
                                  >
                                    <span className="pk-set-dot pk-set-dot-done" aria-hidden="true">
                                      <Icon name="check" size={16} />
                                    </span>
                                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                      <span className="pk-headline">
                                        {phaseRangeText({ from: positions[0], to: positions[run - 1] }, ctx)}
                                      </span>
                                      <span className="pk-caption">
                                        <span className="sr-only">,</span> {t('parcProgram.allDone')}
                                      </span>
                                    </span>
                                    <Icon name="chevron-down" size={18} className="shrink-0 text-ink-2" />
                                  </button>
                                </li>
                                {sessions.slice(run).map((s, i) => renderRow(s, positions[run + i]))}
                              </>
                            ) : (
                              sessions.map((s, i) => renderRow(s, positions[i]))
                            )}
                          </ul>
                        )}
                      </>
                    )}
                  </PhaseSection>
                );
              })}
            </SortableContext>
          )}
        </DndContext>
      )}

      {/* One drawer for the whole block rather than one per phase: an
          archived session is out of the plan, and which phase it used to sit
          in is not what the coach is looking for when restoring it. */}
      {model.archived.length > 0 && idle && (
        <ListGroup title={t('parcProgram.archivedTitle')}>
          <Row
            onClick={() => setShowArchived((v) => !v)}
            aria-expanded={showArchived}
            chevron={showArchived ? 'chevron-up' : 'chevron-down'}
            title={t(pluralKey(lang, model.archived.length, 'parcSessions.archivedCount'), {
              n: n(model.archived.length),
            })}
          />
          {showArchived &&
            model.archived.map((s) => {
              // Not "Session n": an archived session has no place in the
              // block, and its place in this drawer is not one.
              const name = s.title || t('parcSessions.untitled');
              return (
                <li key={s.id} className="pk-row">
                  <button
                    type="button"
                    onClick={() =>
                      navigate(`/coach/student/${studentId}/session/${s.id}/review`, {
                        // So the review's back button returns here.
                        state: { from: location.pathname + location.search },
                      })
                    }
                    className="flex min-h-11 min-w-0 flex-1 items-center bg-transparent text-left"
                  >
                    <span className="pk-headline truncate text-ink-2">{name}</span>
                  </button>
                  {/* Restoring used to mean opening the session's review page —
                      a trip out of Programming for a one-tap action. */}
                  {!readOnly && (
                    <Button
                      variant="text"
                      onClick={() => archiveSession.mutate({ sessionId: s.id, archived: false })}
                      disabled={archiveSession.isPending}
                      aria-label={t('parcProgram.restoreSession', { name })}
                    >
                      {t('parcProgram.restore')}
                    </Button>
                  )}
                </li>
              );
            })}
        </ListGroup>
      )}

      {/* One set of actions for the block. Selection and reorder span every
          phase, so archiving or resequencing a whole mesocycle is one gesture
          instead of one per phase. Both reorder modes hide it: the bar above
          carries the only way out. */}
      {phaseCount > 0 && idle && !readOnly && (
        <div className="flex flex-wrap items-center gap-x-2">
          <Button
            variant="text"
            onClick={() => addSessionTo(weeks[weeks.length - 1])}
            disabled={createSession.isPending}
          >
            <Icon name="plus" size={18} />
            {t('parcProgram.addSession')}
          </Button>
          {/* Opting into phases stays available but never headline: most
              blocks are a single run of sessions. */}
          <Button variant="text" onClick={handleAddPhase} disabled={createWeek.isPending}>
            {t('parcProgram.addPhase')}
          </Button>
          {model.total > 0 && (
            <Button variant="text" onClick={() => setSelecting(true)}>
              {t('parcProgram.select')}
            </Button>
          )}
          {model.total > 1 && (
            <Button variant="text" onClick={() => setReorderingSessions(true)}>
              {t('parcProgram.reorder')}
            </Button>
          )}
        </div>
      )}

      {selecting && (
        <ActionBar className="sticky bottom-0 z-10 -mx-4 md:-mx-8">
          <p role="status" className="pk-caption min-w-0 flex-1">
            {selectedLabel}
          </p>
          <Button size="lg" disabled={selectedCount === 0} onClick={() => setShowCopySelection(true)}>
            {t('parcProgram.copySelected')}
          </Button>
          <Button
            variant="primary"
            size="lg"
            disabled={selectedCount === 0 || archiveSessions.isPending}
            onClick={() =>
              archiveSessions.mutate(
                { sessionIds: [...selectedIds], archived: true },
                { onSuccess: exitSelect },
              )
            }
          >
            {t('parcProgram.archiveSelected')}
          </Button>
        </ActionBar>
      )}

      <CopyDialog
        open={showCopySelection}
        onClose={() => setShowCopySelection(false)}
        title={t('parcProgram.copySessionsTitle')}
        description={t(pluralKey(lang, selectedCount, 'parcProgram.copySessions'), { n: n(selectedCount) })}
        currentStudentId={studentId}
        currentProgramId={program.id}
        showWeekSelect
        onCopy={({ weekId }) => {
          if (!weekId) return;
          copySessions.mutate(
            { sessionIds: [...selectedIds], weekId },
            {
              onSuccess: () => {
                setShowCopySelection(false);
                exitSelect();
              },
            },
          );
        }}
        isPending={copySessions.isPending}
      />

      <CopyDialog
        open={!!copyingPhase}
        onClose={() => setCopyPhaseId(null)}
        title={t('parcProgram.copyPhaseTitle')}
        description={t('parcProgram.copyPhaseDescription')}
        currentStudentId={studentId}
        currentProgramId={program.id}
        onCopy={({ programId }) => {
          if (!programId || !copyingPhase) return;
          duplicateWeek.mutate(
            { weekId: copyingPhase.id, programId },
            { onSuccess: () => setCopyPhaseId(null) },
          );
        }}
        isPending={duplicateWeek.isPending}
      />

      <ConfirmSheet
        open={!!deletingPhase}
        onClose={() => setDeletePhaseId(null)}
        title={
          deletingPhase?.label
            ? t('parcProgram.deletePhaseNamed', { name: deletingPhase.label })
            : t('parcProgram.deletePhaseTitle')
        }
        message={t('parcProgram.deletePhaseMessage')}
        confirmText={t('parcProgram.deletePhase')}
        onConfirm={() => {
          if (deletingPhase) deleteWeek.mutate(deletingPhase.id);
        }}
      />
    </div>
  );
}

// A phase of the sheet: a section named by its heading.
function PhaseSection({ children }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2.5">
      {children(titleId)}
    </section>
  );
}
