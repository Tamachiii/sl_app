import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useIsRestoring } from '@tanstack/react-query';
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
  useSession,
  useAddSlot,
  useUpdateSlot,
  useDeleteSlot,
  useUpdateSetTarget,
  useResetSlotToUniform,
  useRemoveSet,
} from '../../hooks/useSession';
import { useUpdateSession, useDeleteSession } from '../../hooks/useWeek';
import { useSessionConfirmation } from '../../hooks/useSessionConfirmation';
import { useExerciseLibrary } from '../../hooks/useExerciseLibrary';
import { groupSlotsBySuperset } from '../../lib/volume';
import { isLoggedSet } from '../../lib/loggedSets';
import ExerciseSlotRow from './ExerciseSlotRow';
import PreviousSessionPanel from './PreviousSessionPanel';
import Spinner from '../ui/Spinner';
import EditableText from '../ui/EditableText';
import ConfirmDialog from '../ui/ConfirmDialog';
import { useI18n } from '../../hooks/useI18n';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useForgetCoachStudentsPath } from '../../hooks/useRememberCoachStudentsPath';
import { readState } from '../../lib/readState';
import { CoachNotFound, CoachReadProblem } from './CoachPageState';

export default function SessionEditor() {
  const { sessionId, studentId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useI18n();
  const sessionRead = useSession(sessionId);
  const session = sessionRead.data;
  const online = useOnlineStatus();
  const restoring = useIsRestoring();
  const { data: confirmation } = useSessionConfirmation(sessionId);
  const { data: library } = useExerciseLibrary();
  const addSlot = useAddSlot();
  const updateSlot = useUpdateSlot();
  const deleteSlot = useDeleteSlot();
  const updateSetTarget = useUpdateSetTarget();
  const resetSlotToUniform = useResetSlotToUniform();
  const removeSet = useRemoveSet();
  const updateSession = useUpdateSession();
  const deleteSession = useDeleteSession();

  const [showAdd, setShowAdd] = useState(false);
  const [selectedExercise, setSelectedExercise] = useState('');
  const [addUnit, setAddUnit] = useState('reps');
  const [pairAsSuperset, setPairAsSuperset] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Memoised so the `|| []` fallback is not a new array on every render —
  // it feeds the two memos below.
  const slots = useMemo(() => session?.exercise_slots || [], [session?.exercise_slots]);
  const slotGroups = useMemo(() => groupSlotsBySuperset(slots), [slots]);

  // What the athlete has already done decides how much of this page still
  // writes.
  //
  // CONFIRMED — the athlete called the session finished. It is history now, so
  // the whole editor is read-only. `performed_at` is the confirmation's mirror
  // on the session row itself: it arrives with the session, so the lock does
  // not wait for (or depend on) the confirmation query.
  //
  // LOGGED SETS, NOT CONFIRMED — a session in progress, or one the athlete
  // stopped half-way. Its logged sets are locked (ExerciseSlotRow, and the
  // hooks refuse them); the rest stays editable, because re-planning what is
  // left of a session is exactly what the coach opens it for.
  //
  // Either way the banner says so and links to the review, which is where a
  // trained session is read.
  //
  // A DRAFT the athlete is writing is theirs until the coach approves it
  // (review item P53): read-only as a whole too, with its own banner. The
  // approval is in the program menu of the sheet. A session cached by an
  // older build has no `program_status`, and is read as it was.
  const confirmed = !!confirmation || !!session?.performed_at;
  const isDraft = session?.program_status === 'draft';
  const hasLoggedSets = useMemo(
    () => slots.some((slot) => (slot.set_logs || []).some(isLoggedSet)),
    [slots],
  );
  const readOnly = confirmed || isDraft;
  const trained = confirmed || hasLoggedSets;
  const editorPath = `/coach/students/${studentId}/s/${sessionId}`;
  const reviewPath = `/coach/student/${studentId}/session/${sessionId}/review`;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // What the page has to show. `null` is the database's answer that there is
  // no such session — deleted, or not this coach's — and it is said as that,
  // with the way back. A read that got no answer is not an empty session:
  // rendered as one, it was an editor with a live "+ Add exercise" and a
  // "Delete this session" bound to nothing (review item P49).
  const notFound = sessionRead.isSuccess && session == null;
  const pageState = session
    ? 'ready'
    : notFound
      ? 'notFound'
      : readState([sessionRead], { online, restoring });
  // The Athletes tab must not come back to a session that is not there.
  useForgetCoachStudentsPath(notFound);

  // The athlete's page, on the block this session is in. The page shows the
  // active block unless `?program=` names another, so a session of a block
  // being prepared — or of a past one — goes back with its block named: the
  // coach writing next month's block was sent back to this month's after
  // every edit (review item P46). The block comes from the session row; while
  // there is none, from this page's own `?program=`. A session cached by an
  // older build has no `program_id`: the active block, as before.
  const blockId = session
    ? (session.program_is_active === false && session.program_id) || null
    : searchParams.get('program');
  const athletePath = blockId
    ? `/coach/students/${studentId}?program=${encodeURIComponent(blockId)}`
    : `/coach/students/${studentId}`;
  // An explicit destination, never history.back() (a deep link has nothing
  // behind it), and in place of the editor's entry: the system's back from
  // the athlete's page must not open the editor again.
  const leaveEditor = () => navigate(athletePath, { replace: true });

  if (pageState === 'loading') {
    return <div className="flex justify-center py-12"><Spinner /></div>;
  }
  if (pageState === 'notFound') {
    return (
      <CoachNotFound
        title={t('coachEditorNavErrors.session.notFoundTitle')}
        body={t('coachEditorNavErrors.session.notFoundBody')}
        to={athletePath}
        replace
        linkLabel={t('coachEditorNavErrors.session.backToAthlete')}
      />
    );
  }
  if (pageState !== 'ready') {
    return (
      <CoachReadProblem
        state={pageState}
        onRetry={() => sessionRead.refetch({ cancelRefetch: false })}
        retrying={sessionRead.isFetching}
      />
    );
  }

  function handleAddExercise() {
    if (!selectedExercise) return;
    let supersetGroup;
    if (pairAsSuperset && slots.length > 0) {
      const prev = slots[slots.length - 1];
      supersetGroup = prev.superset_group || crypto.randomUUID();
      if (!prev.superset_group) {
        updateSlot.mutate({ id: prev.id, sessionId, superset_group: supersetGroup });
      }
    }
    // Use max(sort_order) + 1 — NOT slots.length — so the new slot lands strictly
    // after every existing one, even when prior deletions have left gaps in
    // sort_order. `slots.length` collides with existing values after any gap,
    // which breaks superset ordering (the new child can render before its parent).
    const nextSortOrder = slots.length > 0
      ? Math.max(...slots.map((s) => s.sort_order ?? 0)) + 1
      : 0;
    addSlot.mutate({
      sessionId,
      exerciseId: selectedExercise,
      sets: 3,
      ...(addUnit === 'seconds' ? { durationSeconds: 30 } : { reps: 10 }),
      sortOrder: nextSortOrder,
      supersetGroup,
    });
    setSelectedExercise('');
    setAddUnit('reps');
    setPairAsSuperset(false);
    setShowAdd(false);
  }

  function handleUnlinkSuperset(groupId) {
    for (const slot of slots) {
      if (slot.superset_group === groupId) {
        updateSlot.mutate({ id: slot.id, sessionId, superset_group: null });
      }
    }
  }

  async function handleDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = slots.findIndex((s) => s.id === active.id);
    const newIdx = slots.findIndex((s) => s.id === over.id);
    if (oldIdx === -1 || newIdx === -1) return;
    // Renumber 0..n-1 so the write is safe even if legacy data has tied
    // sort_orders. No UNIQUE(session_id, sort_order) index → parallel updates
    // are fine.
    const reordered = arrayMove(slots, oldIdx, newIdx);
    await Promise.all(
      reordered
        .map((slot, i) =>
          slot.sort_order === i
            ? null
            : updateSlot.mutateAsync({ id: slot.id, sessionId, sort_order: i })
        )
        .filter(Boolean)
    );
  }

  const inputCls =
    'w-full rounded-lg border border-ink-200 bg-white px-3 py-2 sl-mono text-[16px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]';

  // No page padding: this renders inside the athlete shell (CoachHome already
  // applies p-4 pb-6 md:p-8), under the athlete header and tab strip. The
  // header below is a breadcrumb back to the sheet, not a page header.
  return (
    <div className="space-y-4">
      {/* One row, everything on the same baseline: back, the session name, the
          recommended date. "Copy to…" and "Duplicate" used to sit here too, but
          the sheet carries both now — a duplicate button on every row and copy
          behind its selection bar — so they were a second door onto the same
          actions. The "SESSION" kicker went with them: the athlete header
          directly above already says where you are, and a label naming the kind
          of thing you are looking at costs a line to state the obvious. */}
      <div className="flex items-center gap-3">
        <button
          onClick={leaveEditor}
          aria-label={t('common.back')}
          className="w-9 h-9 rounded-lg bg-ink-100 flex items-center justify-center text-ink-700 hover:bg-ink-200 shrink-0"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex-1 min-w-0 sl-display text-[20px] text-gray-900 leading-tight">
          {readOnly ? (
            <span className="block truncate">
              {session?.title || t('coach.editor.titlePlaceholder')}
            </span>
          ) : (
            <EditableText
              value={session?.title || ''}
              onSave={(title) => updateSession.mutate({ id: sessionId, title })}
              placeholder={t('coach.editor.titlePlaceholder')}
              ariaLabel={t('coach.editor.editTitleAria')}
              // Hold the heading's own size while editing. Left alone the field
              // falls back to the 16px iOS-zoom floor, so tapping the title
              // shrank it — the same twitch the box's width used to cause.
              inputClassName="sl-display text-[20px]"
            />
          )}
        </div>
        <input
          id="session-date"
          type="date"
          aria-label={t('coach.editor.scheduled')}
          title={t('coach.editor.scheduled')}
          value={session?.scheduled_date || ''}
          onChange={(e) =>
            updateSession.mutate({ id: sessionId, scheduled_date: e.target.value || null })
          }
          disabled={readOnly}
          className="shrink-0 rounded-lg border border-ink-200 bg-white px-2 py-1.5 sl-mono text-[16px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-60 disabled:cursor-not-allowed"
        />
      </div>

      {isDraft && (
        <div
          role="note"
          className="rounded-xl p-3 text-[13px] text-ink-900"
          style={{
            background: 'color-mix(in srgb, var(--color-accent) 10%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)',
          }}
        >
          {t('coachEditorNavErrors.draft.editor')}
        </div>
      )}

      {trained && (
        <div
          role="note"
          className="rounded-xl p-3 flex flex-wrap items-center gap-x-3 gap-y-2"
          style={{
            background: 'color-mix(in srgb, var(--color-warn) 12%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-warn) 35%, transparent)',
          }}
        >
          <p className="flex-1 min-w-[12rem] text-[13px] text-ink-900">
            {confirmed
              ? t('coachLoggedHistory.editor.confirmedBanner')
              : t('coachLoggedHistory.editor.loggedBanner')}
          </p>
          {/* `from` is how the review's back button returns here instead of
              to the sessions feed. */}
          <Link
            to={reviewPath}
            state={{ from: editorPath }}
            className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200 shrink-0"
          >
            {t('coachLoggedHistory.editor.openReview')}
          </Link>
        </div>
      )}

      {/* What the athlete last ACTUALLY lifted for each of these exercises —
          the numbers progressive overload is written against, in place, without
          a round trip that loses the editor. `studentId` is the students-table
          id from the route, which is what scopes the read to this athlete. */}
      <PreviousSessionPanel
        studentRowId={studentId}
        sessionId={sessionId}
        slots={slots}
      />

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={slots.map((s) => s.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-3">
            {slotGroups.map((group) => {
              const renderRow = (slot) => (
                <ExerciseSlotRow
                  key={slot.id}
                  slot={slot}
                  onUpdate={(updates) => updateSlot.mutate({ id: slot.id, sessionId, ...updates })}
                  onDelete={() => deleteSlot.mutate({ id: slot.id, sessionId })}
                  onUpdateSet={(logId, updates) =>
                    updateSetTarget.mutate({ logId, sessionId, ...updates })
                  }
                  onResetToUniform={() =>
                    resetSlotToUniform.mutate({ slotId: slot.id, sessionId })
                  }
                  onAddSet={() =>
                    updateSlot.mutate({ id: slot.id, sessionId, sets: (slot.sets || 0) + 1 })
                  }
                  onRemoveSet={(setNumber) =>
                    removeSet.mutate({ slotId: slot.id, setNumber, sessionId })
                  }
                  readOnly={readOnly}
                />
              );
              if (group.slots.length > 1) {
                return (
                  <div
                    key={group.key}
                    className="rounded-xl border p-2 space-y-2"
                    style={{
                      borderColor: 'color-mix(in srgb, var(--color-accent) 35%, transparent)',
                      background: 'color-mix(in srgb, var(--color-accent) 6%, transparent)',
                    }}
                  >
                    <div className="flex items-center justify-between px-2 pt-1">
                      <span className="sl-label" style={{ color: 'var(--color-accent)' }}>
                        {t('coach.editor.superset')}
                      </span>
                      {!readOnly && (
                        <button
                          onClick={() => handleUnlinkSuperset(group.key)}
                          className="sl-mono text-[11px] text-ink-400 hover:text-danger underline"
                        >
                          {t('coach.editor.unlink')}
                        </button>
                      )}
                    </div>
                    {group.slots.map(renderRow)}
                  </div>
                );
              }
              return renderRow(group.slots[0]);
            })}
          </div>
        </SortableContext>
      </DndContext>

      {readOnly ? null : showAdd ? (
        <div className="sl-card p-4 space-y-3">
          <select
            value={selectedExercise}
            onChange={(e) => setSelectedExercise(e.target.value)}
            className={inputCls}
          >
            <option value="">{t('coach.editor.selectExercise')}</option>
            {(library || []).map((ex) => (
              <option key={ex.id} value={ex.id}>
                {t('coach.editor.exerciseOption', {
                  name: ex.name,
                  type: ex.type,
                  difficulty: ex.difficulty,
                })}
              </option>
            ))}
          </select>
          <fieldset className="flex gap-4 sl-mono text-[12px] text-ink-600">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="add-unit"
                value="reps"
                checked={addUnit === 'reps'}
                onChange={(e) => setAddUnit(e.target.value)}
              />
              {t('coach.editor.unitReps')}
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="add-unit"
                value="seconds"
                checked={addUnit === 'seconds'}
                onChange={(e) => setAddUnit(e.target.value)}
              />
              {t('coach.editor.unitSeconds')}
            </label>
          </fieldset>
          {slots.length > 0 && (
            <label className="flex items-center gap-2 sl-mono text-[12px] text-ink-600">
              <input
                type="checkbox"
                checked={pairAsSuperset}
                onChange={(e) => setPairAsSuperset(e.target.checked)}
              />
              {t('coach.editor.pairSuperset')}
            </label>
          )}
          <div className="flex gap-2">
            <button
              onClick={handleAddExercise}
              disabled={!selectedExercise || addSlot.isPending}
              className="flex-1 sl-btn-primary text-[13px] disabled:opacity-50"
              style={{ padding: '10px 16px' }}
            >
              {t('coach.editor.add')}
            </button>
            <button
              onClick={() => setShowAdd(false)}
              className="flex-1 bg-ink-100 text-ink-700 rounded-lg py-2 sl-display text-[13px] hover:bg-ink-200"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="w-full border border-dashed border-ink-200 text-ink-400 rounded-xl py-3 sl-mono text-[12px] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors"
        >
          {t('coach.editor.addExercise')}
        </button>
      )}

      {/* Deleting still lives in the editor, not on the sheet: by this point
          the coach has opened this one session, so it can't be a stray thumb
          on a list. But it sits at the BOTTOM now — a red button pinned beside
          the title was the most prominent thing on a screen whose job is
          writing exercises, and it is the rarest action here. Archiving from
          the sheet is the everyday way to clear a session; this is the escape
          hatch for one created by mistake.

          Not offered at all once the session is trained: the database refuses
          to delete a session that carries logged sets, so the button could
          only ever answer "archive it instead". Nor on an athlete's draft,
          which is read-only. */}
      {!trained && !isDraft && (
        <div className="pt-2 flex justify-end">
          <button
            onClick={() => setConfirmDelete(true)}
            disabled={deleteSession.isPending}
            className="sl-mono text-[11px] text-ink-400 hover:text-danger disabled:opacity-50 py-2 px-1 transition-colors"
          >
            {t('coach.editor.deleteSession')}
          </button>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t('coach.week.deleteSessionTitle')}
        message={t('coach.week.deleteSessionMessage')}
        onConfirm={() =>
          deleteSession.mutate(sessionId, {
            // The editor's own subject is gone — return to the sheet rather
            // than leaving a page bound to a deleted row.
            onSuccess: leaveEditor,
          })
        }
      />
    </div>
  );
}
