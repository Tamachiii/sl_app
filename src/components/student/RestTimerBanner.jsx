import { useRestTimer } from '../../hooks/useRestTimer';
import { useI18n } from '../../hooks/useI18n';

// Brief "Rest done" flash window after the timer expires. After this, the
// banner fully hides until the next set is validated. The hook's ticker
// stops emitting ~5s past endsAt, but we re-check the clock on every render
// so a parent re-render can still hide the banner without help.
export const HIDE_AFTER_EXPIRY_MS = 5_000;

export function formatMMSS(seconds) {
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
 *
 * It is not a live region. Its text changes every second, and a live region
 * that does is read aloud every second by VoiceOver and TalkBack, burying the
 * one announcement that matters. What a screen reader hears — the start of a
 * rest and its end, nothing in between — comes from the status region of
 * RestTimerHost, which is mounted in the student shell for every page.
 */
export default function RestTimerBanner() {
  const snap = useRestTimer();
  const { t } = useI18n();
  if (snap.endsAt == null) return null;

  // The store's snapshot changes every second so that this read is made again:
  // the remaining time is the end time minus now, never a counter.
  // eslint-disable-next-line react-hooks/purity -- the clock is what this renders
  const remainingMs = snap.endsAt - Date.now();
  if (remainingMs <= -HIDE_AFTER_EXPIRY_MS) return null;

  const expired = remainingMs <= 0;
  const seconds = expired ? 0 : Math.ceil(remainingMs / 1000);

  return (
    <div
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
        {expired ? t('student.session.restDone') : t('student.session.restLabel')}
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
