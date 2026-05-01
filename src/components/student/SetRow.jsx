import { memo, useEffect, useRef, useState } from 'react';
import { useToggleSetDone, useSetFailed, useSetRpe } from '../../hooks/useSetLogs';
import { startRestTimer, clearRestTimer } from '../../hooks/useRestTimer';
import { formatSetTarget } from '../../lib/volume';
import RpeInput from './RpeInput';
import VideoUploadButton from './VideoUploadButton';

// Touch-swipe thresholds for the mobile outcome gestures (right-to-left
// commits the set as done, left-to-right marks it failed). Two checks gate
// the commit: the absolute horizontal travel must clear COMMIT_PX, and the
// swipe must read as horizontal-dominant (|dx| > |dy| * H_OVER_V) so a
// vertical scroll near the row never accidentally fires the gesture.
const SWIPE_COMMIT_PX = 64;
const SWIPE_INTENT_PX = 8;
const SWIPE_H_OVER_V = 1.4;
const SWIPE_MAX_OFFSET = 96;

/**
 * SetRow — one row per set_log entry inside a SessionView exercise card.
 *
 * Rest target is read from the per-set `target_rest_seconds` on the log;
 * this lets a coach prescribe different rests per set within one exercise.
 *
 * `showTarget` is set by the parent when the slot's sets are heterogeneous —
 * uniform slots already display the target in the SlotHeader, so duplicating
 * it on every row would be noise.
 */
const SetRow = memo(function SetRow({ log, locked = false, showTarget = false, recordVideo = false, video = null }) {
  const toggleDone = useToggleSetDone();
  const setFailed = useSetFailed();
  const setRpe = useSetRpe();
  const restSeconds = log.target_rest_seconds ?? null;

  const [rpeOpen, setRpeOpen] = useState(false);
  const prevDone = useRef(log.done);
  const prevFailed = useRef(!!log.failed);

  // Swipe state lives in a ref to avoid re-rendering on every touchmove;
  // the visible offset/intent are mirrored into useState only when intent
  // is established or released.
  const swipe = useRef({ active: false, startX: 0, startY: 0, dx: 0, dy: 0, captured: false });
  const [swipeOffset, setSwipeOffset] = useState(0);

  // Rest timer is rendered globally by RestTimerBanner (mounted in
  // SessionView). SetRow only writes to the singleton on outcome transitions
  // — it doesn't read or display remaining time itself, so the indicator
  // survives exercise-card transitions.
  const failed = !!log.failed;

  useEffect(() => {
    const wasResolved = prevDone.current || prevFailed.current;
    const isResolved = log.done || failed;

    // Pending → resolved (either done OR failed): start the rest timer. The
    // student needs to recover regardless of outcome.
    if (!wasResolved && isResolved && restSeconds && restSeconds > 0) {
      startRestTimer(log.id, restSeconds);
    }
    // Resolved → pending: clear the timer.
    if (wasResolved && !isResolved) {
      clearRestTimer(log.id);
    }
    // Auto-expand the RPE selector only for the done transition — RPE is
    // locked for failed sets, so opening it would just show a disabled UI.
    if (!prevDone.current && log.done) {
      setRpeOpen(true);
    }
    prevDone.current = log.done;
    prevFailed.current = failed;
  }, [log.done, failed, log.id, restSeconds]);

  const rpeLocked = locked || failed;

  // Tap cycles neutral → done → failed → neutral, mirroring the swipe outcomes
  // so both interactions reach every state. The done → failed step is one
  // write: patchForFailed(true) clears `done` in the same UPDATE, so the DB
  // CHECK set_logs_done_xor_failed never sees an intermediate both-true row.
  function handleIndicatorTap() {
    if (locked) return;
    if (log.done) setFailed.mutate({ logId: log.id, failed: true });
    else if (failed) setFailed.mutate({ logId: log.id, failed: false });
    else toggleDone.mutate({ logId: log.id, done: true });
  }

  function handleTouchStart(e) {
    if (locked) return;
    const t = e.touches[0];
    swipe.current = { active: true, startX: t.clientX, startY: t.clientY, dx: 0, dy: 0, captured: false };
  }

  function handleTouchMove(e) {
    const s = swipe.current;
    if (!s.active) return;
    const t = e.touches[0];
    s.dx = t.clientX - s.startX;
    s.dy = t.clientY - s.startY;

    if (!s.captured) {
      // Wait until the gesture clearly reads as horizontal before claiming it,
      // otherwise let the page scroll vertically.
      const horizDominant = Math.abs(s.dx) > SWIPE_INTENT_PX && Math.abs(s.dx) > Math.abs(s.dy) * SWIPE_H_OVER_V;
      if (!horizDominant) return;
      s.captured = true;
    }

    // Cap the visible offset so the row doesn't translate off-screen on long
    // drags; the underlying mutation still fires once the threshold is met.
    const clamped = Math.max(-SWIPE_MAX_OFFSET, Math.min(SWIPE_MAX_OFFSET, s.dx));
    setSwipeOffset(clamped);
  }

  function handleTouchEnd() {
    const s = swipe.current;
    if (!s.active) return;
    const captured = s.captured;
    const dx = s.dx;
    swipe.current = { active: false, startX: 0, startY: 0, dx: 0, dy: 0, captured: false };
    setSwipeOffset(0);

    if (!captured || locked) return;

    if (dx <= -SWIPE_COMMIT_PX) {
      if (!log.done) toggleDone.mutate({ logId: log.id, done: true });
      maybeVibrate();
    } else if (dx >= SWIPE_COMMIT_PX) {
      if (!failed) setFailed.mutate({ logId: log.id, failed: true });
      maybeVibrate();
    }
  }

  function handleTouchCancel() {
    swipe.current = { active: false, startX: 0, startY: 0, dx: 0, dy: 0, captured: false };
    setSwipeOffset(0);
  }

  let rowBg;
  if (failed) rowBg = 'bg-danger/10';
  else if (log.done) rowBg = 'bg-success/10';
  else rowBg = 'bg-ink-50';

  // Indicator-button state: done = green check, failed = red ✕, else number.
  let indicatorBg, indicatorContent, indicatorAriaLabel;
  if (log.done) {
    indicatorBg = 'bg-accent text-ink-900';
    indicatorContent = (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
      </svg>
    );
    indicatorAriaLabel = 'Mark set failed';
  } else if (failed) {
    indicatorBg = 'text-white';
    indicatorContent = (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 6l12 12M18 6L6 18" />
      </svg>
    );
    indicatorAriaLabel = 'Clear failed mark';
  } else {
    indicatorBg = 'bg-ink-100 text-ink-500 hover:bg-ink-200';
    indicatorContent = log.set_number;
    indicatorAriaLabel = 'Mark set done';
  }

  // Swipe affordance: tint the trailing edge of the row so the student sees
  // which outcome will commit (green from the right while swiping toward
  // done, red from the left while swiping toward failed). Opacity ramps up
  // as the gesture nears the commit threshold.
  const swipeProgress = Math.min(1, Math.abs(swipeOffset) / SWIPE_COMMIT_PX);
  const swipeColor =
    swipeOffset < 0
      ? 'var(--color-success)'
      : swipeOffset > 0
        ? 'var(--color-danger)'
        : 'transparent';

  return (
    <div
      className={`relative rounded-xl overflow-hidden transition-colors ${rowBg} ${
        log.done || failed ? 'opacity-75' : ''
      }`}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
      style={{ touchAction: 'pan-y' }}
    >
      {swipeOffset !== 0 && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background: swipeColor,
            opacity: 0.18 * swipeProgress,
          }}
        />
      )}
      <div
        className="relative px-3 py-2"
        style={{
          transform: swipeOffset ? `translateX(${swipeOffset}px)` : undefined,
          transition: swipe.current.active ? 'none' : 'transform 150ms ease-out',
        }}
      >
        <div className="flex items-center flex-wrap gap-x-3 gap-y-2">
          <button
            onClick={handleIndicatorTap}
            disabled={locked}
            aria-label={indicatorAriaLabel}
            className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors sl-display text-[13px] font-extrabold ${indicatorBg} ${
              locked ? 'opacity-70 cursor-not-allowed' : ''
            }`}
            style={failed ? { background: 'var(--color-danger)' } : undefined}
          >
            {indicatorContent}
          </button>

          <span className="sl-label">{`Set ${log.set_number}`}</span>

          {showTarget && (
            <span className="sl-label normal-case text-ink-500">{formatSetTarget(log)}</span>
          )}

          {failed && (
            <span
              className="sl-label text-[10px] tracking-[0.18em] font-extrabold"
              style={{ color: 'var(--color-danger)' }}
            >
              FAILED
            </span>
          )}

          <div className="flex-1" />

          {recordVideo && (
            <VideoUploadButton
              setLogId={log.id}
              exerciseSlotId={log.exercise_slot_id}
              setNumber={log.set_number}
              existingVideo={video}
              disabled={locked}
            />
          )}

          <button
            type="button"
            onClick={() => !rpeLocked && setRpeOpen((v) => !v)}
            disabled={rpeLocked}
            aria-expanded={rpeOpen}
            aria-label={
              failed
                ? 'RPE disabled — set is failed'
                : log.rpe != null
                  ? `RPE ${log.rpe}, tap to change`
                  : 'Set RPE'
            }
            className={`sl-pill shrink-0 ${
              log.rpe != null
                ? 'bg-accent/15 text-accent'
                : 'bg-ink-100 text-ink-500'
            } ${rpeLocked ? 'opacity-60 cursor-not-allowed' : 'hover:brightness-95'}`}
            style={log.rpe != null ? { color: 'var(--color-accent)' } : undefined}
          >
            {log.rpe != null ? `RPE ${log.rpe}` : 'RPE'}
          </button>
        </div>

        {rpeOpen && !failed && (
          <div className="pt-2">
            <RpeInput
              value={log.rpe}
              disabled={locked}
              onChange={(rpe) => {
                setRpe.mutate({ logId: log.id, rpe });
                if (rpe != null) setRpeOpen(false);
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
});

function maybeVibrate() {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(10);
    } catch {
      // some browsers throw on user-gesture mismatches; ignore.
    }
  }
}

export default SetRow;
