import { useCallback, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useI18n } from '../../hooks/useI18n';
import { dayName, dayNames, formatNumber, pluralKey } from '../../lib/i18n/format';
import { capitalize } from '../student/sessionModel';
import { Icon, IconButton } from '../parc';
import PortalMenu, { anchorOf, MENU_PADDING } from './PortalMenu';

// The rows of the program sheet (design/parc/screens/Programme.dc.html): the
// place of the session in the block in condensed digits, its name, and a line
// that says where it stands, its recommended day and how many exercises it
// holds. The sheet itself is about phases, drag and modes; a row knows nothing
// of that beyond the flags it is handed.

const isDay = (dn) => dn >= 1 && dn <= 7;

// The name of a session: its title, or its place in the block — never its
// weekday, which is optional advice.
export function sessionName(session, position, t) {
  return session.title || t('parcProgram.sessionN', { n: position });
}

// « Faite, jeudi, 4 exercices ».
function factsOf(session, { confirmed, trained }, { t, lang }) {
  const exercises = (session.exercise_slots || []).length;
  const facts = [
    confirmed ? t('parcProgram.statusDone') : trained ? t('parcProgram.statusInProgress') : null,
    isDay(session.day_number) ? dayName(lang, session.day_number, 'long') : null,
    t(pluralKey(lang, exercises, 'parcProgram.exercises'), { n: formatNumber(lang, exercises) }),
  ].filter(Boolean);
  return capitalize(facts.join(', '));
}

function Place({ position }) {
  const { lang } = useI18n();
  return (
    <span aria-hidden="true" className="pk-condensed pk-tnum w-8 shrink-0 text-center text-[24px] font-extrabold leading-none">
      {formatNumber(lang, position)}
    </span>
  );
}

// One item of the row's menu: 44px, on one line — the menu's height is
// counted from it.
const ITEM = 44;
const DAY_GAP = 4;
const MENU_WIDTH = 4 * ITEM + 3 * DAY_GAP + MENU_PADDING;

/**
 * The ⋯ of a row: duplicate the session, and its recommended day — the seven
 * days and « none », 44px each in two rows of four (eight in one row is wider
 * than a phone). Clearing the day is a real choice: plenty of sessions should
 * not suggest one.
 */
function RowMenu({ session, name, onSetDay, onDuplicate, duplicating }) {
  const { t, lang } = useI18n();
  const [anchor, setAnchor] = useState(null);
  const triggerRef = useRef(null);
  const close = useCallback(() => setAnchor(null), []);
  const dn = session.day_number;
  const short = dayNames(lang, 'short');
  const label = t('parcProgram.sessionMenu', { name });
  const cell = (current) =>
    `h-11 w-11 rounded-control text-[14px] font-semibold ${current ? 'bg-ink text-surface' : 'bg-fill text-ink hover:bg-line'}`;

  return (
    <>
      <IconButton
        ref={triggerRef}
        icon="more"
        tone="none"
        label={label}
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
          height={ITEM + 24 + 2 * ITEM + DAY_GAP + MENU_PADDING}
          width={MENU_WIDTH}
          onClose={close}
          returnFocus={triggerRef}
          label={label}
          className="flex flex-col"
        >
          <button
            type="button"
            disabled={duplicating}
            onClick={(e) => {
              e.stopPropagation();
              close();
              onDuplicate();
            }}
            className="min-h-11 truncate rounded-control px-3 text-left text-[15px] font-semibold hover:bg-fill"
          >
            {t('parcProgram.duplicateSession', { name })}
          </button>
          <p className="pk-small px-3 pt-1 pb-1.5">{t('parcProgram.dayHeading')}</p>
          <div className="grid grid-cols-4 gap-1 px-0.5">
            {short.map((d, i) => (
              <button
                key={i}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  close();
                  onSetDay(i + 1);
                }}
                aria-label={capitalize(dayName(lang, i + 1, 'long'))}
                aria-current={dn === i + 1}
                className={cell(dn === i + 1)}
              >
                {d}
              </button>
            ))}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                close();
                onSetDay(null);
              }}
              aria-label={t('parcProgram.clearDay')}
              aria-current={!isDay(dn)}
              className={cell(!isDay(dn))}
            >
              –
            </button>
          </div>
        </PortalMenu>
      )}
    </>
  );
}

// A session row while the block is in reorder mode: its place, its name and
// its facts, and the handle at the right (design/parc: « La poignée à droite
// change l'ordre »). No other control, so a drag cannot be a mis-tap.
export function SortableSessionRow({ session, position, confirmed = false, trained = false }) {
  const ctx = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: session.id });
  const name = sessionName(session, position, ctx.t);

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className="pk-row bg-surface"
    >
      <Place position={position} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="pk-headline truncate">{name}</span>
        <span className="pk-caption">{factsOf(session, { confirmed, trained }, ctx)}</span>
      </span>
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={ctx.t('parcProgram.moveItem', { name })}
        className="pk-icon-btn shrink-0 cursor-grab touch-none bg-transparent active:cursor-grabbing"
      >
        <Icon name="drag" size={22} />
      </button>
    </li>
  );
}

/**
 * One session of the sheet.
 *
 * `confirmed` — the athlete confirmed the session. `trained` — they logged at
 * least one set in it. Either one means the row's subject is no longer a plan
 * to write but a workout to read, so the row opens the REVIEW (which carries
 * the way into the editor) instead of the editor.
 *
 * In select mode the whole row is the target (`aria-pressed`): a tick box
 * beside the other controls of a row is one more thing to miss.
 *
 * No delete here on purpose: a destructive control on every row of the main
 * authoring surface is a mis-tap waiting to happen. Deleting a session lives
 * in the session editor. Duplicate does belong here — building a block is a
 * run of near-identical sessions — in the row's ⋯, with its recommended day.
 *
 * `readOnly` — the block is an athlete's draft, theirs until the coach
 * approves it: the row opens the session (the editor is read-only too) and
 * offers no write.
 */
export default function SessionRow({
  session, studentId, confirmed, trained, position, onSetDay, onDuplicate, duplicating,
  selecting, selected, onToggleSelect, readOnly = false,
}) {
  const ctx = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const opensReview = !!(confirmed || trained);
  const name = sessionName(session, position, ctx.t);
  const facts = factsOf(session, { confirmed, trained }, ctx);

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

  const text = (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="pk-headline truncate">{name}</span>
      <span className="pk-caption">
        <span className="sr-only">,</span> {facts}
      </span>
    </span>
  );

  if (selecting) {
    return (
      <li>
        <button
          type="button"
          onClick={onToggleSelect}
          aria-pressed={selected}
          className="pk-row w-full bg-transparent text-left"
        >
          <span
            aria-hidden="true"
            className={selected ? 'pk-set-dot pk-set-dot-done' : 'pk-set-dot border-2 border-line-strong bg-transparent'}
          >
            {selected && <Icon name="check" size={16} />}
          </span>
          <Place position={position} />
          {text}
        </button>
      </li>
    );
  }

  return (
    <li className="pk-row">
      <Place position={position} />
      <button
        type="button"
        onClick={open}
        data-session-open={session.id}
        className="flex min-h-11 min-w-0 flex-1 items-center self-stretch bg-transparent text-left"
      >
        {text}
      </button>
      {!readOnly && (
        <RowMenu
          session={session}
          name={name}
          onSetDay={onSetDay}
          onDuplicate={onDuplicate}
          duplicating={duplicating}
        />
      )}
    </li>
  );
}
