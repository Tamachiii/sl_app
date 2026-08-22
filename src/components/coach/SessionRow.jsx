import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { DAY_FULL, DAY_LABELS } from '../../lib/day';

// The rows of the program sheet, lifted out of ProgramSheet when the block
// became one continuous list: the sheet itself is now about phases, drag and
// modes, and a row knows nothing about any of that beyond the flags it is
// handed.

export function DayPill({ session, onPick, t }) {
  const [open, setOpen] = useState(false);
  const dn = session.day_number;
  const label = dn >= 1 && dn <= 7 ? DAY_LABELS[dn - 1] : '—';
  const full = dn >= 1 && dn <= 7 ? DAY_FULL[dn - 1] : '—';

  return (
    <span className="relative shrink-0">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-label={t('coach.sheet.setDay', { day: full })}
        aria-expanded={open}
        className="sl-mono text-[10px] font-semibold px-1.5 py-1 rounded bg-ink-100 text-ink-700 hover:bg-ink-200 transition-colors w-10 text-center"
      >
        {full.toUpperCase()}
      </button>
      {open && (
        <>
          {/* Click-away layer; sits under the menu but over the rows. */}
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            onClick={(e) => { e.stopPropagation(); setOpen(false); }}
            className="fixed inset-0 z-10 cursor-default"
          />
          <span className="absolute left-0 top-full mt-1 z-20 flex gap-0.5 p-1 rounded-lg sl-card">
            {DAY_LABELS.map((d, i) => (
              <button
                key={i}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onPick(i + 1);
                  setOpen(false);
                }}
                aria-label={DAY_FULL[i]}
                aria-current={dn === i + 1}
                className={`w-6 h-6 rounded sl-mono text-[10px] font-semibold transition-colors ${
                  dn === i + 1
                    ? 'bg-accent text-ink-900'
                    : 'bg-ink-100 text-ink-700 hover:bg-ink-200'
                }`}
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
                onPick(null);
                setOpen(false);
              }}
              aria-label={t('coach.sheet.clearDay')}
              aria-current={!(dn >= 1 && dn <= 7)}
              className={`w-6 h-6 rounded sl-mono text-[10px] font-semibold transition-colors ${
                dn >= 1 && dn <= 7
                  ? 'bg-ink-100 text-ink-700 hover:bg-ink-200'
                  : 'bg-accent text-ink-900'
              }`}
            >
              —
            </button>
          </span>
        </>
      )}
    </span>
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
      className="flex items-center gap-2 px-3 py-2 border-t border-ink-100 bg-ink-50"
    >
      <button
        {...attributes}
        {...listeners}
        aria-label={t('coach.sheet.reorderSession', { name: session.title || String(position) })}
        className="text-ink-400 hover:text-ink-700 cursor-grab active:cursor-grabbing touch-none shrink-0 p-1"
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
export default function SessionRow({
  session, studentId, confirmed, position, onSetDay, onDuplicate, duplicating,
  selecting, selected, onToggleSelect, t,
}) {
  const navigate = useNavigate();
  const exCount = (session.exercise_slots || []).length;

  // In select mode the whole row is the checkbox target: a 44px-wide tick box
  // beside a 44px-wide day pill on a phone is two things to miss.
  if (selecting) {
    return (
      <button
        type="button"
        onClick={onToggleSelect}
        aria-pressed={selected}
        className={`w-full flex items-center gap-3 px-3 py-2.5 border-t border-ink-100 text-left transition-colors ${
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
    <div className="flex items-center gap-2 px-3 py-2 border-t border-ink-100">
      <DayPill session={session} onPick={onSetDay} t={t} />
      <button
        type="button"
        onClick={() => navigate(`/coach/students/${studentId}/s/${session.id}`)}
        aria-label={t('coach.week.openSession')}
        className="flex-1 min-w-0 text-left flex items-baseline gap-2 group"
      >
        <span className="sl-display text-[14px] text-gray-900 truncate group-hover:text-[var(--color-accent)] transition-colors">
          {/* Position in the list, not the weekday: day_number is optional
              advice now, so an untitled session must not be named after it. */}
          {session.title || t('coach.week.sessionN', { n: position })}
        </span>
        <span className="sl-mono text-[10px] text-ink-400 shrink-0">
          {t('coach.week.exCount', { n: exCount })}
        </span>
      </button>
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
      <button
        type="button"
        onClick={onDuplicate}
        disabled={duplicating}
        aria-label={t('coach.sheet.duplicateSession')}
        title={t('coach.sheet.duplicateSession')}
        className="w-7 h-7 rounded-lg text-ink-400 hover:bg-ink-100 hover:text-ink-700 flex items-center justify-center transition-colors shrink-0 disabled:opacity-40"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2" strokeWidth={2} />
          <path strokeWidth={2} strokeLinecap="round" d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
      </button>
    </div>
  );
}
