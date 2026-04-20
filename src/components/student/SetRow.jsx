import { memo, useEffect, useRef, useState } from 'react';
import { useToggleSetDone, useSetRpe } from '../../hooks/useSetLogs';
import RpeInput from './RpeInput';

function formatMMSS(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * SetRow — one row per set_log entry inside a SessionView exercise card.
 *
 * Props
 *   log         – the set_log row (id, set_number, done, rpe)
 *   locked      – true when the session is confirmed; all inputs disabled
 *   restSeconds – optional rest countdown after marking done
 */
const SetRow = memo(function SetRow({ log, locked = false, restSeconds = null, recordVideo = false }) {
  const toggleDone = useToggleSetDone();
  const setRpe = useSetRpe();

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

  return (
    <div
      className={`flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 rounded-lg px-3 py-2 ${
        log.done ? 'bg-success/5' : recordVideo ? 'bg-amber-50 ring-1 ring-amber-300' : 'bg-gray-50'
      }`}
    >
      <div className="flex items-center gap-3">
        <button
          onClick={() => !locked && toggleDone.mutate({ logId: log.id, done: !log.done })}
          disabled={locked}
          aria-label={log.done ? 'Mark set undone' : 'Mark set done'}
          className={`w-8 h-8 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
            log.done
              ? 'bg-success border-success text-white'
              : 'border-gray-300 text-transparent hover:border-success/50'
          } ${locked ? 'opacity-70 cursor-not-allowed' : ''}`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
        </button>

        <span className="text-sm text-gray-600 font-medium w-12">
          Set {log.set_number}
        </span>

        {recordVideo && (
          <span
            className="flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-100 rounded px-1.5 py-0.5"
            aria-label="Record video on this set"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            Record
          </span>
        )}

        {showTimer && (
          <span
            className="text-xs font-mono tabular-nums text-primary bg-primary/10 rounded px-1.5 py-0.5"
            aria-label={`Rest remaining ${remaining} seconds`}
          >
            {formatMMSS(remaining)}
          </span>
        )}
        {timerDone && (
          <span className="text-xs font-medium text-success">Rest done</span>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <RpeInput
          value={log.rpe}
          disabled={locked}
          onChange={(rpe) => setRpe.mutate({ logId: log.id, rpe })}
        />
      </div>
    </div>
  );
});

export default SetRow;
