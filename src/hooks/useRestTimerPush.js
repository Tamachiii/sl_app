import { useContext, useEffect, useRef } from 'react';
import { QueryClientContext, useIsRestoring } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { isPushSupported, pushPermission, getActivePushSubscription } from '../lib/pushNotifications';
import { getMessage } from '../lib/i18n';
import { REST_TIMER_TAG } from '../lib/swHandlers';
import { useAuth } from './useAuth';
import { useI18n } from './useI18n';
import { useRestTimer } from './useRestTimer';

// Bridges the in-app rest-timer singleton to a "Rest done" Web Push, for the
// phone in a pocket: the beep and the wake lock (useRestTimerEffects) only
// work while the app is in front.
//
// While a rest runs and THIS DEVICE has notifications on, the hook asks the
// database for one push, in one request:
//
//   schedule_rest_push(p_seconds, p_payload, p_endpoint)  → { id, fire_at, mode }
//
//   • p_seconds   the whole seconds the rest has left, counted right before
//                 the request leaves. The server adds them to its own clock:
//                 a phone whose clock is wrong rings on time all the same.
//                 1 to 900 — what the database accepts; a rest outside that
//                 asks for nothing and keeps its in-app cue.
//   • p_payload   what the notification shows, in the app's language at the
//                 moment the rest is scheduled, under the tag the worker
//                 knows (REST_TIMER_TAG), and a tap that leads back to the
//                 session the set belongs to — or nowhere, when the session
//                 is not known: the worker then brings the app to the front
//                 and moves no window. Never the training list: a tap there
//                 takes the athlete out of the session they are resting in.
//   • p_endpoint  this device's subscription. The push rings here, and only
//                 here: without it every phone and laptop of the account
//                 would ring for a rest taken on one of them.
//
//   mode 'cron'   the database's job sends it; nothing more to do.
//   anything else ('edge', or no answer about it): nobody sends unless the
//                 app calls the dispatch-rest-push Edge Function with the id.
//                 Calling it when the job does run costs one call and never a
//                 second push — every sender claims the row first.
//
// Every change of the rest takes its push back with cancel_rest_push(id) —
// Undo, Skip, the next set, "+30 s" (which schedules the new end), the shell
// going away — and so does a rest that ends while its push is being
// scheduled, as soon as the id is known. The next schedule also closes every
// row the account still had waiting, so a cancel that never arrives, or a
// rest taken back after the app was killed, leaves no second push behind.
// For the same reason the schedule requests leave one after the other: of
// two that cross, the row kept is the one of the request that arrives last.
//
// A database without those functions (migration 16 not applied: PGRST202)
// gets what the app did before — the row inserted with the phone's end time,
// the Edge Function invoked, the row stamped canceled_at to take it back.
// Only that answer falls back. A refusal (device_not_registered,
// rest_seconds_out_of_range, payload_invalid, not authorized) or no answer at
// all schedules nothing: the old insert names no device, and would ring every
// device of the account.
//
// Offline, nothing is asked: the request would wait for a network, and the
// server would count the seconds from whenever it arrived.

/** The longest rest the database schedules a push for (schedule_rest_push). */
export const MAX_REST_PUSH_SECONDS = 900;

// PostgREST's answer for a function the database does not have.
const NO_SUCH_FUNCTION = 'PGRST202';

const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

// The endpoint of this device's push subscription, or null when the device
// has none the app may use: no push here, permission not granted, nothing
// subscribed.
async function deviceEndpoint() {
  if (!isPushSupported() || pushPermission() !== 'granted') return null;
  const subscription = await getActivePushSubscription();
  const endpoint = subscription?.endpoint;
  return typeof endpoint === 'string' && endpoint !== '' ? endpoint : null;
}

// The session the set `logId` belongs to, from the lists of sets the device
// holds — ['set-logs', sessionId, slotIds] — or null. No request: the push
// has to leave before the phone is put away.
function sessionOfSet(queryClient, logId) {
  if (!queryClient || !logId) return null;
  for (const [key, rows] of queryClient.getQueriesData({ queryKey: ['set-logs'] })) {
    if (Array.isArray(rows) && rows.some((row) => row?.id === logId)) {
      const sessionId = key[1];
      return typeof sessionId === 'string' && sessionId !== '' ? sessionId : null;
    }
  }
  return null;
}

/** The "Rest done" notification, in `lang`, leading to `sessionId` when there is one. */
export function restPushPayload(lang, sessionId) {
  const payload = {
    title: getMessage(lang, 'student.session.restDone'),
    body: getMessage(lang, 'restPush.body'),
    tag: REST_TIMER_TAG,
  };
  if (sessionId) {
    payload.data = { url: `${import.meta.env.BASE_URL || '/'}#/student/session/${sessionId}` };
  }
  return payload;
}

// The whole seconds left until `endsAt`, rounded up so the push is never
// early — or null when that is not a rest the database schedules.
function secondsUntil(endsAt) {
  const seconds = Math.ceil((endsAt - Date.now()) / 1000);
  return seconds >= 1 && seconds <= MAX_REST_PUSH_SECONDS ? seconds : null;
}

function dispatch(scheduleId) {
  // Fire and forget: the function answers 202 and does the waiting. A call
  // that fails is a rest without its push — the in-app cue still rings.
  Promise.resolve()
    .then(() => supabase.functions.invoke('dispatch-rest-push', { body: { scheduleId } }))
    .catch(() => {});
}

// What the app did before migration 16: the row written with the phone's end
// time, which only the Edge Function sends.
async function scheduleTheOldWay({ userId, endsAt, payload }) {
  const { data, error } = await supabase
    .from('scheduled_pushes')
    .insert({ user_id: userId, fire_at: new Date(endsAt).toISOString(), payload })
    .select('id')
    .maybeSingle();
  if (error || !data?.id) return null;
  return { id: data.id, needsDispatch: true };
}

// How long a schedule request waits for the one before it to be answered.
export const PREVIOUS_REQUEST_WAIT_MS = 5_000;

// The schedule request sent last, by any mount of the hook — settled once it
// is answered.
let lastRequest = Promise.resolve();

function waitAtMost(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// `send`, once the request before it is answered. schedule_rest_push closes
// every row the account still has waiting before it writes its own: a
// request of the rest before, overtaken by the next rest's, would close the
// new row — and then be taken back itself, leaving the new rest with no push.
// Not for ever: a request that gets no answer must not keep the next rest
// from its push.
function inTurn(send) {
  const mine = waitAtMost(lastRequest, PREVIOUS_REQUEST_WAIT_MS).then(send);
  lastRequest = mine.then(
    () => {},
    () => {},
  );
  return mine;
}

// The push scheduled for this rest — its id, and whether the app has to call
// the Edge Function for it to be sent — or null when none was.
async function scheduleRestPush({ userId, endsAt, payload, endpoint }) {
  const seconds = secondsUntil(endsAt);
  if (seconds == null || isOffline()) return null;
  const { data, error } = await supabase.rpc('schedule_rest_push', {
    p_seconds: seconds,
    p_payload: payload,
    p_endpoint: endpoint,
  });
  if (error) {
    return error.code === NO_SUCH_FUNCTION ? scheduleTheOldWay({ userId, endsAt, payload }) : null;
  }
  if (!data?.id) return null;
  return { id: data.id, needsDispatch: data.mode !== 'cron' };
}

async function cancelRestPush(scheduleId) {
  if (!scheduleId) return;
  try {
    const { error } = await supabase.rpc('cancel_rest_push', { p_id: scheduleId });
    if (error?.code !== NO_SUCH_FUNCTION) return;
    await supabase
      .from('scheduled_pushes')
      .update({ canceled_at: new Date().toISOString() })
      .eq('id', scheduleId)
      .eq('status', 'pending');
  } catch {
    // Not taken back: the next rest's schedule closes it, or it rings.
  }
}

export function useRestTimerPush() {
  const { user } = useAuth();
  const userId = user?.id;
  const { endsAt, logId } = useRestTimer();
  const { lang } = useI18n();
  // Read, not required: a page rendered without a cache provider still mounts.
  const queryClient = useContext(QueryClientContext);
  // A rest taken back after a relaunch waits for the stored cache, which
  // holds the set's session.
  const isRestoring = useIsRestoring();

  // The language is read when the push is scheduled, not followed: a change
  // of language in the middle of a rest must not take its push back.
  const langRef = useRef(lang);
  useEffect(() => {
    langRef.current = lang;
  }, [lang]);

  useEffect(() => {
    if (!userId || endsAt == null || isRestoring) return undefined;
    if (secondsUntil(endsAt) == null) return undefined;

    let cancelled = false;
    let scheduleId = null;

    (async () => {
      try {
        const endpoint = await deviceEndpoint();
        if (!endpoint || cancelled) return;
        const payload = restPushPayload(langRef.current, sessionOfSet(queryClient, logId));
        // A rest that changed while the request before was in flight asks
        // for nothing.
        const scheduled = await inTurn(() =>
          cancelled ? null : scheduleRestPush({ userId, endsAt, payload, endpoint }),
        );
        if (!scheduled) return;
        if (cancelled) {
          // The rest ended while its push was being scheduled.
          cancelRestPush(scheduled.id);
          return;
        }
        scheduleId = scheduled.id;
        if (scheduled.needsDispatch) dispatch(scheduled.id);
      } catch {
        // Not scheduled: the in-app cue still rings.
      }
    })();

    return () => {
      cancelled = true;
      if (scheduleId) cancelRestPush(scheduleId);
    };
  }, [userId, endsAt, logId, isRestoring, queryClient]);
}
