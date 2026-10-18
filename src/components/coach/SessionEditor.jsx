import { useId, useMemo, useState } from 'react';
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
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
} from '@dnd-kit/sortable';
import {
  useSession,
  useAddSlot,
  useUpdateSlot,
  useDeleteSlot,
  useUpdateSetTarget,
  useResetSlotToUniform,
  useRemoveSet,
  useReorderSlots,
} from '../../hooks/useSession';
import { useUpdateSession, useDeleteSession } from '../../hooks/useWeek';
import { useSessionConfirmation } from '../../hooks/useSessionConfirmation';
import { useExerciseLibrary, isActiveExercise } from '../../hooks/useExerciseLibrary';
import { groupSlotsBySuperset } from '../../lib/volume';
import { isLoggedSet } from '../../lib/loggedSets';
import { exerciseTypeLabel } from '../../lib/exerciseTypes';
import { formatNumber } from '../../lib/i18n/format';
import ExerciseSlotRow from './ExerciseSlotRow';
import PreviousSessionPanel from './PreviousSessionPanel';
import Spinner from '../ui/Spinner';
import EditableText from '../ui/EditableText';
import { Button, ConfirmSheet, Icon, IconButton, LargeTitle, SelectField, Sheet } from '../parc';
import { useI18n } from '../../hooks/useI18n';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useForgetCoachStudentsPath } from '../../hooks/useRememberCoachStudentsPath';
import { readState } from '../../lib/readState';
import { planSlotDrag } from '../../lib/slotOrder';
import { CoachNotFound, CoachReadProblem } from './CoachPageState';

// Where ExerciseSlotRow would be, for a slot whose exercise cannot be read.
function UnavailableExerciseCard({ t }) {
  return (
    <section className="rounded-group bg-surface p-4">
      <h2 className="pk-headline text-ink-2">{t('coachEditorNavErrors.exercise.unavailableTitle')}</h2>
      <p className="pk-caption mt-1">{t('coachEditorNavErrors.exercise.unavailableBody')}</p>
    </section>
  );
}

// One mount per session. The route `s/:sessionId` keeps this component
// mounted from one session to the next, and `useReorderSlots` runs under a
// scope named after the session, which must not change while the hook lives
// (see useReorderSlots).
export default function SessionEditor() {
  const { sessionId } = useParams();
  return <SessionEditorPage key={sessionId} />;
}

function SessionEditorPage() {
  const { sessionId, studentId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t, lang } = useI18n();
  // The athlete, from the page this editor stands in (CoachHome's outlet).
  const { student } = useOutletContext() || {};
  const titleHintId = useId();
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
  const reorderSlots = useReorderSlots(sessionId);
  const updateSession = useUpdateSession();
  const deleteSession = useDeleteSession();

  const [showAdd, setShowAdd] = useState(false);
  const [selectedExercise, setSelectedExercise] = useState('');
  const [addUnit, setAddUnit] = useState('reps');
  const [pairAsSuperset, setPairAsSuperset] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);

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

  const back = { label: t('parcEditor.back'), onClick: leaveEditor };
  if (pageState === 'loading') {
    return (
      <div className="flex flex-col gap-6">
        <LargeTitle back={back} title={t('parcEditor.untitled')} />
        <div className="flex justify-center py-12"><Spinner /></div>
      </div>
    );
  }
  if (pageState === 'notFound') {
    return (
      <div className="flex flex-col gap-6">
        <LargeTitle back={back} title={t('parcEditor.untitled')} />
        <CoachNotFound
          title={t('coachEditorNavErrors.session.notFoundTitle')}
          body={t('coachEditorNavErrors.session.notFoundBody')}
          to={athletePath}
          replace
          linkLabel={t('coachEditorNavErrors.session.backToAthlete')}
        />
      </div>
    );
  }
  if (pageState !== 'ready') {
    return (
      <div className="flex flex-col gap-6">
        <LargeTitle back={back} title={t('parcEditor.untitled')} />
        <CoachReadProblem
          state={pageState}
          onRetry={() => sessionRead.refetch({ cancelRefetch: false })}
          retrying={sessionRead.isFetching}
        />
      </div>
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

  // One write per drag, drawn at once. The order is renumbered 0..n-1 (safe
  // over legacy tied sort_orders), and where the slot lands decides its
  // superset: between two members it joins, beside its own it stays,
  // elsewhere it leaves — so no superset is ever split in two.
  function handleDragEnd(event) {
    const { active, over } = event;
    const plan = planSlotDrag(slots, active?.id, over?.id);
    if (plan) reorderSlots.mutate(plan);
  }

  const athleteName = (student?.profile?.full_name || '').trim() || null;
  const canDelete = !trained && !isDraft;

  // The page of the session (design/parc/screens/Editeur.dc.html): back to
  // the athlete's sheet, the session's options, its name as the title — a
  // tap renames it — and the athlete under it. It stands in the athlete's
  // shell, which draws no header of its own over it (CoachHome).
  return (
    <div className="flex flex-col gap-6">
      <LargeTitle
        back={back}
        actions={
          canDelete ? (
            <IconButton icon="more" label={t('parcEditor.options')} onClick={() => setOptionsOpen(true)} />
          ) : null
        }
        title={
          readOnly ? (
            session?.title || t('parcEditor.untitled')
          ) : (
            <>
              <EditableText
                value={session?.title || ''}
                onSave={(title) => updateSession.mutate({ id: sessionId, title })}
                placeholder={t('parcEditor.untitled')}
                ariaLabel={false}
                describedBy={titleHintId}
                // Hold the title's own size while editing: left alone the
                // field falls back to 16px, and tapping the title shrank it.
                inputClassName="pk-large-title !text-[44px] !leading-none"
              />
              <span id={titleHintId} hidden>
                {t('parcEditor.rename')}
              </span>
            </>
          )
        }
        subtitle={athleteName}
      />

      <label className="flex flex-col gap-1.5 sm:max-w-xs">
        <span className="pk-caption">{t('parcEditor.date')}</span>
        <input
          id="session-date"
          type="date"
          value={session?.scheduled_date || ''}
          onChange={(e) =>
            updateSession.mutate({ id: sessionId, scheduled_date: e.target.value || null })
          }
          disabled={readOnly}
          className="pk-field disabled:bg-fill"
        />
      </label>

      {isDraft && (
        <p role="note" className="rounded-group bg-blue-soft p-4 pk-body">
          {t('coachEditorNavErrors.draft.editor')}
        </p>
      )}

      {trained && (
        <div role="note" className="flex flex-col items-start gap-3 rounded-group bg-amber-soft p-4">
          <p className="pk-body">
            {confirmed
              ? t('coachLoggedHistory.editor.confirmedBanner')
              : t('coachLoggedHistory.editor.loggedBanner')}
          </p>
          {/* `from` is how the review's back button returns here instead of
              to the sessions feed. */}
          <Button as={Link} to={reviewPath} state={{ from: editorPath }}>
            {t('coachLoggedHistory.editor.openReview')}
          </Button>
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
          <div className="flex flex-col gap-4">
            {slotGroups.map((group) => {
              // A slot whose exercise this coach cannot read — one of a former
              // coach's library, until the library read follows the program
              // (migration 23) — has `exercise: null`. ExerciseSlotRow reads
              // the exercise's name and type, so it gets a card that says so
              // instead of crashing the page (review item B8).
              const renderRow = (slot) => (!slot.exercise ? (
                <UnavailableExerciseCard key={slot.id} t={t} />
              ) : (
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
              ));
              if (group.slots.length > 1) {
                return (
                  <div key={group.key} className="flex flex-col gap-2 border-l-4 border-blue pl-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="pk-caption font-semibold text-blue">{t('parcReview.superset')}</span>
                      {!readOnly && (
                        <Button
                          variant="text"
                          onClick={() => handleUnlinkSuperset(group.key)}
                          aria-label={t('parcEditor.unlinkLabel')}
                        >
                          {t('parcEditor.unlink')}
                        </Button>
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
        <section className="flex flex-col gap-4 rounded-group bg-surface p-4">
          <SelectField
            label={t('parcEditor.exercise')}
            value={selectedExercise}
            onChange={(e) => setSelectedExercise(e.target.value)}
          >
            <option value="">{t('parcEditor.chooseExercise')}</option>
            {/* An archived exercise is not offered for new work; the slots
                that already hold one still show it (their `exercise` is
                embedded by the session read, not looked up here). */}
            {(library || []).filter(isActiveExercise).map((ex) => (
              <option key={ex.id} value={ex.id}>
                {t('parcEditor.exerciseOption', {
                  name: ex.name,
                  type: exerciseTypeLabel(ex.type, t),
                  difficulty: formatNumber(lang, ex.difficulty),
                })}
              </option>
            ))}
          </SelectField>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="pk-caption mb-1.5">{t('parcEditor.unit')}</legend>
            <div className="flex flex-wrap gap-2">
              {[
                ['reps', t('parcEditor.unitReps')],
                ['seconds', t('parcEditor.unitSeconds')],
              ].map(([value, label]) => (
                <label key={value} className="pk-chip cursor-pointer has-[:checked]:bg-ink has-[:checked]:text-surface">
                  <input
                    type="radio"
                    name="add-unit"
                    value={value}
                    checked={addUnit === value}
                    onChange={(e) => setAddUnit(e.target.value)}
                    className="sr-only"
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          {slots.length > 0 && (
            <label className="flex min-h-11 items-center gap-3 pk-body">
              <input
                type="checkbox"
                checked={pairAsSuperset}
                onChange={(e) => setPairAsSuperset(e.target.checked)}
                className="h-5 w-5 accent-[var(--blue)]"
              />
              {t('parcEditor.pairSuperset')}
            </label>
          )}
          <div className="flex flex-col gap-1">
            <Button variant="primary" size="lg" onClick={handleAddExercise} disabled={!selectedExercise || addSlot.isPending}>
              {t('parcEditor.add')}
            </Button>
            <Button variant="text" onClick={() => setShowAdd(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </section>
      ) : (
        <Button variant="text" className="self-start" onClick={() => setShowAdd(true)}>
          <Icon name="plus" size={18} />
          {t('parcEditor.addExercise')}
        </Button>
      )}

      {/* Deleting lives in the editor's options, not on the sheet: by this
          point the coach has opened this one session, so it can't be a stray
          thumb on a list — and it is the rarest action here. Archiving from
          the sheet is the everyday way to clear a session; this is the escape
          hatch for one created by mistake.

          Not offered at all once the session is trained: the database refuses
          to delete a session that carries logged sets, so the action could
          only ever answer "archive it instead". Nor on an athlete's draft,
          which is read-only. */}
      <Sheet open={optionsOpen} onClose={() => setOptionsOpen(false)} title={t('parcEditor.options')}>
        <Button
          variant="danger"
          size="lg"
          className="w-full"
          disabled={deleteSession.isPending}
          onClick={() => {
            setOptionsOpen(false);
            setConfirmDelete(true);
          }}
        >
          {t('parcEditor.deleteSession')}
        </Button>
      </Sheet>

      <ConfirmSheet
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t('parcEditor.deleteTitle')}
        message={t('parcEditor.deleteMessage')}
        confirmText={t('parcEditor.deleteSession')}
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
