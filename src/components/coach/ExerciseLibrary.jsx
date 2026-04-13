import { useState } from 'react';
import Header from '../layout/Header';
import {
  useExerciseLibrary,
  useCreateExercise,
  useUpdateExercise,
  useDeleteExercise,
} from '../../hooks/useExerciseLibrary';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';

function ExerciseForm({ initial, onSubmit, onCancel, submitLabel }) {
  const [name, setName] = useState(initial?.name || '');
  const [type, setType] = useState(initial?.type || 'pull');
  const [difficulty, setDifficulty] = useState(initial?.difficulty || 1);
  const [volumeWeight, setVolumeWeight] = useState(initial?.volume_weight ?? 1);

  function handleSubmit(e) {
    e.preventDefault();
    onSubmit({ name, type, difficulty, volume_weight: Number(volumeWeight) });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <input
        type="text"
        placeholder="Exercise name"
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm"
      />
      <div className="flex gap-3">
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2.5 text-sm"
        >
          <option value="pull">Pull</option>
          <option value="push">Push</option>
        </select>
        <select
          value={difficulty}
          onChange={(e) => setDifficulty(Number(e.target.value))}
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2.5 text-sm"
        >
          <option value={1}>Difficulty 1</option>
          <option value={2}>Difficulty 2</option>
          <option value={3}>Difficulty 3</option>
        </select>
      </div>
      <div>
        <label className="text-xs text-gray-500 block mb-0.5">Volume Weight</label>
        <input
          type="number"
          min={0.1}
          step={0.1}
          value={volumeWeight}
          onChange={(e) => setVolumeWeight(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm"
        />
      </div>
      <div className="flex gap-2">
        <button
          type="submit"
          className="flex-1 bg-primary text-white rounded-lg py-2 text-sm font-medium"
        >
          {submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 bg-gray-100 text-gray-600 rounded-lg py-2 text-sm font-medium"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

export default function ExerciseLibrary() {
  const { data: exercises, isLoading } = useExerciseLibrary();
  const createExercise = useCreateExercise();
  const updateExercise = useUpdateExercise();
  const deleteExercise = useDeleteExercise();

  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);

  function handleCreate(values) {
    createExercise.mutate(values, { onSuccess: () => setShowAdd(false) });
  }

  function handleUpdate(id, values) {
    updateExercise.mutate({ id, ...values }, { onSuccess: () => setEditingId(null) });
  }

  return (
    <>
      <Header title="Exercise Library" />
      <div className="p-4 space-y-3">
        {isLoading && (
          <div className="flex justify-center py-12"><Spinner /></div>
        )}
        {!isLoading && (!exercises || exercises.length === 0) && !showAdd && (
          <EmptyState message="No exercises yet" />
        )}

        {exercises?.map((ex) => (
          <div key={ex.id} className="bg-white rounded-xl shadow-sm p-4">
            {editingId === ex.id ? (
              <ExerciseForm
                initial={ex}
                onSubmit={(vals) => handleUpdate(ex.id, vals)}
                onCancel={() => setEditingId(null)}
                submitLabel="Save"
              />
            ) : (
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-medium text-gray-900 text-sm">{ex.name}</span>
                  <span className={`ml-2 text-xs font-medium px-1.5 py-0.5 rounded ${
                    ex.type === 'pull' ? 'bg-pull/10 text-pull' : 'bg-push/10 text-push'
                  }`}>
                    {ex.type}
                  </span>
                  <span className="ml-1 text-xs text-gray-400">
                    D{ex.difficulty} / VW{ex.volume_weight}
                  </span>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => setEditingId(ex.id)}
                    aria-label={`Edit ${ex.name}`}
                    className="text-gray-400 hover:text-primary p-1 text-sm"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete "${ex.name}"?`)) deleteExercise.mutate(ex.id);
                    }}
                    aria-label={`Delete ${ex.name}`}
                    className="text-gray-400 hover:text-danger p-1 text-sm"
                  >
                    Del
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}

        {showAdd ? (
          <div className="bg-white rounded-xl shadow-sm p-4">
            <ExerciseForm
              onSubmit={handleCreate}
              onCancel={() => setShowAdd(false)}
              submitLabel="Create"
            />
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
