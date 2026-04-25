import SetRow from './SetRow';
import SlotCommentBox from './SlotCommentBox';
import {
  formatSlotPrescription,
  formatRestSeconds,
  formatSetTarget,
  isSlotUniform,
  getSlotTargetWeight,
  getSlotTargetRest,
} from '../../lib/volume';

function PerSetList({ slotLogs }) {
  if (!slotLogs || slotLogs.length === 0) return null;
  return (
    <ul className="sl-mono text-[11px] text-ink-400 mt-1 space-y-0.5">
      {slotLogs.map((log) => {
        const rest = formatRestSeconds(log.target_rest_seconds);
        return (
          <li key={log.id}>
            <span className="sl-label mr-1">Set {log.set_number}</span>
            {formatSetTarget(log)}
            {rest && <span className="ml-2">· Rest {rest}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function SlotBody({ slot, slotLogs, slotComments, sessionId, isConfirmed, isArchived, getVideoForLog }) {
  return (
    <div className="space-y-3">
      {slot.notes && (
        <div
          className="rounded-lg px-3 py-2.5"
          style={{
            background: 'color-mix(in srgb, var(--color-accent) 8%, transparent)',
            borderLeft: '2px solid var(--color-accent)',
          }}
        >
          <div className="sl-label mb-1" style={{ color: 'var(--color-accent)' }}>Coach note</div>
          <p className="text-[13px] leading-snug text-gray-800 whitespace-pre-wrap">{slot.notes}</p>
        </div>
      )}
      <div className="space-y-1.5">
        {slotLogs.map((log) => (
          <SetRow
            key={log.id}
            log={log}
            locked={isConfirmed}
            recordVideo={(slot.record_video_set_numbers || []).includes(log.set_number)}
            video={getVideoForLog ? getVideoForLog(log.id) : null}
          />
        ))}
      </div>
      <SlotCommentBox
        sessionId={sessionId}
        slotId={slot.id}
        comment={(slotComments || []).find((c) => c.exercise_slot_id === slot.id)}
        locked={isArchived}
      />
    </div>
  );
}

function SlotHeader({ slot, slotLogs, globalIdx }) {
  const ex = slot.exercise;
  const composed = { ...slot, set_logs: slotLogs };
  const uniform = isSlotUniform(composed);
  const compact = uniform ? formatSlotPrescription(composed) : null;
  const headWeight = getSlotTargetWeight(composed);
  const headRest = getSlotTargetRest(composed);
  return (
    <div className="flex items-baseline gap-2.5 flex-1 min-w-0">
      <span className="sl-mono text-[12px]" style={{ color: 'var(--color-accent)' }}>{globalIdx}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="sl-display text-[20px] text-gray-900">{ex.name}</span>
        </div>
        {uniform ? (
          <p className="sl-mono text-[11px] text-ink-400 mt-1">
            {compact}
            {headWeight ? ` @ ${headWeight}kg` : ' (BW)'}
            {headRest != null && (
              <span className="ml-2">· Rest {formatRestSeconds(headRest)}</span>
            )}
          </p>
        ) : (
          <p className="sl-mono text-[11px] text-ink-400 mt-1">
            {slot.sets} sets · varied
          </p>
        )}
      </div>
    </div>
  );
}

function Chevron({ open }) {
  return (
    <svg
      className={`w-4 h-4 text-ink-400 shrink-0 self-center transition-transform ${open ? 'rotate-180' : ''}`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

export default function SlotGroupCard({
  group,
  groupIdx,
  open,
  onToggle,
  getLogsForSlot,
  slotComments,
  sessionId,
  isConfirmed,
  isArchived,
  getVideoForLog,
}) {
  const groupLogs = group.slots.flatMap((s) => getLogsForSlot(s.id));
  const done = groupLogs.filter((l) => l.done).length;
  const total = groupLogs.length;

  if (group.slots.length > 1) {
    return (
      <div
        className="rounded-xl border-2 p-2 space-y-2"
        style={{
          borderColor: 'color-mix(in srgb, var(--color-accent) 35%, transparent)',
          background: 'color-mix(in srgb, var(--color-accent) 5%, transparent)',
        }}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="w-full px-2 pt-1 pb-1 flex items-baseline gap-2 text-left"
        >
          <span className="sl-label" style={{ color: 'var(--color-accent)' }}>Superset</span>
          <span className="sl-mono text-[11px] text-ink-400 flex-1 truncate">
            {open ? 'Alternate between exercises each set' : `${group.slots.length} exercises`}
          </span>
          {total > 0 && (
            <span className="sl-mono text-[11px] text-ink-400 shrink-0">{done}/{total}</span>
          )}
          <Chevron open={open} />
        </button>
        {open && group.slots.map((slot, i) => {
          const globalIdx = String(groupIdx + i + 1).padStart(2, '0');
          const slotLogs = getLogsForSlot(slot.id);
          const uniform = isSlotUniform({ ...slot, set_logs: slotLogs });
          return (
            <div key={slot.id} className="sl-card p-4 space-y-3">
              <SlotHeader slot={slot} slotLogs={slotLogs} globalIdx={globalIdx} />
              {!uniform && <PerSetList slotLogs={slotLogs} />}
              <SlotBody
                slot={slot}
                slotLogs={slotLogs}
                slotComments={slotComments}
                sessionId={sessionId}
                isConfirmed={isConfirmed}
                isArchived={isArchived}
                getVideoForLog={getVideoForLog}
              />
            </div>
          );
        })}
      </div>
    );
  }

  const slot = group.slots[0];
  const slotLogs = getLogsForSlot(slot.id);
  const uniform = isSlotUniform({ ...slot, set_logs: slotLogs });
  const globalIdx = String(groupIdx + 1).padStart(2, '0');
  return (
    <div className="sl-card overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-baseline gap-2.5 p-4 text-left hover:bg-ink-50 transition-colors"
      >
        <SlotHeader slot={slot} slotLogs={slotLogs} globalIdx={globalIdx} />
        {total > 0 && (
          <span className="sl-mono text-[11px] text-ink-400 shrink-0 self-center">{done}/{total}</span>
        )}
        <Chevron open={open} />
      </button>
      {open && (
        <div className="px-4 pb-4 pt-3 border-t border-ink-100">
          {!uniform && <PerSetList slotLogs={slotLogs} />}
          <SlotBody
            slot={slot}
            slotLogs={slotLogs}
            slotComments={slotComments}
            sessionId={sessionId}
            isConfirmed={isConfirmed}
            isArchived={isArchived}
            getVideoForLog={getVideoForLog}
          />
        </div>
      )}
    </div>
  );
}
