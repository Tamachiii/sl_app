import { memo } from 'react';

/**
 * Coach-facing per-slot read-out of the student's logged sets and RPE values.
 * Renders nothing when there are no logs yet (student hasn't started the set).
 */
const SlotProgress = memo(function SlotProgress({ logs, plannedSets }) {
  if (!logs || logs.length === 0) return null;

  const sorted = [...logs].sort((a, b) => a.set_number - b.set_number);
  const doneCount = sorted.filter((l) => l.done).length;
  const failedCount = sorted.filter((l) => l.failed).length;
  const skippedCount = sorted.filter((l) => l.skipped).length;
  const rpeCount = sorted.filter((l) => l.rpe != null).length;

  return (
    <div className="mt-2 border-t border-gray-100 pt-2 space-y-1">
      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>Student progress</span>
        <span>
          <span className="font-medium text-gray-700">{doneCount}</span>/{plannedSets} done
          {failedCount > 0 && (
            <span className="ml-2" style={{ color: 'var(--color-danger)' }}>
              <span className="font-medium">{failedCount}</span> failed
            </span>
          )}
          {skippedCount > 0 && (
            <span className="ml-2 text-gray-400">
              <span className="font-medium">{skippedCount}</span> skipped
            </span>
          )}
          {rpeCount > 0 && (
            <span className="ml-2">
              <span className="font-medium text-gray-700">{rpeCount}</span>/{plannedSets} RPE
            </span>
          )}
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {sorted.map((log) => {
          const failed = !!log.failed;
          const skipped = !!log.skipped;
          const extra = !!log.is_student_added;
          let pillClass;
          if (skipped) pillClass = 'bg-gray-100 text-gray-400 line-through';
          else if (failed) pillClass = 'text-white';
          else if (log.done) pillClass = 'bg-success/10 text-success';
          else pillClass = 'bg-gray-100 text-gray-400';
          const pillStyle = !skipped && failed ? { background: 'var(--color-danger)' } : undefined;
          const label = `${extra ? '+' : ''}Set ${log.set_number}`;
          const title = skipped
            ? `${label}: skipped`
            : failed
              ? `${label}: failed`
              : log.done
                ? log.rpe != null
                  ? `${label}: done @ RPE ${log.rpe}`
                  : `${label}: done (no RPE)`
                : `${label}: not done`;
          return (
            <span
              key={log.id}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${pillClass}`}
              style={pillStyle}
              title={title}
            >
              <span>{label}</span>
              {skipped ? (
                <span aria-hidden="true">–</span>
              ) : failed ? (
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 6l12 12M18 6L6 18" />
                </svg>
              ) : log.done ? (
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <span aria-hidden="true">·</span>
              )}
              {!failed && !skipped && log.rpe != null && (
                <span className="text-[10px] opacity-80">RPE {log.rpe}</span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
});

export default SlotProgress;
