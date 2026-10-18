import { useEffect, useId, useState } from 'react';
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
import { Button, Icon, IconButton, LargeTitle, Sheet } from '../parc';
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

/**
 * The athlete page's title, which is the block on screen
 * (design/parc/screens/Programme.dc.html): the block's name is the page's h1,
 * a tap on it opens the sheet of the athlete's blocks, and the round ⋯ at its
 * right opens the block's options.
 *
 * `titleProps` is the frame `CoachHome` hands its athlete pages — the way back
 * to the roster and the account menu — and `subtitle` the line under the name,
 * which the page writes: the athlete, then what the block is. `athleteName`
 * names the sheet.
 */
export default function ProgramSwitcher({
  studentId,
  programs,
  selectedId,
  onSelect,
  onProgramDeleted,
  athleteName,
  titleProps,
  subtitle,
}) {
  const { t, lang } = useI18n();
  const hintId = useId();
  // Mirrors the `programs` prop so a drag reorders the list on the frame the
  // pointer moves. useReorderPrograms does write the same order optimistically,
  // but only after an awaited cancelQueries, which is a tick too late — without
  // this the dragged row snaps back before the cache update lands.
  const [localPrograms, setLocalPrograms] = useState(programs || []);
  const [isOpen, setIsOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  // Trash is a rarely-used corner: only fetch the trashed list once the coach
  // actually opens the sheet of blocks (where the entry point lives), not on
  // every visit of the athlete. TrashDialog fetches for itself when it mounts.
  const { data: trashedPrograms = [] } = useTrashedPrograms(studentId, { enabled: isOpen });
  const createProgram = useCreateProgram();
  // One athlete for as long as the switcher is mounted (`key={studentId}` in
  // its parent): the hook's reorders wait in a queue named after the athlete,
  // and a hook whose athlete changed under it would lose the one it has
  // waiting.
  const reorderPrograms = useReorderPrograms(studentId);

  useEffect(() => {
    setLocalPrograms(programs || []);
  }, [programs]);

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
      {/* The block's name is the headline of everything below it, so it is
          the page's title; what the block is (in progress, a draft) is said by
          the line under it, and the actions on the list of blocks — a new one,
          the trash — live in the sheet. The button is named by the block, so
          the h1 stays the block; what a tap does is its description. */}
      <LargeTitle
        {...titleProps}
        title={
          <button
            type="button"
            onClick={() => setIsOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={isOpen}
            aria-describedby={hintId}
            className="flex min-h-11 max-w-full items-center gap-2 bg-transparent text-left"
          >
            <span className="min-w-0 break-words">{selected?.name ?? '–'}</span>
            <Icon name="chevron-down" size={24} className="shrink-0 text-ink-2" />
          </button>
        }
        trailing={
          <IconButton
            icon="more"
            label={t('parcProgram.blockOptions')}
            onClick={() => setManageOpen(true)}
            disabled={!selected}
            className="shrink-0"
          />
        }
        subtitle={subtitle}
      />
      <span id={hintId} hidden>
        {t('parcProgram.blockPicker')}
      </span>

      <Sheet
        open={isOpen}
        onClose={() => setIsOpen(false)}
        title={athleteName ? t('coachAthleteBlock.blocksOf', { name: athleteName }) : t('parcProgram.blockPicker')}
      >
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <div
            role="listbox"
            aria-label={t('parcProgram.blockPicker')}
            className="flex max-h-[50vh] flex-col gap-0.5 overflow-y-auto"
          >
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
        <div className="mt-2 flex flex-wrap items-center gap-x-2 border-t border-line pt-2">
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
      </Sheet>

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
