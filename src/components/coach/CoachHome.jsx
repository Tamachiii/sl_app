import Header from '../layout/Header';
import { useAuth } from '../../hooks/useAuth';
import { useStudents } from '../../hooks/useStudents';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import StudentCard from './StudentCard';

export default function CoachHome() {
  const { profile } = useAuth();
  const { data: students, isLoading } = useStudents();

  return (
    <>
      <Header title="Students" />
      <div className="p-4 space-y-3">
        {profile?.full_name && (
          <div
            title={`Coach - ${profile.full_name}`}
            className="rounded-xl bg-white shadow-sm px-4 py-3 cursor-help"
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-primary">
              Welcome back
            </p>
            <p className="text-base font-semibold text-gray-900 mt-1">
              {students?.length
                ? `You're coaching ${students.length} ${students.length === 1 ? 'athlete' : 'athletes'}.`
                : 'Add a student to get started.'}
            </p>
          </div>
        )}
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
