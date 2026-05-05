import SetRow from './SetRow';
import SlotCommentBox from './SlotCommentBox';
import {
  formatRestSeconds,
  isSlotUniform,
  getSlotTargetRest,
  summarizeSlotPrescription,
} from '../../lib/volume';

function SlotBody({
  slot,
  slotLogs,
  slotComments,
  sessionId,
  isConfirmed,
  isReadOnly,
  getVideoForLog,
  uniform,
  showCommentBox = true,
}) {
  // Sets lock when the student has confirmed the session OR when the session
  // is read-only (past program / coach-archived). The comment box only locks
  // on read-only — students can still add notes to a confirmed-but-not-yet-
  // archived session.
  const setsLocked = isConfirmed || isReadOnly;
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
            locked={setsLocked}
            showTarget={!uniform}
            recordVideo={(slot.record_video_set_numbers || []).includes(log.set_number)}
            video={getVideoForLog ? getVideoForLog(log.id) : null}
          />
        ))}
      </div>
      {showCommentBox && (
        <SlotCommentBox
          sessionId={sessionId}
          slotId={slot.id}
          comment={(slotComments || []).find((c) => c.exercise_slot_id === slot.id)}
          locked={isReadOnly}
        />
      )}
    </div>
  );
}

function SlotHeader({ slot, slotLogs, globalIdx }) {
  const ex = slot.exercise;
  const composed = { ...slot, set_logs: slotLogs };
  const summary = summarizeSlotPrescription(composed);
  // Rest is shown alongside the headline only when uniform across all sets;
  // when sets diverge the per-row display owns rest so the headline stays terse.
  const uniform = isSlotUniform(composed);
  const headRest = uniform ? getSlotTargetRest(composed) : null;
  return (
    <div className="flex items-baseline gap-2.5 flex-1 min-w-0">
      <span className="sl-mono text-[12px]" style={{ color: 'var(--color-accent)' }}>{globalIdx}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="sl-display text-[20px] text-gray-900">{ex.name}</span>
        </div>
        {summary && (
          <p className="sl-mono text-[11px] text-ink-400 mt-1">
            {summary}
            {headRest != null && (
              <span className="ml-2">· Rest {formatRestSeconds(headRest)}</span>
            )}
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
  isReadOnly,
  getVideoForLog,
}) {
  const groupLogs = group.slots.flatMap((s) => getLogsForSlot(s.id));
  const done = groupLogs.filter((l) => l.done).length;
  const total = groupLogs.length;

  if (group.slots.length > 1) {
    // Supersets share a single comment box (one note for the whole pairing,
    // not one per exercise). Anchor the comment to the first slot in the
    // group so existing slot_comments rows on the lead slot stay visible.
    const leadSlot = group.slots[0];
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
            {`${group.slots.length} exercises`}
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
              <SlotBody
                slot={slot}
                slotLogs={slotLogs}
                slotComments={slotComments}
                sessionId={sessionId}
                isConfirmed={isConfirmed}
                isReadOnly={isReadOnly}
                getVideoForLog={getVideoForLog}
                uniform={uniform}
                showCommentBox={false}
              />
            </div>
          );
        })}
        {open && (
          <div className="px-2 pt-1 pb-1">
            <SlotCommentBox
              sessionId={sessionId}
              slotId={leadSlot.id}
              comment={(slotComments || []).find((c) => c.exercise_slot_id === leadSlot.id)}
              locked={isReadOnly}
            />
          </div>
        )}
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
          <SlotBody
            slot={slot}
            slotLogs={slotLogs}
            slotComments={slotComments}
            sessionId={sessionId}
            isConfirmed={isConfirmed}
            isReadOnly={isReadOnly}
            getVideoForLog={getVideoForLog}
            uniform={uniform}
          />
        </div>
      )}
    </div>
  );
}
