import { useIsMutating } from '@tanstack/react-query';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useI18n } from '../../hooks/useI18n';
import { isQueuedWrite } from '../../lib/persistence';
import { formatNumber, pluralKey } from '../../lib/i18n/format';

/**
 * Slim global banner that surfaces real connectivity loss.
 *
 * Mounted once in AppShell so every signed-in page picks it up. Visibility is
 * keyed on `navigator.onLine`; the container stays mounted with
 * `max-height: 0` while hidden, so its appearance/dismissal animates rather
 * than yanking the layout up and down.
 *
 * "N changes waiting to sync" counts the writes this device still owes the
 * database — `isQueuedWrite` in lib/persistence.js, the same test that decides
 * what the persister stores. So the number is what will be sent once the
 * network is back, also after the app was killed in between, and nothing else.
 * It used to count every paused mutation: a session opened without signal
 * paused a housekeeping write of its page (one without a key, not part of the
 * queue), and the banner announced "1 change waiting to sync" to an athlete
 * who had not touched anything.
 *
 * The count is DERIVED, never mirrored into state. `useIsMutating` is a
 * `useSyncExternalStore` read over the mutation cache, so React owns the
 * scheduling. The previous `useState` + `mutationCache.subscribe` mirror called
 * `setState` straight from React Query's *synchronous* notify — and
 * `useMutation` builds its MutationObserver during render (the constructor
 * calls `setOptions`, which notifies the cache), so every page with a mutation
 * hook tripped "Cannot update a component (OfflineBanner) while rendering a
 * different component". Dev-only warning today, a real hazard under concurrent
 * rendering. Keep this derived.
 */
export default function OfflineBanner() {
  const isOnline = useOnlineStatus();
  const { t, lang } = useI18n();
  const waitingCount = useIsMutating({ predicate: isQueuedWrite });

  const visible = !isOnline;

  let message = '';
  if (!isOnline) {
    message =
      waitingCount > 0
        ? t(pluralKey(lang, waitingCount, 'parcFrame.offlinePending'), { n: formatNumber(lang, waitingCount) })
        : t('parcFrame.offline');
  }

  return (
    <div
      data-testid="offline-banner-wrapper"
      aria-hidden={!visible}
      style={{
        // Stuck to the top of the scrolling <main> it is mounted in, so the
        // notice is still there half-way down a session. `top: 0` is not the
        // top of the screen: a sticky box is held inside its scroller's
        // CONTENT box, and main pads its top by the safe-area inset — so the
        // banner stays where it sits before any scroll, under the notch.
        // (The inset as `top` would add it a second time.) Above the popovers
        // of a page (z-10 to z-30), below the toasts (z-50).
        position: 'sticky',
        top: 0,
        zIndex: 40,
        maxHeight: visible ? 80 : 0,
        opacity: visible ? 1 : 0,
        overflow: 'hidden',
        transition: 'max-height 220ms ease, opacity 180ms ease',
      }}
    >
      <div
        role="status"
        aria-live="polite"
        data-testid="offline-banner"
        className="border-b border-line-strong bg-amber-soft px-4 py-2 text-center text-[14px] font-semibold leading-[1.35] text-ink"
      >
        {message}
      </div>
    </div>
  );
}
