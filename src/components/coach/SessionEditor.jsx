import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import Header from '../layout/Header';
import { useSession, useAddSlot, useUpdateSlot, useDeleteSlot } from '../../hooks/useSession';
import { useUpdateSession } from '../../hooks/useWeek';
import { useExerciseLibrary } from '../../hooks/useExerciseLibrary';
import { useDuplicateSession } from '../../hooks/useDuplicate';
import { computeSessionVolume, groupSlotsBySuperset } from '../../lib/volume';
import VolumeBar from './VolumeBar';
import ExerciseSlotRow from './ExerciseSlotRow';
import Spinner from '../ui/Spinner';
import EditableText from '../ui/EditableText';
import CopyDialog from '../ui/CopyDialog';

export default function SessionEditor() {
  const { sessionId, studentId } = useParams();
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

  if (isLoading) {
    return (
      <>
        <Header title="Session" showBack />
        <div className="flex justify-center py-12"><Spinner /></div>
      </>
    );
  }

  const slots = session?.exercise_slots || [];
  const vol = computeSessionVolume(slots);
  const slotGroups = useMemo(() => groupSlotsBySuperset(slots), [slots]);

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
    addSlot.mutate({
      sessionId,
      exerciseId: selectedExercise,
      sets: 3,
      ...(addUnit === 'seconds' ? { durationSeconds: 30 } : { reps: 10 }),
      sortOrder: slots.length,
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

  async function handleMoveSlot(index, direction) {
    const target = index + direction;
    if (target < 0 || target >= slots.length) return;
    const a = slots[index];
    const b = slots[target];
    await Promise.all([
      updateSlot.mutateAsync({ id: a.id, sessionId, sort_order: b.sort_order }),
      updateSlot.mutateAsync({ id: b.id, sessionId, sort_order: a.sort_order })
    ]);
  }

  return (
    <>
      <Header
        title={
          <EditableText
            value={session?.title || ''}
            onSave={(title) => updateSession.mutate({ id: sessionId, title })}
            placeholder="Session"
            ariaLabel="Edit session title"
          />
        }
        showBack
        actions={
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setShowCopy(true)}
              className="text-xs bg-gray-100 text-gray-600 rounded-lg px-2.5 py-1.5 hover:bg-gray-200"
            >
              Copy to…
            </button>
            <button
              onClick={() => duplicateSession.mutate({ sessionId })}
              disabled={duplicateSession.isPending}
              className="text-xs bg-gray-100 text-gray-600 rounded-lg px-2.5 py-1.5 hover:bg-gray-200"
            >
              Duplicate
            </button>
          </div>
        }
      />
      <div className="p-4 space-y-4">
        <VolumeBar pull={vol.pull} push={vol.push} />

        <div className="bg-white rounded-xl shadow-sm p-3 flex items-center gap-3">
          <label htmlFor="session-date" className="text-sm text-gray-600 shrink-0">
            Scheduled date
          </label>
          <input
            id="session-date"
            type="date"
            value={session?.scheduled_date || ''}
            onChange={(e) =>
              updateSession.mutate({ id: sessionId, scheduled_date: e.target.value || null })
            }
            className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
          />
        </div>

        {(() => {
          let flatIdx = 0;
          return slotGroups.map((group) => {
            const startIdx = flatIdx;
            flatIdx += group.slots.length;
            const renderRow = (slot, j) => (
              <ExerciseSlotRow
                key={slot.id}
                slot={slot}
                index={startIdx + j}
                total={slots.length}
                onUpdate={(updates) => updateSlot.mutate({ id: slot.id, sessionId, ...updates })}
                onDelete={() => deleteSlot.mutate({ id: slot.id, sessionId })}
                onMove={(dir) => handleMoveSlot(startIdx + j, dir)}
              />
            );
            if (group.slots.length > 1) {
              return (
                <div
                  key={group.key}
                  className="rounded-xl border-2 border-primary/30 bg-primary/5 p-2 space-y-2"
                >
                  <div className="flex items-center justify-between px-2 pt-1">
                    <span className="text-xs font-semibold uppercase tracking-wide text-primary">
                      Superset
                    </span>
                    <button
                      onClick={() => handleUnlinkSuperset(group.key)}
                      className="text-xs text-gray-500 hover:text-danger"
                    >
                      Unlink superset
                    </button>
                  </div>
                  {group.slots.map(renderRow)}
                </div>
              );
            }
            return renderRow(group.slots[0], 0);
          });
        })()}

        {showAdd ? (
          <div className="bg-white rounded-xl shadow-sm p-4 space-y-3">
            <select
              value={selectedExercise}
              onChange={(e) => setSelectedExercise(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm"
            >
              <option value="">Select exercise...</option>
              {(library || []).map((ex) => (
                <option key={ex.id} value={ex.id}>
                  {ex.name} ({ex.type}, D{ex.difficulty})
                </option>
              ))}
            </select>
            <fieldset className="flex gap-3 text-sm text-gray-600">
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
                Seconds (time under tension)
              </label>
            </fieldset>
            {slots.length > 0 && (
              <label className="flex items-center gap-2 text-sm text-gray-600">
                <input
                  type="checkbox"
                  checked={pairAsSuperset}
                  onChange={(e) => setPairAsSuperset(e.target.checked)}
                />
                Pair with previous exercise as superset
              </label>
            )}
            <div className="flex gap-2">
              <button
                onClick={handleAddExercise}
                disabled={!selectedExercise || addSlot.isPending}
                className="flex-1 bg-primary text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50"
              >
                Add
              </button>
              <button
                onClick={() => setShowAdd(false)}
                className="flex-1 bg-gray-100 text-gray-600 rounded-lg py-2 text-sm font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowAdd(true)}
            className="w-full border-2 border-dashed border-gray-300 text-gray-400 rounded-xl py-3 text-sm font-medium hover:border-primary hover:text-primary transition-colors"
          >
            + Add Exercise
          </button>
        )}
      </div>

      <CopyDialog
        open={showCopy}
        onClose={() => setShowCopy(false)}
        title="Copy session to another student"
        currentStudentId={studentId}
        showWeekSelect
        onCopy={handleCopyToStudent}
        isPending={duplicateSession.isPending}
      />
    </>
  );
}
