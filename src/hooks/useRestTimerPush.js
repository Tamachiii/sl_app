import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { isPushSupported, pushPermission, getActivePushSubscription } from '../lib/pushNotifications';
import { useAuth } from './useAuth';
import { useRestTimer } from './useRestTimer';

// Bridges the in-app rest-timer singleton to a server-scheduled Web Push.
//
// While a rest timer is active AND push notifications are enabled for
// this device, we:
//
//   1. INSERT a `scheduled_pushes` row with `fire_at = endsAt` and a
//      payload describing the "Rest done" notification.
//   2. Invoke the `dispatch-rest-push` Edge Function so it sleeps until
//      fire_at and delivers the push via web-push (VAPID-signed).
//   3. When the rest timer is cleared/replaced or the user leaves
//      SessionView, UPDATE the row's canceled_at so the function aborts
//      delivery on its late-cancellation check.
//
// Caps:
//
//   • Delays longer than ~5 min are skipped client-side because the Edge
//     Function's wall-time limit (400s) won't survive them. Most rest
//     periods are well under this; the in-foreground beep + wake-lock
//     side-effect path still covers everything regardless.
//   • If the device doesn't have an active push subscription (user
//     hasn't enabled the toggle), this hook is a no-op.

const MAX_DELAY_MS = 350_000; // mirrors the Edge Function clamp

async function hasActiveSubscription() {
  if (!isPushSupported() || pushPermission() !== 'granted') return false;
  const sub = await getActivePushSubscription();
  return !!sub;
}

async function scheduleRestPush({ userId, endsAt }) {
  const fireAt = new Date(endsAt).toISOString();
  const payload = {
    title: 'Rest done',
    body: 'Time for your next set.',
    tag: 'rest-timer',
    data: { url: `${import.meta.env.BASE_URL || '/'}#/student` },
  };
  const { data, error } = await supabase
    .from('scheduled_pushes')
    .insert({ user_id: userId, fire_at: fireAt, payload })
    .select('id')
    .maybeSingle();
  if (error || !data) throw error || new Error('insert failed');

  // Fire-and-forget invocation. The function sleeps until fire_at and
  // delivers; we don't await it. Errors here are logged but non-fatal —
  // if the function can't be reached, the schedule row stays 'pending'.
  supabase.functions
    .invoke('dispatch-rest-push', { body: { scheduleId: data.id } })
    .catch(() => {
      // No-op: dispatch failures are visible in the function logs;
      // the user still has the in-app beep as a fallback.
    });

  return data.id;
}

async function cancelRestPush(scheduleId) {
  if (!scheduleId) return;
  await supabase
    .from('scheduled_pushes')
    .update({ canceled_at: new Date().toISOString() })
    .eq('id', scheduleId)
    .eq('status', 'pending');
}

export function useRestTimerPush() {
  const { user } = useAuth();
  const userId = user?.id;
  const { endsAt, logId } = useRestTimer();
  const scheduleIdRef = useRef(null);
  const lastKeyRef = useRef(null);

  useEffect(() => {
    if (!userId || endsAt == null) return undefined;

    const key = `${logId}:${endsAt}`;
    if (lastKeyRef.current === key) return undefined;
    lastKeyRef.current = key;

    const delay = endsAt - Date.now();
    if (delay <= 0 || delay > MAX_DELAY_MS) return undefined;

    let cancelled = false;
    let myScheduleId = null;

    (async () => {
      try {
        const active = await hasActiveSubscription();
        if (!active || cancelled) return;
        const id = await scheduleRestPush({ userId, endsAt });
        if (cancelled) {
          cancelRestPush(id);
          return;
        }
        myScheduleId = id;
        scheduleIdRef.current = id;
      } catch {
        // Schedule failure is non-fatal — in-app cue still fires.
      }
    })();

    return () => {
      cancelled = true;
      const id = myScheduleId || scheduleIdRef.current;
      if (id) {
        cancelRestPush(id);
        if (scheduleIdRef.current === id) scheduleIdRef.current = null;
      }
    };
  }, [userId, endsAt, logId]);
}
