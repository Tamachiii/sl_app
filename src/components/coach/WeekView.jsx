import { useParams, useNavigate } from 'react-router-dom';
import Header from '../layout/Header';
import { useWeek, useCreateSession, useDeleteSession } from '../../hooks/useWeek';
import { useDuplicateWeek } from '../../hooks/useDuplicate';
import { computeSessionVolume } from '../../lib/volume';
import VolumeBar from './VolumeBar';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';

export default function WeekView() {
  const { studentId, weekId } = useParams();
  const navigate = useNavigate();
  const { data: week, isLoading } = useWeek(weekId);
  const createSession = useCreateSession();
  const deleteSession = useDeleteSession();
  const duplicateWeek = useDuplicateWeek();

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

  return (
    <>
      <Header
        title={`Week ${week?.week_number ?? ''}${week?.label ? ` — ${week.label}` : ''}`}
        showBack
        actions={
          <button
            onClick={handleDuplicateWeek}
            disabled={duplicateWeek.isPending}
            className="text-xs bg-gray-100 text-gray-600 rounded-lg px-2.5 py-1.5 hover:bg-gray-200"
          >
            Duplicate
          </button>
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
              <div className="flex items-center justify-between">
                <button
                  onClick={() =>
                    navigate(`/coach/student/${studentId}/week/${weekId}/session/${sess.id}`)
                  }
                  className="font-medium text-gray-900 text-left flex-1"
                >
                  {sess.title || `Session ${sess.day_number}`}
                </button>
                <button
                  onClick={() => {
                    if (confirm('Delete this session?')) deleteSession.mutate(sess.id);
                  }}
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
