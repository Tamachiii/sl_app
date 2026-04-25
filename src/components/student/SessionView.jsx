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
import Dialog from '../ui/Dialog';
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
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  // Accordion-style manual override:
  //   null      → no manual override; defer to auto (firstOpenIdx).
  //   string    → that group key is the only open one (closes any auto-open).
  //   false     → user manually closed the auto-open group; nothing is open.
  const [openKey, setOpenKey] = useState(null);

  useEffect(() => {
    if (slots.length > 0 && logs !== undefined) {
      ensureLogs.mutate({ sessionId, slots });
    }
  }, [sessionId, slots.length, logs !== undefined]);

  // Auto-open only the first group that still has incomplete sets (or whose
  // logs haven't been ensured yet). Once the user finishes the last set of
  // group N, the next group with incomplete work auto-expands.
  const firstOpenIdx = useMemo(() => {
    for (let i = 0; i < slotGroups.length; i++) {
      const gl = slotGroups[i].slots.flatMap((s) =>
        (logs || []).filter((l) => l.exercise_slot_id === s.id)
      );
      if (gl.length === 0 || gl.some((l) => !l.done)) return i;
    }
    return -1;
  }, [slotGroups, logs]);

  // Manual open/close overrides are single-shot: once the natural auto-open
  // target shifts (e.g. student cancels/undoes a set, or finishes the last
  // set of the current group), drop the override so auto-open/close resumes.
  // Without this reset, revisiting a completed group and then reverting state
  // would leave `openKey` sticky and starve subsequent auto transitions.
  useEffect(() => {
    setOpenKey(null);
  }, [firstOpenIdx]);

  if (sessLoading || logsLoading) {
    return <div className="flex justify-center py-12"><Spinner /></div>;
  }

  function getLogsForSlot(slotId) {
    return (logs || [])
      .filter((l) => l.exercise_slot_id === slotId)
      .sort((a, b) => a.set_number - b.set_number);
  }

  function isGroupOpen(group, idx) {
    // No manual override → auto behavior (only firstOpenIdx is open).
    if (openKey === null) return idx === firstOpenIdx;
    // Manual override → only the chosen key (or none, if `false`) is open.
    return openKey === group.key;
  }

  // Accordion: opening a group closes whichever was previously open. Tapping
  // the currently-open group collapses it (mirrors the Sessions page).
  function toggleGroup(group, idx) {
    const wasOpen = isGroupOpen(group, idx);
    setOpenKey(wasOpen ? false : group.key);
  }

  const isConfirmed = !!confirmation;
  const isArchived = !!session?.archived_at;

  function handleConfirm() {
    confirmSession.mutate({ sessionId, notes: notes.trim() || null }, {
      onSuccess: () => {
        setNotes('');
        setConfirmDialogOpen(false);
      },
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

      {!confLoading && (isConfirmed ? (
        <div
          className="sl-card p-4 space-y-3 !bg-success/5"
          style={{ borderLeft: '3px solid var(--color-success)' }}
        >
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
        </div>
      ) : (
        <button
          onClick={() => setConfirmDialogOpen(true)}
          disabled={confirmSession.isPending}
          className="sl-btn-primary w-full text-[13px] disabled:opacity-50"
          style={{ padding: '10px 16px' }}
        >
          {confirmSession.isPending ? 'Confirming…' : 'Confirm session'}
        </button>
      ))}

      <Dialog
        open={confirmDialogOpen}
        onClose={() => {
          if (!confirmSession.isPending) setConfirmDialogOpen(false);
        }}
        title="Confirm session"
      >
        <p className="sl-mono text-[12px] text-ink-400 mb-3 leading-relaxed">
          Add an optional note for your coach before confirming.
        </p>
        <label htmlFor="confirm-notes" className="sr-only">
          Notes for your coach
        </label>
        <textarea
          id="confirm-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional notes for your coach…"
          rows={4}
          className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-[16px] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] mb-4"
        />
        <div className="flex gap-2">
          <button
            onClick={handleConfirm}
            disabled={confirmSession.isPending}
            className="flex-1 rounded-lg py-2.5 sl-display text-[13px] text-white disabled:opacity-50"
            style={{ background: 'var(--color-accent)' }}
          >
            {confirmSession.isPending ? 'Confirming…' : 'Confirm'}
          </button>
          <button
            onClick={() => setConfirmDialogOpen(false)}
            disabled={confirmSession.isPending}
            className="flex-1 bg-ink-100 text-ink-700 rounded-lg py-2.5 sl-display text-[13px] hover:bg-ink-200 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </Dialog>
    </div>
  );
}
