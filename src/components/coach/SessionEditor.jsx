import { useState } from 'react';
import { useParams } from 'react-router-dom';
import Header from '../layout/Header';
import { useSession, useAddSlot, useUpdateSlot, useDeleteSlot } from '../../hooks/useSession';
import { useUpdateSession } from '../../hooks/useWeek';
import { useExerciseLibrary } from '../../hooks/useExerciseLibrary';
import { useDuplicateSession } from '../../hooks/useDuplicate';
import { useStudents } from '../../hooks/useStudents';
import { useProgram } from '../../hooks/useProgram';
import { computeSessionVolume } from '../../lib/volume';
import VolumeBar from './VolumeBar';
import ExerciseSlotRow from './ExerciseSlotRow';
import Spinner from '../ui/Spinner';
import EditableText from '../ui/EditableText';
import Dialog from '../ui/Dialog';

export default function SessionEditor() {
  const { sessionId, studentId } = useParams();
  const { data: session, isLoading } = useSession(sessionId);
  const { data: library } = useExerciseLibrary();
  const addSlot = useAddSlot();
  const updateSlot = useUpdateSlot();
  const deleteSlot = useDeleteSlot();
  const duplicateSession = useDuplicateSession();
  const updateSession = useUpdateSession();
  const { data: students } = useStudents();

  const [showAdd, setShowAdd] = useState(false);
  const [selectedExercise, setSelectedExercise] = useState('');
  const [addUnit, setAddUnit] = useState('reps');
  const [showCopy, setShowCopy] = useState(false);
  const [copyStudentId, setCopyStudentId] = useState('');
  const [copyWeekId, setCopyWeekId] = useState('');
  const { data: destProgram } = useProgram(copyStudentId);
  const destWeeks = destProgram?.weeks || [];

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
      ...(addUnit === 'seconds' ? { durationSeconds: 30 } : { reps: 10 }),
      sortOrder: slots.length,
    });
    setSelectedExercise('');
    setAddUnit('reps');
    setShowAdd(false);
  }

  function handleCopyToStudent() {
    if (!copyWeekId) return;
    duplicateSession.mutate(
      { sessionId, weekId: copyWeekId },
      {
        onSuccess: () => {
          setShowCopy(false);
          setCopyStudentId('');
          setCopyWeekId('');
        },
      }
    );
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

      <Dialog
        open={showCopy}
        onClose={() => setShowCopy(false)}
        title="Copy session to another student"
      >
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs text-gray-600 block mb-1">Student</span>
            <select
              value={copyStudentId}
              onChange={(e) => {
                setCopyStudentId(e.target.value);
                setCopyWeekId('');
              }}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">Select student…</option>
              {(students || [])
                .filter((s) => s.id !== studentId)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.profile?.full_name || 'Unnamed student'}
                  </option>
                ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs text-gray-600 block mb-1">Destination week</span>
            <select
              value={copyWeekId}
              onChange={(e) => setCopyWeekId(e.target.value)}
              disabled={!copyStudentId || destWeeks.length === 0}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50"
            >
              <option value="">
                {!copyStudentId
                  ? 'Select a student first'
                  : destWeeks.length === 0
                    ? 'No weeks in this student\u2019s program'
                    : 'Select week…'}
              </option>
              {destWeeks.map((w) => (
                <option key={w.id} value={w.id}>
                  Week {w.week_number}
                  {w.label ? ` — ${w.label}` : ''}
                </option>
              ))}
            </select>
          </label>

          <div className="flex gap-2 pt-1">
            <button
              onClick={handleCopyToStudent}
              disabled={!copyWeekId || duplicateSession.isPending}
              className="flex-1 bg-primary text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50"
            >
              {duplicateSession.isPending ? 'Copying…' : 'Copy'}
            </button>
            <button
              onClick={() => setShowCopy(false)}
              className="flex-1 bg-gray-100 text-gray-600 rounded-lg py-2 text-sm font-medium"
            >
              Cancel
            </button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
