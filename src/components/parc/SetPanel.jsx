import { useEffect, useRef, useState } from 'react';

// A figure longer than this does not hold in a half column at 124px: it is
// drawn at `numeral-lg` (design/parc/components/SetPanel, « À éviter »).
const HERO_MAX_CHARS = 3;

function Figure({ value, unit, small }) {
  const text = String(value ?? '');
  const size = small || text.length > HERO_MAX_CHARS ? 'pk-numeral-lg' : 'pk-numeral-hero';
  return (
    <div className="min-w-0">
      <div className={`${size} pk-condensed whitespace-nowrap`}>{text}</div>
      <div className="pk-subhead mt-1.5">{unit}</div>
    </div>
  );
}

/**
 * Whether the two figures hold side by side at the size the README gives
 * them. A figure of three characters at 124px is 159px wide and « PDC » 184px,
 * where half a phone's panel is 151px: « 100 » kg used to break into « 10 »
 * over « 0 ». The figures never break now, and once the row is seen to be
 * wider than the panel both are drawn at `numeral-lg` — until the panel is
 * wide enough again, or the figures change.
 *
 * Measured by a ResizeObserver on the row and on each figure: a figure that
 * grows changes the width of its column, so a new value is checked too.
 * Without one (jsdom) the figures keep their size.
 */
function useFiguresHold(figures, columns) {
  const rowRef = useRef(null);
  // The width the row needed at the README's sizes, for these figures.
  const [overflow, setOverflow] = useState({ figures: null, need: 0 });
  const [width, setWidth] = useState(Infinity);
  const need = overflow.figures === figures ? overflow.need : 0;
  const hold = need === 0 || width >= need;

  useEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      setWidth(row.clientWidth);
      if (row.scrollWidth > row.clientWidth + 1) {
        setOverflow({ figures: row.dataset.figures, need: row.scrollWidth });
      }
    });
    observer.observe(row);
    for (const column of row.children) observer.observe(column);
    // The figures are measured again once the app's font has come: the one
    // drawn before it is wider.
    const fonts = typeof document !== 'undefined' ? document.fonts : null;
    const again = () => setOverflow({ figures: null, need: 0 });
    fonts?.addEventListener?.('loadingdone', again);
    return () => {
      observer.disconnect();
      fonts?.removeEventListener?.('loadingdone', again);
    };
  }, [columns]);

  return [rowRef, hold];
}

/**
 * The panel of the set in progress (design/parc/components/SetPanel): the
 * exercise and « Série 3 sur 4 », then two giant condensed figures — reps (or
 * seconds for a hold) and load (« PDC » at bodyweight) — each over its unit,
 * and the line of last time under a rule when there is one. Once per session
 * screen, under the exercise switcher; nothing else has this size.
 *
 * `primary` and `secondary` are `{ value, unit }`; `footer` the line of last
 * time; `label` the name of the panel (« Série en cours »).
 */
export default function SetPanel({ title, position, primary, secondary, footer, label, children }) {
  const figures = `${primary?.value ?? ''}|${secondary?.value ?? ''}`;
  const [rowRef, hold] = useFiguresHold(figures, `${!!primary}${!!secondary}`);
  return (
    <section aria-label={label} className="pk-panel">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="pk-title min-w-0">{title}</h2>
        {position && <span className="pk-subhead whitespace-nowrap">{position}</span>}
      </div>
      {(primary || secondary) && (
        // Two equal columns while both figures hold in one, the wider figure
        // taking what it needs otherwise (`min-content`).
        <div
          ref={rowRef}
          data-figures={figures}
          className="mt-3 grid grid-cols-[repeat(2,minmax(min-content,1fr))] gap-4"
        >
          {primary && <Figure {...primary} small={!hold} />}
          {secondary && <Figure {...secondary} small={!hold} />}
        </div>
      )}
      {children}
      {footer && (
        <div className="pk-subhead mt-4 border-t border-line pt-3.5">{footer}</div>
      )}
    </section>
  );
}
