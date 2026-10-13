// send-push — Supabase Edge Function (Deno runtime).
//
// Internal fan-out endpoint: the one the database calls when something
// should produce a Web Push. Unlike dispatch-rest-push (which the app calls
// with the athlete's JWT), nobody but the project reaches it.
//
// The callers are the notification triggers and RPCs — session feedback,
// session confirm, slot deviation, promote request, program submit /
// approve / send-back, chat messages — and, where pg_cron runs, the job
// that hands over the rest pushes that are due. They read `app_functions_url`
// and the bearer from `vault.decrypted_secrets` and POST here via pg_net,
// inside an EXCEPTION block: a push that cannot be queued never rolls back
// the write that caused it. Nobody reads the answer.
//
// Authorization: the caller presents the project's INTERNAL_BEARER — the
// value the vault keeps under `app_service_role_key`, which is NOT the
// service-role key, whatever the name says. The database has no user JWT,
// so the function is deployed with `verify_jwt = false`
// (supabase/config.toml) and the gate in ../_shared/auth.js is the only
// check there is: POST only, the bearer in constant time, a body of 8 kB at
// most, no CORS. Nothing below the gate runs for anyone else.
//
// This file is the adapter: it reads the environment and hands the gate's
// request to ../_shared/push.js, with the two clients that module works
// with. What can be decided without Deno is decided in ../_shared/, where
// vitest runs it; index.test.js runs this file too, with its two remote
// modules replaced.
//
// Two kinds of body (../_shared/push.js has the whole contract):
//
//   {
//     "user_id": "<recipient profile id>",
//     "payload": {                       // forwarded verbatim to the SW
//       "title": "Feedback from Coach",
//       "body":  "Great session — keep your shoulders…",
//       "tag":   "feedback-<message-id>",
//       "data":  { "url": "/sl_app/#/student/session/<sessionId>" }
//     },
//     "ttl": 86400,                      // optional: seconds a push service keeps it
//     "urgency": "normal"                // optional: very-low | low | normal | high
//   }
//
// An event: every push_subscriptions row of `user_id` gets the payload, now.
// 404/410 from the push service drops the dead subscription; every other
// failure is a line of the log. `200 {"delivered":N}`, and 502 when there
// were devices and none took it.
//
//   { …the same…, "schedule_id": "<scheduled_pushes id>", "not_before": "<time>" }
//
// A rest push: answered 202 at once, sent at `not_before` — after
// claim_rest_push(schedule_id) said the row is this call's to send, and with
// what the claim answered.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
import { admitInternalRequest } from '../_shared/auth.js';
import { answerPush } from '../_shared/push.js';

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

// What Supabase's runtime gives a function to go on working after its
// answer: the global `EdgeRuntime`. Read when a request comes in, and from
// globalThis — Deno itself does not know the name.
type BackgroundRuntime = { waitUntil(work: Promise<unknown>): void };

Deno.serve(async (req: Request) => {
  // Internal-only: POST, the shared INTERNAL_BEARER, a small JSON body. The
  // DB trigger reads the matching value from vault and sends it; nobody
  // else should know this.
  const admitted = await admitInternalRequest(req, { name: 'send-push', bearer: INTERNAL_BEARER });
  if (admitted.response) return admitted.response;

  const runtime = (globalThis as { EdgeRuntime?: BackgroundRuntime }).EdgeRuntime;

  return answerPush(admitted.body as Record<string, unknown>, {
    name: 'send-push',
    webpush,
    // Made for a request that is served, not for one the body of which is
    // refused.
    createAdmin: () => createClient(SUPABASE_URL, SERVICE_ROLE_KEY),
    waitUntil: runtime ? (work: Promise<unknown>) => runtime.waitUntil(work) : undefined,
  });
});
