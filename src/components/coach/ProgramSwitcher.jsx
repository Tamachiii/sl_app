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
import { formatNumber } from '../../lib/i18n/format';
import { Button, Icon, IconButton } from '../parc';
import { ActiveBadge, ActiveDot, DraftBadge } from './ProgramBadges';
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

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-stretch rounded-control ${isSelected ? 'bg-blue-soft' : 'hover:bg-fill'}`}
    >
      <button
        type="button"
        role="option"
        aria-selected={isSelected}
        onClick={onSelect}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2 bg-transparent px-3 text-left"
      >
        <span className="pk-headline truncate">{program.name}</span>
        {program.is_active && <ActiveBadge t={t} />}
        {program.status === 'draft' && <DraftBadge submitted={!!program.submitted_at} t={t} />}
      </button>
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={t('parcProgram.moveBlock', { name: program.name })}
        className="pk-icon-btn shrink-0 cursor-grab touch-none bg-transparent active:cursor-grabbing"
      >
        <Icon name="drag" size={22} />
      </button>
    </div>
  );
}

export default function ProgramSwitcher({ studentId, programs, selectedId, onSelect, onProgramDeleted }) {
  const { t, lang } = useI18n();
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
  // One athlete for as long as the switcher is mounted (`key={studentId}` in
  // its parent): the hook's reorders wait in a queue named after the athlete,
  // and a hook whose athlete changed under it would lose the one it has
  // waiting.
  const reorderPrograms = useReorderPrograms(studentId);

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
        {/* The block's name is the headline of everything below it, so it
            gets the row; being in progress is a dot, and the actions on the
            list of blocks — a new one, the trash — live in the list. */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsOpen((v) => !v)}
            aria-haspopup="listbox"
            aria-expanded={isOpen}
            aria-label={t('parcProgram.blockPicker')}
            className="flex min-h-11 min-w-0 flex-1 items-center gap-2 bg-transparent text-left"
          >
            <span className="pk-title truncate">{selected?.name ?? '–'}</span>
            {selected?.is_active && <ActiveDot t={t} />}
            {selected?.status === 'draft' && <DraftBadge submitted={!!selected.submitted_at} t={t} />}
            <Icon
              name="chevron-down"
              size={18}
              className={`shrink-0 text-ink-2 transition-transform ${isOpen ? 'rotate-180' : ''}`}
            />
          </button>

          <IconButton
            icon="more"
            label={t('parcProgram.blockOptions')}
            onClick={() => setManageOpen(true)}
            disabled={!selected}
          />
        </div>

        {isOpen && (
          <div
            role="listbox"
            aria-label={t('parcProgram.blockPicker')}
            className="absolute top-full right-0 left-0 z-20 mt-1 overflow-hidden rounded-group border border-line bg-surface p-1 shadow-lg"
          >
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <div className="flex max-h-[60vh] flex-col gap-0.5 overflow-y-auto">
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
            <div className="mt-1 flex flex-wrap items-center gap-x-2 border-t border-line pt-1">
              <Button
                variant="text"
                onClick={() => {
                  setIsOpen(false);
                  handleAdd();
                }}
                disabled={createProgram.isPending}
              >
                <Icon name="plus" size={18} />
                {t('parcProgram.newBlock')}
              </Button>
              {trashedPrograms.length > 0 && (
                <Button
                  variant="text"
                  onClick={() => {
                    setIsOpen(false);
                    setTrashOpen(true);
                  }}
                >
                  {t('parcProgram.trashCount', { n: formatNumber(lang, trashedPrograms.length) })}
                </Button>
              )}
            </div>
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
