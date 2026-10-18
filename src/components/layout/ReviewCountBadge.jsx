import { useToReviewCount } from '../../hooks/useToReviewCount';
import { useI18n } from '../../hooks/useI18n';
import { formatNumber, pluralKey } from '../../lib/i18n/format';
import { Count } from '../parc';

export const REVIEW_COUNT_CAP = 99;

// Where the count sits: on the icon of a tab (design/parc/components/TabBar),
// or at the end of a side-nav item.
const PLACE = {
  icon: 'absolute left-1/2 top-0 ml-1.5',
  count: '',
};

/**
 * The number of sessions waiting for the coach's review, on the Sessions tab,
 * as a Parc count (« 99+ » past 99). Nothing while there is none, or while the
 * number is not known.
 *
 * The digits are hidden from assistive technology and the sentence beside
 * them is read instead ("3 sessions to review"), as part of the tab's name:
 * an `aria-label` on a plain span is not read by every screen reader.
 */
export default function ReviewCountBadge({ variant = 'count' }) {
  const count = useToReviewCount();
  const { t, lang } = useI18n();
  if (!count) return null;
  return (
    <Count
      count={count}
      countLabel={t(pluralKey(lang, count, 'coachNavMemoryBadge.toReviewAria'), { n: formatNumber(lang, count) })}
      className={PLACE[variant] ?? PLACE.count}
    />
  );
}
