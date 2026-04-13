import { useNavigate } from 'react-router-dom';
import { useCreateWeek } from '../../hooks/useProgram';

export default function WeekTimeline({ studentId, program }) {
  const navigate = useNavigate();
  const createWeek = useCreateWeek();
  const weeks = program.weeks || [];

  function handleAddWeek() {
    const nextNum = weeks.length > 0
      ? Math.max(...weeks.map((w) => w.week_number)) + 1
      : 1;
    createWeek.mutate({ programId: program.id, weekNumber: nextNum });
  }

  return (
    <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
      {weeks.map((w) => (
        <button
          key={w.id}
          onClick={() => navigate(`/coach/student/${studentId}/week/${w.id}`)}
          className="shrink-0 bg-gray-100 hover:bg-primary/10 text-gray-700 rounded-lg px-3 py-2 text-sm font-medium transition-colors"
        >
          W{w.week_number}
          {w.label && (
            <span className="block text-xs text-gray-400">{w.label}</span>
          )}
        </button>
      ))}
      <button
        onClick={handleAddWeek}
        disabled={createWeek.isPending}
        className="shrink-0 border-2 border-dashed border-gray-300 text-gray-400 rounded-lg px-3 py-2 text-sm font-medium hover:border-primary hover:text-primary transition-colors"
      >
        + Week
      </button>
    </div>
  );
}
