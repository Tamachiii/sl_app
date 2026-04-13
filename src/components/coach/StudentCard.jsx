import WeekTimeline from './WeekTimeline';
import { useProgram } from '../../hooks/useProgram';

export default function StudentCard({ student }) {
  const { data: program } = useProgram(student.id);

  return (
    <div className="bg-white rounded-xl shadow-sm p-4">
      <h3 className="font-semibold text-gray-900 mb-2">
        {student.profile?.full_name || 'Student'}
      </h3>
      {program && (
        <WeekTimeline
          studentId={student.id}
          program={program}
        />
      )}
    </div>
  );
}
