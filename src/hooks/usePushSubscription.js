import { useCallback, useEffect, useState } from 'react';
import {
  enablePush,
  disablePush,
  isPushSupported,
  isPushEnabled,
  pushErrorKey,
  pushPermission,
} from '../lib/pushNotifications';
import { useAuth } from './useAuth';

// State + actions for the notification toggles (the athlete's profile page,
// the coach's avatar menu). Kept thin: no react-query plumbing because each
// consumer is one row in one place, and we want explicit error surfacing for
// the permission flow.
//
// Nothing that fails is shown as "off" without a word: what stopped a toggle
// is `errorCode` (a code of lib/pushNotifications.js), and `errorKey` is the
// i18n key of the sentence a toggle prints for it — always one the
// dictionaries have, whatever was thrown.
export function usePushSubscription() {
  const { user } = useAuth();
  const userId = user?.id;
  const supported = isPushSupported();
  const [enabled, setEnabled] = useState(false);
  const [permission, setPermission] = useState(supported ? pushPermission() : 'denied');
  const [pending, setPending] = useState(supported);
  // A stable error CODE (see lib/pushNotifications pushError), not a raw
  // English string — the consuming toggle localizes it. '' = no error.
  const [errorCode, setErrorCode] = useState('');

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
        setErrorCode('');
        setPermission(pushPermission());
      })
      .catch((e) => {
        if (cancelled) return;
        // The database could not be asked whether this device is registered:
        // the toggle says so, instead of a plain "off".
        setEnabled(false);
        setErrorCode(e?.code || 'generic');
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [supported, userId]);

  const enable = useCallback(async () => {
    setErrorCode('');
    setPending(true);
    try {
      await enablePush(userId);
      setEnabled(true);
      setPermission(pushPermission());
    } catch (e) {
      setErrorCode(e?.code || 'generic');
      setEnabled(false);
      setPermission(pushPermission());
    } finally {
      setPending(false);
    }
  }, [userId]);

  // A switch-off that failed leaves the toggle on: the device still receives.
  const disable = useCallback(async () => {
    setErrorCode('');
    setPending(true);
    try {
      await disablePush(userId);
      setEnabled(false);
    } catch (e) {
      setErrorCode(e?.code || 'generic');
    } finally {
      setPending(false);
    }
  }, [userId]);

  return {
    supported,
    enabled,
    permission,
    pending,
    errorCode,
    errorKey: pushErrorKey(errorCode),
    enable,
    disable,
  };
}
