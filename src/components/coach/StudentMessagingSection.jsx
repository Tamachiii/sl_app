import { useOutletContext } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';
import EmptyState from '../ui/EmptyState';
import MessageThread from '../messaging/MessageThread';

/**
 * Coach-side messaging tab inside a single student's view. Renders the
 * thread between the signed-in coach and the selected student.
 *
 * Sized to fit inside the rest of the Students-tab layout: the column has a
 * fixed visual height so the thread scroller (a flex-1 child) is bounded —
 * MessageThread is a flex column that needs a height to scroll.
 */
export default function StudentMessagingSection() {
  const { student } = useOutletContext();
  const { t } = useI18n();

  if (!student?.profile_id) {
    return <EmptyState message={t('messaging.noStudentLink')} />;
  }

  return (
    <div className="sl-card p-3 md:p-4 flex flex-col" style={{ height: '60vh', minHeight: 360 }}>
      <MessageThread
        otherProfileId={student.profile_id}
        otherFullName={student.profile?.full_name}
      />
    </div>
  );
}
