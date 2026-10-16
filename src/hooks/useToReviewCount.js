import { useMemo } from 'react';
import { useAllConfirmations } from './useSessionConfirmation';
import { reviewCountsByStudent } from '../lib/coachRoster';

/**
 * How many confirmed sessions wait for the coach's review: the number on the
 * Sessions tab (layout/ReviewCountBadge). It is the roster's own count —
 * neither reviewed nor archived, per athlete, in lib/coachRoster — summed, so
 * the tab never disagrees with the "N to review" chips of the cards.
 *
 * `undefined` while the number is not known: the confirmations are loading,
 * or their read failed with nothing in the cache. The tab then draws nothing
 * rather than a count it does not have.
 *
 * The one place the navigation asks. When the count comes from somewhere
 * cheaper than every confirmation of the coach, only this file changes.
 */
export function useToReviewCount() {
  const { data } = useAllConfirmations();
  return useMemo(() => {
    if (!Array.isArray(data)) return undefined;
    let total = 0;
    for (const n of reviewCountsByStudent(data).values()) total += n;
    return total;
  }, [data]);
}
