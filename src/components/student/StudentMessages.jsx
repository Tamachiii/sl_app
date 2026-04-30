import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { useMyCoach } from '../../hooks/useStudents';
import UserMenu from '../ui/UserMenu';
import EmptyState from '../ui/EmptyState';
import Spinner from '../ui/Spinner';
import MessageThread from '../messaging/MessageThread';

/**
 * Student Messages tab. Each student has exactly one coach (`students.coach_id`),
 * so this page jumps straight into the thread with that coach — no list.
 */
export default function StudentMessages() {
  const { profile, signOut } = useAuth();
  const { t } = useI18n();
  const { data: coach, isLoading } = useMyCoach();

  return (
    <div
      className="flex-1 flex flex-col min-h-0 p-4 md:p-8"
      style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + var(--kb-inset, 0px) + 12px)' }}
    >
      {/* Match the standard top-level page header: kicker (coach's name)
          above an h1 page title. Right-aligned bell + avatar sits at the
          top so it lines up with the kicker, like every other student tab. */}
      <div className="pt-3 pb-1 flex items-start justify-between gap-4 shrink-0">
        <div className="min-w-0">
          <div className="sl-label text-ink-400 truncate">
            {coach?.full_name || t('messaging.coach')}
          </div>
          <h1 className="sl-display text-[32px] md:text-[44px] text-gray-900 leading-none mt-1">
            {t('messaging.title')}
          </h1>
        </div>
        <UserMenu fullName={profile?.full_name} onSignOut={signOut} />
      </div>

      {isLoading && (
        <div className="flex justify-center py-12"><Spinner /></div>
      )}

      {!isLoading && !coach && (
        <EmptyState message={t('messaging.noCoach')} />
      )}

      {!isLoading && coach && (
        <div className="flex-1 min-h-0 flex">
          <MessageThread
            otherProfileId={coach.id}
            otherFullName={coach.full_name}
            className="w-full"
          />
        </div>
      )}
    </div>
  );
}
