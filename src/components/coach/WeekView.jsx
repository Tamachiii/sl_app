import { useParams, useNavigate } from 'react-router-dom';
import Header from '../layout/Header';
import { useWeek, useCreateSession, useDeleteSession, useUpdateWeek, useUpdateSession, useDeleteWeek, useMoveWeek } from '../../hooks/useWeek';
import { useDuplicateWeek } from '../../hooks/useDuplicate';
import { useProgram } from '../../hooks/useProgram';
import { computeSessionVolume } from '../../lib/volume';
import VolumeBar from './VolumeBar';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import EditableText from '../ui/EditableText';
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
  const moveWeek = useMoveWeek();
  const { data: program } = useProgram(studentId);
  const { data: confirmedIds } = useWeekConfirmedSessionIds(weekId);

  if (isLoading) {
    return (
      <>
        <Header title="Week" showBack />
        <div className="flex justify-center py-12"><Spinner /></div>
      </>
    );
  }

  const sessions = week?.sessions || [];

  function handleAddSession() {
    createSession.mutate({
      weekId,
      title: `Session ${sessions.length + 1}`,
      dayNumber: sessions.length + 1,
      sortOrder: sessions.length,
    });
  }

  function handleDuplicateWeek() {
    const maxWeek = week.week_number;
    duplicateWeek.mutate({ weekId, newWeekNumber: maxWeek + 1 });
  }

  const siblings = (program?.weeks || []).slice().sort((a, b) => a.week_number - b.week_number);
  const currentIdx = siblings.findIndex((w) => w.id === week?.id);
  const prevWeek = currentIdx > 0 ? siblings[currentIdx - 1] : null;
  const nextWeek = currentIdx >= 0 && currentIdx < siblings.length - 1 ? siblings[currentIdx + 1] : null;

  function handleMove(direction) {
    const other = direction === -1 ? prevWeek : nextWeek;
    if (!other || !week) return;
    moveWeek.mutate({
      aId: week.id,
      aNumber: week.week_number,
      bId: other.id,
      bNumber: other.week_number,
    });
  }

  function handleDeleteWeek() {
    if (!confirm(`Delete Week ${week.week_number}? This will remove all its sessions.`)) return;
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
              onClick={() => handleMove(-1)}
              disabled={!prevWeek || moveWeek.isPending}
              aria-label="Move week earlier"
              title="Move earlier"
              className="text-xs bg-gray-100 text-gray-600 rounded-lg px-2 py-1.5 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <button
              onClick={() => handleMove(1)}
              disabled={!nextWeek || moveWeek.isPending}
              aria-label="Move week later"
              title="Move later"
              className="text-xs bg-gray-100 text-gray-600 rounded-lg px-2 py-1.5 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
            <button
              onClick={handleDuplicateWeek}
              disabled={duplicateWeek.isPending}
              className="text-xs bg-gray-100 text-gray-600 rounded-lg px-2.5 py-1.5 hover:bg-gray-200"
            >
              Duplicate
            </button>
            <button
              onClick={handleDeleteWeek}
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
                  onClick={() => {
                    if (confirm('Delete this session?')) deleteSession.mutate(sess.id);
                  }}
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

        <button
          onClick={handleAddSession}
          disabled={createSession.isPending}
          className="w-full border-2 border-dashed border-gray-300 text-gray-400 rounded-xl py-3 text-sm font-medium hover:border-primary hover:text-primary transition-colors"
        >
          + Add Session
        </button>
      </div>
    </>
  );
}
