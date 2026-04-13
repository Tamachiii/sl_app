import { useState } from 'react';
import { useParams } from 'react-router-dom';
import Header from '../layout/Header';
import { useSession, useAddSlot, useUpdateSlot, useDeleteSlot } from '../../hooks/useSession';
import { useExerciseLibrary } from '../../hooks/useExerciseLibrary';
import { useDuplicateSession } from '../../hooks/useDuplicate';
import { computeSessionVolume } from '../../lib/volume';
import VolumeBar from './VolumeBar';
import ExerciseSlotRow from './ExerciseSlotRow';
import Spinner from '../ui/Spinner';

export default function SessionEditor() {
  const { sessionId } = useParams();
  const { data: session, isLoading } = useSession(sessionId);
  const { data: library } = useExerciseLibrary();
  const addSlot = useAddSlot();
  const updateSlot = useUpdateSlot();
  const deleteSlot = useDeleteSlot();
  const duplicateSession = useDuplicateSession();

  const [showAdd, setShowAdd] = useState(false);
  const [selectedExercise, setSelectedExercise] = useState('');

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

  function handleAddExercise() {
    if (!selectedExercise) return;
    addSlot.mutate({
      sessionId,
      exerciseId: selectedExercise,
      sets: 3,
      reps: 10,
      sortOrder: slots.length,
    });
    setSelectedExercise('');
    setShowAdd(false);
  }

  function handleMoveSlot(index, direction) {
    const target = index + direction;
    if (target < 0 || target >= slots.length) return;
    const a = slots[index];
    const b = slots[target];
    updateSlot.mutate({ id: a.id, sessionId, sort_order: b.sort_order });
    updateSlot.mutate({ id: b.id, sessionId, sort_order: a.sort_order });
  }

  return (
    <>
      <Header
        title={session?.title || 'Session'}
        showBack
        actions={
          <button
            onClick={() => duplicateSession.mutate({ sessionId })}
            disabled={duplicateSession.isPending}
            className="text-xs bg-gray-100 text-gray-600 rounded-lg px-2.5 py-1.5 hover:bg-gray-200"
          >
            Duplicate
          </button>
        }
      />
      <div className="p-4 space-y-4">
        <VolumeBar pull={vol.pull} push={vol.push} />

        {slots.map((slot, idx) => (
          <ExerciseSlotRow
            key={slot.id}
            slot={slot}
            index={idx}
            total={slots.length}
            onUpdate={(updates) => updateSlot.mutate({ id: slot.id, sessionId, ...updates })}
            onDelete={() => deleteSlot.mutate({ id: slot.id })}
            onMove={(dir) => handleMoveSlot(idx, dir)}
          />
        ))}

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
    </>
  );
}
