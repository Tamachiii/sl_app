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

/**
 * A page that is visible again after being hidden for less than this, its
 * channel joined, reads nothing again. A desktop tab that is switched away
 * from keeps its socket and is handed every event meanwhile: a resync at each
 * switch read the conversation list, the profiles and the open thread again
 * for nothing. A longer absence — more than one heartbeat of the client, which
 * sends one every 25 s — may have been a suspension whose socket died without
 * the page being told, and is read again at once. A socket that dies in a
 * short absence is not missed either: it is closed or fails its heartbeat,
 * the client joins the channel again, and that SUBSCRIBED reads everything.
 */
export const RESYNC_AFTER_HIDDEN_MS = 30_000;

/** Why `onResync` is called. */
export const RESYNC = Object.freeze({
  SUBSCRIBED: 'subscribed',
  ONLINE: 'online',
  VISIBLE: 'visible',
});

/**
 * The options of the invalidation a resync of `reason` asks React Query for:
 * what becomes of a read of the cache that is already in flight.
 *
 * After SUBSCRIBED — and a resync that gives no reason — it is cancelled and
 * sent again: it may have been sent before the join, and be older than the
 * first event the channel delivers. After `online` and `visible` it is kept:
 * it is most often React Query's own refetch on reconnect or focus, sent a
 * moment ago, and a cancel would only send a second request — most reads of
 * these caches do not pass `signal` on, so the first one is not even stopped.
 * A read that stalled while the page was away is kept too; if the socket died
 * meanwhile, the SUBSCRIBED of the channel joined again sends it again.
 */
export function resyncRefetchOptions(reason) {
  return { cancelRefetch: reason !== RESYNC.ONLINE && reason !== RESYNC.VISIBLE };
}

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
 * - `onResync(reason)`: called when the cache may be missing events, with one
 *   of RESYNC — `subscribed` each time the channel is SUBSCRIBED, the first
 *   time included (what the page read while the channel was joining arrived
 *   on no channel); `online` when the browser is back online; `visible` when
 *   the page is visible again after RESYNC_AFTER_HIDDEN_MS or more, or with
 *   its channel not joined (a suspended page is not told that its socket
 *   died).
 *
 * Returns the function that ends it.
 *
 * CHANNEL_ERROR and TIMED_OUT leave the channel where it is: the client joins
 * it again by itself, and a channel removed on its first error is never
 * joined again — the chat and the bell would stay as they are until a reload
 * after every dropped socket and every suspension of the page. It is removed
 * after MAX_JOIN_FAILURES of them in a row with no SUBSCRIBED in between, and
 * opened again, with a new count, on the next `online` or `visibilitychange`.
 * A channel the server closed — which the client never joins again — is
 * opened again then too, or once it is REOPEN_AFTER_MS old.
 */
export function watchPostgresChanges({ topic, filters, onChange, onResync }) {
  let stopped = false;
  let channel = null;
  // The last status of `channel` was SUBSCRIBED.
  let joined = false;
  let openedAt = 0;
  let failures = 0;
  let reopenTimer = null;
  let lastResync = Number.NEGATIVE_INFINITY;
  // When the page was hidden; null while it is shown, or when that was not seen.
  let hiddenAt = document.visibilityState === 'hidden' ? Date.now() : null;

  function resync(reason, { always = false } = {}) {
    const now = Date.now();
    if (!always && now - lastResync < RESYNC_GAP_MS) return;
    lastResync = now;
    onResync(reason);
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
    joined = false;
    openedAt = Date.now();
    failures = 0;
    opened.subscribe((status) => {
      // A channel that was let go still reports its own CLOSED.
      if (stopped || channel !== opened) return;
      joined = status === 'SUBSCRIBED';
      if (status === 'SUBSCRIBED') {
        failures = 0;
        // Never held back: what a refetch sent before this join read may be
        // older than the first event the channel delivers.
        resync(RESYNC.SUBSCRIBED, { always: true });
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

  function onOnline() {
    if (stopped) return;
    if (!channel) open();
    resync(RESYNC.ONLINE);
  }

  function onVisibility() {
    if (stopped) return;
    const state = document.visibilityState;
    if (state === 'hidden') {
      if (hiddenAt === null) hiddenAt = Date.now();
      return;
    }
    if (state !== 'visible') return;
    const away = hiddenAt === null ? Number.POSITIVE_INFINITY : Date.now() - hiddenAt;
    hiddenAt = null;
    if (!channel) open();
    // A joined channel was handed every event of a short absence.
    if (joined && away < RESYNC_AFTER_HIDDEN_MS) return;
    resync(RESYNC.VISIBLE);
  }

  open();
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    stopped = true;
    cancelReopen();
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisibility);
    const last = channel;
    channel = null;
    if (last) supabase.removeChannel(last);
  };
}
