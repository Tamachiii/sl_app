import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { useI18n } from '../../hooks/useI18n';
import { compareSessions } from '../../lib/day';
import { planSessionDrag } from '../../lib/sessionMove';
import SessionRow, { SortableSessionRow } from './SessionRow';
import PhaseDivider, { SortablePhaseDivider } from './PhaseDivider';
import CopyDialog from '../ui/CopyDialog';
import ConfirmDialog from '../ui/ConfirmDialog';
import EmptyState from '../ui/EmptyState';

function activeSessions(week) {
  return (week.sessions || []).filter((s) => !s.archived_at).sort(compareSessions);
}

/**
 * The Programming tab's body: the whole training block as ONE continuous,
 * reorderable list.
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
  const { t } = useI18n();
  const navigate = useNavigate();
  const createWeek = useCreateWeek();
  const updateWeek = useUpdateWeek();
  const deleteWeek = useDeleteWeek();
  const duplicateWeek = useDuplicateWeek();
  const createSession = useCreateSession();
  const updateSession = useUpdateSession();
  const duplicateSession = useDuplicateSession();
  const reorderWeeks = useReorderWeeks();
  const reorderSessions = useReorderSessions();
  const moveSession = useMoveSession();
  const archiveSession = useArchiveSession();
  const archiveSessions = useArchiveSessions();
  const copySessions = useCopySessions();
  const { data: confirmedIds } = useProgramConfirmedSessionIds(program.id);

  const weeks = useMemo(() => program.weeks || [], [program.weeks]);

  const [reorderingPhases, setReorderingPhases] = useState(false);
  const [reorderingSessions, setReorderingSessions] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [showCopySelection, setShowCopySelection] = useState(false);
  const [copyPhaseId, setCopyPhaseId] = useState(null);
  const [deletePhaseId, setDeletePhaseId] = useState(null);

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
      title: t('coach.week.sessionN', { n: model.total + 1 }),
      // No recommended weekday by default: a weekday is advice now, and
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
            title: t('coach.week.sessionN', { n: 1 }),
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

  return (
    <div className="space-y-2">
      {(reorderingPhases || reorderingSessions) && (
        <div className="flex items-center justify-between gap-2">
          <span className="sl-mono text-[11px] text-ink-400">
            {reorderingSessions && phaseCount > 1
              ? t('coach.sheet.reorderSessionsHint')
              : t('coach.sheet.reorderHint')}
          </span>
          <button
            type="button"
            onClick={() => { setReorderingPhases(false); setReorderingSessions(false); }}
            className="sl-pill shrink-0"
            style={{ background: 'var(--color-accent)', color: 'var(--color-ink-900)' }}
          >
            {t('common.done')}
          </button>
        </div>
      )}

      {phaseCount === 0 ? (
        <>
          <EmptyState message={t('coach.sheet.noSessionsYet')} />
          <button
            type="button"
            onClick={handleAddFirstSession}
            disabled={createWeek.isPending || createSession.isPending}
            className="w-full border border-dashed border-ink-200 text-ink-400 rounded-xl py-3 sl-mono text-[11px] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors"
          >
            {t('coach.week.addSession')}
          </button>
        </>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <div className="sl-card overflow-hidden">
            {reorderingPhases ? (
              <SortableContext items={weeks.map((w) => w.id)} strategy={verticalListSortingStrategy}>
                {model.phases.map(({ week, sessions }) => (
                  <SortablePhaseDivider
                    key={week.id}
                    week={week}
                    sessionCount={sessions.length}
                    t={t}
                  />
                ))}
              </SortableContext>
            ) : (
              <SortableContext
                items={model.phases.flatMap((p) => p.sessions.map((s) => s.id))}
                strategy={verticalListSortingStrategy}
              >
                {model.phases.map(({ week, sessions, positions, exCount }) => (
                  <div key={week.id}>
                    {/* Rendered even for a lone unnamed phase: it is where the
                        name is set, and keeping it makes a one-phase block the
                        same shape as a six-phase one. */}
                    <PhaseDivider
                      week={week}
                      sessionCount={sessions.length}
                      exCount={exCount}
                      quiet={phaseCount === 1}
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
                      t={t}
                    />

                    {sessions.length === 0 && (
                      <p className="sl-mono text-[11px] text-ink-400 px-3 py-3 border-t border-ink-100">
                        {t('coach.week.noSessions')}
                      </p>
                    )}

                    {sessions.map((s, i) =>
                      reorderingSessions ? (
                        <SortableSessionRow key={s.id} session={s} position={positions[i]} t={t} />
                      ) : (
                        <SessionRow
                          key={s.id}
                          session={s}
                          studentId={studentId}
                          confirmed={confirmedIds?.has(s.id)}
                          position={positions[i]}
                          onSetDay={(day) => updateSession.mutate({ id: s.id, day_number: day })}
                          onDuplicate={() => duplicateSession.mutate({ sessionId: s.id })}
                          duplicating={duplicateSession.isPending}
                          selecting={selecting}
                          selected={selectedIds.has(s.id)}
                          onToggleSelect={() => toggleSelected(s.id)}
                          t={t}
                        />
                      ),
                    )}
                  </div>
                ))}
              </SortableContext>
            )}

            {/* One drawer for the whole block rather than one per phase: an
                archived session is out of the plan, and which phase it used to
                sit in is not what the coach is looking for when restoring it. */}
            {model.archived.length > 0 && idle && (
              <div className="border-t border-ink-100">
                <button
                  type="button"
                  onClick={() => setShowArchived((v) => !v)}
                  className="w-full text-ink-400 py-2 sl-mono text-[10px] hover:text-ink-700 underline"
                >
                  {showArchived
                    ? t('coach.week.hideArchived', { n: model.archived.length })
                    : t('coach.week.showArchived', { n: model.archived.length })}
                </button>
                {showArchived && model.archived.map((s, i) => (
                  <div
                    key={s.id}
                    className="flex items-center gap-2 border-t border-ink-100 opacity-75 hover:opacity-100"
                  >
                    <button
                      type="button"
                      onClick={() => navigate(`/coach/student/${studentId}/session/${s.id}/review`)}
                      aria-label={t('coach.week.openArchivedSession')}
                      className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 text-left"
                    >
                      <span className="sl-display text-[13px] text-ink-600 flex-1 truncate">
                        {s.title || t('coach.week.sessionN', { n: i + 1 })}
                      </span>
                      <span
                        className="sl-pill text-ink-900 shrink-0"
                        style={{ background: 'color-mix(in srgb, var(--color-warn) 18%, transparent)' }}
                      >
                        {t('common.archived')}
                      </span>
                    </button>
                    {/* Restoring used to mean opening the session's review page —
                        a full-page route whose back button lands on an unrelated
                        feed, so it was a one-way trip out of Programming. */}
                    <button
                      type="button"
                      onClick={() => archiveSession.mutate({ sessionId: s.id, archived: false })}
                      disabled={archiveSession.isPending}
                      aria-label={t('coach.sheet.unarchiveSession')}
                      title={t('coach.sheet.unarchiveSession')}
                      className="shrink-0 px-3 py-2 sl-mono text-[10px] text-ink-400 hover:text-[var(--color-accent)] transition-colors"
                    >
                      {t('coach.sheet.unarchive')}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* One footer for the block. Selection and reorder now span every
                phase, so archiving or resequencing a whole mesocycle is one
                gesture instead of one per week card. */}
            {selecting ? (
              <div className="flex items-center gap-2 px-3 py-2 border-t border-ink-100 bg-ink-50">
                <span className="sl-mono text-[11px] text-ink-400 flex-1">
                  {t('coach.sheet.nSelected', { n: selectedIds.size })}
                </span>
                <button
                  type="button"
                  disabled={selectedIds.size === 0 || archiveSessions.isPending}
                  onClick={() =>
                    archiveSessions.mutate(
                      { sessionIds: [...selectedIds], archived: true },
                      { onSuccess: exitSelect },
                    )
                  }
                  className="sl-mono text-[11px] text-ink-700 hover:text-[var(--color-accent)] disabled:opacity-40 transition-colors"
                >
                  {t('coach.sheet.archiveSelected')}
                </button>
                <button
                  type="button"
                  disabled={selectedIds.size === 0}
                  onClick={() => setShowCopySelection(true)}
                  className="sl-mono text-[11px] text-ink-700 hover:text-[var(--color-accent)] disabled:opacity-40 transition-colors"
                >
                  {t('coach.week.copyTo')}
                </button>
                <button
                  type="button"
                  onClick={exitSelect}
                  aria-label={t('common.cancel')}
                  className="sl-mono text-[13px] text-ink-400 hover:text-gray-900 px-1 transition-colors"
                >
                  &times;
                </button>
              </div>
            ) : idle && (
              /* Both reorder modes hide this bar: the banner above already
                 carries the only way out, and two buttons reading "Done" on one
                 screen is one too many to aim at. */
              <div className="flex items-stretch border-t border-ink-100">
                <button
                  type="button"
                  onClick={() => addSessionTo(weeks[weeks.length - 1])}
                  disabled={createSession.isPending}
                  className="flex-1 text-ink-400 py-2.5 sl-mono text-[11px] hover:text-[var(--color-accent)] transition-colors"
                >
                  {t('coach.week.addSession')}
                </button>
                {model.total > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelecting(true)}
                    className="px-4 py-2.5 sl-mono text-[11px] text-ink-400 border-l border-ink-100 hover:text-[var(--color-accent)] transition-colors"
                  >
                    {t('coach.sheet.select')}
                  </button>
                )}
                {model.total > 1 && (
                  <button
                    type="button"
                    onClick={() => setReorderingSessions(true)}
                    className="px-4 py-2.5 sl-mono text-[11px] text-ink-400 border-l border-ink-100 hover:text-[var(--color-accent)] transition-colors"
                  >
                    {t('coach.sheet.reorderSessions')}
                  </button>
                )}
              </div>
            )}
          </div>
        </DndContext>
      )}

      {/* Opting into phases stays available but never headline: most blocks are
          a single run of sessions and never need a divider at all. */}
      {phaseCount > 0 && idle && (
        <button
          type="button"
          onClick={handleAddPhase}
          disabled={createWeek.isPending}
          className="w-full text-ink-400 py-2 sl-mono text-[11px] hover:text-[var(--color-accent)] transition-colors"
        >
          {t('coach.sheet.addPhase')}
        </button>
      )}

      <CopyDialog
        open={showCopySelection}
        onClose={() => setShowCopySelection(false)}
        title={t('coach.sheet.copySessionsTitle')}
        description={t('coach.sheet.copySessionsDescription', { n: selectedIds.size })}
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
        title={t('coach.sheet.copyPhaseTitle')}
        description={t('coach.week.copyDescription')}
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

      <ConfirmDialog
        open={!!deletingPhase}
        onClose={() => setDeletePhaseId(null)}
        title={t('coach.sheet.deletePhaseTitle')}
        message={
          deletingPhase?.label
            ? t('coach.sheet.deletePhaseNamed', { name: deletingPhase.label })
            : t('coach.sheet.deletePhaseMessage')
        }
        onConfirm={() => {
          if (deletingPhase) deleteWeek.mutate(deletingPhase.id);
          setDeletePhaseId(null);
        }}
      />
    </div>
  );
}
