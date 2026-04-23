import { memo, useEffect, useRef, useState } from 'react';
import { useToggleSetDone, useSetRpe } from '../../hooks/useSetLogs';
import RpeInput from './RpeInput';
import VideoUploadButton from './VideoUploadButton';

function formatMMSS(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * SetRow — one row per set_log entry inside a SessionView exercise card.
 */
const SetRow = memo(function SetRow({ log, locked = false, restSeconds = null, recordVideo = false, video = null }) {
  const toggleDone = useToggleSetDone();
  const setRpe = useSetRpe();

  const [rpeOpen, setRpeOpen] = useState(false);
  const [remaining, setRemaining] = useState(null);
  const prevDone = useRef(log.done);

  useEffect(() => {
    if (!prevDone.current && log.done && restSeconds && restSeconds > 0) {
      setRemaining(restSeconds);
    }
    if (prevDone.current && !log.done) {
      setRemaining(null);
    }
    prevDone.current = log.done;
  }, [log.done, restSeconds]);

  useEffect(() => {
    if (remaining == null || remaining <= 0) return;
    const t = setInterval(() => {
      setRemaining((r) => (r != null && r > 0 ? r - 1 : 0));
    }, 1000);
    return () => clearInterval(t);
  }, [remaining]);

  const showTimer = remaining != null && remaining > 0;
  const timerDone = remaining === 0;

  const rowBg = log.done ? 'bg-success/10' : 'bg-ink-50';

  return (
    <div
      className={`rounded-xl px-3 py-2 transition-colors ${rowBg} ${
        log.done ? 'opacity-75' : ''
      }`}
    >
      <div className="flex items-center flex-wrap gap-x-3 gap-y-2">
        <button
          onClick={() => !locked && toggleDone.mutate({ logId: log.id, done: !log.done })}
          disabled={locked}
          aria-label={log.done ? 'Mark set undone' : 'Mark set done'}
          className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors sl-display text-[13px] font-extrabold ${
            log.done
              ? 'bg-accent text-ink-900'
              : 'bg-ink-100 text-ink-500 hover:bg-ink-200'
          } ${locked ? 'opacity-70 cursor-not-allowed' : ''}`}
        >
          {log.done ? (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            log.set_number
          )}
        </button>

        <span className="sl-label">{`Set ${log.set_number}`}</span>

        <div className="flex-1" />

        {showTimer && (
          <span
            className="sl-mono text-[11px] text-ink-900 rounded px-1.5 py-0.5 tabular-nums"
            style={{ background: 'var(--color-accent)' }}
            aria-label={`Rest remaining ${remaining} seconds`}
          >
            {formatMMSS(remaining)}
          </span>
        )}
        {timerDone && (
          <span className="sl-mono text-[11px] font-semibold" style={{ color: 'var(--color-success)' }}>
            Rest done
          </span>
        )}

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
          onClick={() => !locked && setRpeOpen((v) => !v)}
          disabled={locked}
          aria-expanded={rpeOpen}
          aria-label={log.rpe != null ? `RPE ${log.rpe}, tap to change` : 'Set RPE'}
          className={`sl-pill shrink-0 ${
            log.rpe != null
              ? 'bg-accent/15 text-accent'
              : 'bg-ink-100 text-ink-500'
          } ${locked ? 'opacity-60 cursor-not-allowed' : 'hover:brightness-95'}`}
          style={log.rpe != null ? { color: 'var(--color-accent)' } : undefined}
        >
          {log.rpe != null ? `RPE ${log.rpe}` : 'RPE'}
        </button>
      </div>

      {rpeOpen && (
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
  );
});

export default SetRow;
