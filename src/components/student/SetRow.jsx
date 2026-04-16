import { memo, useEffect, useRef, useState } from 'react';
import { useToggleSetDone, useSetRpe, useSetWeight } from '../../hooks/useSetLogs';
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
 *   log               – the set_log row (id, set_number, done, rpe, weight_kg)
 *   locked            – true when the session is confirmed; all inputs disabled
 *   restSeconds       – optional rest countdown after marking done
 *   prescribedWeightKg – optional coach-prescribed target weight for the slot
 */
const SetRow = memo(function SetRow({ log, locked = false, restSeconds = null, prescribedWeightKg }) {
  const toggleDone = useToggleSetDone();
  const setRpe = useSetRpe();
  const setWeight = useSetWeight();

  // Controlled local state for the weight input so the user can type freely
  // before we fire the mutation on blur / Enter.
  const [localWeight, setLocalWeight] = useState(
    log.weight_kg != null ? String(log.weight_kg) : ''
  );

  // Keep local state in sync if the log updates from the server (e.g. cache
  // invalidation from another device or optimistic rollback).
  useEffect(() => {
    setLocalWeight(log.weight_kg != null ? String(log.weight_kg) : '');
  }, [log.weight_kg]);

  // Rest-countdown state — ephemeral (not persisted).
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

  function commitWeight() {
    const parsed = parseFloat(localWeight);
    const next = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    // Only fire mutation when the value actually changed.
    const prev = log.weight_kg != null ? Number(log.weight_kg) : null;
    if (next !== prev) {
      setWeight.mutate({ logId: log.id, weightKg: next });
    }
  }

  function handleWeightKeyDown(e) {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    }
  }

  const placeholder = prescribedWeightKg != null ? `${prescribedWeightKg}` : 'BW';

  return (
    <div
      className={`flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 rounded-lg px-3 py-2 ${
        log.done ? 'bg-success/5' : 'bg-gray-50'
      }`}
    >
      {/* Done button + set number + timer */}
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

      {/* Weight input */}
      <div className="flex items-center gap-1.5">
        <label htmlFor={`weight-${log.id}`} className="text-xs text-gray-400 shrink-0">
          kg
        </label>
        {locked ? (
          <span
            id={`weight-${log.id}`}
            className="text-sm font-medium text-gray-700 w-16 text-right"
          >
            {log.weight_kg != null ? `${log.weight_kg} kg` : '—'}
          </span>
        ) : (
          <input
            id={`weight-${log.id}`}
            type="number"
            inputMode="decimal"
            min="0"
            step="0.5"
            value={localWeight}
            placeholder={placeholder}
            onChange={(e) => setLocalWeight(e.target.value)}
            onBlur={commitWeight}
            onKeyDown={handleWeightKeyDown}
            aria-label={`Weight for set ${log.set_number}`}
            className="w-16 rounded border border-gray-300 px-2 py-1 text-sm text-right
                       focus:outline-none focus:ring-2 focus:ring-primary tabular-nums"
          />
        )}
      </div>

      {/* RPE picker */}
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
