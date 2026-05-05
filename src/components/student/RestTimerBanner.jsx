import { useRestTimer } from '../../hooks/useRestTimer';

// Brief "Rest done" flash window after the timer expires. After this, the
// banner fully hides until the next set is validated. The hook's ticker
// stops emitting ~5s past endsAt, but we re-check Date.now() on every render
// so a parent re-render can still hide the banner without help.
const HIDE_AFTER_EXPIRY_MS = 5_000;

function formatMMSS(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * RestTimerBanner — single, session-level rest indicator.
 *
 * Reads the app-wide singleton timer (hooks/useRestTimer) and renders a
 * compact pill that lives in the right slot of SessionView's top bar, so
 * the indicator survives exercise-card transitions without pushing the
 * scroll content down. Validating a new set replaces (not queues) the
 * active timer; tapping a stale set or navigating between exercises does
 * not affect it. While running it shows the remaining mm:ss; when the
 * timer expires it briefly flashes "Rest done" and auto-hides after
 * HIDE_AFTER_EXPIRY_MS so the UI doesn't carry a stale indicator forever.
 */
export default function RestTimerBanner() {
  const snap = useRestTimer();
  if (snap.endsAt == null) return null;

  const remainingMs = snap.endsAt - Date.now();
  if (remainingMs <= -HIDE_AFTER_EXPIRY_MS) return null;

  const expired = remainingMs <= 0;
  const seconds = expired ? 0 : Math.ceil(remainingMs / 1000);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={expired ? 'Rest done' : `Rest remaining ${seconds} seconds`}
      className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded-full whitespace-nowrap"
      style={{
        background: expired
          ? 'color-mix(in srgb, var(--color-success) 18%, transparent)'
          : 'color-mix(in srgb, var(--color-accent) 18%, transparent)',
      }}
    >
      <span
        className="sl-label"
        style={{ color: expired ? 'var(--color-success)' : 'var(--color-accent)' }}
      >
        {expired ? 'Rest done' : 'Rest'}
      </span>
      {!expired && (
        <span
          className="sl-mono text-[12px] font-bold tabular-nums"
          style={{ color: 'var(--color-accent)' }}
        >
          {formatMMSS(seconds)}
        </span>
      )}
    </div>
  );
}
