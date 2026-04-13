import Header from '../layout/Header';
import { useStudents } from '../../hooks/useStudents';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import StudentCard from './StudentCard';

export default function CoachHome() {
  const { data: students, isLoading } = useStudents();

  return (
    <>
      <Header title="Students" />
      <div className="p-4 space-y-3">
        {isLoading && (
          <div className="flex justify-center py-12"><Spinner /></div>
        )}
        {!isLoading && (!students || students.length === 0) && (
          <EmptyState message="No students yet. Add students via Supabase dashboard." />
        )}
        {students?.map((s) => (
          <StudentCard key={s.id} student={s} />
        ))}
      </div>
    </>
  );
}
