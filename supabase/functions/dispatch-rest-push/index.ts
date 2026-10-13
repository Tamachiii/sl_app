// dispatch-rest-push — Supabase Edge Function (Deno runtime).
//
// Called by the app when a rest timer starts, with the id of a row of
// scheduled_pushes: the notification "your rest is over", for a phone that
// is locked. It is the sender where no pg_cron job hands the rest pushes to
// send-push (schedule_rest_push answered mode 'edge'), and the one every app
// from before wave 3 calls, whatever the mode.
//
// A function cannot wait for the end of a rest: a worker of the runtime
// lives 150 seconds. So this one answers 202 at once and goes on after its
// answer, in hops — it waits a minute at most, then calls ITSELF for the
// next minute — and the last hop asks claim_rest_push whether the row is
// still its to send, sends, and writes on the row what became of it.
// ../_shared/restPush.js has the whole contract, and the reasons.
//
// Authorization: the function checks its caller itself, in one of two ways.
// It is deployed with `verify_jwt = false` (supabase/config.toml), because a
// hop has no user token to show, and the gate of ../_shared/restPush.js —
// which takes its comparisons from ../_shared/auth.js — is the only check
// there is:
//
//   Authorization: Bearer <token>   the app: the athlete's token, checked
//                                   with the auth server, and the row must
//                                   be theirs
//   x-internal-bearer: <secret>     a hop: the project's INTERNAL_BEARER,
//                                   the secret send-push is called with
//
// This file is the adapter: it reads the environment and hands the request
// to the shared module with what that module works with — the auth server,
// the service-role client, the web-push library, the runtime's waitUntil.
// What can be decided without Deno is decided in ../_shared/, where vitest
// runs it; index.test.js runs this file too, with its two remote modules
// replaced.
//
// Body: { "scheduleId": "<scheduled_pushes id>" }. A hop adds its number.
//
// Secrets, beyond what Supabase provides: INTERNAL_BEARER and the VAPID pair
// (docs/runbook/30-edge-functions.md, section 2).

import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
import { dispatchRestPush, functionUrl } from '../_shared/restPush.js';

const NAME = 'dispatch-rest-push';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
// The secret a hop shows. Unset, no hop is let in — a rest longer than a
// minute does not ring, and the log says why — and the app is still served.
const INTERNAL_BEARER = Deno.env.get('INTERNAL_BEARER');
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

// What Supabase's runtime gives a function to go on working after its
// answer: the global `EdgeRuntime`. Read when a request comes in, and from
// globalThis — Deno itself does not know the name.
type BackgroundRuntime = { waitUntil(work: Promise<unknown>): void };

Deno.serve((req: Request) => {
  const runtime = (globalThis as { EdgeRuntime?: BackgroundRuntime }).EdgeRuntime;

  return dispatchRestPush(req, {
    name: NAME,
    bearer: INTERNAL_BEARER,
    selfUrl: functionUrl(SUPABASE_URL, NAME),
    // Who a token belongs to is the auth server's answer, asked with the
    // anon key and the token itself. Made for a caller that shows a token,
    // not for one that shows nothing.
    getUser: (token: string) => createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    }).auth.getUser(token),
    // The service role reads and writes the rows. Made for a caller that
    // was let in, and the shared module asks whose row it is.
    createAdmin: () => createClient(SUPABASE_URL, SERVICE_ROLE_KEY),
    webpush,
    waitUntil: runtime ? (work: Promise<unknown>) => runtime.waitUntil(work) : undefined,
  });
});
