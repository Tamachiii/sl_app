import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useSession } from '../../hooks/useSession';
import { useSetLogs, useEnsureSetLogs } from '../../hooks/useSetLogs';
import { useSlotComments } from '../../hooks/useSlotComments';
import SlotCommentBox from './SlotCommentBox';
import {
  useSessionConfirmation,
  useConfirmSession,
  useUnconfirmSession,
} from '../../hooks/useSessionConfirmation';
import SetRow from './SetRow';
import Spinner from '../ui/Spinner';
import { formatSlotPrescription, formatRestSeconds, groupSlotsBySuperset } from '../../lib/volume';

const DAY_FULL = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

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

  function isGroupOpen(group) {
    if (manualOpen[group.key] !== undefined) return manualOpen[group.key];
    const gl = getGroupLogs(group);
    if (gl.length === 0) return true;
    return gl.some((l) => !l.done);
  }

  function toggleGroup(group) {
    const currently = isGroupOpen(group);
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
    <div className="p-4 pb-6 space-y-5">
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

      {slotGroups.map((group, groupIdx) => {
        const open = isGroupOpen(group);
        const gl = getGroupLogs(group);
        const done = gl.filter((l) => l.done).length;
        const total = gl.length;
        const chevron = (
          <svg
            className={`w-4 h-4 text-ink-400 shrink-0 self-center transition-transform ${open ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        );

        const renderSlotFull = (slot, slotIdx) => {
          const ex = slot.exercise;
          const slotLogs = getLogsForSlot(slot.id);
          const globalIdx = String(slotIdx + 1).padStart(2, '0');
          return (
            <div key={slot.id} className="sl-card p-4 space-y-3">
              <div className="flex items-baseline gap-2.5">
                <span className="sl-mono text-[12px]" style={{ color: 'var(--color-accent)' }}>{globalIdx}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="sl-display text-[20px] text-gray-900">{ex.name}</span>
                    <span
                      className={`sl-pill ${
                        ex.type === 'pull' ? 'bg-pull/15 text-pull' : 'bg-push/15 text-push'
                      }`}
                    >
                      {ex.type}
                    </span>
                  </div>
                  <p className="sl-mono text-[11px] text-ink-400 mt-1">
                    {formatSlotPrescription(slot)}
                    {slot.weight_kg ? ` @ ${slot.weight_kg}kg` : ' (BW)'}
                    {slot.rest_seconds != null && (
                      <span className="ml-2">· Rest {formatRestSeconds(slot.rest_seconds)}</span>
                    )}
                  </p>
                </div>
              </div>

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
                    restSeconds={slot.rest_seconds}
                    recordVideo={(slot.record_video_set_numbers || []).includes(log.set_number)}
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
        };

        if (group.slots.length > 1) {
          return (
            <div
              key={group.key}
              className="rounded-xl border-2 p-2 space-y-2"
              style={{
                borderColor: 'color-mix(in srgb, var(--color-accent) 35%, transparent)',
                background: 'color-mix(in srgb, var(--color-accent) 5%, transparent)',
              }}
            >
              <button
                type="button"
                onClick={() => toggleGroup(group)}
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
                {chevron}
              </button>
              {open && group.slots.map((s, i) => renderSlotFull(s, groupIdx + i))}
            </div>
          );
        }

        const slot = group.slots[0];
        const ex = slot.exercise;
        const slotLogs = getLogsForSlot(slot.id);
        const globalIdx = String(groupIdx + 1).padStart(2, '0');
        return (
          <div key={slot.id} className="sl-card overflow-hidden">
            <button
              type="button"
              onClick={() => toggleGroup(group)}
              aria-expanded={open}
              className="w-full flex items-baseline gap-2.5 p-4 text-left hover:bg-ink-50 transition-colors"
            >
              <span className="sl-mono text-[12px]" style={{ color: 'var(--color-accent)' }}>{globalIdx}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="sl-display text-[20px] text-gray-900">{ex.name}</span>
                  <span
                    className={`sl-pill ${
                      ex.type === 'pull' ? 'bg-pull/15 text-pull' : 'bg-push/15 text-push'
                    }`}
                  >
                    {ex.type}
                  </span>
                </div>
                <p className="sl-mono text-[11px] text-ink-400 mt-1">
                  {formatSlotPrescription(slot)}
                  {slot.weight_kg ? ` @ ${slot.weight_kg}kg` : ' (BW)'}
                  {slot.rest_seconds != null && (
                    <span className="ml-2">· Rest {formatRestSeconds(slot.rest_seconds)}</span>
                  )}
                </p>
              </div>
              {total > 0 && (
                <span className="sl-mono text-[11px] text-ink-400 shrink-0 self-center">{done}/{total}</span>
              )}
              {chevron}
            </button>
            {open && (
              <div className="px-4 pb-4 pt-3 space-y-3 border-t border-ink-100">
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
                      restSeconds={slot.rest_seconds}
                      recordVideo={(slot.record_video_set_numbers || []).includes(log.set_number)}
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
            )}
          </div>
        );
      })}

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
