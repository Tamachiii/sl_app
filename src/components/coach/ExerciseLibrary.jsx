import { useMemo, useState } from 'react';
import {
  useExerciseLibrary,
  useCreateExercise,
  useUpdateExercise,
  useDeleteExercise,
} from '../../hooks/useExerciseLibrary';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import UserMenu from '../ui/UserMenu';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';

const TYPE_FILTERS = ['all', 'pull', 'push'];

const inputCls =
  'w-full rounded-lg border border-ink-200 bg-white px-3 py-2 sl-mono text-[16px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]';

function FilterPill({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className="sl-pill transition-colors"
      style={
        active
          ? {
              background: 'var(--color-accent)',
              color: 'var(--color-ink-900)',
            }
          : undefined
      }
    >
      {!active ? <span className="text-ink-500">{label}</span> : label}
    </button>
  );
}

function ExerciseForm({ initial, onSubmit, onCancel, submitLabel, pending, pendingLabel }) {
  const { t } = useI18n();
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
        placeholder={t('coach.library.name')}
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
        className={inputCls}
      />
      <div className="flex gap-3">
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className={`${inputCls} flex-1`}
        >
          <option value="pull">{t('coach.library.typePull')}</option>
          <option value="push">{t('coach.library.typePush')}</option>
        </select>
        <select
          value={difficulty}
          onChange={(e) => setDifficulty(Number(e.target.value))}
          className={`${inputCls} flex-1`}
        >
          <option value={1}>{t('coach.library.difficulty', { n: 1 })}</option>
          <option value={2}>{t('coach.library.difficulty', { n: 2 })}</option>
          <option value={3}>{t('coach.library.difficulty', { n: 3 })}</option>
        </select>
      </div>
      <div>
        <label className="sl-label text-ink-400 block mb-1">{t('coach.library.volumeWeight')}</label>
        <input
          type="number"
          min={0.1}
          step={0.1}
          value={volumeWeight}
          onChange={(e) => setVolumeWeight(e.target.value)}
          className={inputCls}
        />
      </div>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="flex-1 sl-btn-primary text-[13px] disabled:opacity-50"
          style={{ padding: '10px 16px' }}
        >
          {pending && pendingLabel ? pendingLabel : submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-lg bg-ink-100 text-ink-700 hover:bg-ink-200 py-2 sl-mono text-[12px]"
          >
            {t('common.cancel')}
          </button>
        )}
      </div>
    </form>
  );
}

export default function ExerciseLibrary() {
  const { t } = useI18n();
  const { profile, signOut } = useAuth();
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
    <div className="p-4 pb-6 md:p-8 space-y-5">
      <div className="pt-3 pb-1 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="sl-label text-ink-400">{t('coach.library.kicker')}</div>
          <h1 className="sl-display text-[28px] md:text-[40px] text-gray-900 leading-none mt-1">
            {t('coach.library.title')}
          </h1>
        </div>
        <UserMenu fullName={profile?.full_name} onSignOut={signOut} />
      </div>

      {isLoading && (
        <div className="flex justify-center py-12"><Spinner /></div>
      )}

      {showAdd && (
        <div className="sl-card p-4">
          <ExerciseForm
            onSubmit={handleCreate}
            onCancel={() => setShowAdd(false)}
            submitLabel={t('coach.library.create')}
            pending={createExercise.isPending}
            pendingLabel={t('coach.library.creating')}
          />
        </div>
      )}

      {!isLoading && !showAdd && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            {hasExercises && (
              <div className="relative flex-1">
                <svg
                  className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-400 pointer-events-none"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z" />
                </svg>
                <input
                  type="search"
                  aria-label={t('coach.library.search')}
                  placeholder={t('coach.library.search')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full rounded-lg border border-ink-200 bg-white pl-9 pr-3 py-2 sl-mono text-[16px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                />
              </div>
            )}
            <button
              onClick={() => setShowAdd(true)}
              className={`sl-btn-primary text-[12px] px-3 py-2 shrink-0${hasExercises ? '' : ' ml-auto'}`}
            >
              {t('coach.library.add')}
            </button>
          </div>

          {hasExercises && (
            <div className="flex gap-2" role="group" aria-label="Filter by type">
              {TYPE_FILTERS.map((filter) => {
                const label =
                  filter === 'all'
                    ? t('coach.library.filterAll')
                    : filter === 'pull'
                    ? t('coach.library.filterPull')
                    : t('coach.library.filterPush');
                return (
                  <FilterPill
                    key={filter}
                    label={label}
                    active={typeFilter === filter}
                    onClick={() => setTypeFilter(filter)}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {!isLoading && !hasExercises && !showAdd && (
        <EmptyState message={t('coach.library.noneYet')} />
      )}

      {!isLoading && hasExercises && filtered.length === 0 && (
        <EmptyState message={t('coach.library.noneMatch')} />
      )}

      <div className="space-y-2 md:grid md:grid-cols-2 md:gap-2 md:space-y-0">
        {filtered.map((ex) => (
          <div key={ex.id} className="sl-card p-4">
            {editingId === ex.id ? (
              <ExerciseForm
                initial={ex}
                onSubmit={(vals) => handleUpdate(ex.id, vals)}
                onCancel={() => setEditingId(null)}
                submitLabel={t('common.save')}
                pending={updateExercise.isPending}
                pendingLabel={t('common.saving')}
              />
            ) : (
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 flex-wrap min-w-0">
                  <span className="sl-display text-[15px] text-gray-900 truncate">
                    {ex.name}
                  </span>
                  <span
                    className={`sl-pill ${
                      ex.type === 'pull' ? 'bg-pull/15 text-pull' : 'bg-push/15 text-push'
                    }`}
                  >
                    {ex.type}
                  </span>
                  <span className="sl-mono text-[10px] text-ink-400">
                    D{ex.difficulty} · VW{ex.volume_weight}
                  </span>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button
                    onClick={() => setEditingId(ex.id)}
                    aria-label={`Edit ${ex.name}`}
                    className="sl-mono text-[11px] text-ink-400 hover:text-[var(--color-accent)] px-1"
                  >
                    {t('coach.library.edit')}
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(t('coach.library.confirmDelete', { name: ex.name }))) deleteExercise.mutate(ex.id);
                    }}
                    aria-label={`Delete ${ex.name}`}
                    className="sl-mono text-[11px] text-ink-400 hover:text-danger px-1"
                  >
                    {t('coach.library.del')}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
