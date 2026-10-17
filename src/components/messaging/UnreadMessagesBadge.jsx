import { useUnreadMessageCount } from '../../hooks/useMessages';
import { useI18n } from '../../hooks/useI18n';
import { Count } from '../parc';

// Where the count sits: on the icon of a tab (`dot`, the name it had when the
// tab bar drew a dot), or at the end of a side-nav item (`count`).
const PLACE = {
  dot: 'absolute left-1/2 top-0 ml-1.5',
  count: '',
};

/**
 * The number of unread messages addressed to the signed-in user, on the
 * Messages tab, as a Parc count (« 99+ » past 99): the digits for the eye and
 * the sentence for assistive technology. Nothing while there is none.
 */
export default function UnreadMessagesBadge({ variant = 'count' }) {
  const { data: count = 0 } = useUnreadMessageCount();
  const { t } = useI18n();
  if (!count) return null;
  return (
    <Count count={count} countLabel={t('messaging.unreadAria', { n: count })} className={PLACE[variant] ?? PLACE.count} />
  );
}
