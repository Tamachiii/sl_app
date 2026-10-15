import { supabase } from './supabase';

/**
 * How many times in a row a channel may fail to join before it is let go.
 *
 * A failed join is not the end of a channel: the socket reconnects by itself
 * and the channel joins again on its own timer (1 s, 2 s, 5 s, then every
 * 10 s), and one dropped connection counts once however long it lasts. What
 * never recovers is a join the server refuses every time — a table that is not
 * in the publication — and without a limit that one is retried every ten
 * seconds for as long as the page lives. Eight leaves room for the joins that
 * are refused with an expired token right after a resume, while the session
 * is being refreshed.
 */
export const MAX_JOIN_FAILURES = 8;

/**
 * A channel the server closed is opened again once it is this old. A server
 * that closes every channel it has just accepted gets one new channel every
 * thirty seconds, not one per answer; `online` and `visibilitychange` open it
 * again at once.
 */
export const REOPEN_AFTER_MS = 30_000;

/**
 * `visibilitychange` and `online` often arrive together when a phone comes
 * back: the second one within this delay asks for nothing.
 */
export const RESYNC_GAP_MS = 1_000;

// supabase.channel(name) hands back the channel that is still registered under
// that name, and a removal is only complete once the server has answered — so
// a name that is reused straight away (StrictMode's second mount, a reopening)
// can return a channel that is leaving, on which subscribe() does nothing.
let openings = 0;

/**
 * Keeps one Realtime channel on `postgres_changes` alive for as long as the
 * caller wants it, and says when the cache may have missed something.
 *
 * - `filters`: one `postgres_changes` filter per binding; `onChange(payload)`
 *   receives the events of all of them.
 * - `onResync()`: called when the cache may be missing events — each time the
 *   channel is SUBSCRIBED, the first time included (what the page read while
 *   the channel was joining arrived on no channel), when the browser is back
 *   online and when the page is visible again (a suspended page is not told
 *   that its socket died).
 *
 * Returns the function that ends it.
 *
 * CHANNEL_ERROR and TIMED_OUT leave the channel where it is: the client joins
 * it again by itself. It is removed after MAX_JOIN_FAILURES of them in a row
 * with no SUBSCRIBED in between, and opened again, with a new count, on the
 * next `online` or `visibilitychange`. A channel the server closed — which the
 * client never joins again — is opened again then too, or once it is
 * REOPEN_AFTER_MS old.
 */
export function watchPostgresChanges({ topic, filters, onChange, onResync }) {
  let stopped = false;
  let channel = null;
  let openedAt = 0;
  let failures = 0;
  let reopenTimer = null;
  let lastResync = Number.NEGATIVE_INFINITY;

  function resync(always) {
    const now = Date.now();
    if (!always && now - lastResync < RESYNC_GAP_MS) return;
    lastResync = now;
    onResync();
  }

  function cancelReopen() {
    if (reopenTimer !== null) clearTimeout(reopenTimer);
    reopenTimer = null;
  }

  function open() {
    cancelReopen();
    openings += 1;
    const opened = supabase.channel(`${topic}-${openings}`);
    for (const filter of filters) {
      opened.on('postgres_changes', filter, (payload) => {
        if (!stopped && channel === opened) onChange(payload);
      });
    }
    channel = opened;
    openedAt = Date.now();
    failures = 0;
    opened.subscribe((status) => {
      // A channel that was let go still reports its own CLOSED.
      if (stopped || channel !== opened) return;
      if (status === 'SUBSCRIBED') {
        failures = 0;
        // Never held back: what a refetch sent before this join read may be
        // older than the first event the channel delivers.
        resync(true);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        failures += 1;
        if (failures >= MAX_JOIN_FAILURES) {
          channel = null;
          supabase.removeChannel(opened);
        }
      } else if (status === 'CLOSED') {
        channel = null;
        const age = Date.now() - openedAt;
        if (age >= REOPEN_AFTER_MS) open();
        else reopenTimer = setTimeout(open, REOPEN_AFTER_MS - age);
      }
    });
  }

  function catchUp() {
    if (stopped) return;
    if (!channel) open();
    resync(false);
  }

  function onVisibility() {
    if (document.visibilityState === 'visible') catchUp();
  }

  open();
  window.addEventListener('online', catchUp);
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    stopped = true;
    cancelReopen();
    window.removeEventListener('online', catchUp);
    document.removeEventListener('visibilitychange', onVisibility);
    const last = channel;
    channel = null;
    if (last) supabase.removeChannel(last);
  };
}
