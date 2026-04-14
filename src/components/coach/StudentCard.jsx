import { Link } from 'react-router-dom';
import WeekTimeline from './WeekTimeline';
import { useProgram } from '../../hooks/useProgram';

export default function StudentCard({ student }) {
  const { data: program } = useProgram(student.id);

  return (
    <div className="bg-white rounded-xl shadow-sm p-4">
      <div className="flex items-center justify-between mb-2 gap-2">
        <h3 className="font-semibold text-gray-900">
          {student.profile?.full_name || 'Student'}
        </h3>
        <div className="flex items-center gap-1.5">
          <Link
            to={`/coach/student/${student.id}/goals`}
            className="text-xs bg-gray-100 text-gray-600 rounded-lg px-2.5 py-1 hover:bg-gray-200"
          >
            Goals
          </Link>
          <Link
            to={`/coach/student/${student.id}/confirmations`}
            className="text-xs bg-gray-100 text-gray-600 rounded-lg px-2.5 py-1 hover:bg-gray-200"
          >
            Confirmed sessions
          </Link>
        </div>
      </div>
      {program && (
        <WeekTimeline
          studentId={student.id}
          program={program}
        />
      )}
    </div>
  );
}
