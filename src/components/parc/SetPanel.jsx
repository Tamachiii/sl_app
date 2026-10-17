// A figure longer than this does not hold in a half column at 124px: it is
// drawn at `numeral-lg` (design/parc/components/SetPanel, « À éviter »).
const HERO_MAX_CHARS = 3;

function Figure({ value, unit }) {
  const text = String(value ?? '');
  const size = text.length > HERO_MAX_CHARS ? 'pk-numeral-lg' : 'pk-numeral-hero';
  return (
    <div className="min-w-0">
      <div className={`${size} pk-condensed break-words`}>{text}</div>
      <div className="pk-subhead mt-1.5">{unit}</div>
    </div>
  );
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
  return (
    <section aria-label={label} className="pk-panel">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="pk-title min-w-0">{title}</h2>
        {position && <span className="pk-subhead whitespace-nowrap">{position}</span>}
      </div>
      {(primary || secondary) && (
        <div className="mt-3 grid grid-cols-2 gap-4">
          {primary && <Figure {...primary} />}
          {secondary && <Figure {...secondary} />}
        </div>
      )}
      {children}
      {footer && (
        <div className="pk-subhead mt-4 border-t border-line pt-3.5">{footer}</div>
      )}
    </section>
  );
}
