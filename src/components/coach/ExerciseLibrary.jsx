import { useId, useMemo, useState } from 'react';
import {
  useExerciseLibrary,
  useCreateExercise,
  useUpdateExercise,
  useArchiveExercise,
  useDeleteExercise,
  isActiveExercise,
} from '../../hooks/useExerciseLibrary';
import Spinner from '../ui/Spinner';
import UserMenu from '../ui/UserMenu';
import ExerciseDeleteDialog from './ExerciseDeleteDialog';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { decimalText, parseDecimalInput } from '../../lib/number';
import { exerciseType, exerciseTypeLabel } from '../../lib/exerciseTypes';
import { formatNumber, pluralKey } from '../../lib/i18n/format';
import { Button, IconButton, LargeTitle, ListGroup, NumberField, Row, SearchField, SegmentedControl, Sheet } from '../parc';

const TYPE_FILTERS = ['all', 'pull', 'push'];

// What a volume weight may be: what `exercise_library.volume_weight` holds, a
// numeric(4,2) — 99.99 at most — and not under 0.1, where the exercise would
// count for nothing in the volume. Never empty: the column is NOT NULL.
const VOLUME_WEIGHT_RULES = { min: 0.1, max: 99.99, allowEmpty: false };

// « Tirer, difficulté 2, volume ×1,5, lest ajouté » — what an exercise is,
// under its name; its type is also a mark of its chart colour.
function exerciseFacts(ex, { t, lang }) {
  const parts = [
    exerciseTypeLabel(ex.type, t),
    t('parcLibrary.difficulty', { n: formatNumber(lang, ex.difficulty) }),
  ];
  if (ex.volume_weight != null && Number(ex.volume_weight) !== 1) {
    parts.push(t('parcLibrary.volume', { n: formatNumber(lang, Number(ex.volume_weight)) }));
  }
  if (ex.load_mode === 'added') parts.push(t('parcLibrary.loadAdded'));
  if (ex.load_mode === 'full') parts.push(t('parcLibrary.loadFull'));
  return parts.join(', ');
}

// The colour of a type's columns in the charts; a type the app does not know
// is grey, never the colour of another one (lib/exerciseTypes).
const MARK = { pull: 'bg-chart-pull', push: 'bg-chart-push' };

function TypeMark({ type }) {
  return (
    <span
      aria-hidden="true"
      className={`mr-1.5 inline-block h-2.5 w-2.5 rounded-full align-[1px] ${MARK[exerciseType(type).id] ?? 'bg-ink-3'}`}
    />
  );
}

function ExerciseForm({ initial, onSubmit, onCancel, submitLabel, pending, pendingLabel }) {
  const { t } = useI18n();
  const [name, setName] = useState(initial?.name || '');
  const [type, setType] = useState(initial?.type || 'pull');
  const [difficulty, setDifficulty] = useState(initial?.difficulty || 1);
  const [volumeWeight, setVolumeWeight] = useState(decimalText(initial?.volume_weight ?? 1));
  const [volumeRefused, setVolumeRefused] = useState(false);
  const nameId = useId();
  // Loading mode is opt-in: '' (unclassified) leaves records exactly as today.
  const [loadMode, setLoadMode] = useState(initial?.load_mode ?? '');

  function handleSubmit(e) {
    e.preventDefault();
    // "0,5" is 0.5 whatever the language of the browser (L9): a number field
    // read it as 5 or as "", and Number("") sent 0. Text that is not a number
    // is stopped by the field's `pattern` before this runs; a number out of
    // the range is stopped here, with the alert below.
    const parsed = parseDecimalInput(volumeWeight, VOLUME_WEIGHT_RULES);
    if (!parsed.ok) {
      setVolumeRefused(true);
      return;
    }
    onSubmit({ name, type, difficulty, volume_weight: parsed.value, load_mode: loadMode || null });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <label htmlFor={nameId} className="flex flex-col gap-1.5">
        <span className="pk-small">{t('parcLibrary.name')}</span>
        <input
          id={nameId}
          type="text"
          placeholder={t('parcLibrary.namePlaceholder')}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="pk-field"
        />
      </label>
      <SegmentedControl
        label={t('parcLibrary.type')}
        value={type}
        onChange={setType}
        options={[
          { value: 'pull', label: exerciseTypeLabel('pull', t) },
          { value: 'push', label: exerciseTypeLabel('push', t) },
        ]}
      />
      <SegmentedControl
        label={t('parcLibrary.difficultyLabel')}
        value={difficulty}
        onChange={setDifficulty}
        options={[1, 2, 3].map((n) => ({ value: n, label: String(n) }))}
      />
      <NumberField
        {...VOLUME_WEIGHT_RULES}
        required
        label={t('parcLibrary.volumeWeight')}
        value={volumeWeight}
        onChange={(e) => {
          setVolumeWeight(e.target.value);
          setVolumeRefused(false);
        }}
        error={volumeRefused ? t('coachDecimalInputs.volumeWeightRange') : undefined}
      />
      <div className="flex flex-col gap-1.5">
        <SegmentedControl
          label={t('parcLibrary.loadMode')}
          value={loadMode}
          onChange={setLoadMode}
          options={[
            { value: '', label: t('parcLibrary.loadUnset') },
            { value: 'added', label: t('parcLibrary.loadAddedOption') },
            { value: 'full', label: t('parcLibrary.loadFullOption') },
          ]}
        />
        <p className="pk-small">{t('parcLibrary.loadHelp')}</p>
      </div>
      <div className="flex flex-col gap-1">
        <Button type="submit" variant="primary" size="lg" disabled={pending}>
          {pending && pendingLabel ? pendingLabel : submitLabel}
        </Button>
        {onCancel && (
          <Button variant="text" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}

export default function ExerciseLibrary() {
  const { t, lang } = useI18n();
  const { profile, signOut } = useAuth();
  const { data: exercises, isLoading } = useExerciseLibrary();
  const createExercise = useCreateExercise();
  const updateExercise = useUpdateExercise();
  const archiveExercise = useArchiveExercise();
  const deleteExercise = useDeleteExercise();

  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  // The exercise whose delete dialog is open, or null.
  const [deleting, setDeleting] = useState(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [showArchived, setShowArchived] = useState(false);
  // The exercise whose ⋯ sheet is open, or null.
  const [actionsFor, setActionsFor] = useState(null);

  // An exercise that is in use cannot be deleted, so it is archived: it leaves
  // this list — and the pickers, which filter with the same predicate — for
  // the "Archived · N" drawer below. The search and the type pills are about
  // the exercises on offer; the drawer lists every archived one.
  const { active, archived } = useMemo(() => {
    const all = exercises || [];
    return {
      active: all.filter(isActiveExercise),
      archived: all.filter((ex) => !isActiveExercise(ex)),
    };
  }, [exercises]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return active.filter((ex) => {
      const matchesSearch = !q || ex.name.toLowerCase().includes(q);
      const matchesType = typeFilter === 'all' || ex.type === typeFilter;
      return matchesSearch && matchesType;
    });
  }, [active, search, typeFilter]);

  // The exercise being archived or restored, so its button is not pressed
  // twice while the write is out.
  const movingId = archiveExercise.isPending ? archiveExercise.variables?.id : null;

  function setArchived(id, value) {
    archiveExercise.mutate({ id, archived: value });
  }

  function handleCreate(values) {
    createExercise.mutate(values, { onSuccess: () => setShowAdd(false) });
  }

  function handleUpdate(id, values) {
    updateExercise.mutate({ id, ...values }, { onSuccess: () => setEditingId(null) });
  }

  const hasExercises = active.length > 0;

  const ctx = { t, lang };
  const counts = [
    t(pluralKey(lang, active.length, 'parcLibrary.exercises'), { n: formatNumber(lang, active.length) }),
    archived.length > 0
      ? t(pluralKey(lang, archived.length, 'parcLibrary.archived'), { n: formatNumber(lang, archived.length) })
      : null,
  ].filter(Boolean).join(', ');
  const target = actionsFor ? (exercises || []).find((ex) => ex.id === actionsFor) || null : null;
  const editing = editingId ? (exercises || []).find((ex) => ex.id === editingId) || null : null;

  return (
    <div className="flex flex-col gap-6 px-4 pt-3 pb-6 md:px-8">
      <header className="flex flex-col gap-4">
        <LargeTitle
          title={t('parcLibrary.title')}
          subtitle={isLoading ? null : counts}
          trailing={
            <div className="flex shrink-0 items-center gap-2">
              <IconButton icon="plus" label={t('parcLibrary.add')} onClick={() => setShowAdd(true)} />
              <UserMenu fullName={profile?.full_name} onSignOut={signOut} />
            </div>
          }
        />
        {!isLoading && hasExercises && (
          <>
            <SearchField label={t('parcLibrary.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="flex gap-2" role="group" aria-label={t('parcLibrary.filterLabel')}>
              {TYPE_FILTERS.map((filter) => (
                <button
                  key={filter}
                  type="button"
                  aria-pressed={typeFilter === filter}
                  onClick={() => setTypeFilter(filter)}
                  className="pk-chip"
                >
                  {filter === 'all' ? t('parcLibrary.filterAll') : exerciseTypeLabel(filter, t)}
                </button>
              ))}
            </div>
          </>
        )}
      </header>

      {isLoading && (
        <div className="flex justify-center py-12"><Spinner /></div>
      )}

      {!isLoading && !hasExercises && (
        <p className="rounded-group bg-surface p-4 pk-body">
          {archived.length > 0 ? t('parcLibrary.allArchived') : t('parcLibrary.noneYet')}
        </p>
      )}

      {!isLoading && hasExercises && filtered.length === 0 && (
        <div className="rounded-group bg-surface p-4">
          <p className="pk-headline">{t('parcLibrary.noneMatch')}</p>
          <p className="pk-caption mt-1">{t('parcLibrary.noneMatchHelp')}</p>
        </div>
      )}

      {filtered.length > 0 && (
        <ListGroup label={t('parcLibrary.listLabel')}>
          {filtered.map((ex) => (
            <Row
              key={ex.id}
              title={ex.name}
              subtitle={
                <>
                  <TypeMark type={ex.type} />
                  {exerciseFacts(ex, ctx)}
                </>
              }
              trailing={
                <IconButton
                  icon="more"
                  tone="none"
                  label={t('parcLibrary.options', { name: ex.name })}
                  onClick={() => setActionsFor(ex.id)}
                />
              }
            />
          ))}
        </ListGroup>
      )}

      {!isLoading && archived.length > 0 && (
        <section aria-label={t('parcLibrary.archivedListLabel')} className="flex flex-col gap-2.5">
          <ul className="pk-group">
            <Row
              onClick={() => setShowArchived((v) => !v)}
              aria-expanded={showArchived}
              chevron={showArchived ? 'chevron-up' : 'chevron-down'}
              title={t(pluralKey(lang, archived.length, 'parcLibrary.drawer'), { n: formatNumber(lang, archived.length) })}
            />
            {showArchived &&
              archived.map((ex) => (
                <li key={ex.id} className="pk-row">
                  <span className="pk-body min-w-0 flex-1 truncate">{ex.name}</span>
                  <Button
                    variant="text"
                    onClick={() => setArchived(ex.id, false)}
                    disabled={movingId === ex.id}
                    aria-label={t('coachLibraryArchive.restoreLabel', { name: ex.name })}
                  >
                    {t('parcLibrary.restore')}
                  </Button>
                  <Button
                    variant="text"
                    className="text-red"
                    onClick={() => setDeleting(ex)}
                    aria-label={t('parcLibrary.deleteLabel', { name: ex.name })}
                  >
                    {t('parcLibrary.delete')}
                  </Button>
                </li>
              ))}
          </ul>
          {showArchived && <p className="pk-caption">{t('coachLibraryArchive.drawerHint')}</p>}
        </section>
      )}

      {/* What can be done to an exercise, from its ⋯: edit it, archive it,
          delete it — which first reads where it is used. */}
      <Sheet
        open={!!target}
        onClose={() => setActionsFor(null)}
        title={target?.name}
        description={target ? exerciseFacts(target, ctx) : undefined}
      >
        {target && (
          <ul className="pk-group">
            <Row
              title={t('parcLibrary.edit')}
              chevron={false}
              onClick={() => {
                setActionsFor(null);
                setEditingId(target.id);
              }}
            />
            <Row
              title={t('parcLibrary.archive')}
              chevron={false}
              disabled={movingId === target.id}
              aria-label={t('coachLibraryArchive.archiveLabel', { name: target.name })}
              onClick={() => {
                setActionsFor(null);
                setArchived(target.id, true);
              }}
            />
            <Row
              title={<span className="text-red">{t('parcLibrary.delete')}</span>}
              chevron={false}
              aria-label={t('parcLibrary.deleteLabel', { name: target.name })}
              onClick={() => {
                setActionsFor(null);
                setDeleting(target);
              }}
            />
          </ul>
        )}
      </Sheet>

      <Sheet open={showAdd} onClose={() => setShowAdd(false)} title={t('parcLibrary.newTitle')}>
        <ExerciseForm
          onSubmit={handleCreate}
          onCancel={() => setShowAdd(false)}
          submitLabel={t('parcLibrary.create')}
          pending={createExercise.isPending}
          pendingLabel={t('parcLibrary.creating')}
        />
      </Sheet>

      <Sheet open={!!editing} onClose={() => setEditingId(null)} title={t('parcLibrary.editTitle')}>
        {editing && (
          <ExerciseForm
            key={editing.id}
            initial={editing}
            onSubmit={(vals) => handleUpdate(editing.id, vals)}
            onCancel={() => setEditingId(null)}
            submitLabel={t('parcLibrary.save')}
            pending={updateExercise.isPending}
            pendingLabel={t('common.saving')}
          />
        )}
      </Sheet>

      <ExerciseDeleteDialog
        exercise={deleting}
        onClose={() => setDeleting(null)}
        onDelete={(id) => deleteExercise.mutate(id)}
        onArchive={(id) => setArchived(id, true)}
      />
    </div>
  );
}
