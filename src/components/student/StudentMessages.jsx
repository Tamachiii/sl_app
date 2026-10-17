import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { useMyCoach } from '../../hooks/useStudents';
import UserMenu from '../ui/UserMenu';
import Spinner from '../ui/Spinner';
import MessageThread from '../messaging/MessageThread';
import { LargeTitle } from '../parc';

/**
 * Student Messages tab. Each student has exactly one coach (`students.coach_id`),
 * so this page jumps straight into the thread with that coach — no list.
 */
export default function StudentMessages() {
  const { profile, signOut } = useAuth();
  const { t } = useI18n();
  const { data: coach, isLoading } = useMyCoach();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The title of a tab, with the coach's name under it: the thread
          below spans the width and keeps its composer above the keyboard. */}
      <div className="shrink-0 border-b border-line-strong px-4 pt-3 pb-4 md:px-8">
        <LargeTitle
          title={t('parcMessages.title')}
          subtitle={coach?.full_name || null}
          trailing={<UserMenu fullName={profile?.full_name} onSignOut={signOut} profileHref="/student/profile" />}
        />
      </div>

      {isLoading && (
        <div className="flex justify-center py-12"><Spinner /></div>
      )}

      {!isLoading && !coach && (
        <p className="mx-4 mt-4 rounded-group bg-surface p-4 pk-body md:mx-8">{t('parcMessages.noCoach')}</p>
      )}

      {!isLoading && coach && (
        <div className="flex min-h-0 flex-1">
          <MessageThread otherProfileId={coach.id} otherFullName={coach.full_name} className="w-full" />
        </div>
      )}
    </div>
  );
}
