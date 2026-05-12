// send-push — Supabase Edge Function (Deno runtime).
//
// Internal fan-out endpoint. Unlike dispatch-rest-push (which auths the
// caller via user JWT and sleeps until fire_at), this function is the
// one a DB trigger calls when an event should produce a Web Push *now*.
//
// Today the only caller is the `notify_student_on_session_feedback`
// trigger on `messages`, which fires when a coach inserts a feedback
// message with session_id set. The trigger reads `app.functions_url`
// and `app.service_role_key` from DB GUCs and POSTs here via pg_net.
//
// Authorization: must present the service-role bearer (i.e. only the
// project itself can invoke this — the DB trigger does). Anything else
// gets a 401.
//
// Body shape:
//
//   {
//     "user_id": "<recipient profile id>",
//     "payload": {                       // forwarded verbatim to the SW
//       "title": "Feedback from Coach",
//       "body":  "Great session — keep your shoulders…",
//       "tag":   "feedback-<message-id>",
//       "data":  { "url": "/sl_app/#/student/session/<sessionId>" }
//     }
//   }
//
// Each push_subscriptions row for `user_id` gets the payload. 404/410
// from the push service drops the dead subscription. The response is a
// `{ delivered: <count> }` JSON.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Shared secret the DB trigger sends in the Authorization header. We
// don't reuse SUPABASE_SERVICE_ROLE_KEY for the bearer check because
// Supabase auto-injects a `sb_secret_*` key into newer projects whose
// full value isn't recoverable outside the dashboard — that means the
// value in vault (which pg_net sends) can drift from the env-injected
// value. INTERNAL_BEARER is a dedicated secret we set via `supabase
// secrets set` and store identically in vault, so the two sides always
// agree no matter which key format the project uses.
const INTERNAL_BEARER = Deno.env.get('INTERNAL_BEARER')!;
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
  }

  // Internal-only: caller must present the shared INTERNAL_BEARER. The
  // DB trigger reads the matching value from vault and sends it; nobody
  // else should know this.
  const auth = req.headers.get('Authorization') ?? '';
  if (!INTERNAL_BEARER || auth !== `Bearer ${INTERNAL_BEARER}`) {
    return new Response('Unauthorized', { status: 401, headers: CORS_HEADERS });
  }

  let body: { user_id?: string; payload?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return new Response('Bad request', { status: 400, headers: CORS_HEADERS });
  }
  const { user_id, payload } = body;
  if (!user_id || !payload) {
    return new Response('Missing user_id or payload', { status: 400, headers: CORS_HEADERS });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: subs, error: subsErr } = await admin
    .from('push_subscriptions')
    .select('*')
    .eq('user_id', user_id);

  if (subsErr) {
    return new Response(JSON.stringify({ error: subsErr.message }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
    });
  }
  if (!subs || subs.length === 0) {
    return new Response(JSON.stringify({ delivered: 0 }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
    });
  }

  const bodyStr = JSON.stringify(payload);
  let delivered = 0;

  await Promise.all(
    subs.map(async (sub: { id: string; endpoint: string; p256dh: string; auth: string }) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          bodyStr,
        );
        delivered += 1;
        await admin
          .from('push_subscriptions')
          .update({ last_seen_at: new Date().toISOString() })
          .eq('id', sub.id);
      } catch (e) {
        const status = (e as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          // Permanently dead subscription — clean it up so future fans
          // don't keep retrying it.
          await admin.from('push_subscriptions').delete().eq('id', sub.id);
        }
      }
    }),
  );

  return new Response(JSON.stringify({ delivered }), {
    status: 200,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
  });
});
