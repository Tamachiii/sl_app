import { useCallback, useEffect, useState } from 'react';
import {
  enablePush,
  disablePush,
  isPushSupported,
  isPushEnabled,
  pushErrorKey,
  pushPermission,
} from '../lib/pushNotifications';
import { lastHeal, noteHealed } from './usePushAutoHeal';
import { useAuth } from './useAuth';

// The failures of a background look (`usePushAutoHeal`) a toggle prints when
// it opens: the ones that do not go away by themselves. A network that did not
// answer five minutes ago is not one — the look is made again.
const LASTING = new Set(['endpoint_refused']);

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
    (async () => {
      // What this device last told the database about the subscription it
      // holds — read first, from the device.
      const last = await lastHeal(userId).catch(() => null);
      let on;
      let code = '';
      try {
        on = await isPushEnabled(userId);
        // The database refuses this device for good: the look that found out
        // ran in the background, where nobody could be told.
        if (last && !last.ok && LASTING.has(last.code)) code = last.code;
      } catch (e) {
        // The database could not be asked whether this device is registered:
        // the toggle says so, and shows what the device itself remembers —
        // not a plain "off" for a phone that has no signal.
        on = last?.ok === true;
        code = e?.code || 'generic';
      }
      if (cancelled) return;
      setEnabled(on);
      setErrorCode(code);
      setPermission(pushPermission());
      setPending(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [supported, userId]);

  const enable = useCallback(async () => {
    setErrorCode('');
    setPending(true);
    try {
      await enablePush(userId);
      await noteHealed(userId);
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
