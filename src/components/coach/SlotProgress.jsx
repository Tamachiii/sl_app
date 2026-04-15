import { memo } from 'react';

/**
 * Coach-facing per-slot read-out of the student's logged sets and RPE values.
 * Renders nothing when there are no logs yet (student hasn't started the set).
 */
const SlotProgress = memo(function SlotProgress({ logs, plannedSets }) {
  if (!logs || logs.length === 0) return null;

  const sorted = [...logs].sort((a, b) => a.set_number - b.set_number);
  const doneCount = sorted.filter((l) => l.done).length;
  const rpeCount = sorted.filter((l) => l.rpe != null).length;

  return (
    <div className="mt-2 border-t border-gray-100 pt-2 space-y-1">
      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>Student progress</span>
        <span>
          <span className="font-medium text-gray-700">{doneCount}</span>/{plannedSets} done
          {rpeCount > 0 && (
            <span className="ml-2">
              <span className="font-medium text-gray-700">{rpeCount}</span>/{plannedSets} RPE
            </span>
          )}
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {sorted.map((log) => (
          <span
            key={log.id}
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${
              log.done
                ? 'bg-success/10 text-success'
                : 'bg-gray-100 text-gray-400'
            }`}
            title={
              log.done
                ? log.rpe != null
                  ? `Set ${log.set_number}: done @ RPE ${log.rpe}`
                  : `Set ${log.set_number}: done (no RPE)`
                : `Set ${log.set_number}: not done`
            }
          >
            <span>Set {log.set_number}</span>
            {log.done ? (
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <span aria-hidden="true">·</span>
            )}
            {log.rpe != null && (
              <span className="text-[10px] opacity-80">RPE {log.rpe}</span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
});

export default SlotProgress;
