import Icon from './Icon';
import { useLongPress } from './useLongPress';

const DOT = {
  done: 'pk-set-dot-done',
  offplan: 'pk-set-dot-done',
  failed: 'pk-set-dot-failed',
  current: 'pk-set-dot-current',
  pending: 'pk-set-dot-pending',
  skipped: 'pk-set-dot-pending',
};

// A failed set and a set off the plan colour the whole row, edge to edge of
// the group: the row steps out of the group's 16px padding and takes it back
// inside, and the first and last rows follow the group's corners.
const TINT = {
  failed: '-mx-4 px-4 bg-red-soft first:rounded-t-group last:rounded-b-group',
  offplan: '-mx-4 px-4 bg-amber-soft first:rounded-t-group last:rounded-b-group',
};

function Dot({ state, number }) {
  return (
    <span className={`pk-set-dot ${DOT[state]}`} aria-hidden="true">
      {state === 'done' || state === 'offplan' ? (
        <Icon name="check" size={16} strokeWidth={3} />
      ) : state === 'failed' ? (
        <Icon name="close" size={14} strokeWidth={3} />
      ) : state === 'skipped' ? (
        <Icon name="skip" size={16} />
      ) : (
        number
      )}
    </span>
  );
}

/**
 * The row of one set in the list of the exercise shown
 * (design/parc/components/SetRow): a round indicator, the title, the target,
 * and at the right the RPE or the state.
 *
 * `state`:
 * - `done`: a blue disc with a check; `trailing` is the RPE (« RPE 7,5 »);
 * - `failed`: the row on `red-soft`, a red disc with a cross, the title in
 *   `red`, what was done as the caption (« 3 répétitions sur 5 »);
 * - `current`: a ring with the number; `trailing` is « En cours » in blue;
 * - `pending`: the number on `fill`;
 * - `offplan`: the row on `amber-soft`, the caption in `amber` starting with
 *   « Hors plan »;
 * - `skipped`: the skip arrows on `fill` (« Série 5, sautée »).
 *
 * `title` says the state in words too (« Série 1, faite »): the indicator is
 * never the only carrier. With `onPress` and/or `onLongPress` the row is a
 * button — a tap opens the set's sheet, a press of 500 ms marks it failed
 * (`useLongPress`), never a tap; `describedBy` points at the sentence that
 * says so. Without either, it is a plain row.
 */
export default function SetRow({
  state = 'pending',
  number,
  title,
  caption,
  trailing,
  onPress,
  onLongPress,
  describedBy,
  label,
  disabled = false,
}) {
  const interactive = Boolean(onPress || onLongPress);
  const press = useLongPress({ onPress, onLongPress, enabled: !disabled });

  const titleClass = `pk-body font-semibold ${state === 'failed' ? 'text-red' : ''}`;
  const captionClass = `pk-caption ${state === 'offplan' ? 'text-amber' : ''}`;
  const trailingClass = `whitespace-nowrap text-[15px] font-semibold ${state === 'current' ? 'text-blue' : ''}`;

  const body = (
    <>
      <Dot state={state} number={number} />
      {/* The commas are for a screen reader, which reads the row as one name:
          « Série 3, 5 répétitions, 20 kg, En cours ». */}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={titleClass}>{title}</span>
        {caption && (
          <span className={captionClass}>
            <span className="sr-only">,</span>{' '}
            {caption}
          </span>
        )}
      </span>
      {trailing != null && trailing !== '' && (
        <span className={trailingClass}>
          <span className="sr-only">,</span>{' '}
          {trailing}
        </span>
      )}
    </>
  );

  return (
    <li className={TINT[state] ?? ''}>
      {interactive ? (
        <button
          type="button"
          {...press}
          disabled={disabled}
          aria-label={label}
          aria-describedby={describedBy}
          className="pk-row w-full touch-pan-y select-none bg-transparent text-left [-webkit-touch-callout:none]"
        >
          {body}
        </button>
      ) : (
        <div className="pk-row" aria-label={label} role={label ? 'group' : undefined}>
          {body}
        </div>
      )}
    </li>
  );
}
