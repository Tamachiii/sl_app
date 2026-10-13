// What a reload asked for by a tap waits for: the writes it would lose.
//
// A write that is on its way to the server when the page reloads may or may
// not have arrived, and nothing will say which. A write that waits in the
// offline queue is safe once the queue is on disk. So the two reloads a person
// asks for — "Update" (components/ui/UpdatePrompt) and "Reload" on the screen
// of a page that could not load one of its files (components/ui/ErrorBoundary)
// — wait for the first kind to come back and give the second the time to be
// written, both for a bounded time.

/**
 * Longer than the persister's throttle (lib/queryClient: 1000 ms): a write that
 * joined the offline queue this instant is in IndexedDB once this has passed.
 */
export const QUEUE_ON_DISK_MS = 1500;

/**
 * How long a reload waits for a write that is on its way. A request can hang
 * for minutes on a network that neither answers nor fails; past this the
 * caller is told, instead of a screen stuck on "Updating…".
 */
export const WRITES_WAIT_MS = 10 * 1000;

const onItsWay = (mutation) => !mutation.state.isPaused;

/**
 * Resolves `true` once a reload can no longer drop a write: nothing is on its
 * way to the server, and whatever waits in the offline queue has reached the
 * disk. Resolves `false` when a write is still on its way after WRITES_WAIT_MS:
 * a reload would drop it.
 */
export async function writesAreSafe(queryClient) {
  const sending = () => queryClient.isMutating({ predicate: onItsWay }) > 0;
  if (sending()) {
    const arrived = await new Promise((resolve) => {
      let giveUp = null;
      const unsubscribe = queryClient.getMutationCache().subscribe(() => {
        if (sending()) return;
        clearTimeout(giveUp);
        unsubscribe();
        resolve(true);
      });
      giveUp = setTimeout(() => {
        unsubscribe();
        resolve(false);
      }, WRITES_WAIT_MS);
    });
    if (!arrived) return false;
  }
  if (queryClient.isMutating() > 0) {
    await new Promise((resolve) => setTimeout(resolve, QUEUE_ON_DISK_MS));
  }
  return true;
}
