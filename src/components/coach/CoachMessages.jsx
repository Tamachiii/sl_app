import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { useStudents } from '../../hooks/useStudents';
import { useConversations } from '../../hooks/useMessages';
import UserMenu from '../ui/UserMenu';
import EmptyState from '../ui/EmptyState';
import Spinner from '../ui/Spinner';
import ConversationList from '../messaging/ConversationList';
import MessageThread from '../messaging/MessageThread';

const ChevronLeft = (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
  </svg>
);

/**
 * Coach Messages tab. Two modes:
 *   /coach/messages                 → conversation roll-up
 *   /coach/messages/:otherProfileId → thread with that student
 *
 * The roll-up is fed by `useConversations`; for new messages the coach picks
 * a student via the row of "start a conversation" cards rendered when no
 * thread exists yet for that student.
 */
export default function CoachMessages() {
  const { otherProfileId } = useParams();
  const { profile, signOut } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const { data: students } = useStudents();
  const { data: conversations } = useConversations();

  // The thread view needs the counterpart's display name. We get it from the
  // students list (coach's full roster) since the conversations rollup only
  // covers students with at least one message exchanged.
  const counterpart = useMemo(() => {
    if (!otherProfileId) return null;
    const s = (students || []).find((x) => x.profile_id === otherProfileId);
    if (s) return { id: s.profile_id, full_name: s.profile?.full_name };
    const c = (conversations || []).find((x) => x.otherProfileId === otherProfileId);
    if (c) return { id: c.otherProfileId, full_name: c.otherFullName };
    return null;
  }, [otherProfileId, students, conversations]);

  // Students with no message history — surface them so the coach can start
  // a conversation. Skips the currently-open thread.
  const startable = useMemo(() => {
    if (otherProfileId) return [];
    const seen = new Set((conversations || []).map((c) => c.otherProfileId));
    return (students || [])
      .filter((s) => !seen.has(s.profile_id))
      .map((s) => ({ profileId: s.profile_id, fullName: s.profile?.full_name || '—' }));
  }, [students, conversations, otherProfileId]);

  if (otherProfileId) {
    // Outer container fills main (flex-1 of the AppShell wrapper), then a
    // bottom padding equal to the keyboard inset lifts the composer above
    // the soft keyboard on iOS.
    return (
      <div
        className="flex-1 flex flex-col min-h-0 px-4 md:px-8 pt-3 pb-3"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + var(--kb-inset, 0px) + 12px)' }}
      >
        <div className="pb-3 flex items-center justify-between gap-3 shrink-0">
          <button
            type="button"
            onClick={() => navigate('/coach/messages')}
            aria-label={t('common.back')}
            className="w-9 h-9 rounded-lg bg-ink-100 text-ink-700 flex items-center justify-center"
          >
            {ChevronLeft}
          </button>
          <div className="min-w-0 text-center">
            <div className="sl-label text-ink-400 truncate">{t('messaging.title')}</div>
            <div className="sl-display text-[18px] md:text-[22px] text-gray-900 truncate">
              {counterpart?.full_name || '—'}
            </div>
          </div>
          <UserMenu fullName={profile?.full_name} onSignOut={signOut} />
        </div>

        <div className="flex-1 min-h-0 flex">
          <MessageThread
            otherProfileId={otherProfileId}
            otherFullName={counterpart?.full_name}
            className="w-full"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 pb-6 md:p-8 space-y-5">
      <div className="pt-3 pb-1 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="sl-label text-ink-400">{t('coach.home.kicker')}</div>
          <h1 className="sl-display text-[28px] md:text-[40px] text-gray-900 leading-none mt-1">
            {t('messaging.title')}
          </h1>
        </div>
        <UserMenu fullName={profile?.full_name} onSignOut={signOut} />
      </div>

      {!students && (
        <div className="flex justify-center py-12"><Spinner /></div>
      )}

      {students && students.length === 0 && (
        <EmptyState message={t('coach.home.noStudentsExt')} />
      )}

      {students && students.length > 0 && (
        <>
          <ConversationList
            linkBuilder={(c) => `/coach/messages/${c.otherProfileId}`}
            emptyMessage={t('messaging.coachNoConversations')}
          />

          {startable.length > 0 && (
            <section aria-labelledby="start-heading" className="space-y-2 pt-2">
              <h2 id="start-heading" className="sl-label text-ink-400">
                {t('messaging.startNew')}
              </h2>
              <ul className="grid grid-cols-2 md:grid-cols-3 gap-2 list-none p-0 m-0">
                {startable.map((s) => (
                  <li key={s.profileId}>
                    <button
                      type="button"
                      onClick={() => navigate(`/coach/messages/${s.profileId}`)}
                      className="w-full sl-card p-3 text-left hover:bg-ink-50/50 dark:hover:bg-ink-800 transition-colors"
                    >
                      <span className="sl-display text-[14px] text-gray-900 truncate block">
                        {s.fullName}
                      </span>
                      <span className="sl-mono text-[10px] text-ink-400 mt-1 block">
                        {t('messaging.tapToOpen')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
