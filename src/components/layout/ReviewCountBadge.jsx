import { useToReviewCount } from '../../hooks/useToReviewCount';
import { useI18n } from '../../hooks/useI18n';
import { formatNumber, pluralKey } from '../../lib/i18n/format';

// Past this the badge says "99+". A roster that is behind is behind: the
// exact number is in the feed, and three digits would crowd the icon.
export const REVIEW_COUNT_CAP = 99;

const PLACE = {
  // Over the top right of the bottom nav's icon, like a phone's app badge:
  // one line box no taller than the digits, so it does not cover the icon.
  icon: 'absolute top-1.5 left-1/2 ml-1.5 min-w-4 text-center leading-none',
  // At the end of the side nav's row, the size of the unread-messages count.
  count: 'ml-auto',
};

/**
 * The number of sessions waiting for the coach's review, on the Sessions tab.
 * Nothing while there is none, or while the number is not known.
 *
 * The digits are hidden from assistive technology and the sentence beside
 * them is read instead ("3 sessions to review"), as part of the tab's name:
 * an `aria-label` on a plain span is not read by every screen reader.
 */
export default function ReviewCountBadge({ variant = 'count' }) {
  const count = useToReviewCount();
  const { t, lang } = useI18n();

  if (!count) return null;

  const shown = count > REVIEW_COUNT_CAP
    ? `${formatNumber(lang, REVIEW_COUNT_CAP)}+`
    : formatNumber(lang, count);
  return (
    <span
      className={`${PLACE[variant] ?? PLACE.count} sl-mono sl-on-fill text-[10px] tabular-nums px-1.5 py-0.5 rounded-full`}
      style={{ background: 'var(--color-accent)' }}
    >
      <span aria-hidden="true">{shown}</span>
      <span className="sr-only">
        {t(pluralKey(lang, count, 'coachNavMemoryBadge.toReviewAria'), { n: formatNumber(lang, count) })}
      </span>
    </span>
  );
}
