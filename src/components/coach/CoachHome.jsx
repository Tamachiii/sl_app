import { useAuth } from '../../hooks/useAuth';
import { useStudents } from '../../hooks/useStudents';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import StudentCard from './StudentCard';

export default function CoachHome() {
  const { profile } = useAuth();
  const { data: students, isLoading } = useStudents();

  const firstName = (profile?.full_name || '').split(' ')[0] || 'Coach';
  const count = students?.length ?? 0;

  return (
    <div className="p-4 pb-6 space-y-5">
      <h1 className="sr-only">Students</h1>

      {profile?.full_name && (
        <div
          className="sl-card px-4 py-4 cursor-help"
          title={`Coach · ${profile.full_name}`}
        >
          <div className="sl-label text-ink-400">Coach</div>
          <p className="sl-display text-[28px] text-gray-900 leading-none mt-1">
            Hey, {firstName}.
          </p>
          <p className="sl-mono text-[11px] text-ink-400 mt-2">
            {count > 0
              ? `Coaching ${count} ${count === 1 ? 'athlete' : 'athletes'}.`
              : 'Add a student to get started.'}
          </p>
        </div>
      )}

      <div className="sl-label text-ink-400">Athletes</div>

      {isLoading && (
        <div className="flex justify-center py-12"><Spinner /></div>
      )}
      {!isLoading && !count && (
        <EmptyState message="No students yet. Add students via Supabase dashboard." />
      )}
      <div className="space-y-3">
        {students?.map((s) => (
          <StudentCard key={s.id} student={s} />
        ))}
      </div>
    </div>
  );
}
