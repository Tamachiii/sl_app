import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { useStudentProgramDetails } from '../../hooks/useStudentProgramDetails';
import { useMyConfirmedSessionIds } from '../../hooks/useSessionConfirmation';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import UserMenu from '../ui/UserMenu';
import SessionCard from './SessionCard';

export default function StudentSessions() {
  const { user, profile, signOut } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const { data: weeks, isLoading } = useStudentProgramDetails(user?.id);
  const { data: confirmedIds = new Set() } = useMyConfirmedSessionIds();

  const [showArchived, setShowArchived] = useState(false);
  const [openSessionId, setOpenSessionId] = useState(null);

  // Most recent weeks first — students care about what's current, not where
  // they started. Within each week, session order is preserved.
  const visibleWeeks = useMemo(() => {
    if (!weeks) return [];
    return weeks
      .map((w) => ({
        ...w,
        sessions: (w.sessions || []).filter((s) => showArchived || !s.archived_at),
      }))
      .filter((w) => w.sessions.length > 0)
      .reverse();
  }, [weeks, showArchived]);

  const archivedCount = useMemo(
    () =>
      (weeks || []).reduce(
        (n, w) => n + (w.sessions || []).filter((s) => s.archived_at).length,
        0
      ),
    [weeks]
  );

  if (isLoading) {
    return (
      <div className="p-4">
        <h1 className="sr-only">Sessions</h1>
        <div className="flex justify-center py-12"><Spinner /></div>
      </div>
    );
  }

  return (
    <div className="p-4 pb-6 md:p-8 space-y-5">
      <div className="pt-3 pb-1 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="sl-label text-ink-400">{t('student.sessions.kicker')}</div>
          <h1 className="sl-display text-[32px] md:text-[44px] text-gray-900 leading-none mt-1">{t('student.sessions.title')}</h1>
        </div>
        <UserMenu fullName={profile?.full_name} onSignOut={signOut} profileHref="/student/profile" />
      </div>

      {!weeks?.length && <EmptyState message={t('student.home.noProgram')} />}

      {visibleWeeks.map((week, index) => {
        // Toggle sits on the heading row of the first (most-recent) visible
        // week so it's reachable without scrolling regardless of expand state.
        const showToggleInline = index === 0 && archivedCount > 0;
        return (
          <section key={week.id} aria-labelledby={`week-${week.id}-heading`} className="space-y-2.5">
            <div className={showToggleInline ? 'flex items-baseline justify-between gap-3' : undefined}>
              <h2
                id={`week-${week.id}-heading`}
                className="sl-label text-ink-400 flex items-baseline gap-2"
              >
                <span>{t('student.home.week')} {week.week_number}</span>
                {week.label && (
                  <span className="sl-mono text-[11px] normal-case text-ink-400">· {week.label}</span>
                )}
              </h2>
              {showToggleInline && (
                <ArchivedToggle
                  count={archivedCount}
                  expanded={showArchived}
                  onToggle={() => setShowArchived((v) => !v)}
                  t={t}
                />
              )}
            </div>
            <div className="space-y-2">
              {week.sessions.map((session) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  confirmed={confirmedIds.has(session.id)}
                  archived={!!session.archived_at}
                  onStart={() => navigate(`/student/session/${session.id}`)}
                  open={openSessionId === session.id}
                  onToggle={() =>
                    setOpenSessionId((id) => (id === session.id ? null : session.id))
                  }
                />
              ))}
            </div>
          </section>
        );
      })}

      {/* Fallback: if every session is archived and the student hasn't
          expanded yet, there's no first week to host the inline toggle —
          drop a standalone one so the archive remains reachable. */}
      {visibleWeeks.length === 0 && archivedCount > 0 && (
        <div className="flex justify-end">
          <ArchivedToggle
            count={archivedCount}
            expanded={showArchived}
            onToggle={() => setShowArchived((v) => !v)}
            t={t}
          />
        </div>
      )}
    </div>
  );
}

function ArchivedToggle({ count, expanded, onToggle, t }) {
  const label = expanded
    ? t(count === 1 ? 'student.sessions.hideArchivedOne' : 'student.sessions.hideArchivedMany', { n: count })
    : t(count === 1 ? 'student.sessions.showArchivedOne' : 'student.sessions.showArchivedMany', { n: count });
  return (
    <button
      onClick={onToggle}
      aria-pressed={expanded}
      className="sl-mono text-[11px] text-ink-400 hover:text-gray-700 underline py-1"
    >
      {label}
    </button>
  );
}
