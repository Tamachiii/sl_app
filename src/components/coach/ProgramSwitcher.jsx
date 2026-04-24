import { useEffect, useRef, useState } from 'react';
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
  useSortable,
  sortableKeyboardCoordinates,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  useCreateProgram,
  useRenameProgram,
  useDeleteProgram,
  useSetActiveProgram,
  useReorderPrograms,
} from '../../hooks/useProgram';
import { useI18n } from '../../hooks/useI18n';
import Dialog from '../ui/Dialog';

function ActiveBadge({ t }) {
  return (
    <span
      className="sl-mono text-[10px] inline-flex items-center gap-1 px-1 rounded shrink-0"
      style={{
        background: 'color-mix(in srgb, var(--color-success) 18%, transparent)',
        color: 'var(--color-success)',
      }}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />
      {t('coach.home.activeBadge')}
    </span>
  );
}

function SortableProgramRow({ program, isSelected, t, onSelect }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: program.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const weekCount = (program.weeks || []).length;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-stretch ${isSelected ? 'bg-ink-100' : ''} hover:bg-ink-100 transition-colors`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={t('coach.home.reorderProgram', { name: program.name })}
        className="px-2 text-ink-400 hover:text-gray-700 cursor-grab active:cursor-grabbing touch-none flex items-center"
      >
        <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
          <circle cx="2.5" cy="3" r="1.25" />
          <circle cx="7.5" cy="3" r="1.25" />
          <circle cx="2.5" cy="8" r="1.25" />
          <circle cx="7.5" cy="8" r="1.25" />
          <circle cx="2.5" cy="13" r="1.25" />
          <circle cx="7.5" cy="13" r="1.25" />
        </svg>
      </button>
      <button
        type="button"
        role="option"
        aria-selected={isSelected}
        onClick={onSelect}
        className="flex-1 min-w-0 pr-3 py-2 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="sl-display text-[13px] text-gray-900 truncate">
            {program.name}
          </span>
          {program.is_active && <ActiveBadge t={t} />}
        </div>
        {weekCount > 0 && (
          <span className="sl-mono text-[10px] text-ink-400 block mt-0.5">
            {t(weekCount === 1 ? 'coach.home.weeksOne' : 'coach.home.weeksMany', { n: weekCount }).toUpperCase()}
          </span>
        )}
      </button>
    </div>
  );
}

function ManageProgramDialog({ program, programCount, studentId, t, onClose, onDeleted }) {
  const [name, setName] = useState(program?.name ?? '');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const rename = useRenameProgram();
  const setActive = useSetActiveProgram();
  const del = useDeleteProgram();

  useEffect(() => {
    setName(program?.name ?? '');
    setConfirmingDelete(false);
  }, [program?.id]);

  if (!program) return null;

  const trimmed = name.trim();
  const dirty = trimmed && trimmed !== program.name;
  // Block deleting the active program when others exist (student would have
  // zero active programs). The sole-program case is fine — useEnsureProgram
  // respawns a default on the next coach visit.
  const canDelete = !program.is_active || programCount <= 1;

  function handleRename() {
    if (!dirty) return;
    rename.mutate(
      { programId: program.id, studentId, name: trimmed },
      { onSuccess: () => onClose() },
    );
  }

  function handleSetActive() {
    setActive.mutate(
      { programId: program.id, studentId },
      { onSuccess: () => onClose() },
    );
  }

  function handleDelete() {
    del.mutate(
      { programId: program.id, studentId },
      {
        onSuccess: () => {
          setConfirmingDelete(false);
          onDeleted?.(program.id);
          onClose();
        },
      },
    );
  }

  return (
    <Dialog open={true} onClose={onClose} title={t('coach.home.manageProgram')}>
      <div className="space-y-4">
        <label className="block">
          <span className="sl-label text-ink-400 block mb-1.5">
            {t('coach.home.programNameLabel')}
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 sl-mono text-[16px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
          />
        </label>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={handleRename}
            disabled={!dirty || rename.isPending}
            className="sl-btn-primary w-full text-[13px] disabled:opacity-50"
            style={{ padding: '10px 16px' }}
          >
            {rename.isPending ? t('common.saving') : t('coach.home.rename')}
          </button>

          {!program.is_active && (
            <button
              type="button"
              onClick={handleSetActive}
              disabled={setActive.isPending}
              className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200 w-full justify-center disabled:opacity-50"
            >
              {setActive.isPending ? t('common.saving') : t('coach.home.setActive')}
            </button>
          )}

          {confirmingDelete ? (
            <div
              className="rounded-lg p-3 space-y-2"
              style={{
                background: 'color-mix(in srgb, var(--color-danger) 10%, transparent)',
                border: '1px solid color-mix(in srgb, var(--color-danger) 35%, transparent)',
              }}
            >
              <p className="text-[13px] text-gray-900">
                {t('coach.home.confirmDeleteProgram', { name: program.name })}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={del.isPending}
                  className="flex-1 rounded-lg py-2 sl-mono text-[12px] text-white disabled:opacity-50"
                  style={{ background: 'var(--color-danger)' }}
                >
                  {del.isPending ? t('common.saving') : t('coach.home.delete').toUpperCase()}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="flex-1 sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200 justify-center"
                >
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              disabled={!canDelete}
              title={!canDelete ? t('coach.home.cannotDeleteActive') : undefined}
              className="sl-pill w-full justify-center disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: 'color-mix(in srgb, var(--color-danger) 10%, transparent)',
                color: 'var(--color-danger)',
              }}
            >
              {t('coach.home.delete')}
            </button>
          )}

          {!canDelete && (
            <p className="sl-mono text-[11px] text-ink-400">
              {t('coach.home.cannotDeleteActive')}
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}

export default function ProgramSwitcher({ studentId, programs, selectedId, onSelect, onProgramDeleted }) {
  const { t } = useI18n();
  const [localPrograms, setLocalPrograms] = useState(programs || []);
  const [isOpen, setIsOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const wrapperRef = useRef(null);
  const createProgram = useCreateProgram();
  const reorderPrograms = useReorderPrograms();

  useEffect(() => {
    setLocalPrograms(programs || []);
  }, [programs]);

  useEffect(() => {
    if (!isOpen) return undefined;
    function handleDocDown(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    }
    function handleKey(e) {
      if (e.key === 'Escape') setIsOpen(false);
    }
    document.addEventListener('mousedown', handleDocDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleDocDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [isOpen]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const selected = localPrograms.find((p) => p.id === selectedId)
    ?? localPrograms.find((p) => p.is_active)
    ?? localPrograms[0]
    ?? null;
  const selectedWeekCount = (selected?.weeks || []).length;

  function handleAdd() {
    const nextNum = localPrograms.length + 1;
    const defaultName = t('coach.home.defaultProgramName', { n: nextNum });
    createProgram.mutate(
      { studentId, name: defaultName, setActive: false },
      {
        onSuccess: (newProg) => {
          if (newProg?.id) onSelect(newProg.id);
        },
      },
    );
  }

  function handleDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIdx = localPrograms.findIndex((p) => p.id === active.id);
    const newIdx = localPrograms.findIndex((p) => p.id === over.id);
    if (oldIdx === -1 || newIdx === -1) return;

    const reordered = arrayMove(localPrograms, oldIdx, newIdx).map((p, i) => ({
      ...p,
      sort_order: i,
    }));
    setLocalPrograms(reordered);
    reorderPrograms.mutate({ studentId, orderedIds: reordered.map((p) => p.id) });
  }

  function pickProgram(id) {
    onSelect(id);
    setIsOpen(false);
  }

  return (
    <>
      <div ref={wrapperRef} className="relative">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsOpen((v) => !v)}
            aria-haspopup="listbox"
            aria-expanded={isOpen}
            aria-label={t('coach.home.selectProgram')}
            className="flex-1 min-w-0 flex items-center gap-2 pl-3 pr-2 py-2 rounded-lg bg-ink-100 hover:bg-ink-200 transition-colors"
          >
            <div className="min-w-0 flex-1 text-left">
              <div className="flex items-center gap-2">
                <span className="sl-display text-[14px] md:text-[15px] text-gray-900 truncate">
                  {selected?.name ?? '—'}
                </span>
                {selected?.is_active && <ActiveBadge t={t} />}
              </div>
              {selected && (
                <span className="sl-mono text-[10px] text-ink-400 block mt-0.5">
                  {t(
                    selectedWeekCount === 1 ? 'coach.home.weeksOne' : 'coach.home.weeksMany',
                    { n: selectedWeekCount },
                  ).toUpperCase()}
                </span>
              )}
            </div>
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              aria-hidden="true"
              className={`shrink-0 text-ink-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
            >
              <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          <button
            type="button"
            onClick={handleAdd}
            disabled={createProgram.isPending}
            aria-label={t('coach.home.addProgram')}
            className="shrink-0 rounded-lg border border-dashed border-ink-200 text-ink-400 px-3 py-2 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors disabled:opacity-50"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M7 1.5V12.5M1.5 7H12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>

          <button
            type="button"
            onClick={() => setManageOpen(true)}
            disabled={!selected}
            aria-label={t('coach.home.programMenu')}
            className="shrink-0 rounded-lg bg-ink-100 text-ink-700 px-3 py-2 hover:bg-ink-200 transition-colors disabled:opacity-40"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
              <circle cx="3" cy="7" r="1.4" />
              <circle cx="7" cy="7" r="1.4" />
              <circle cx="11" cy="7" r="1.4" />
            </svg>
          </button>
        </div>

        {isOpen && (
          <div
            role="listbox"
            className="absolute left-0 right-0 top-full mt-1 z-20 rounded-lg bg-white shadow-lg overflow-hidden"
            style={{ border: '1px solid var(--color-ink-200)' }}
          >
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <div className="py-1 max-h-[60vh] overflow-y-auto">
                <SortableContext
                  items={localPrograms.map((p) => p.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {localPrograms.map((p) => (
                    <SortableProgramRow
                      key={p.id}
                      program={p}
                      isSelected={p.id === (selected?.id ?? null)}
                      t={t}
                      onSelect={() => pickProgram(p.id)}
                    />
                  ))}
                </SortableContext>
              </div>
            </DndContext>
          </div>
        )}
      </div>

      {manageOpen && selected && (
        <ManageProgramDialog
          program={selected}
          programCount={localPrograms.length}
          studentId={studentId}
          t={t}
          onClose={() => setManageOpen(false)}
          onDeleted={onProgramDeleted}
        />
      )}
    </>
  );
}
