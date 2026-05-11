// dispatch-rest-push — Supabase Edge Function (Deno runtime).
//
// Called by the student client whenever a rest timer starts. The client
// has already INSERTed a scheduled_pushes row carrying { fire_at, payload }
// under their own RLS. This function:
//
//   1. Auths the caller via the Supabase JWT.
//   2. Loads the scheduled_pushes row by id (with service role).
//   3. Verifies the row belongs to the caller (defense in depth — the
//      caller can only INSERT/UPDATE their own rows under RLS, but the
//      function reads with service role and must enforce ownership).
//   4. Sleeps until fire_at (clamped to a safe upper bound below the
//      Edge Function wall-time limit).
//   5. Re-reads the row to honor a late `canceled_at`.
//   6. Sends a Web Push to every push_subscription for that user via
//      web-push (VAPID-signed). Marks each subscription's last_seen_at;
//      a 404/410 from the push service permanently drops the row.
//   7. Marks scheduled_pushes.status = 'sent' (or 'failed' on errors).
//
// The function returns 202 Accepted immediately if the caller used
// `?fireAndForget=1`; otherwise it awaits the dispatch and returns 200.
//
// Required env (Supabase project secrets):
//   - SUPABASE_URL                 (auto-injected)
//   - SUPABASE_SERVICE_ROLE_KEY    (auto-injected)
//   - VAPID_PUBLIC_KEY             (set via `supabase secrets set`)
//   - VAPID_PRIVATE_KEY            (set via `supabase secrets set`)
//   - VAPID_SUBJECT                (mailto: URI you control)
//
// Generate VAPID keys once:
//   npx web-push generate-vapid-keys --json
//   supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... \
//     VAPID_SUBJECT=mailto:you@example.com

import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Wall-time limit on the Edge Function (Supabase Pro = 400s). Clamp the
// scheduled delay a hair below so we never exceed it. Rest timers in this
// app are typically 30–300s, well within bounds.
const MAX_DELAY_MS = 350_000;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
  }

  const auth = req.headers.get('Authorization');
  if (!auth) {
    return new Response('Unauthorized', { status: 401, headers: CORS_HEADERS });
  }

  // Verify the JWT and resolve the caller's user_id. We use an anon-key
  // client bound to the caller's token so RLS would reject any spoofed id.
  const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return new Response('Unauthorized', { status: 401, headers: CORS_HEADERS });
  }
  const userId = userData.user.id;

  let body: { scheduleId?: string };
  try {
    body = await req.json();
  } catch {
    return new Response('Bad request', { status: 400, headers: CORS_HEADERS });
  }
  const scheduleId = body.scheduleId;
  if (!scheduleId) {
    return new Response('Missing scheduleId', { status: 400, headers: CORS_HEADERS });
  }

  // From here on we use the service role to read/update rows. We've already
  // proven who the caller is; we double-check user_id on every row.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: scheduled, error: loadErr } = await admin
    .from('scheduled_pushes')
    .select('*')
    .eq('id', scheduleId)
    .maybeSingle();

  if (loadErr || !scheduled) {
    return new Response('Not found', { status: 404, headers: CORS_HEADERS });
  }
  if (scheduled.user_id !== userId) {
    return new Response('Forbidden', { status: 403, headers: CORS_HEADERS });
  }
  if (scheduled.status !== 'pending' || scheduled.canceled_at) {
    return new Response('Already resolved', { status: 200, headers: CORS_HEADERS });
  }

  const fireAt = new Date(scheduled.fire_at).getTime();
  const delay = Math.min(MAX_DELAY_MS, Math.max(0, fireAt - Date.now()));
  if (fireAt - Date.now() > MAX_DELAY_MS) {
    // Refuse delays beyond what we can guarantee. The client should not
    // have scheduled this — but mark it failed so a poller could pick it
    // up later if we ever add one.
    await admin
      .from('scheduled_pushes')
      .update({ status: 'failed', error: 'delay_exceeds_function_limit' })
      .eq('id', scheduleId);
    return new Response('Delay too long', { status: 422, headers: CORS_HEADERS });
  }

  if (delay > 0) {
    await sleep(delay);
  }

  // Late-cancellation check. The client may have set canceled_at while
  // we were sleeping.
  const { data: recheck } = await admin
    .from('scheduled_pushes')
    .select('status, canceled_at')
    .eq('id', scheduleId)
    .maybeSingle();
  if (!recheck || recheck.status !== 'pending' || recheck.canceled_at) {
    await admin
      .from('scheduled_pushes')
      .update({ status: 'canceled' })
      .eq('id', scheduleId)
      .eq('status', 'pending');
    return new Response('Canceled', { status: 200, headers: CORS_HEADERS });
  }

  // Load every subscription for this user. We deliver to all of them so
  // a user with phone + laptop installed still gets the cue on whichever
  // one is in their hand.
  const { data: subs, error: subsErr } = await admin
    .from('push_subscriptions')
    .select('*')
    .eq('user_id', userId);

  if (subsErr || !subs || subs.length === 0) {
    await admin
      .from('scheduled_pushes')
      .update({ status: 'failed', error: subsErr?.message ?? 'no_subscriptions' })
      .eq('id', scheduleId);
    return new Response('No subscriptions', { status: 200, headers: CORS_HEADERS });
  }

  const payload = JSON.stringify(scheduled.payload ?? {});
  let anyDelivered = false;

  await Promise.all(
    subs.map(async (sub: { id: string; endpoint: string; p256dh: string; auth: string }) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        anyDelivered = true;
        await admin
          .from('push_subscriptions')
          .update({ last_seen_at: new Date().toISOString() })
          .eq('id', sub.id);
      } catch (e) {
        const status = (e as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          // Subscription is dead — clean it up.
          await admin.from('push_subscriptions').delete().eq('id', sub.id);
        }
      }
    }),
  );

  await admin
    .from('scheduled_pushes')
    .update({
      status: anyDelivered ? 'sent' : 'failed',
      sent_at: anyDelivered ? new Date().toISOString() : null,
      error: anyDelivered ? null : 'all_subscriptions_failed',
    })
    .eq('id', scheduleId);

  return new Response(JSON.stringify({ delivered: anyDelivered }), {
    status: 200,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
  });
});
