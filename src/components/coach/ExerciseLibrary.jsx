import { useMemo, useState } from 'react';
import Header from '../layout/Header';
import {
  useExerciseLibrary,
  useCreateExercise,
  useUpdateExercise,
  useDeleteExercise,
} from '../../hooks/useExerciseLibrary';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';

const TYPE_FILTERS = ['all', 'pull', 'push'];

function FilterPill({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
        active
          ? 'bg-primary text-white'
          : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
      }`}
    >
      {label}
    </button>
  );
}

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
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');

  const filtered = useMemo(() => {
    if (!exercises) return [];
    const q = search.trim().toLowerCase();
    return exercises.filter((ex) => {
      const matchesSearch = !q || ex.name.toLowerCase().includes(q);
      const matchesType = typeFilter === 'all' || ex.type === typeFilter;
      return matchesSearch && matchesType;
    });
  }, [exercises, search, typeFilter]);

  function handleCreate(values) {
    createExercise.mutate(values, { onSuccess: () => setShowAdd(false) });
  }

  function handleUpdate(id, values) {
    updateExercise.mutate({ id, ...values }, { onSuccess: () => setEditingId(null) });
  }

  const hasExercises = exercises && exercises.length > 0;

  return (
    <>
      <Header title="Exercise Library" />
      <div className="p-4 space-y-3">
        {isLoading && (
          <div className="flex justify-center py-12"><Spinner /></div>
        )}

        {!isLoading && hasExercises && (
          <div className="space-y-2">
            {/* Search */}
            <div className="relative">
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z" />
              </svg>
              <input
                type="search"
                aria-label="Search exercises"
                placeholder="Search exercises…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-xl border border-gray-200 pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            {/* Type filter pills */}
            <div className="flex gap-2" role="group" aria-label="Filter by type">
              {TYPE_FILTERS.map((t) => (
                <FilterPill
                  key={t}
                  label={t === 'all' ? 'All' : t.charAt(0).toUpperCase() + t.slice(1)}
                  active={typeFilter === t}
                  onClick={() => setTypeFilter(t)}
                />
              ))}
            </div>
          </div>
        )}

        {!isLoading && !hasExercises && !showAdd && (
          <EmptyState message="No exercises yet" />
        )}

        {!isLoading && hasExercises && filtered.length === 0 && (
          <EmptyState message="No exercises match your search" />
        )}

        {filtered.map((ex) => (
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
