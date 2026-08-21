import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useSession } from '../../hooks/useSession';
import { useSetLogs, useEnsureSetLogs } from '../../hooks/useSetLogs';
import { useSlotComments } from '../../hooks/useSlotComments';
import { useSlotDeviations } from '../../hooks/useSlotDeviations';
import { useLastPerformance } from '../../hooks/useLastPerformance';
import { useExerciseLibrary } from '../../hooks/useExerciseLibrary';
import { useSetVideos } from '../../hooks/useSetVideo';
import {
  useSessionConfirmation,
  useConfirmSession,
  useUnconfirmSession,
} from '../../hooks/useSessionConfirmation';
import { useSessionFeedback, formatMessageStamp } from '../../hooks/useMessages';
import { useI18n } from '../../hooks/useI18n';
import Spinner from '../ui/Spinner';
import Dialog from '../ui/Dialog';
import ConfirmDialog from '../ui/ConfirmDialog';
import { groupSlotsBySuperset } from '../../lib/volume';
import { DAY_FULL, performedOnFromLogs } from '../../lib/day';
import SlotGroupCard from './SlotGroupCard';
import RestTimerBanner from './RestTimerBanner';
import { useRestTimerEffects } from '../../hooks/useRestTimerEffects';
import { useRestTimerPush } from '../../hooks/useRestTimerPush';

// A set no longer needs the student's attention iff it was skipped, failed,
// completed with an RPE, or belongs to an exercise the student skip-deviated
// (those logs are hidden by SlotGroupCard, so they could otherwise never
// resolve — pinning the accordion and capping progress below 100% for the
// rest of the session). The RPE requirement pairs with SetRow's auto-expand
// on the done transition — see the firstOpenIdx comment.
function isLogResolved(log, skippedSlotIds) {
  return (
    log.skipped ||
    log.failed ||
    (log.done && log.rpe != null) ||
    skippedSlotIds.has(log.exercise_slot_id)
  );
}

function SessionTopBar({ title, meta, onBack }) {
  return (
    <div className="flex items-center justify-between gap-3 pt-3 pb-4">
      <button
        onClick={onBack}
        aria-label="Go back"
        className="w-9 h-9 rounded-full bg-ink-100 text-ink-700 flex items-center justify-center hover:bg-ink-200 active:scale-95 transition shrink-0"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <div className="min-w-0 text-center flex-1">
        {meta && <div className="sl-label truncate">{meta}</div>}
        <div className="sl-display text-[16px] text-gray-900 truncate">{title}</div>
      </div>
      {/* Right slot: rest-timer pill when active, empty 36px placeholder
          otherwise (keeps the title centered between the back button and
          this slot). */}
      <div className="min-w-9 h-9 flex items-center justify-end shrink-0">
        <RestTimerBanner />
      </div>
    </div>
  );
}

export default function SessionView() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { t, lang } = useI18n();
  const { data: session, isLoading: sessLoading } = useSession(sessionId);
  const { data: feedback } = useSessionFeedback(sessionId);
  const slots = session?.exercise_slots || [];
  const { data: logs, isLoading: logsLoading } = useSetLogs(sessionId, slots);
  const { data: slotComments } = useSlotComments(sessionId, slots);
  const { data: slotDeviations, isFetched: deviationsFetched } = useSlotDeviations(
    sessionId,
    slots,
  );
  const { data: lastPerformance } = useLastPerformance(
    sessionId,
    slots,
    session?.scheduled_date,
    slotDeviations,
    deviationsFetched,
  );
  const { data: exerciseLibrary } = useExerciseLibrary();
  const slotIds = useMemo(() => slots.map((s) => s.id), [slots]);
  const { data: videos } = useSetVideos(sessionId, slotIds);
  const videosByLogId = useMemo(() => {
    const m = new Map();
    (videos || []).forEach((v) => m.set(v.set_log_id, v));
    return m;
  }, [videos]);
  const slotGroups = useMemo(() => groupSlotsBySuperset(slots), [slots]);
  // Per-group offset = cumulative slot count of all preceding groups. Lets
  // SlotGroupCard label its rows with the global slot position (e.g. an
  // entry after a 2-slot superset starts at 04, not 03 from the group
  // index).
  const groupSlotOffsets = useMemo(() => {
    const offsets = [];
    let acc = 0;
    for (const g of slotGroups) {
      offsets.push(acc);
      acc += g.slots.length;
    }
    return offsets;
  }, [slotGroups]);
  const ensureLogs = useEnsureSetLogs();
  const { data: confirmation, isLoading: confLoading } = useSessionConfirmation(sessionId);
  const confirmSession = useConfirmSession();
  const unconfirmSession = useUnconfirmSession();

  // Out-of-band rest-timer side effects (wake lock + audio cue + vibrate +
  // hidden-title countdown). Mounted exactly here so the singleton timer
  // has one driver site, mirroring RestTimerBanner. See useRestTimerEffects.
  useRestTimerEffects();
  // Background push bridge: schedules a "Rest done" Web Push on the server
  // for users who opted in (StudentProfile → Rest end notifications).
  // No-op when push isn't supported or the user hasn't enabled it.
  useRestTimerPush();

  const [notes, setNotes] = useState('');
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [undoDialogOpen, setUndoDialogOpen] = useState(false);
  // Accordion-style manual override:
  //   null      → no manual override; defer to auto (firstOpenIdx).
  //   string    → that group key is the only open one (closes any auto-open).
  //   false     → user manually closed the auto-open group; nothing is open.
  const [openKey, setOpenKey] = useState(null);

  // Only run the safety-net materialization on writeable sessions. Past-
  // program / coach-archived sessions reject INSERT under RLS, so calling
  // ensureLogs would only generate silent failures. The backfill migration
  // (2026_04_26_backfill_missing_set_logs.sql) covers legacy past-program
  // slots once at deploy time.
  const canMaterializeLogs =
    !!session && session.program_is_active !== false && !session.archived_at;
  useEffect(() => {
    if (canMaterializeLogs && slots.length > 0 && logs !== undefined) {
      ensureLogs.mutate({ sessionId, slots });
    }
  }, [sessionId, slots.length, logs !== undefined, canMaterializeLogs]);

  // Slot ids the student skip-deviated: every log under them counts as
  // resolved (see isLogResolved).
  const skippedSlotIds = useMemo(
    () =>
      new Set(
        (slotDeviations || [])
          .filter((d) => d.kind === 'skip')
          .map((d) => d.exercise_slot_id)
      ),
    [slotDeviations]
  );

  // Auto-open only the first group that still has unresolved sets (see
  // isLogResolved for the predicate). The RPE requirement pairs with
  // SetRow's auto-expand on the done transition: without it, the last set's
  // auto-expanded RPE panel would collapse before the student can record a
  // value, because the group would advance the moment the set flips to done.
  // Failed and skipped sets bypass — RPE is locked/meaningless there.
  const firstOpenIdx = useMemo(() => {
    for (let i = 0; i < slotGroups.length; i++) {
      const gl = slotGroups[i].slots.flatMap((s) =>
        (logs || []).filter((l) => l.exercise_slot_id === s.id)
      );
      if (gl.length === 0 || gl.some((l) => !isLogResolved(l, skippedSlotIds))) return i;
    }
    return -1;
  }, [slotGroups, logs, skippedSlotIds]);

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
  // Sessions become read-only once the parent program is no longer the
  // student's active block (so history viewed via the stats calendar can't
  // be retroactively confirmed/undone) or once the coach has individually
  // archived the session. RLS enforces the same rule server-side; this is
  // the UI gate.
  const isPastProgram = session ? session.program_is_active === false : false;
  const isReadOnly = isPastProgram || isArchived;

  function handleConfirm() {
    // Pin the training date HERE, from the set logs, rather than letting the
    // server's confirmed_at default stand in for it: a confirm queued offline
    // replays whenever connectivity returns, which can be days later.
    const performedOn = performedOnFromLogs(logs);
    confirmSession.mutate({ sessionId, notes: notes.trim() || null, performedOn }, {
      onSuccess: () => {
        setNotes('');
        setConfirmDialogOpen(false);
      },
    });
  }

  function handleUnconfirm() {
    setUndoDialogOpen(false);
    unconfirmSession.mutate({ sessionId });
  }

  // Build total-sets progress numbers. The text counts only successfully
  // completed sets (a quality signal), but the progress bar reflects every
  // resolved set — failed, skipped, and skip-deviated included — so a
  // deviated session can still reach 100%.
  const allLogs = logs || [];
  const doneCount = allLogs.filter((l) => l.done).length;
  // `l.done ||` is the bar's sole divergence from isLogResolved: the bar
  // doesn't wait for an RPE on a done set.
  const resolvedCount = allLogs.filter(
    (l) => l.done || isLogResolved(l, skippedSlotIds)
  ).length;
  const totalCount = allLogs.length;
  const progress = totalCount > 0 ? Math.round((resolvedCount / totalCount) * 100) : 0;

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

      {feedback && (
        <section
          aria-labelledby="coach-feedback-heading"
          className="sl-card p-4 space-y-3"
          style={{ borderLeft: '3px solid var(--color-accent)' }}
        >
          <div className="flex items-center justify-between gap-3">
            <h2
              id="coach-feedback-heading"
              className="sl-label flex items-center gap-2"
              style={{ color: 'var(--color-accent)' }}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              {t('student.feedback.title')}
            </h2>
            <span className="sl-mono text-[11px] text-ink-400 shrink-0">
              {formatMessageStamp(feedback.created_at, lang)}
            </span>
          </div>
          <p className="text-[14px] text-gray-900 whitespace-pre-wrap leading-relaxed">
            {feedback.body}
          </p>
          <button
            type="button"
            onClick={() => navigate('/student/messages')}
            className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200"
          >
            {t('student.feedback.replyInMessages')}
          </button>
        </section>
      )}

      {slotGroups.map((group, groupIdx) => (
        <SlotGroupCard
          key={group.key}
          group={group}
          slotOffset={groupSlotOffsets[groupIdx]}
          open={isGroupOpen(group, groupIdx)}
          onToggle={() => toggleGroup(group, groupIdx)}
          getLogsForSlot={getLogsForSlot}
          slotComments={slotComments}
          slotDeviations={slotDeviations}
          lastPerformance={lastPerformance}
          exerciseLibrary={exerciseLibrary}
          sessionId={sessionId}
          isConfirmed={isConfirmed}
          isReadOnly={isReadOnly}
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
              <p className="sl-display text-[16px] text-gray-900">{t('student.session.confirmed')}</p>
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
          {isReadOnly ? (
            <p className="sl-mono text-[11px] text-ink-400 text-center">
              {isArchived
                ? t('student.session.lockedArchived')
                : t('student.session.lockedPast')}
            </p>
          ) : (
            <button
              onClick={() => setUndoDialogOpen(true)}
              disabled={unconfirmSession.isPending}
              className="sl-mono text-[11px] text-ink-400 hover:text-danger underline w-full"
            >
              {t('student.session.undoConfirmation')}
            </button>
          )}
        </div>
      ) : isReadOnly ? (
        <div
          className="sl-card p-4 text-center"
          style={{ borderLeft: '3px solid var(--color-ink-300)' }}
        >
          <p className="sl-mono text-[11px] text-ink-400">
            {isArchived
              ? t('student.session.readOnlyArchived')
              : t('student.session.readOnlyPast')}
          </p>
        </div>
      ) : (
        <button
          onClick={() => setConfirmDialogOpen(true)}
          disabled={confirmSession.isPending}
          className="sl-btn-primary w-full text-[13px] disabled:opacity-50"
          style={{ padding: '10px 16px' }}
        >
          {confirmSession.isPending
            ? t('student.session.confirming')
            : t('student.session.confirmCta')}
        </button>
      ))}

      <Dialog
        open={confirmDialogOpen}
        onClose={() => {
          if (!confirmSession.isPending) setConfirmDialogOpen(false);
        }}
        title={t('student.session.confirmDialogTitle')}
      >
        <p className="sl-mono text-[12px] text-ink-400 mb-3 leading-relaxed">
          {t('student.session.confirmDialogBody')}
        </p>
        <label htmlFor="confirm-notes" className="sr-only">
          {t('student.session.notesLabel')}
        </label>
        <textarea
          id="confirm-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t('student.session.notesPlaceholder')}
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
            {confirmSession.isPending
              ? t('student.session.confirming')
              : t('common.confirm')}
          </button>
          <button
            onClick={() => setConfirmDialogOpen(false)}
            disabled={confirmSession.isPending}
            className="flex-1 bg-ink-100 text-ink-700 rounded-lg py-2.5 sl-display text-[13px] hover:bg-ink-200 disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
        </div>
      </Dialog>

      <ConfirmDialog
        open={undoDialogOpen}
        onClose={() => setUndoDialogOpen(false)}
        onConfirm={handleUnconfirm}
        title={t('student.session.undoConfirmTitle')}
        message={t('student.session.undoConfirmBody')}
        confirmText={t('student.session.undoConfirmation')}
      />
    </div>
  );
}
