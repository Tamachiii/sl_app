/**
 * Change what the cache already holds under `queryKey` — every entry the key
 * matches — as a guess of the device, not as a read.
 *
 * `setQueryData` alone says more than an optimistic update means. It stamps
 * the entry as read just now, and takes off the flag that says "to be read
 * again". The training list an offline confirmation was written into would
 * then count as fresh for two more minutes: not read again when the athlete
 * comes back to it on a network, after a workout during which the coach may
 * have rewritten the block. And an entry whose refresh could not be served —
 * invalidated without a network — would forget that it is owed one.
 *
 * Written through here, an entry keeps the age of its last read and its flag,
 * so it is read again exactly when it would have been.
 *
 * `update(data)` answers the new data, or `undefined` (or the same data) to
 * leave the entry alone. An entry that holds nothing is never created: a
 * guess about one row is not an answer about the list — a list of confirmed
 * sessions made of the one just confirmed would put every other session of
 * the block back to "not done".
 */
export function writeCached(queryClient, queryKey, update) {
  for (const query of queryClient.getQueryCache().findAll({ queryKey })) {
    const { data, dataUpdatedAt, isInvalidated } = query.state;
    if (data === undefined) continue;
    const next = update(data);
    if (next === undefined || next === data) continue;
    queryClient.setQueryData(query.queryKey, next, { updatedAt: dataUpdatedAt });
    if (isInvalidated) query.invalidate();
  }
}
