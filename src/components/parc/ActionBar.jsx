/**
 * The bar at the bottom of an athlete's screen (design/parc/components/
 * ActionBar): the main action within reach of the thumb, and the rest that is
 * running. Three elements at most — the rest, « +30 s », « Valider la série 3 »
 * — or the main action alone across the width.
 *
 * The caller gives the main button (`<Button variant="primary" size="lg"
 * className="flex-1">`) and, while a rest runs, a `<RestCountdown>`. The page
 * above stops short of the bar: its bottom padding is the bar's height.
 *
 * The bottom padding is the screen's safe area, and never less than the 12px
 * of the bar's top: the 28px of `safe-bottom` is what the mocks draw for the
 * phone's home bar, which `env(safe-area-inset-bottom)` measures for real.
 */
export default function ActionBar({ className = '', children, ...rest }) {
  return (
    <div
      {...rest}
      className={`pk-actionbar ${className}`}
      style={{ paddingBottom: 'max(var(--space-3), env(safe-area-inset-bottom))', ...rest.style }}
    >
      {children}
    </div>
  );
}

/**
 * The rest that is running, at the left of the ActionBar: « Repos » over the
 * time in condensed blue digits (« 1:30 »). It is a `timer`, which says
 * nothing by itself as it counts: the start and the end of a rest are
 * announced elsewhere, never each second. `label` is the word above,
 * `ariaLabel` the sentence a screen reader reads when it reaches it.
 */
export function RestCountdown({ label, time, ariaLabel }) {
  return (
    <div role="timer" aria-label={ariaLabel} className="flex min-w-16 flex-col">
      <span className="pk-small" aria-hidden="true">{label}</span>
      <span className="pk-numeral-md text-blue" aria-hidden="true">{time}</span>
    </div>
  );
}

/** A number of seconds as a rest is written: « 1:30 », « 0:05 », « 12:00 ». */
export function formatRestClock(totalSeconds) {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
