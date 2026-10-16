import { useMemo } from 'react';
import { useReviewCounts } from './useSessionConfirmation';

/**
 * How many confirmed sessions wait for the coach's review: the number on the
 * Sessions tab (layout/ReviewCountBadge). It is the roster's own count — the
 * `useReviewCounts` entry the "N to review" chips of the cards read, per
 * athlete — summed, so the tab never disagrees with the chips.
 *
 * `undefined` while the number is not known: the counts are loading, or their
 * read failed with nothing in the cache. The tab then draws nothing rather
 * than a count it does not have.
 *
 * The one place the navigation asks. It runs on every coach page, so it reads
 * what the database counts (`coach_review_counts()`), or the inbox alone
 * without that function — never the coach's whole history.
 */
export function useToReviewCount() {
  const { data } = useReviewCounts();
  return useMemo(() => {
    if (data == null) return undefined;
    let total = 0;
    for (const n of Object.values(data)) total += n;
    return total;
  }, [data]);
}
