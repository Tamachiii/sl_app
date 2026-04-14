import { useNavigate } from 'react-router-dom';
import Header from '../layout/Header';
import { useAuth } from '../../hooks/useAuth';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import { useMyConfirmedSessionIds } from '../../hooks/useSessionConfirmation';

export default function StudentHome() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data: confirmedIds } = useMyConfirmedSessionIds();

  const { data, isLoading } = useQuery({
    queryKey: ['student-weeks', user?.id],
    queryFn: async () => {
      // Get the student row for this user
      const { data: student, error: sErr } = await supabase
        .from('students')
        .select('id')
        .eq('profile_id', user.id)
        .single();
      if (sErr) throw sErr;

      // Get program with weeks and sessions
      const { data: programs, error: pErr } = await supabase
        .from('programs')
        .select(`
          id, name,
          weeks(
            id, week_number, label,
            sessions(id, title, sort_order)
          )
        `)
        .eq('student_id', student.id)
        .order('created_at', { ascending: true });
      if (pErr) throw pErr;

      // Flatten weeks from all programs, sorted
      const weeks = [];
      for (const prog of programs) {
        for (const w of prog.weeks || []) {
          w.sessions = (w.sessions || []).sort((a, b) => a.sort_order - b.sort_order);
          weeks.push(w);
        }
      }
      weeks.sort((a, b) => a.week_number - b.week_number);
      return weeks;
    },
    enabled: !!user,
  });

  return (
    <>
      <Header title="My Program" />
      <div className="p-4 space-y-3">
        {isLoading && (
          <div className="flex justify-center py-12"><Spinner /></div>
        )}
        {!isLoading && (!data || data.length === 0) && (
          <EmptyState message="No program assigned yet" />
        )}
        {data?.map((week) => (
          <div key={week.id} className="bg-white rounded-xl shadow-sm p-4">
            <h3 className="font-semibold text-gray-900 mb-2">
              Week {week.week_number}
              {week.label && <span className="text-gray-400 font-normal ml-2">{week.label}</span>}
            </h3>
            <div className="space-y-1">
              {(week.sessions || []).map((sess) => {
                const confirmed = confirmedIds?.has(sess.id);
                return (
                  <button
                    key={sess.id}
                    onClick={() => navigate(`/student/session/${sess.id}`)}
                    className="w-full flex items-center justify-between gap-2 text-left bg-gray-50 rounded-lg px-3 py-2.5 text-sm text-gray-700 hover:bg-primary/5 transition-colors"
                  >
                    <span>{sess.title || `Session ${sess.sort_order + 1}`}</span>
                    {confirmed && (
                      <span
                        aria-label="Confirmed"
                        className="flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 px-1.5 py-0.5 rounded"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                        Done
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
