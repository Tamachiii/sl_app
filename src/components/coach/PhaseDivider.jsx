import { useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { phaseDropId } from '../../lib/sessionMove';
import EditableText from '../ui/EditableText';

/**
 * A phase boundary inside the block's single list.
 *
 * This is what a `weeks` row became. It carries NO number: the coach asked for
 * free names, and a number was the thing that made a week feel like a container
 * with a fixed length — the very idea the queue refactor removed. An unnamed
 * phase still draws its rule, because the boundary is real (it is a different
 * `week_id`, and it is what a session is dragged across); it simply says
 * nothing. Half the phases in production are unnamed, so hiding those dividers
 * would silently merge them into their neighbours.
 *
 * It is also a drop target, which is the only way to reach a phase with no
 * sessions to aim at.
 */

function PhaseMenu({ onAddSession, onDuplicate, onCopy, onDelete, onReorder, canReorder, t }) {
  const [open, setOpen] = useState(false);

  const items = [
    { label: t('coach.week.addSession'), fn: onAddSession, danger: false },
    { label: t('coach.week.duplicate'), fn: onDuplicate, danger: false },
    { label: t('coach.week.copyTo'), fn: onCopy, danger: false },
    ...(canReorder ? [{ label: t('coach.sheet.reorderPhases'), fn: onReorder, danger: false }] : []),
    { label: t('coach.sheet.deletePhase'), fn: onDelete, danger: true },
  ];

  return (
    <span className="relative shrink-0">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-label={t('coach.sheet.phaseMenu')}
        aria-expanded={open}
        className="w-7 h-7 rounded-lg text-ink-400 hover:bg-ink-100 hover:text-ink-700 flex items-center justify-center transition-colors"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
          <circle cx="3" cy="7" r="1.4" /><circle cx="7" cy="7" r="1.4" /><circle cx="11" cy="7" r="1.4" />
        </svg>
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            onClick={(e) => { e.stopPropagation(); setOpen(false); }}
            className="fixed inset-0 z-10 cursor-default"
          />
          <span className="absolute right-0 top-full mt-1 z-20 sl-card p-1 flex flex-col min-w-[160px]">
            {items.map(({ label, fn, danger }) => (
              <button
                key={label}
                type="button"
                onClick={(e) => { e.stopPropagation(); setOpen(false); fn(); }}
                className={`text-left px-2.5 py-1.5 rounded sl-mono text-[11px] hover:bg-ink-100 transition-colors ${
                  danger ? 'text-danger' : 'text-ink-700'
                }`}
              >
                {label}
              </button>
            ))}
          </span>
        </>
      )}
    </span>
  );
}

// While phases are being reordered the divider becomes the draggable row and
// its sessions are hidden: dragging a header that carries its whole phase with
// it is legible, dragging it past twenty rows of that phase is not.
export function SortablePhaseDivider({ week, sessionCount, t }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: week.id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className="flex items-center gap-2 px-3 py-2.5 border-t border-ink-100 first:border-t-0 bg-ink-50"
    >
      <button
        {...attributes}
        {...listeners}
        aria-label={t('coach.sheet.reorderPhase', { name: week.label || t('coach.sheet.unnamedPhase') })}
        className="text-ink-400 hover:text-ink-700 cursor-grab active:cursor-grabbing touch-none shrink-0 p-1"
      >
        <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
          <circle cx="2.5" cy="3" r="1.25" /><circle cx="7.5" cy="3" r="1.25" />
          <circle cx="2.5" cy="8" r="1.25" /><circle cx="7.5" cy="8" r="1.25" />
          <circle cx="2.5" cy="13" r="1.25" /><circle cx="7.5" cy="13" r="1.25" />
        </svg>
      </button>
      <span className="sl-display text-[13px] text-gray-900 truncate flex-1">
        {week.label || <span className="text-ink-400">{t('coach.sheet.unnamedPhase')}</span>}
      </span>
      <span className="sl-mono text-[10px] text-ink-400 shrink-0">
        {t('coach.week.sessionCount', { n: sessionCount })}
      </span>
    </div>
  );
}

export default function PhaseDivider({
  week, sessionCount, exCount, quiet, canReorder, onRename,
  onAddSession, onDuplicate, onCopy, onDelete, onReorder, t,
}) {
  const { setNodeRef, isOver } = useDroppable({ id: phaseDropId(week.id) });

  return (
    <div
      ref={setNodeRef}
      className="flex items-center gap-2 px-3 py-2 border-t border-ink-100 first:border-t-0 transition-colors"
      style={isOver ? { background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)' } : undefined}
    >
      {/* A NAMED phase is a heading and reads like one. An unnamed one is just
          a boundary, so its invitation drops out of `sl-label` — three stacked
          "NAME THIS PHASE" in caps shout louder than the sessions do. */}
      <div className="flex-1 min-w-0">
        <EditableText
          value={week.label || ''}
          onSave={onRename}
          placeholder={t('coach.sheet.phaseNamePlaceholder')}
          ariaLabel={t('coach.week.editLabelAria')}
          className={
            week.label
              ? 'sl-label text-ink-500 truncate'
              : 'sl-mono text-[10px] text-ink-300 truncate'
          }
        />
      </div>
      {/* A lone phase doesn't need its size announced — the list below IS the
          size. With several, the meta is how a coach compares them at a glance. */}
      {!quiet && (
        <span className="sl-mono text-[10px] text-ink-400 shrink-0">
          {t('coach.sheet.weekMeta', { s: sessionCount, e: exCount })}
        </span>
      )}
      <PhaseMenu
        t={t}
        canReorder={canReorder}
        onReorder={onReorder}
        onAddSession={onAddSession}
        onDuplicate={onDuplicate}
        onCopy={onCopy}
        onDelete={onDelete}
      />
    </div>
  );
}
