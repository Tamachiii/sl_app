import { useCallback, useEffect, useState } from 'react';
import {
  enablePush,
  disablePush,
  isPushSupported,
  isPushEnabled,
  pushPermission,
} from '../lib/pushNotifications';
import { useAuth } from './useAuth';

// State + actions for the "Rest end notifications" toggle on the
// StudentProfile page. Kept thin: no react-query plumbing because the
// only consumer is one row in one place, and we want explicit error
// surfacing for the permission flow.
export function usePushSubscription() {
  const { user } = useAuth();
  const userId = user?.id;
  const supported = isPushSupported();
  const [enabled, setEnabled] = useState(false);
  const [permission, setPermission] = useState(supported ? pushPermission() : 'denied');
  const [pending, setPending] = useState(supported);
  const [error, setError] = useState('');

  // Initial sync — what does the device + DB currently say?
  useEffect(() => {
    let cancelled = false;
    if (!supported || !userId) {
      setPending(false);
      return undefined;
    }
    setPending(true);
    isPushEnabled(userId)
      .then((on) => {
        if (cancelled) return;
        setEnabled(on);
        setPermission(pushPermission());
      })
      .catch(() => {
        if (cancelled) return;
        setEnabled(false);
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [supported, userId]);

  const enable = useCallback(async () => {
    setError('');
    setPending(true);
    try {
      await enablePush(userId);
      setEnabled(true);
      setPermission(pushPermission());
    } catch (e) {
      setError(e?.message || 'Could not enable notifications');
      setEnabled(false);
    } finally {
      setPending(false);
    }
  }, [userId]);

  const disable = useCallback(async () => {
    setError('');
    setPending(true);
    try {
      await disablePush(userId);
      setEnabled(false);
    } catch (e) {
      setError(e?.message || 'Could not disable notifications');
    } finally {
      setPending(false);
    }
  }, [userId]);

  return { supported, enabled, permission, pending, error, enable, disable };
}
