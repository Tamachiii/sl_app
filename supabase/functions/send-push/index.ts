// send-push — Supabase Edge Function (Deno runtime).
//
// Internal fan-out endpoint. Unlike dispatch-rest-push (which auths the
// caller via user JWT and sleeps until fire_at), this function is the
// one a DB trigger calls when an event should produce a Web Push *now*.
//
// The callers are the notification triggers and RPCs: session feedback,
// session confirm, slot deviation, promote request, and program submit /
// approve / send-back, plus chat messages. Each reads `app_functions_url`
// and `app_service_role_key` from `vault.decrypted_secrets` and POSTs here
// via pg_net, wrapped in an EXCEPTION block so a push failure can never
// roll back the write that triggered it. See the fan-out block in
// schema.sql (search for `send-push`).
//
// Authorization: the caller presents the project's INTERNAL_BEARER — the
// value the vault keeps under `app_service_role_key`, which is NOT the
// service-role key, whatever the name says. The database has no user JWT,
// so the function is deployed with `verify_jwt = false`
// (supabase/config.toml) and the gate in ../_shared/auth.js is the only
// check there is: POST only, the bearer in constant time, a body of 8 kB at
// most, no CORS. Nothing below the gate runs for anyone else.
//
// This file is the adapter: it reads the environment and wires the gate to
// the fan-out. What can be decided without Deno is decided in ../_shared/,
// where vitest runs it; index.test.js runs this file too, with the two
// imports below replaced.
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
import { admitInternalRequest } from '../_shared/auth.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Shared secret the DB trigger sends in the Authorization header. We
// don't reuse SUPABASE_SERVICE_ROLE_KEY for the bearer check because
// Supabase auto-injects a `sb_secret_*` key into newer projects whose
// full value isn't recoverable outside the dashboard — that means the
// value in vault (which pg_net sends) can drift from the env-injected
// value. INTERNAL_BEARER is a dedicated secret we set via `supabase
// secrets set` and store identically in vault, so the two sides always
// agree no matter which key format the project uses. Unset, the gate
// refuses every call with a 500 and says why in the log.
const INTERNAL_BEARER = Deno.env.get('INTERNAL_BEARER');
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

Deno.serve(async (req: Request) => {
  // Internal-only: POST, the shared INTERNAL_BEARER, a small JSON body. The
  // DB trigger reads the matching value from vault and sends it; nobody
  // else should know this.
  const admitted = await admitInternalRequest(req, { name: 'send-push', bearer: INTERNAL_BEARER });
  if (admitted.response) return admitted.response;

  const { user_id, payload } = admitted.body as { user_id?: string; payload?: Record<string, unknown> };
  if (!user_id || !payload) {
    return new Response('send-push: missing user_id or payload', { status: 400 });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: subs, error: subsErr } = await admin
    .from('push_subscriptions')
    .select('*')
    .eq('user_id', user_id);

  if (subsErr) return json({ error: subsErr.message }, 500);
  if (!subs || subs.length === 0) return json({ delivered: 0 });

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

  return json({ delivered });
});
