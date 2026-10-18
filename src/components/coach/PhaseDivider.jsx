import { useCallback, useId, useRef, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { phaseDropId } from '../../lib/sessionMove';
import { useI18n } from '../../hooks/useI18n';
import { formatNumber, pluralKey } from '../../lib/i18n/format';
import EditableText from '../ui/EditableText';
import { Icon, IconButton } from '../parc';
import PortalMenu, { anchorOf, MENU_PADDING } from './PortalMenu';

/**
 * The head of a phase in the block's list (design/parc/screens/
 * Programme.dc.html): its name as a heading, the places its sessions hold in
 * the block (« Séances 9 à 16 »), and its ⋯.
 *
 * This is what a `weeks` row became. It carries NO number: the coach asked for
 * free names, and a number was the thing that made a week feel like a
 * container with a fixed length. An unnamed phase is still drawn — « Phase
 * sans nom » — because the boundary is real: it is a different `week_id`, and
 * it is what a session is dragged across.
 *
 * It is also a drop target, which is the only way to reach a phase with no
 * sessions to aim at.
 */

// One item of a menu: 44px tall, on one line — the menu's height is counted
// from it (`PortalMenu`), so an item must not wrap.
const ITEM_HEIGHT = 44;
const MENU_WIDTH = 240;

// « Séances 9 à 16 », « Séance 9 », « Pas encore de séance ».
export function phaseRangeText(range, { t, lang }) {
  if (!range) return t('parcProgram.phaseEmpty');
  if (range.from === range.to) return t('parcProgram.phaseOne', { n: formatNumber(lang, range.from) });
  return t('parcProgram.phaseRange', { from: formatNumber(lang, range.from), to: formatNumber(lang, range.to) });
}

function PhaseMenu({ onAddSession, onDuplicate, onCopy, onDelete, onReorder, canReorder }) {
  const { t } = useI18n();
  const [anchor, setAnchor] = useState(null);
  const triggerRef = useRef(null);
  const close = useCallback(() => setAnchor(null), []);

  const items = [
    { label: t('parcProgram.addSession'), fn: onAddSession, danger: false },
    { label: t('parcProgram.duplicatePhase'), fn: onDuplicate, danger: false },
    { label: t('parcProgram.copyTo'), fn: onCopy, danger: false },
    ...(canReorder ? [{ label: t('parcProgram.reorderPhases'), fn: onReorder, danger: false }] : []),
    { label: t('parcProgram.deletePhase'), fn: onDelete, danger: true },
  ];

  return (
    <>
      <IconButton
        ref={triggerRef}
        icon="more"
        tone="none"
        label={t('parcProgram.phaseMenu')}
        aria-expanded={!!anchor}
        onClick={(e) => {
          e.stopPropagation();
          // Read here, at the tap: where the trigger is decides where the
          // menu goes, and nothing is measured once it is drawn.
          setAnchor(anchor ? null : anchorOf(e.currentTarget));
        }}
      />
      {anchor && (
        <PortalMenu
          anchor={anchor}
          height={items.length * ITEM_HEIGHT + MENU_PADDING}
          width={MENU_WIDTH}
          align="end"
          onClose={close}
          returnFocus={triggerRef}
          label={t('parcProgram.phaseMenu')}
          className="flex min-w-[240px] flex-col"
        >
          {items.map(({ label, fn, danger }) => (
            <button
              key={label}
              type="button"
              onClick={(e) => { e.stopPropagation(); close(); fn(); }}
              className={`min-h-11 truncate rounded-control px-3 text-left text-[15px] font-semibold hover:bg-fill ${
                danger ? 'text-red' : 'text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </PortalMenu>
      )}
    </>
  );
}

// While phases are being reordered a phase is one row — its name, how many
// sessions it holds, the handle — and its sessions are hidden: dragging a
// header that carries its whole phase with it is legible, dragging it past
// twenty rows of that phase is not.
export function SortablePhaseDivider({ week, sessionCount }) {
  const { t, lang } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: week.id });
  const name = week.label || t('parcProgram.phaseUnnamed');

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className="pk-row bg-surface"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={`pk-headline truncate ${week.label ? '' : 'text-ink-2'}`}>{name}</span>
        <span className="pk-caption">
          {t(pluralKey(lang, sessionCount, 'parcProgram.sessionsCount'), { n: formatNumber(lang, sessionCount) })}
        </span>
      </span>
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={t('parcProgram.moveItem', { name })}
        className="pk-icon-btn shrink-0 cursor-grab touch-none bg-transparent active:cursor-grabbing"
      >
        <Icon name="drag" size={22} />
      </button>
    </li>
  );
}

// `readOnly` — the block is an athlete's draft: the head shows the name and
// the places, and offers no rename and no menu (every item of it writes, or
// copies into a block the sheet could pick as this very draft).
// `action` — while the sheet is in a mode (choosing, reordering), what stands
// at the right of the head in place of its menu: « Done » on the first phase,
// nothing (null) on the others. Left out, the head carries its menu.
export default function PhaseDivider({
  week, titleId, range, canReorder, onRename,
  onAddSession, onDuplicate, onCopy, onDelete, onReorder, readOnly = false, action,
}) {
  const ctx = useI18n();
  const { t } = ctx;
  const { setNodeRef, isOver } = useDroppable({ id: phaseDropId(week.id) });
  const hintId = useId();

  return (
    <div
      ref={setNodeRef}
      className={`flex items-center gap-2 rounded-control transition-colors ${isOver ? 'bg-blue-soft' : ''}`}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <h2 id={titleId} className="pk-headline min-w-0">
          {readOnly ? (
            <span className={week.label ? '' : 'text-ink-2'}>{week.label || t('parcProgram.phaseUnnamed')}</span>
          ) : (
            <>
              {/* The heading is named by the phase; what a tap does is its
                  description, and the field's name once it is open. */}
              <EditableText
                value={week.label || ''}
                onSave={onRename}
                placeholder={t('parcProgram.phaseUnnamed')}
                ariaLabel={false}
                describedBy={hintId}
                className="min-h-11 max-w-full truncate"
              />
              <span id={hintId} hidden>
                {t('parcProgram.phaseRename')}
              </span>
            </>
          )}
        </h2>
        <span className="pk-caption">{phaseRangeText(range, ctx)}</span>
      </div>
      {action !== undefined ? action : !readOnly && (
        <PhaseMenu
          canReorder={canReorder}
          onReorder={onReorder}
          onAddSession={onAddSession}
          onDuplicate={onDuplicate}
          onCopy={onCopy}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}
