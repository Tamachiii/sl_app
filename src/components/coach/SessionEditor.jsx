import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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
import { useSession, useAddSlot, useUpdateSlot, useDeleteSlot } from '../../hooks/useSession';
import { useUpdateSession } from '../../hooks/useWeek';
import { useExerciseLibrary } from '../../hooks/useExerciseLibrary';
import { useDuplicateSession } from '../../hooks/useDuplicate';
import { groupSlotsBySuperset } from '../../lib/volume';
import ExerciseSlotRow from './ExerciseSlotRow';
import Spinner from '../ui/Spinner';
import EditableText from '../ui/EditableText';
import CopyDialog from '../ui/CopyDialog';

export default function SessionEditor() {
  const { sessionId, studentId } = useParams();
  const navigate = useNavigate();
  const { data: session, isLoading } = useSession(sessionId);
  const { data: library } = useExerciseLibrary();
  const addSlot = useAddSlot();
  const updateSlot = useUpdateSlot();
  const deleteSlot = useDeleteSlot();
  const duplicateSession = useDuplicateSession();
  const updateSession = useUpdateSession();

  const [showAdd, setShowAdd] = useState(false);
  const [selectedExercise, setSelectedExercise] = useState('');
  const [addUnit, setAddUnit] = useState('reps');
  const [pairAsSuperset, setPairAsSuperset] = useState(false);
  const [showCopy, setShowCopy] = useState(false);

  const slots = session?.exercise_slots || [];
  const slotGroups = useMemo(() => groupSlotsBySuperset(slots), [slots]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (isLoading) {
    return <div className="flex justify-center py-12"><Spinner /></div>;
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

  function handleCopyToStudent({ weekId }) {
    if (!weekId) return;
    duplicateSession.mutate(
      { sessionId, weekId },
      { onSuccess: () => setShowCopy(false) }
    );
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

  return (
    <div className="p-4 pb-6 md:p-8 space-y-5">
      <div className="flex items-start gap-3">
        <button
          onClick={() => navigate(-1)}
          aria-label="Back"
          className="w-9 h-9 rounded-lg bg-ink-100 flex items-center justify-center text-ink-700 hover:bg-ink-200 shrink-0"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <div className="sl-label text-ink-400">Session</div>
          <div className="sl-display text-[22px] text-gray-900 leading-tight mt-0.5">
            <EditableText
              value={session?.title || ''}
              onSave={(title) => updateSession.mutate({ id: sessionId, title })}
              placeholder="Session"
              ariaLabel="Edit session title"
            />
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => setShowCopy(true)}
            className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200"
          >
            copy to…
          </button>
          <button
            onClick={() => duplicateSession.mutate({ sessionId })}
            disabled={duplicateSession.isPending}
            className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200 disabled:opacity-50"
          >
            duplicate
          </button>
        </div>
      </div>

      <div className="sl-card p-3 flex items-center gap-3">
        <label htmlFor="session-date" className="sl-label text-ink-400 shrink-0">
          Scheduled
        </label>
        <input
          id="session-date"
          type="date"
          value={session?.scheduled_date || ''}
          onChange={(e) =>
            updateSession.mutate({ id: sessionId, scheduled_date: e.target.value || null })
          }
          className="flex-1 rounded-lg border border-ink-200 bg-white px-3 py-1.5 sl-mono text-[16px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
        />
      </div>

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
                        Superset
                      </span>
                      <button
                        onClick={() => handleUnlinkSuperset(group.key)}
                        className="sl-mono text-[11px] text-ink-400 hover:text-danger underline"
                      >
                        unlink
                      </button>
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

      {showAdd ? (
        <div className="sl-card p-4 space-y-3">
          <select
            value={selectedExercise}
            onChange={(e) => setSelectedExercise(e.target.value)}
            className={inputCls}
          >
            <option value="">Select exercise…</option>
            {(library || []).map((ex) => (
              <option key={ex.id} value={ex.id}>
                {ex.name} ({ex.type}, D{ex.difficulty})
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
              Reps
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="add-unit"
                value="seconds"
                checked={addUnit === 'seconds'}
                onChange={(e) => setAddUnit(e.target.value)}
              />
              Seconds (TUT)
            </label>
          </fieldset>
          {slots.length > 0 && (
            <label className="flex items-center gap-2 sl-mono text-[12px] text-ink-600">
              <input
                type="checkbox"
                checked={pairAsSuperset}
                onChange={(e) => setPairAsSuperset(e.target.checked)}
              />
              Pair with previous as superset
            </label>
          )}
          <div className="flex gap-2">
            <button
              onClick={handleAddExercise}
              disabled={!selectedExercise || addSlot.isPending}
              className="flex-1 sl-btn-primary text-[13px] disabled:opacity-50"
              style={{ padding: '10px 16px' }}
            >
              Add
            </button>
            <button
              onClick={() => setShowAdd(false)}
              className="flex-1 bg-ink-100 text-ink-700 rounded-lg py-2 sl-display text-[13px] hover:bg-ink-200"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="w-full border border-dashed border-ink-200 text-ink-400 rounded-xl py-3 sl-mono text-[12px] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors"
        >
          + ADD EXERCISE
        </button>
      )}

      <CopyDialog
        open={showCopy}
        onClose={() => setShowCopy(false)}
        title="Copy session to another student"
        currentStudentId={studentId}
        showWeekSelect
        onCopy={handleCopyToStudent}
        isPending={duplicateSession.isPending}
      />
    </div>
  );
}
