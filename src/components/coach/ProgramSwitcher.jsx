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
  useReorderPrograms,
  useTrashedPrograms,
} from '../../hooks/useProgram';
import { useI18n } from '../../hooks/useI18n';
import { ActiveBadge, DraftBadge } from './ProgramBadges';
import ManageProgramDialog from './ProgramManageDialog';
import TrashDialog from './ProgramTrashDialog';

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
          {program.status === 'draft' && <DraftBadge submitted={!!program.submitted_at} t={t} />}
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

export default function ProgramSwitcher({ studentId, programs, selectedId, onSelect, onProgramDeleted }) {
  const { t } = useI18n();
  // Mirrors the `programs` prop so a drag reorders the list on the frame the
  // pointer moves. useReorderPrograms does write the same order optimistically,
  // but only after an awaited cancelQueries, which is a tick too late — without
  // this the dragged row snaps back before the cache update lands.
  const [localPrograms, setLocalPrograms] = useState(programs || []);
  const [isOpen, setIsOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  // Trash is a rarely-used corner: only fetch the trashed list once the coach
  // actually opens the program dropdown (where the entry point lives), not on
  // every Programming-tab visit. TrashDialog fetches for itself when it mounts.
  const { data: trashedPrograms = [] } = useTrashedPrograms(studentId, { enabled: isOpen });
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
                {selected?.status === 'draft' && <DraftBadge submitted={!!selected.submitted_at} t={t} />}
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
            className="absolute left-0 right-0 top-full mt-1 z-20 rounded-lg bg-white border border-ink-200 shadow-lg overflow-hidden"
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
            {trashedPrograms.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setIsOpen(false);
                  setTrashOpen(true);
                }}
                className="w-full text-left px-3 py-2 sl-mono text-[11px] text-ink-400 border-t border-ink-200 hover:bg-ink-100 transition-colors"
              >
                {t('coach.home.trashCount', { n: trashedPrograms.length })}
              </button>
            )}
          </div>
        )}
      </div>

      {trashOpen && (
        <TrashDialog studentId={studentId} t={t} onClose={() => setTrashOpen(false)} />
      )}

      {manageOpen && selected && (
        <ManageProgramDialog
          program={selected}
          studentId={studentId}
          t={t}
          onClose={() => setManageOpen(false)}
          onDeleted={onProgramDeleted}
          onDuplicated={(id) => { if (id) onSelect(id); }}
        />
      )}
    </>
  );
}
