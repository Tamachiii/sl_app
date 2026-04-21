import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
  horizontalListSortingStrategy,
  useSortable,
  sortableKeyboardCoordinates,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useCreateWeek } from '../../hooks/useProgram';
import { useReorderWeeks } from '../../hooks/useWeek';

function SortableWeek({ week, studentId }) {
  const navigate = useNavigate();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: week.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="shrink-0 flex items-stretch rounded-lg bg-ink-100 overflow-hidden"
    >
      <button
        onClick={() => navigate(`/coach/student/${studentId}/week/${week.id}`)}
        className="pl-3 pr-2 py-2 text-left transition-colors hover:bg-ink-200"
      >
        <span className="sl-display text-[13px] text-gray-900 block leading-tight">
          W{week.week_number}
        </span>
        {week.label && (
          <span className="sl-mono text-[10px] text-ink-400 block mt-0.5">{week.label}</span>
        )}
      </button>
      <button
        {...attributes}
        {...listeners}
        aria-label={`Reorder week ${week.week_number}`}
        className="px-2 text-ink-400 hover:text-gray-700 hover:bg-ink-200 cursor-grab active:cursor-grabbing touch-none"
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
    </div>
  );
}

export default function WeekTimeline({ studentId, program }) {
  const createWeek = useCreateWeek();
  const reorderWeeks = useReorderWeeks();
  const [localWeeks, setLocalWeeks] = useState(program.weeks || []);

  useEffect(() => {
    setLocalWeeks(program.weeks || []);
  }, [program.weeks]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleAddWeek() {
    const nextNum = localWeeks.length > 0
      ? Math.max(...localWeeks.map((w) => w.week_number)) + 1
      : 1;
    createWeek.mutate({ programId: program.id, weekNumber: nextNum });
  }

  function handleDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIdx = localWeeks.findIndex((w) => w.id === active.id);
    const newIdx = localWeeks.findIndex((w) => w.id === over.id);
    if (oldIdx === -1 || newIdx === -1) return;

    const reordered = arrayMove(localWeeks, oldIdx, newIdx).map((w, i) => ({
      ...w,
      week_number: i + 1,
    }));
    setLocalWeeks(reordered);
    reorderWeeks.mutate({
      programId: program.id,
      orderedIds: reordered.map((w) => w.id),
    });
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        <SortableContext
          items={localWeeks.map((w) => w.id)}
          strategy={horizontalListSortingStrategy}
        >
          {localWeeks.map((w) => (
            <SortableWeek key={w.id} week={w} studentId={studentId} />
          ))}
        </SortableContext>
        <button
          onClick={handleAddWeek}
          disabled={createWeek.isPending}
          className="shrink-0 border border-dashed border-ink-200 text-ink-400 rounded-lg px-3 py-2 sl-mono text-[11px] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors"
        >
          + WEEK
        </button>
      </div>
    </DndContext>
  );
}
