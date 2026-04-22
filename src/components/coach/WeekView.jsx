import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useWeek, useCreateSession, useDeleteSession, useUpdateWeek, useUpdateSession, useDeleteWeek } from '../../hooks/useWeek';
import { useDuplicateWeek } from '../../hooks/useDuplicate';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import EditableText from '../ui/EditableText';
import CopyDialog from '../ui/CopyDialog';
import ConfirmDialog from '../ui/ConfirmDialog';
import { useWeekConfirmedSessionIds } from '../../hooks/useSessionConfirmation';

export default function WeekView() {
  const { studentId, weekId } = useParams();
  const navigate = useNavigate();
  const { data: week, isLoading } = useWeek(weekId);
  const createSession = useCreateSession();
  const deleteSession = useDeleteSession();
  const duplicateWeek = useDuplicateWeek();
  const updateWeek = useUpdateWeek();
  const updateSession = useUpdateSession();
  const deleteWeek = useDeleteWeek();
  const { data: confirmedIds } = useWeekConfirmedSessionIds(weekId);

  const [showCopy, setShowCopy] = useState(false);
  const [deleteWeekConfirm, setDeleteWeekConfirm] = useState(false);
  const [deleteSessionConfirm, setDeleteSessionConfirm] = useState(null);
  const [showArchived, setShowArchived] = useState(false);

  if (isLoading) {
    return <div className="flex justify-center py-12"><Spinner /></div>;
  }

  const allSessions = week?.sessions || [];
  const sessions = allSessions.filter((s) => !s.archived_at);
  const archivedSessions = allSessions.filter((s) => s.archived_at);

  function handleAddSession() {
    createSession.mutate({
      weekId,
      title: `Session ${sessions.length + 1}`,
      dayNumber: sessions.length + 1,
      sortOrder: sessions.length,
    });
  }

  function handleDuplicateWeek() {
    const maxWeek = week?.week_number ?? 1;
    duplicateWeek.mutate({ weekId, newWeekNumber: maxWeek + 1 });
  }

  function handleCopyToStudent({ programId }) {
    if (!programId) return;
    duplicateWeek.mutate(
      { weekId, programId },
      { onSuccess: () => setShowCopy(false) }
    );
  }

  function handleDeleteWeek() {
    deleteWeek.mutate(weekId, {
      onSuccess: () => navigate(-1),
    });
  }

  return (
    <div className="p-4 pb-6 md:p-8 space-y-5">
      <div className="flex items-start gap-3">
        <button
          onClick={() => navigate(-1)}
          aria-label="Back"
          className="w-9 h-9 rounded-lg bg-ink-100 flex items-center justify-center text-ink-700 hover:bg-ink-200 shrink-0"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <div className="sl-label text-ink-400">Week {week?.week_number ?? ''}</div>
          <div className="sl-display text-[22px] text-gray-900 leading-tight mt-0.5">
            <EditableText
              value={week?.label || ''}
              onSave={(label) => updateWeek.mutate({ id: weekId, label })}
              placeholder="Label"
              ariaLabel="Edit week label"
            />
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={handleDuplicateWeek}
            disabled={duplicateWeek.isPending}
            className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200 disabled:opacity-50"
          >
            duplicate
          </button>
          <button
            onClick={() => setShowCopy(true)}
            className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200"
          >
            copy to…
          </button>
          <button
            onClick={() => setDeleteWeekConfirm(true)}
            disabled={deleteWeek.isPending}
            aria-label="Delete week"
            className="sl-pill bg-ink-100 text-danger hover:bg-red-50"
          >
            delete
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {sessions.length === 0 && <EmptyState message="No sessions yet" />}
        {sessions.map((sess) => {
          const exCount = (sess.exercise_slots || []).length;
          return (
            <div key={sess.id} className="sl-card px-4 py-3 flex items-center gap-2">
              <div className="flex-1 min-w-0 flex items-baseline gap-2">
                <EditableText
                  value={sess.title || ''}
                  onSave={(title) => updateSession.mutate({ id: sess.id, title })}
                  placeholder={`Session ${sess.day_number}`}
                  ariaLabel="Edit session title"
                  className="sl-display text-[16px] text-gray-900"
                />
                <span className="sl-mono text-[11px] text-ink-400 shrink-0">
                  {exCount} ex
                </span>
              </div>
              {confirmedIds?.has(sess.id) && (
                <span
                  aria-label="Confirmed by student"
                  title="Confirmed by student"
                  className="w-5 h-5 rounded-full flex items-center justify-center shrink-0"
                  style={{
                    background: 'var(--color-success)',
                    color: 'var(--color-ink-900)',
                  }}
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                </span>
              )}
              <button
                onClick={() =>
                  navigate(`/coach/student/${studentId}/week/${weekId}/session/${sess.id}`)
                }
                aria-label="Open session"
                className="text-ink-400 hover:text-[var(--color-accent)] p-1"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
              <button
                onClick={() => setDeleteSessionConfirm(sess.id)}
                aria-label="Delete session"
                className="text-ink-400 hover:text-danger p-1"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          );
        })}

        {archivedSessions.length > 0 && (
          <button
            onClick={() => setShowArchived((v) => !v)}
            className="w-full sl-mono text-[11px] text-ink-400 hover:text-ink-700 py-2 underline"
          >
            {showArchived
              ? `Hide ${archivedSessions.length} archived`
              : `Show ${archivedSessions.length} archived`}
          </button>
        )}

        {showArchived &&
          archivedSessions.map((sess) => (
            <div key={sess.id} className="sl-card p-4 space-y-1 opacity-75">
              <div className="flex items-center justify-between gap-2">
                <span className="sl-display text-[15px] text-ink-600 flex-1 truncate">
                  {sess.title || `Session ${sess.day_number}`}
                </span>
                <span
                  className="sl-pill"
                  style={{
                    background: 'color-mix(in srgb, var(--color-warn) 18%, transparent)',
                    color: 'var(--color-ink-900)',
                  }}
                >
                  archived
                </span>
                <button
                  onClick={() =>
                    navigate(`/coach/student/${studentId}/session/${sess.id}/review`)
                  }
                  aria-label="Open archived session"
                  className="text-ink-400 hover:text-[var(--color-accent)] p-1"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
              <p className="sl-mono text-[11px] text-ink-400">
                Archived {new Date(sess.archived_at).toLocaleDateString()}
              </p>
            </div>
          ))}

        <button
          onClick={handleAddSession}
          disabled={createSession.isPending}
          className="w-full border border-dashed border-ink-200 text-ink-400 rounded-xl py-3 sl-mono text-[12px] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors"
        >
          + ADD SESSION
        </button>
      </div>

      <CopyDialog
        open={showCopy}
        onClose={() => setShowCopy(false)}
        title="Copy week to another student"
        description="The week and all its sessions will be appended to the end of the destination student's program."
        currentStudentId={studentId}
        onCopy={handleCopyToStudent}
        isPending={duplicateWeek.isPending}
      />

      <ConfirmDialog
        open={deleteWeekConfirm}
        onClose={() => setDeleteWeekConfirm(false)}
        title="Delete Week"
        message={`Delete Week ${week?.week_number}? This will remove all its sessions.`}
        onConfirm={handleDeleteWeek}
      />

      <ConfirmDialog
        open={!!deleteSessionConfirm}
        onClose={() => setDeleteSessionConfirm(null)}
        title="Delete Session"
        message="Are you sure you want to delete this session?"
        onConfirm={() => deleteSession.mutate(deleteSessionConfirm)}
      />
    </div>
  );
}
