import { useCallback, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { DAY_FULL, DAY_LABELS } from '../../lib/day';
import PortalMenu, { anchorOf, MENU_PADDING } from './PortalMenu';

// The rows of the program sheet, lifted out of ProgramSheet when the block
// became one continuous list: the sheet itself is now about phases, drag and
// modes, and a row knows nothing about any of that beyond the flags it is
// handed.

// The weekday picker: seven days and "none", 44px each, in two rows of four —
// eight in one row is 352px plus the gaps, wider than a phone.
const DAY_CELL = 44;
const DAY_GAP = 4;
const DAY_GRID_WIDTH = 4 * DAY_CELL + 3 * DAY_GAP + MENU_PADDING;
const DAY_GRID_HEIGHT = 2 * DAY_CELL + DAY_GAP + MENU_PADDING;

const PILL_LOOK =
  'sl-mono text-[10px] font-semibold px-1.5 py-1 rounded bg-ink-100 text-ink-700 transition-colors w-10 text-center';

// `readOnly`: the recommended day, drawn and not offered — a draft's.
export function DayPill({ session, onPick, readOnly = false, t }) {
  const [anchor, setAnchor] = useState(null);
  const triggerRef = useRef(null);
  const close = useCallback(() => setAnchor(null), []);
  const dn = session.day_number;
  const full = dn >= 1 && dn <= 7 ? DAY_FULL[dn - 1] : '—';

  if (readOnly) {
    return (
      <span className="h-11 min-w-11 shrink-0 flex items-center justify-center">
        <span className={PILL_LOOK}>{full.toUpperCase()}</span>
      </span>
    );
  }

  function pick(day) {
    close();
    onPick(day);
  }

  const cell = (current) =>
    `w-11 h-11 rounded sl-mono text-[10px] font-semibold transition-colors ${
      current ? 'bg-accent text-ink-900' : 'bg-ink-100 text-ink-700 hover:bg-ink-200'
    }`;

  return (
    <>
      {/* 44px to press; the pill drawn inside keeps its size. */}
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setAnchor(anchor ? null : anchorOf(e.currentTarget));
        }}
        aria-label={t('coach.sheet.setDay', { day: full })}
        aria-expanded={!!anchor}
        className="group h-11 min-w-11 shrink-0 flex items-center justify-center"
      >
        <span className={`${PILL_LOOK} group-hover:bg-ink-200`}>
          {full.toUpperCase()}
        </span>
      </button>
      {anchor && (
        <PortalMenu
          anchor={anchor}
          height={DAY_GRID_HEIGHT}
          width={DAY_GRID_WIDTH}
          align="start"
          onClose={close}
          returnFocus={triggerRef}
          label={t('coach.sheet.setDay', { day: full })}
          className="grid grid-cols-4 gap-1"
        >
          {DAY_LABELS.map((d, i) => (
            <button
              key={i}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                pick(i + 1);
              }}
              aria-label={DAY_FULL[i]}
              aria-current={dn === i + 1}
              className={cell(dn === i + 1)}
            >
              {d}
            </button>
          ))}
          {/* Clearing the day is a real choice now that a weekday is only a
              recommendation: plenty of sessions shouldn't suggest one. */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              pick(null);
            }}
            aria-label={t('coach.sheet.clearDay')}
            aria-current={!(dn >= 1 && dn <= 7)}
            className={cell(!(dn >= 1 && dn <= 7))}
          >
            —
          </button>
        </PortalMenu>
      )}
    </>
  );
}

// A session row while the block is in reorder mode. Keeps its TITLE — the
// phase-reorder mode blanks its rows, which makes you drag anonymous bars — and
// drops every other control so a drag can't be a mis-tap on the day pill.
//
// `position` is the row's place in the WHOLE block, not in its phase: with one
// continuous list that is the number the coach is actually looking at.
export function SortableSessionRow({ session, position, t }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: session.id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className="flex items-center gap-2 min-h-11 px-3 border-t border-ink-100 bg-ink-50"
    >
      <button
        {...attributes}
        {...listeners}
        aria-label={t('coach.sheet.reorderSession', { name: session.title || String(position) })}
        className="w-11 h-11 -ml-3 flex items-center justify-center text-ink-400 hover:text-ink-700 cursor-grab active:cursor-grabbing touch-none shrink-0"
      >
        <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
          <circle cx="2.5" cy="3" r="1.25" /><circle cx="7.5" cy="3" r="1.25" />
          <circle cx="2.5" cy="8" r="1.25" /><circle cx="7.5" cy="8" r="1.25" />
          <circle cx="2.5" cy="13" r="1.25" /><circle cx="7.5" cy="13" r="1.25" />
        </svg>
      </button>
      <span className="sl-display text-[14px] text-gray-900 truncate flex-1">
        {session.title || t('coach.week.sessionN', { n: position })}
      </span>
      <span className="sl-mono text-[10px] text-ink-400 shrink-0">
        {t('coach.week.exCount', { n: (session.exercise_slots || []).length })}
      </span>
    </div>
  );
}

// No delete control here on purpose: a destructive icon on every row of the
// main authoring surface is both visual noise and a mis-tap waiting to happen
// on a phone. Deleting a session lives in the session editor, where the coach
// has already committed to that one session.
//
// Duplicate is a different matter and does belong here: building a block is a
// run of near-identical sessions, and doing it from the editor costs two
// navigations per copy. It is non-destructive, so a mis-tap is cheap.
//
// `confirmed` — the athlete confirmed the session. `trained` — they logged at
// least one set in it. Either one means the row's subject is no longer a plan
// to write but a workout to read, so the row opens the REVIEW (which carries
// the way into the editor) instead of the editor. It used to open the editor
// for every row, ✓ ones included: the coach's main daily task was two tabs
// away from the page listing the sessions, and one tap away from deleting them.
//
// `readOnly` — the block is an athlete's draft, theirs until the coach
// approves it: the row opens the session (the editor is read-only too) and
// offers no write, neither the day nor a duplicate.
export default function SessionRow({
  session, studentId, confirmed, trained, position, onSetDay, onDuplicate, duplicating,
  selecting, selected, onToggleSelect, readOnly = false, t,
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const exCount = (session.exercise_slots || []).length;
  const opensReview = !!(confirmed || trained);

  function open() {
    if (!opensReview) {
      navigate(`/coach/students/${studentId}/s/${session.id}`);
      return;
    }
    // `from` is what the review's back button returns to — this sheet, on the
    // block it is showing (`?program=`), not the sessions feed.
    navigate(`/coach/student/${studentId}/session/${session.id}/review`, {
      state: { from: location.pathname + location.search },
    });
  }

  // In select mode the whole row is the checkbox target: a 44px-wide tick box
  // beside a 44px-wide day pill on a phone is two things to miss.
  if (selecting) {
    return (
      <button
        type="button"
        onClick={onToggleSelect}
        aria-pressed={selected}
        className={`w-full flex items-center gap-3 min-h-11 px-3 py-2 border-t border-ink-100 text-left transition-colors ${
          selected ? 'bg-ink-100' : 'hover:bg-ink-50'
        }`}
      >
        <span
          aria-hidden="true"
          className="w-4 h-4 rounded shrink-0 flex items-center justify-center border"
          style={
            selected
              ? { background: 'var(--color-accent)', borderColor: 'var(--color-accent)' }
              : { borderColor: 'var(--color-ink-200)' }
          }
        >
          {selected && (
            <svg className="w-2.5 h-2.5 text-ink-900" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
          )}
        </span>
        <span className="sl-display text-[14px] text-gray-900 truncate flex-1">
          {session.title || t('coach.week.sessionN', { n: position })}
        </span>
        <span className="sl-mono text-[10px] text-ink-400 shrink-0">
          {t('coach.week.exCount', { n: exCount })}
        </span>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 min-h-11 px-3 border-t border-ink-100">
      <DayPill session={session} onPick={onSetDay} readOnly={readOnly} t={t} />
      <button
        type="button"
        onClick={open}
        aria-label={opensReview ? t('coachLoggedHistory.sheet.openReview') : t('coach.week.openSession')}
        // The whole height of the row, between the day pill and the duplicate
        // button: it was the height of its text, 15px, with a write on either
        // side of it (live review N15).
        className="flex-1 min-w-0 self-stretch min-h-11 text-left flex items-center group"
      >
        <span className="min-w-0 flex items-baseline gap-2">
          <span className="sl-display text-[14px] text-gray-900 truncate group-hover:text-[var(--color-accent)] transition-colors">
            {/* Position in the list, not the weekday: day_number is optional
                advice now, so an untitled session must not be named after it. */}
            {session.title || t('coach.week.sessionN', { n: position })}
          </span>
          <span className="sl-mono text-[10px] text-ink-400 shrink-0">
            {t('coach.week.exCount', { n: exCount })}
          </span>
        </span>
      </button>
      {/* Started, not confirmed: a hollow ring where the ✓ will be, so the row
          says why it opens the review and not the editor. */}
      {trained && !confirmed && (
        <span
          role="img"
          aria-label={t('coachLoggedHistory.sheet.inProgress')}
          title={t('coachLoggedHistory.sheet.inProgress')}
          className="w-4 h-4 rounded-full shrink-0 border-2"
          style={{ borderColor: 'var(--color-success)' }}
        />
      )}
      {confirmed && (
        <span
          aria-label={t('coach.week.confirmedByStudent')}
          title={t('coach.week.confirmedByStudent')}
          className="w-4 h-4 rounded-full flex items-center justify-center shrink-0"
          style={{ background: 'var(--color-success)', color: 'var(--color-ink-900)' }}
        >
          <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
        </span>
      )}
      {!readOnly && (
        <button
          type="button"
          onClick={onDuplicate}
          disabled={duplicating}
          aria-label={t('coach.sheet.duplicateSession')}
          title={t('coach.sheet.duplicateSession')}
          className="w-11 h-11 -mr-2 rounded-lg text-ink-400 hover:bg-ink-100 hover:text-ink-700 flex items-center justify-center transition-colors shrink-0 disabled:opacity-40"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="9" y="9" width="11" height="11" rx="2" strokeWidth={2} />
            <path strokeWidth={2} strokeLinecap="round" d="M5 15V5a2 2 0 0 1 2-2h10" />
          </svg>
        </button>
      )}
    </div>
  );
}
