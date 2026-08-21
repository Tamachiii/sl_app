import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { useStudentProgramDetails } from '../../hooks/useStudentProgramDetails';
import { useMyConfirmedSessionIds } from '../../hooks/useSessionConfirmation';
import { useMyFeedbackSessionIds } from '../../hooks/useMessages';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import UserMenu from '../ui/UserMenu';
import SessionCard from './SessionCard';

export default function StudentSessions() {
  const { user, profile, signOut } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const { data: weeks, isLoading } = useStudentProgramDetails(user?.id, { allPrograms: true });
  const { data: confirmedIds = new Set() } = useMyConfirmedSessionIds();
  const { data: feedbackIds = new Set() } = useMyFeedbackSessionIds();

  const [showArchived, setShowArchived] = useState(false);
  const [openSessionId, setOpenSessionId] = useState(null);

  // Group weeks by program. Active program first, then past programs by
  // sort_order DESC (most recent periodization block first). Within each
  // program, weeks are reversed so the newest week appears at the top.
  const programGroups = useMemo(() => {
    if (!weeks) return [];
    const byProgram = new Map();
    for (const w of weeks) {
      const pid = w.program?.id ?? '__none__';
      if (!byProgram.has(pid)) {
        byProgram.set(pid, { program: w.program, weeks: [] });
      }
      const filteredSessions = (w.sessions || []).filter(
        (s) => showArchived || !s.archived_at
      );
      if (filteredSessions.length === 0) continue;
      byProgram.get(pid).weeks.push({ ...w, sessions: filteredSessions });
    }
    const groups = Array.from(byProgram.values()).filter((g) => g.weeks.length > 0);
    for (const g of groups) g.weeks.reverse();
    groups.sort((a, b) => {
      if (!!a.program?.is_active !== !!b.program?.is_active) {
        return a.program?.is_active ? -1 : 1;
      }
      return (b.program?.sort_order ?? 0) - (a.program?.sort_order ?? 0);
    });
    return groups;
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

  // The archived toggle hangs off the first PROGRAM header. It used to sit on
  // the first week heading, which no longer exists for unlabelled weeks — and
  // the program header is a steadier anchor anyway.
  const firstGroupId = programGroups[0]?.program?.id ?? null;

  return (
    <div className="p-4 pb-6 md:p-8 space-y-6">
      <div className="pt-3 pb-1 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="sl-label text-ink-400">{t('student.sessions.kicker')}</div>
          <h1 className="sl-display text-[32px] md:text-[44px] text-gray-900 leading-none mt-1">{t('student.sessions.title')}</h1>
        </div>
        <UserMenu fullName={profile?.full_name} onSignOut={signOut} profileHref="/student/profile" />
      </div>

      {!weeks?.length && <EmptyState message={t('student.home.noProgram')} />}

      {programGroups.map((group) => {
        const isActive = !!group.program?.is_active;
        const programName = group.program?.name || '';
        return (
          <section
            key={group.program?.id ?? 'no-program'}
            aria-labelledby={`program-${group.program?.id ?? 'none'}-heading`}
            className="space-y-3"
          >
            <header className="flex items-baseline justify-between gap-3 border-b border-ink-100 pb-1.5">
              <div className="min-w-0">
                <div
                  id={`program-${group.program?.id ?? 'none'}-heading`}
                  className="sl-label text-gray-900 truncate"
                >
                  {programName}
                </div>
                {!isActive && (
                  <div className="sl-mono text-[10px] text-ink-400 mt-0.5">
                    {t('student.sessions.pastProgram')}
                  </div>
                )}
              </div>
              {archivedCount > 0 && group.program?.id === firstGroupId && (
                <ArchivedToggle
                  count={archivedCount}
                  expanded={showArchived}
                  onToggle={() => setShowArchived((v) => !v)}
                  t={t}
                />
              )}
            </header>

            {/* A week is an optional PHASE, not a calendar slot: it earns a
                heading only when the coach named it ("Deload", "Peak").
                Unlabelled weeks are pure ordering and the sessions flow
                straight on, which is what a block reads like once the student
                works through it at their own pace. */}
            {group.weeks.map((week) => {
              const phase = (week.label || '').trim();
              const headingId = `week-${week.id}-heading`;
              return (
                <section
                  key={week.id}
                  aria-labelledby={phase ? headingId : undefined}
                  className="space-y-2.5"
                >
                  {phase && (
                    <h2 id={headingId} className="sl-label text-ink-400">
                      {phase}
                    </h2>
                  )}
                  <div className="space-y-2">
                    {week.sessions.map((session) => (
                      <SessionCard
                        key={session.id}
                        session={session}
                        confirmed={confirmedIds.has(session.id)}
                        archived={!!session.archived_at}
                        hasFeedback={feedbackIds.has(session.id)}
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
          </section>
        );
      })}

      {/* Fallback: if every session is archived and the student hasn't
          expanded yet, there's no first week to host the inline toggle —
          drop a standalone one so the archive remains reachable. */}
      {programGroups.length === 0 && archivedCount > 0 && (
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
