import { useIsMutating } from '@tanstack/react-query';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useI18n } from '../../hooks/useI18n';

/**
 * Slim global banner that surfaces connectivity + pending-write state.
 *
 * Mounted once in AppShell so every signed-in page picks it up. While offline
 * we show the offline notice with a count of unresolved mutations; while
 * online with the queue draining we show a brief "syncing N changes" hint.
 *
 * useIsMutating returns every mutation in the `pending` status, which includes
 * mutations React Query has paused offline — so the same number drives both
 * branches without double-counting against the mutation cache.
 */
export default function OfflineBanner() {
  const isOnline = useOnlineStatus();
  const pending = useIsMutating();
  const { t } = useI18n();

  if (isOnline && pending === 0) return null;

  let message;
  let tone;
  if (!isOnline) {
    if (pending > 0) {
      message = t(
        pending === 1
          ? 'offline.bannerOfflineWithPending'
          : 'offline.bannerOfflineWithPendingMany',
        { n: pending }
      );
    } else {
      message = t('offline.bannerOffline');
    }
    tone = 'warn';
  } else {
    message = t(
      pending === 1 ? 'offline.bannerPending' : 'offline.bannerPendingMany',
      { n: pending }
    );
    tone = 'accent';
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="offline-banner"
      className="sl-mono text-[11px] text-center px-3 py-1.5 border-b"
      style={{
        background: tone === 'warn' ? 'var(--color-warn)' : 'var(--color-accent)',
        color: 'var(--color-ink-900)',
        borderColor: 'rgba(0,0,0,0.08)',
      }}
    >
      {message}
    </div>
  );
}
