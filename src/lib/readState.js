/**
 * What a part of a page can say about the reads it is made of: 'ready' when
 * each of them holds data, and otherwise why not.
 *
 *   'ready'    every read holds data;
 *   'loading'  one is on its way, the cache is still being read back from
 *              IndexedDB, or nothing was asked yet;
 *   'offline'  one waits for the network;
 *   'failed'   one got no answer while the device is online.
 *
 * "No data" is not one state. A read that never got an answer — the device is
 * offline and waits (`isPaused`), or the request failed — has nothing to say
 * about what it reads, and a page that renders it as an empty answer makes a
 * statement only an answer can make: "No program assigned yet" on the training
 * list, a session without an exercise and with a live "Confirm session" on the
 * session page. Data, however old, always wins: a refresh that failed leaves
 * `isError` on a read that still holds the last good answer, and that answer
 * is what is shown.
 *
 * `restoring` is the moment at launch when what the device kept is still being
 * read from IndexedDB (`useIsRestoring`): no read has data yet and none has
 * been sent, which on a device without a network would otherwise pass for
 * "nothing kept".
 *
 * `queries` are results of `useQuery`; `online` is `useOnlineStatus()`.
 */
export function readState(queries, { online, restoring }) {
  const missing = queries.filter((q) => q.data == null);
  if (missing.length === 0) return 'ready';
  if (restoring || missing.some((q) => q.fetchStatus === 'fetching')) return 'loading';
  if (!online || missing.some((q) => q.isPaused)) return 'offline';
  if (missing.some((q) => q.isError)) return 'failed';
  // Not asked yet (the account is not known): nothing to report.
  return 'loading';
}
