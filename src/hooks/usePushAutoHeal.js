import { useEffect } from 'react';
import { reconcilePushSubscription } from '../lib/pushNotifications';
import { useAuth } from './useAuth';

/**
 * App-wide Web Push self-healing. For any signed-in user (coach or student),
 * reconcile the device's live push subscription with the DB once on load and
 * again whenever the tab regains focus, so a rotated endpoint — which silently
 * ends delivery once send-push reaps the stale row — heals without the user
 * having to re-toggle from settings.
 *
 * Role-agnostic and best-effort: reconcilePushSubscription is UPSERT-only and
 * permission-gated, so this never subscribes, prompts, or enables push for a
 * user who didn't already opt in on this device.
 */
export function usePushAutoHeal() {
  const { user } = useAuth();
  const userId = user?.id;

  useEffect(() => {
    if (!userId) return undefined;
    const heal = () => {
      reconcilePushSubscription(userId).catch(() => {
        // Best-effort; the next focus or a manual re-toggle recovers.
      });
    };
    heal();
    function onVisibility() {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') heal();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [userId]);
}
