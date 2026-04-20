import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Header from '../layout/Header';
import { useWeek, useCreateSession, useDeleteSession, useUpdateWeek, useUpdateSession, useDeleteWeek } from '../../hooks/useWeek';
import { useDuplicateWeek } from '../../hooks/useDuplicate';
import { computeSessionVolume } from '../../lib/volume';
import VolumeBar from './VolumeBar';
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
    return (
      <>
        <Header title="Week" showBack />
        <div className="flex justify-center py-12"><Spinner /></div>
      </>
    );
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
    <>
      <Header
        title={
          <span className="flex items-center gap-2">
            <span>Week {week?.week_number ?? ''}</span>
            <span className="text-gray-400">—</span>
            <EditableText
              value={week?.label || ''}
              onSave={(label) => updateWeek.mutate({ id: weekId, label })}
              placeholder="Label"
              ariaLabel="Edit week label"
              className="font-semibold"
            />
          </span>
        }
        showBack
        actions={
          <>
            <button
              onClick={handleDuplicateWeek}
              disabled={duplicateWeek.isPending}
              className="text-xs bg-gray-100 text-gray-600 rounded-lg px-2.5 py-1.5 hover:bg-gray-200"
            >
              Duplicate
            </button>
            <button
              onClick={() => setShowCopy(true)}
              className="text-xs bg-gray-100 text-gray-600 rounded-lg px-2.5 py-1.5 hover:bg-gray-200"
            >
              Copy to…
            </button>
            <button
              onClick={() => setDeleteWeekConfirm(true)}
              disabled={deleteWeek.isPending}
              aria-label="Delete week"
              className="text-xs bg-gray-100 text-danger rounded-lg px-2.5 py-1.5 hover:bg-red-50"
            >
              Delete
            </button>
          </>
        }
      />
      <div className="p-4 space-y-3">
        {sessions.length === 0 && (
          <EmptyState message="No sessions yet" />
        )}
        {sessions.map((sess) => {
          const vol = computeSessionVolume(sess.exercise_slots || []);
          return (
            <div key={sess.id} className="bg-white rounded-xl shadow-sm p-4 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <EditableText
                  value={sess.title || ''}
                  onSave={(title) => updateSession.mutate({ id: sess.id, title })}
                  placeholder={`Session ${sess.day_number}`}
                  ariaLabel="Edit session title"
                  className="font-medium text-gray-900 flex-1"
                />
                {confirmedIds?.has(sess.id) && (
                  <span
                    aria-label="Confirmed by student"
                    title="Confirmed by student"
                    className="flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 px-1.5 py-0.5 rounded"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                    Confirmed
                  </span>
                )}
                <button
                  onClick={() =>
                    navigate(`/coach/student/${studentId}/week/${weekId}/session/${sess.id}`)
                  }
                  aria-label="Open session"
                  className="text-gray-400 hover:text-primary p-1"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
                <button
                  onClick={() => setDeleteSessionConfirm(sess.id)}
                  aria-label="Delete session"
                  className="text-gray-400 hover:text-danger text-sm p-1"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
              <p className="text-xs text-gray-400">{(sess.exercise_slots || []).length} exercises</p>
              <VolumeBar pull={vol.pull} push={vol.push} />
            </div>
          );
        })}

        {archivedSessions.length > 0 && (
          <button
            onClick={() => setShowArchived((v) => !v)}
            className="w-full text-xs text-gray-500 hover:text-gray-700 py-2"
          >
            {showArchived
              ? `Hide ${archivedSessions.length} archived`
              : `Show ${archivedSessions.length} archived`}
          </button>
        )}

        {showArchived &&
          archivedSessions.map((sess) => (
            <div
              key={sess.id}
              className="bg-gray-50 border border-gray-200 rounded-xl p-4 space-y-1 opacity-75"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-gray-600 flex-1 truncate">
                  {sess.title || `Session ${sess.day_number}`}
                </span>
                <span className="text-xs font-medium text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                  Archived
                </span>
                <button
                  onClick={() =>
                    navigate(`/coach/student/${studentId}/session/${sess.id}/review`)
                  }
                  aria-label="Open archived session"
                  className="text-gray-400 hover:text-primary p-1"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
              <p className="text-xs text-gray-400">
                Archived {new Date(sess.archived_at).toLocaleDateString()}
              </p>
            </div>
          ))}

        <button
          onClick={handleAddSession}
          disabled={createSession.isPending}
          className="w-full border-2 border-dashed border-gray-300 text-gray-400 rounded-xl py-3 text-sm font-medium hover:border-primary hover:text-primary transition-colors"
        >
          + Add Session
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
    </>
  );
}
