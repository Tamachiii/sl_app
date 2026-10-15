import { useRestTimer, clearRestTimer, extendRestTimer } from '../../hooks/useRestTimer';
import { useI18n } from '../../hooks/useI18n';

// Brief "Rest done" flash window after the timer expires. After this, the
// banner fully hides until the next set is validated. The hook's ticker
// stops emitting ~5s past endsAt, but we re-check the clock on every render
// so a parent re-render can still hide the banner without help.
export const HIDE_AFTER_EXPIRY_MS = 5_000;

// What "+30 s" adds to the rest that is running.
const EXTEND_SECONDS = 30;

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
 * While the rest runs it carries two controls of its own, 44 px each: "+30 s"
 * (extendRestTimer) and Skip (clearRestTimer of the running set). Both go
 * through the store's commit, so the stored copy, the beep, the wake lock and
 * the push (RestTimerHost) all follow the new end. "Rest done" has neither:
 * there is nothing left to skip, and +30 s on a rest that has ended does
 * nothing.
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

  if (remainingMs <= 0) {
    return (
      <div
        className="inline-flex items-center px-2.5 h-8 rounded-full whitespace-nowrap"
        style={{ background: 'color-mix(in srgb, var(--color-success) 18%, transparent)' }}
      >
        <span className="sl-label" style={{ color: 'var(--color-success)' }}>
          {t('student.session.restDone')}
        </span>
      </div>
    );
  }

  const seconds = Math.ceil(remainingMs / 1000);
  const { logId } = snap;
  return (
    // The countdown on top of its label, then the two controls: 44 px tall,
    // in the right slot of the session's top bar, which grows for them while
    // the rest runs.
    <div
      role="group"
      aria-label={t('sessionRestControls.timerGroup')}
      className="inline-flex items-center gap-1 whitespace-nowrap"
    >
      <div
        className="flex flex-col items-center justify-center gap-0.5 h-11 px-2.5 rounded-full leading-none"
        style={{ background: 'color-mix(in srgb, var(--color-accent) 18%, transparent)' }}
      >
        <span className="sl-label" style={{ color: 'var(--color-accent)' }}>
          {t('student.session.restLabel')}
        </span>
        <span
          className="sl-mono text-[12px] font-bold tabular-nums"
          style={{ color: 'var(--color-accent)' }}
        >
          {formatMMSS(seconds)}
        </span>
      </div>
      <button
        type="button"
        onClick={() => extendRestTimer(logId, EXTEND_SECONDS)}
        aria-label={t('sessionRestControls.addThirtyAria')}
        className="sl-pill sl-pill-btn px-2 normal-case tracking-normal bg-ink-100 text-ink-700 hover:bg-ink-200"
      >
        {t('sessionRestControls.addThirty')}
      </button>
      <button
        type="button"
        onClick={() => clearRestTimer(logId)}
        aria-label={t('sessionRestControls.skip')}
        title={t('sessionRestControls.skip')}
        className="sl-pill sl-pill-btn px-0 bg-ink-100 text-ink-700 hover:bg-ink-200"
      >
        {/* Skip forward: a play triangle against a bar. */}
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M6 5.5v13l9.5-6.5L6 5.5zM18 5.5v13" />
        </svg>
      </button>
    </div>
  );
}
