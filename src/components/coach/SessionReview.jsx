import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

const LAST_COACH_SESSION_KEY = 'sl_last_coach_session';
import Spinner from '../ui/Spinner';
import VideoLightbox from '../ui/VideoLightbox';
import VideoPlayer from '../ui/VideoPlayer';
import VideoThumbCard from '../ui/VideoThumbCard';
import { useSession } from '../../hooks/useSession';
import { useSetLogs } from '../../hooks/useSetLogs';
import { useSlotComments } from '../../hooks/useSlotComments';
import { useSetVideos } from '../../hooks/useSetVideo';
import { useArchiveSession } from '../../hooks/useWeek';
import { useSessionConfirmation } from '../../hooks/useSessionConfirmation';
import { useStudents } from '../../hooks/useStudents';
import { useSessionFeedback } from '../../hooks/useMessages';
import SlotProgress from './SlotProgress';
import SessionFeedbackComposer from './SessionFeedbackComposer';
import SessionFeedbackSent from './SessionFeedbackSent';
import SessionReviewedNoFeedback from './SessionReviewedNoFeedback';
import {
  formatRestSeconds,
  groupSlotsBySuperset,
  isSlotUniform,
  formatSetTarget,
  getSlotTargetRest,
  summarizeSlotPrescription,
} from '../../lib/volume';

function SlotVideoStrip({ videos, onPlay }) {
  if (!videos || videos.length === 0) return null;
  const sorted = [...videos].sort((a, b) => a.set_number - b.set_number);
  return (
    <div className="flex flex-wrap gap-2 pt-2">
      {sorted.map((v) => (
        <VideoThumbCard
          key={v.id}
          setNumber={v.set_number}
          onClick={() => onPlay(v)}
        />
      ))}
    </div>
  );
}

export default function SessionReview() {
  const { studentId, sessionId } = useParams();
  const navigate = useNavigate();

  // Persist so tabbing between Sessions and other tabs returns to this
  // review instead of dropping the coach back on the feed. Cleared on
  // explicit back-button click below.
  useEffect(() => {
    if (!studentId || !sessionId) return;
    try {
      localStorage.setItem(
        LAST_COACH_SESSION_KEY,
        JSON.stringify({ studentId, sessionId }),
      );
    } catch { /* ignore */ }
  }, [studentId, sessionId]);

  function handleBack() {
    try { localStorage.removeItem(LAST_COACH_SESSION_KEY); } catch { /* ignore */ }
    // Explicit parent — history's previous entry can be any tab the coach
    // came through (and the SessionsFeed restore redirect complicates it).
    navigate('/coach/sessions');
  }

  const { data: session, isLoading } = useSession(sessionId);
  const slots = session?.exercise_slots || [];
  const { data: setLogs } = useSetLogs(sessionId, slots);
  const { data: slotComments } = useSlotComments(sessionId, slots);
  const slotIds = useMemo(() => slots.map((s) => s.id), [slots]);
  const { data: videos } = useSetVideos(sessionId, slotIds);
  const videosBySlot = useMemo(() => {
    const m = new Map();
    (videos || []).forEach((v) => {
      const arr = m.get(v.exercise_slot_id) || [];
      arr.push(v);
      m.set(v.exercise_slot_id, arr);
    });
    return m;
  }, [videos]);
  const { data: confirmation } = useSessionConfirmation(sessionId);
  const { data: existingFeedback, isLoading: feedbackLoading } = useSessionFeedback(sessionId);
  const archiveSession = useArchiveSession();
  const { data: students } = useStudents();
  const student = useMemo(
    () => (students || []).find((s) => s.id === studentId) || null,
    [students, studentId],
  );
  const slotGroups = useMemo(() => groupSlotsBySuperset(slots), [slots]);
  const isArchived = !!session?.archived_at;
  const [playing, setPlaying] = useState(null);

  if (isLoading) {
    return <div className="flex justify-center py-12"><Spinner /></div>;
  }

  return (
    <div className="p-4 pb-6 md:p-8 space-y-5">
      <div className="flex items-start gap-3">
        <button
          onClick={handleBack}
          aria-label="Back"
          className="w-9 h-9 rounded-lg bg-ink-100 flex items-center justify-center text-ink-700 hover:bg-ink-200 shrink-0"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <div className="sl-label text-ink-400">Review</div>
          <h1 className="sl-display text-[22px] text-gray-900 leading-tight mt-0.5 truncate">
            {session?.title || 'Session'}
          </h1>
        </div>
        <button
          onClick={() => archiveSession.mutate({ sessionId, archived: !isArchived })}
          disabled={archiveSession.isPending}
          className={`sl-pill shrink-0 disabled:opacity-50 ${
            isArchived ? '' : 'bg-ink-100 text-ink-700 hover:bg-ink-200'
          }`}
          style={
            isArchived
              ? {
                  background: 'color-mix(in srgb, var(--color-warn) 22%, transparent)',
                  color: 'var(--color-ink-900)',
                }
              : undefined
          }
        >
          {isArchived ? 'unarchive' : 'archive'}
        </button>
      </div>

      {isArchived && (
        <div
          className="rounded-xl p-3 sl-mono text-[12px]"
          style={{
            background: 'color-mix(in srgb, var(--color-warn) 12%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-warn) 35%, transparent)',
            color: 'var(--color-ink-900)',
          }}
        >
          Archived on {new Date(session.archived_at).toLocaleString()}
        </div>
      )}

      {confirmation ? (
        <div
          className="rounded-xl p-3 space-y-1"
          style={{
            background: 'color-mix(in srgb, var(--color-success) 10%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-success) 35%, transparent)',
          }}
        >
          <div
            className="flex items-center gap-2 sl-label"
            style={{ color: 'var(--color-success)' }}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
            Confirmed by student
          </div>
          <p className="sl-mono text-[11px] text-ink-400">
            {new Date(confirmation.confirmed_at).toLocaleString()}
          </p>
          {confirmation.notes && (
            <p className="text-[13px] text-ink-700 whitespace-pre-wrap pt-1">{confirmation.notes}</p>
          )}
        </div>
      ) : (
        <div className="sl-card p-3 sl-mono text-[12px] text-ink-500">
          Not yet confirmed by the student.
        </div>
      )}

      <div className="space-y-3">
        {slotGroups.map((group) => {
          const renderSlot = (slot) => {
            const ex = slot.exercise;
            const slotLogs = (setLogs || [])
              .filter((l) => l.exercise_slot_id === slot.id)
              .slice()
              .sort((a, b) => a.set_number - b.set_number);
            const comment = (slotComments || []).find((x) => x.exercise_slot_id === slot.id);
            const composed = { ...slot, set_logs: slotLogs };
            const uniform = isSlotUniform(composed);
            const summary = summarizeSlotPrescription(composed);
            const headRest = uniform ? getSlotTargetRest(composed) : null;
            return (
              <div key={slot.id} className="sl-card p-4 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="sl-display text-[16px] text-gray-900">{ex.name}</span>
                  <span
                    className={`sl-pill ${
                      ex.type === 'pull' ? 'bg-pull/15 text-pull' : 'bg-push/15 text-push'
                    }`}
                  >
                    {ex.type}
                  </span>
                  <span className="sl-mono text-[10px] text-ink-400">D{ex.difficulty}</span>
                </div>
                <div className="sl-mono text-[11px] text-ink-400">
                  <p>
                    PLANNED: {summary || `${slot.sets} sets`}
                    {headRest != null && (
                      <span className="ml-2">· REST {formatRestSeconds(headRest)}</span>
                    )}
                  </p>
                  {/* Coach-side audit list: SlotProgress shows actuals only,
                      so the planned-per-set detail lives here when sets diverge.
                      Student SessionView drops this list because every SetRow
                      already carries its own target inline. */}
                  {!uniform && (
                    <ul className="mt-1 space-y-0.5">
                      {slotLogs.map((log) => {
                        const rest = formatRestSeconds(log.target_rest_seconds);
                        return (
                          <li key={log.id} className="flex gap-2">
                            <span className="sl-label shrink-0">Set {log.set_number}</span>
                            <span>
                              {formatSetTarget(log)}
                              {rest && <span className="ml-2">· REST {rest}</span>}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
                <SlotProgress logs={slotLogs} plannedSets={slot.sets} />
                <SlotVideoStrip
                  videos={videosBySlot.get(slot.id)}
                  onPlay={setPlaying}
                />
                {comment && (
                  <div
                    className="text-[13px] text-gray-900 rounded-lg px-2.5 py-1.5 whitespace-pre-wrap"
                    style={{
                      background: 'color-mix(in srgb, var(--color-accent) 10%, transparent)',
                      border: '1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)',
                    }}
                  >
                    <span
                      className="sl-label mr-1"
                      style={{ color: 'var(--color-accent)' }}
                    >
                      Student note
                    </span>
                    {comment.body}
                  </div>
                )}
              </div>
            );
          };
          if (group.slots.length > 1) {
            return (
              <div
                key={group.key}
                className="rounded-xl p-2 space-y-2"
                style={{
                  borderColor: 'color-mix(in srgb, var(--color-accent) 35%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)',
                  background: 'color-mix(in srgb, var(--color-accent) 6%, transparent)',
                }}
              >
                <div className="px-2 pt-1">
                  <span className="sl-label" style={{ color: 'var(--color-accent)' }}>
                    Superset
                  </span>
                </div>
                {group.slots.map(renderSlot)}
              </div>
            );
          }
          return renderSlot(group.slots[0]);
        })}
      </div>

      {/* Feedback step — three branches based on `sessions.reviewed_at` and
          whether a feedback message exists. Feedback is one-shot per session
          (UNIQUE index on messages.session_id), and the review itself is
          one-shot (reviewed_at, set either by the feedback trigger or by
          "Finish without feedback"). The back-arrow at the top is NOT a
          completion gesture — it leaves the session reviewable. */}
      {!feedbackLoading && (
        existingFeedback ? (
          <SessionFeedbackSent
            feedback={existingFeedback}
            studentProfileId={student?.profile_id}
            onFinish={handleBack}
          />
        ) : session?.reviewed_at ? (
          <SessionReviewedNoFeedback
            reviewedAt={session.reviewed_at}
            studentProfileId={student?.profile_id}
            onFinish={handleBack}
          />
        ) : (
          <SessionFeedbackComposer
            sessionId={sessionId}
            studentProfileId={student?.profile_id}
            studentFullName={student?.profile?.full_name}
            onFinish={handleBack}
          />
        )
      )}

      <VideoLightbox open={!!playing} onClose={() => setPlaying(null)}>
        {playing && <VideoPlayer storagePath={playing.storage_path} />}
      </VideoLightbox>
    </div>
  );
}
