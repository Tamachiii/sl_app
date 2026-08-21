import { useIsMutating } from '@tanstack/react-query';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useI18n } from '../../hooks/useI18n';

/**
 * Slim global banner that surfaces real connectivity loss.
 *
 * Mounted once in AppShell so every signed-in page picks it up. Visibility is
 * keyed on `navigator.onLine` plus the count of mutations React Query has
 * **paused** (state.isPaused === true). Paused mutations only exist when a
 * write was issued while offline; normal in-flight online mutations don't
 * count, so the banner doesn't flash on every set/RPE tap. The container
 * stays mounted with `max-height: 0` while hidden, so its appearance/dismissal
 * animates rather than yanking the layout up and down.
 *
 * The paused count is DERIVED, never mirrored into state. `useIsMutating` is a
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
  const { t } = useI18n();
  const pausedCount = useIsMutating({ predicate: (m) => m.state.isPaused });

  const visible = !isOnline;

  let message;
  if (!isOnline) {
    if (pausedCount > 0) {
      message = t(
        pausedCount === 1
          ? 'offline.bannerOfflineWithPending'
          : 'offline.bannerOfflineWithPendingMany',
        { n: pausedCount }
      );
    } else {
      message = t('offline.bannerOffline');
    }
  } else {
    // Render a frozen empty string while collapsing so screen readers don't
    // re-announce on the way out — the wrapper is already aria-hidden.
    message = '';
  }

  return (
    <div
      data-testid="offline-banner-wrapper"
      aria-hidden={!visible}
      style={{
        maxHeight: visible ? 48 : 0,
        opacity: visible ? 1 : 0,
        overflow: 'hidden',
        transition: 'max-height 220ms ease, opacity 180ms ease',
      }}
    >
      <div
        role="status"
        aria-live="polite"
        data-testid="offline-banner"
        className="sl-mono text-[11px] text-center px-3 py-1.5 border-b"
        style={{
          background: 'var(--color-warn)',
          color: 'var(--color-ink-900)',
          borderColor: 'rgba(0,0,0,0.08)',
        }}
      >
        {message}
      </div>
    </div>
  );
}
