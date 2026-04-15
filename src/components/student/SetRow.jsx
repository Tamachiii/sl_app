import { memo, useEffect, useRef, useState } from 'react';
import { useToggleSetDone, useSetRpe } from '../../hooks/useSetLogs';
import RpeInput from './RpeInput';

function formatMMSS(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const SetRow = memo(function SetRow({ log, locked = false, restSeconds = null }) {
  const toggleDone = useToggleSetDone();
  const setRpe = useSetRpe();

  // Local countdown — starts when the set is toggled done (this session only).
  // It's intentionally ephemeral: not persisted, resets on reload or unmount.
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
        log.done ? 'bg-success/5' : 'bg-gray-50'
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
