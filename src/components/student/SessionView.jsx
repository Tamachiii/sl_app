import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useSession } from '../../hooks/useSession';
import { useSetLogs, useEnsureSetLogs } from '../../hooks/useSetLogs';
import { useSlotComments } from '../../hooks/useSlotComments';
import { useSetVideos } from '../../hooks/useSetVideo';
import {
  useSessionConfirmation,
  useConfirmSession,
  useUnconfirmSession,
} from '../../hooks/useSessionConfirmation';
import Spinner from '../ui/Spinner';
import { groupSlotsBySuperset } from '../../lib/volume';
import { DAY_FULL } from '../../lib/day';
import SlotGroupCard from './SlotGroupCard';

function SessionTopBar({ title, meta, onBack }) {
  return (
    <div className="flex items-center justify-between gap-3 pt-3 pb-4">
      <button
        onClick={onBack}
        aria-label="Go back"
        className="w-9 h-9 rounded-full bg-ink-100 text-ink-700 flex items-center justify-center hover:bg-ink-200 active:scale-95 transition"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <div className="min-w-0 text-center">
        {meta && <div className="sl-label truncate">{meta}</div>}
        <div className="sl-display text-[16px] text-gray-900 truncate">{title}</div>
      </div>
      <div className="w-9 h-9" aria-hidden />
    </div>
  );
}

export default function SessionView() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { data: session, isLoading: sessLoading } = useSession(sessionId);
  const slots = session?.exercise_slots || [];
  const { data: logs, isLoading: logsLoading } = useSetLogs(sessionId, slots);
  const { data: slotComments } = useSlotComments(sessionId, slots);
  const slotIds = useMemo(() => slots.map((s) => s.id), [slots]);
  const { data: videos } = useSetVideos(sessionId, slotIds);
  const videosByLogId = useMemo(() => {
    const m = new Map();
    (videos || []).forEach((v) => m.set(v.set_log_id, v));
    return m;
  }, [videos]);
  const slotGroups = useMemo(() => groupSlotsBySuperset(slots), [slots]);
  const ensureLogs = useEnsureSetLogs();
  const { data: confirmation, isLoading: confLoading } = useSessionConfirmation(sessionId);
  const confirmSession = useConfirmSession();
  const unconfirmSession = useUnconfirmSession();

  const [notes, setNotes] = useState('');
  const [manualOpen, setManualOpen] = useState({});

  useEffect(() => {
    if (slots.length > 0 && logs !== undefined) {
      ensureLogs.mutate({ sessionId, slots });
    }
  }, [sessionId, slots.length, logs !== undefined]);

  if (sessLoading || logsLoading) {
    return <div className="flex justify-center py-12"><Spinner /></div>;
  }

  function getLogsForSlot(slotId) {
    return (logs || [])
      .filter((l) => l.exercise_slot_id === slotId)
      .sort((a, b) => a.set_number - b.set_number);
  }

  function getGroupLogs(group) {
    return group.slots.flatMap((s) => getLogsForSlot(s.id));
  }

  // Auto-open only the first group that still has incomplete sets (or whose
  // logs haven't been ensured yet). Once the user finishes the last set of
  // group N, the next group with incomplete work auto-expands.
  let firstOpenIdx = -1;
  for (let i = 0; i < slotGroups.length; i++) {
    const gl = getGroupLogs(slotGroups[i]);
    if (gl.length === 0 || gl.some((l) => !l.done)) {
      firstOpenIdx = i;
      break;
    }
  }

  function isGroupOpen(group, idx) {
    if (manualOpen[group.key] !== undefined) return manualOpen[group.key];
    return idx === firstOpenIdx;
  }

  function toggleGroup(group, idx) {
    const currently = isGroupOpen(group, idx);
    setManualOpen((prev) => ({ ...prev, [group.key]: !currently }));
  }

  const isConfirmed = !!confirmation;
  const isArchived = !!session?.archived_at;

  function handleConfirm() {
    confirmSession.mutate({ sessionId, notes: notes.trim() || null }, {
      onSuccess: () => setNotes(''),
    });
  }

  function handleUnconfirm() {
    if (confirm('Undo confirmation for this session?')) {
      unconfirmSession.mutate({ sessionId });
    }
  }

  // Build total-sets progress numbers.
  const allLogs = logs || [];
  const doneCount = allLogs.filter((l) => l.done).length;
  const totalCount = allLogs.length;
  const progress = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  // Top-bar metadata: weekday + exercise count.
  const metaBits = [];
  if (session?.scheduled_date) {
    const [y, m, d] = session.scheduled_date.split('-').map(Number);
    const jsDay = new Date(y, m - 1, d).getDay();
    const dn = jsDay === 0 ? 7 : jsDay;
    metaBits.push(DAY_FULL[dn - 1].toUpperCase());
  }
  if (slots.length > 0) metaBits.push(`${slots.length} EX`);

  return (
    <div className="p-4 pb-6 md:p-8 space-y-5">
      <SessionTopBar
        title={session?.title || 'Session'}
        meta={metaBits.join(' · ')}
        onBack={() => navigate(-1)}
      />

      {/* Progress bar */}
      {totalCount > 0 && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="sl-mono text-[11px] text-ink-400">{doneCount} of {totalCount} sets</span>
            <span className="sl-mono text-[11px]" style={{ color: 'var(--color-accent)' }}>{progress}%</span>
          </div>
          <div className="h-1 rounded-full bg-ink-100 overflow-hidden">
            <div
              className="h-full transition-[width] duration-300"
              style={{ width: `${progress}%`, background: 'var(--color-accent)' }}
            />
          </div>
        </div>
      )}

      {slotGroups.map((group, groupIdx) => (
        <SlotGroupCard
          key={group.key}
          group={group}
          groupIdx={groupIdx}
          open={isGroupOpen(group, groupIdx)}
          onToggle={() => toggleGroup(group, groupIdx)}
          getLogsForSlot={getLogsForSlot}
          slotComments={slotComments}
          sessionId={sessionId}
          isConfirmed={isConfirmed}
          isArchived={isArchived}
          getVideoForLog={(logId) => videosByLogId.get(logId) || null}
        />
      ))}

      {!confLoading && (
        <div
          className={`sl-card p-4 space-y-3 ${
            isConfirmed ? '!bg-success/5' : ''
          }`}
          style={isConfirmed ? { borderLeft: '3px solid var(--color-success)' } : undefined}
        >
          {isConfirmed ? (
            <>
              <div className="flex items-start gap-3">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: 'var(--color-success)', color: 'var(--color-ink-900)' }}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="sl-display text-[16px] text-gray-900">Session confirmed</p>
                  <p className="sl-mono text-[11px] text-ink-400 mt-0.5">
                    {new Date(confirmation.confirmed_at).toLocaleString()}
                  </p>
                  {confirmation.notes && (
                    <p className="mt-2 text-[13px] text-gray-700 whitespace-pre-wrap">
                      {confirmation.notes}
                    </p>
                  )}
                </div>
              </div>
              {isArchived ? (
                <p className="sl-mono text-[11px] text-ink-400 text-center">
                  Archived by your coach — confirmation is locked.
                </p>
              ) : (
                <button
                  onClick={handleUnconfirm}
                  disabled={unconfirmSession.isPending}
                  className="sl-mono text-[11px] text-ink-400 hover:text-danger underline w-full"
                >
                  Undo confirmation
                </button>
              )}
            </>
          ) : (
            <>
              <div>
                <p className="sl-display text-[18px] text-gray-900">Confirm session</p>
                <p className="sl-mono text-[11px] text-ink-400 mt-1">
                  Let your coach know you've completed this session.
                </p>
              </div>
              <label htmlFor="confirm-notes" className="sr-only">
                Notes for your coach
              </label>
              <textarea
                id="confirm-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional notes for your coach…"
                rows={3}
                className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-[14px] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              />
              <button
                onClick={handleConfirm}
                disabled={confirmSession.isPending}
                className="sl-btn-primary w-full text-[13px] disabled:opacity-50"
                style={{ padding: '10px 16px' }}
              >
                {confirmSession.isPending ? 'Confirming…' : 'Confirm session'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
