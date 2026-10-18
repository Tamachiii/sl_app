const CLASS = { done: 'is-done', today: 'is-today', next: 'is-next' };

/**
 * An athlete's week in seven dots, Monday to Sunday
 * (design/parc/components/WeekDots): `done` a full blue disc, `today` (a
 * session planned today) an ink ring, `next` (the next session advised) an
 * `ink-3` ring, anything else — rest, nothing — a full `line-strong` disc.
 * The states differ by shape, not by colour alone, and there is no « missed »:
 * a planned day that passes is not a failure.
 *
 * `days` holds the seven states (from `buildDayStrip`), `label` the sentence
 * that says the week (« lundi et mercredi faits, séance prévue aujourd'hui »).
 */
export default function WeekDots({ days, label }) {
  return (
    <span className="pk-week" role="img" aria-label={label}>
      {days.map((day, index) => (
        <span key={index} className={CLASS[day] ?? undefined} />
      ))}
    </span>
  );
}
