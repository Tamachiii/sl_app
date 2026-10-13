# 30 — Edge Functions: deploy, secrets, the check after a deploy

| | |
|---|---|
| Where | the Supabase CLI, from the root of this checkout. No file of `supabase/migrations/`, no dashboard setting |
| Kind | code published to Supabase's Edge runtime, and one shared secret · no table of the app and no row is touched |
| Wave / checkpoint | from wave 1. A function deploy is a step of Checkpoint B and of the checkpoints after it; the two functions as they stand after wave 2 are deployed at Checkpoint B, after migrations 15 and 16 and before migration 19 ("When", below) |
| Findings | L25 (low), B18 (low), P35 (medium), P10 (high) |
| Check | after every deploy and every rotation (section 3) — it writes nothing and sends no notification |

This page is for the person who owns the Supabase project. Nothing in the repository, no workflow and no agent deploys a function or sets a secret: you do, with the commands below.

## The two functions

| Function | `verify_jwt` | Called by | How it knows its caller |
|---|---|---|---|
| `send-push` | `false` | the database, through pg_net: every notification trigger, and — where pg_cron is switched on — the job that hands over the rest pushes that are due | the `INTERNAL_BEARER` secret, which the function checks itself |
| `dispatch-rest-push` | `false` | the app, when a rest timer starts — and itself: it waits for the end of a rest a minute at a time, and each minute after the first is a request it makes to its own address | the app by the signed-in athlete's JWT, which the function checks with the auth server; itself by the `INTERNAL_BEARER` secret, in a header of its own (`x-internal-bearer`) |

`verify_jwt` is the check Supabase's gateway makes **in front of** a function: with `true`, a request without a valid user JWT is answered 401 by the gateway and the function never runs. The database has no user JWT, and neither has a function that calls itself. So both run with `false`, and their own check is the only one.

The column is not a wish: it is `supabase/config.toml`, which the CLI reads at every deploy. A test fails when a function has no entry in that file (`supabase/functions/deploy.test.js`), and when this table and the file disagree (`supabase/functions/runbook.test.js`).

## What was wrong

**The flag lived in someone's memory (B18).** `send-push` had to be deployed with `--no-verify-jwt`, and nothing recorded it. One `supabase functions deploy send-push` without the flag puts the gateway's check in front of it. From then on every call of the database is refused before the function runs, and nothing says so: the triggers do not read the answer, and the bell rows are still written. Every push of the app — session confirmed, feedback, message, off-plan exercise, draft submitted — stops, silently, for everyone.

**The function's own check was the weak kind (L25).** It compared the bearer with `!==`, which stops at the first character that differs: the time it takes tells how much of a guess is right. It answered every request, refusals included, with `Access-Control-Allow-Origin: *`, so any web page could call it from a browser. And it read a body of any size. Nothing suggests any of it was ever used, and the function is safe for as long as the secret is. The secret is what most of the rest of this page is about, because whoever has it can send a notification, with any text and any link, to any user.

**A push that failed left no trace (P35).** The function answered `200 {"delivered":0}` whatever had happened, and wrote nothing in its log. When a push service refused a message — a signing key it does not know, a quota, an outage — nothing anywhere said so: a VAPID key changed on one side only would have stopped every notification of the app, in silence. And every message was handed to the push services with the library's own settings: kept for four weeks for a phone that is offline, at ordinary urgency, with no time limit on the connection. "Your rest is over" could arrive an hour later, on a phone that had been saving its battery.

**A rest of two and a half minutes or more never rang (P10).** `dispatch-rest-push` waited, inside the request the app had made, until the rest was over, and only then sent. The platform does not let a function wait that long: on the free plan it ends after 150 seconds. So the notification "your rest is over" arrived for a short rest and never for a long one — the rests after a heavy set, with the phone locked, which are the ones it exists for. The function also sent a row it had merely read: with a second sender, that is two notifications.

## What this version does

- `supabase/config.toml` carries the flag of each function. The deploy command has no flag to forget.
- `send-push` opens with one gate (`supabase/functions/_shared/auth.js`): `POST` only, the bearer compared in constant time, a body of 8 kB at most, a JSON object. Nothing else in the function runs for a caller the gate refuses.
- No `Access-Control-*` header, and no answer to a preflight: a browser cannot call it.
- A refusal says who refuses: `send-push: unauthorized`. The check of section 3 uses that to tell the function's refusal from the gateway's.
- Without its secret the function refuses everyone with a 500, `send-push: not configured`, and writes `INTERNAL_BEARER is not set` in its log.
- **Every push that was not taken is a line of the function's log** (section 5): the status the push service answered, what it said, and its host — never the rest of the address, which is the phone's own.
- **`502` when a user has devices and none of them got the message.** The answer is still `200 {"delivered":N}` when N devices took it, and `200 {"delivered":0}` for a user who has no device. A device its push service calls gone (a 404 or a 410: the app was removed, the permission taken back) is deleted, as before, and a user whose every device was gone is a user without a device: `200`. Nobody reads the answer at the time; where pg_cron is switched on, the answers that were not a 2xx are counted once an hour ([50](50-pg-cron.md)).
- **A message is kept one day** for a phone that is offline, not four weeks, and a connection to a push service has a time limit (5 seconds of silence, 8 seconds in all). The database can ask for something else in its request (`ttl` in seconds, `urgency`); from migration 15 on it sends `ttl`. A value the push services would not take is replaced by the usual one, with a line in the log: the push is sent all the same.
- **It sends to the four push services and nowhere else**: Google's, Mozilla's, Apple's and Microsoft's — the list migration 15 puts on the table as a rule ([15](migrations/15-push-plumbing.md)). A device whose address is anywhere else is not called. Its row stays, and the log names the host.
- **It can send a rest push at its time.** Where pg_cron is switched on, the database hands over each rest push about ten seconds before the rest ends, with the time not to send before. The function answers `202` at once, waits (two minutes at most), asks the database whether the push is still its to send — the athlete may have started the next set, the other function may have sent it — and only then sends, kept for one minute, at high urgency: to the device the rest was started on, or to every device of the athlete where the app that started it names none (every app before wave 3). It then writes on the row what became of it ([16](migrations/16-rest-push-scheduling.md)). Without pg_cron no such request arrives.

- **`dispatch-rest-push` answers at once and waits a minute at a time.** It answers `202`, goes on working after its answer, and waits a minute at most. If the rest is not over by then, it calls itself — a new request, which waits the next minute — and the last request sends. A rest of three minutes is three requests; one of fifteen minutes, the longest the database schedules, is fifteen. Why a minute, when the limit is 150 seconds: the 150 seconds belong to a *worker* of the platform, not to a request. A worker takes every request that arrives during the first 75 seconds of its life, so a request can land on one that is 75 seconds old, and the other 75 are all it is sure of.
- **It asks before it sends, as `send-push` does.** Its last request asks the database whether the push is still its to send (`claim_rest_push`, migration 16), sends what the database answered, and writes on the row what became of it. Two senders that hold the same rest are one notification. A rest its athlete took back — the next set was started — is not sent, and the request that finds it taken back stops there: nothing calls itself for a rest that is over.
- **It checks its two callers itself, before it reads anything.** The app shows the athlete's token: the function asks the auth server whose it is, and sends only a rest of that athlete. A request the function makes to itself shows the `INTERNAL_BEARER` secret in the header `x-internal-bearer`, compared in constant time; a request that carries that header is judged on it alone. Anything else is `401 dispatch-rest-push: unauthorized`. A web page can call the function with a token, as the app does, and cannot send that header.
- **A hand-over that fails is not tried again.** If the request for the next minute is refused or lost, the rest does not ring, and one line of the log says why (section 5). There is no second try and nothing that sweeps up afterwards: that is why pg_cron, where the database does the waiting, stays the way to prefer ([50](50-pg-cron.md)).

For the database that is in production today and for the app, nothing changes in how they call: same URLs, same headers, same bodies, and from `send-push` the same answer `{"delivered":N}` whenever a device got the message or the user has none. The app does not read what `dispatch-rest-push` answers. What changes for an athlete is that a rest of two and a half minutes or more rings.

## When

- **Checkpoint B and later**: the checkpoint lists the functions to deploy; the commands are section 1, the check is section 3.
- **`send-push` as it stands after wave 2**: at Checkpoint B, in this order — **migrations 15 and 16, then this deploy, then, if you choose pg_cron, migration 19.**
  - *After migration 15*, because its audit is what looks at the addresses of the devices that exist ([15](migrations/15-push-plumbing.md), "Devices whose endpoint is not at a known push service"). This version sends nothing to an address outside the list: deploy it once that audit has shown there is none.
  - *After migration 16*, because the function asks the database for `claim_rest_push`, which that migration creates.
  - **Never migration 19 before this deploy.** The job of migration 19 hands a rest push over ten seconds early. The `send-push` from before wave 2 does not know what that request is: it would send it at once, to every device of the athlete, ten seconds early — and the function the app calls would ring them again at the time. Nothing in the database can tell which version is deployed; the third line of the check (section 3) can.
  - It does not need the migrations in order to run: the database that is in production today calls it exactly as it calls the version it replaces, and gets the same answers. If a deploy has to come first for another reason, nothing breaks.
- **`dispatch-rest-push` as it stands after wave 2**: at Checkpoint B, right after `send-push` — **migration 16, then this deploy, then, if you choose pg_cron, migration 19.**
  - **Never before migration 16.** Unlike `send-push`, this function cannot do its work without it: its last step asks the database for `claim_rest_push`, which that migration creates. Deployed first, it sends nothing — no rest rings — and its log says `claim_rest_push could not be asked`.
  - **Never migration 19 before this deploy either.** The version in production (v2, 2026-05-11) sends a row it has merely read. With the job of migration 19 switched on, the job hands the same row to `send-push`, and the two send: every rest of an app from before wave 3 can ring twice.
  - The app that is deployed calls it exactly as it calls the version it replaces: nothing to publish first.

## 1. Deploy

From the root of the checkout, on the branch that carries the code, with the CLI linked ([00, section 1](00-before-you-start.md)).

```bash
supabase functions deploy send-push --use-api
```

```bash
supabase functions deploy dispatch-rest-push --use-api
```

One function per command, and only the one the checkpoint asks for. Then section 3.

- **`--use-api`** has Supabase bundle the function from the files the CLI uploads. Without it the CLI bundles on this machine, in Docker, which this machine does not have.
- **Never `--no-verify-jwt`.** `supabase/config.toml` decides, function by function. The flag overrides the file — for every function named on that command line.
- **Never from the dashboard's code editor.** It deploys what is typed into it: not this repository, not `_shared/`, and with its own setting for JWT verification.
- **Never `supabase config push`.** The file holds the function flags and nothing else; a push would overwrite the project's Auth settings with the CLI's defaults ([20](20-auth-config.md)). If `supabase link` prints that the local configuration differs from the project's: it does, on purpose.
- **`Could not find the supabase-go binary`**: the CLI is installed in two parts and this shell found only the first. The message lists the fix. On this machine `~/.local/share/supabase` holds both parts: put it first in `PATH` and run the command again.

A deploy replaces the function within seconds.

## 2. Secrets

Two places hold secrets, and one value is in both.

**The functions' secrets** — set with `supabase secrets set`, read by the functions as environment variables:

| Name | Read by | What it is |
|---|---|---|
| `INTERNAL_BEARER` | both | the shared secret: who presents it to `send-push` may send a push to any user. `dispatch-rest-push` shows it to itself, from one minute of a rest to the next |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | both | the key pair that signs every push. The public half is also built into the app (`VITE_VAPID_PUBLIC_KEY`, a GitHub secret) |
| `VAPID_SUBJECT` | both | a `mailto:` address the push services may write to |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are given to every function by Supabase. Do not set them.

```bash
supabase secrets list
```

It prints names and digests, never a value. The four names of the table must be there.

**The database's vault** — read by the triggers when they call `send-push`:

| Name | What it is |
|---|---|
| `app_functions_url` | where the functions are: `https://<project ref>.supabase.co/functions/v1` |
| `app_service_role_key` | **the same value as `INTERNAL_BEARER`**. It is not the service-role key and must not be: the name is a leftover |

```bash
supabase db query --linked "select name, case when name = 'app_functions_url' then decrypted_secret end as value, updated_at from vault.decrypted_secrets where name in ('app_functions_url', 'app_service_role_key') order by name"
```

Two rows. The first shows the URL, which must be the `VITE_SUPABASE_URL` of `.env` followed by `/functions/v1`. The second shows no value — the query never prints the bearer — and the day it was last changed. With a row missing, the triggers skip the push without an error, and only the bell rows are written.

**Do not rename `app_service_role_key`.** The triggers in production read that name and no other. Migration 15 (Checkpoint B) teaches them `app_internal_bearer`; the rename is a step of that migration's page, after it is applied.

**Do not change the VAPID pair.** Every phone's subscription is tied to the public key: with a new pair, every user has to switch notifications off and on again, and the app must be rebuilt with the new public key.

## 3. The check

After every deploy of `send-push`, and after every rotation. From the root of the checkout that holds the `.env`. It reads the project URL from that file and sends at most three requests to `send-push`, for a user id nobody has and a rest push that does not exist: no notification is sent and nothing is written.

```bash
node --env-file=.env --input-type=module -e '
const url = new URL("/functions/v1/send-push", process.env.VITE_SUPABASE_URL);
const bearer = process.env.INTERNAL_BEARER;
const ask = async (headers, more = {}) => {
  const body = JSON.stringify({ user_id: "00000000-0000-0000-0000-000000000000", payload: { title: "deploy check" }, ...more });
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  return `${res.status} ${(await res.text()).replace(/\s+/g, " ").trim().slice(0, 120)}`;
};
const closed = await ask({});
console.log(`no bearer: ${closed}`);
if (closed !== "401 send-push: unauthorized") process.exit(1);
if (!bearer) {
  console.log("bearer: not sent, INTERNAL_BEARER is not set in this shell");
  process.exit(0);
}
const open = await ask({ authorization: `Bearer ${bearer}` });
console.log(`bearer: ${open}`);
if (open !== `200 {"delivered":0}`) process.exit(1);
const rest = await ask({ authorization: `Bearer ${bearer}` }, { schedule_id: "deploy check", not_before: "deploy check" });
console.log(`rest push: ${rest}`);
if (rest !== "400 send-push: schedule_id is not a uuid") process.exit(1);
'
```

It prints two lines, or three:

| line | after a deploy | during a rotation (section 4) |
|---|---|---|
| `no bearer` | `401 send-push: unauthorized` | `401 send-push: unauthorized` |
| `bearer` | `not sent, INTERNAL_BEARER is not set in this shell` | `200 {"delivered":0}` |
| `rest push` | — | `400 send-push: schedule_id is not a uuid` |

The first line is the one that matters after a deploy: the function itself refused a caller without the secret. So the gateway let the request through (`verify_jwt` is off, as it must be), and the gate is in place.

The second and the third request are made only when your shell holds the secret, which it does during a rotation and at no other time: nobody needs to keep the value, and section 4 is how you get a fresh one. They are sent only after the first line came back as above — never to something that did not answer as `send-push`.

The third line is the one that tells **which version** answers. It hands the function a rest push whose id is not an id: the version of this page refuses it by name, and the one from before wave 2 — which has the same gate — does not know what a rest push is and answers `200 {"delivered":0}`. That is the line to have seen before migration 19 is applied, and seeing it takes a rotation.

If it does not print that:

- **`no bearer: 401 Unauthorized`** — one word. That is the version from before this page (v4, deployed 2026-05-12): the gateway lets requests through and the old check refuses. Nothing is broken. It is what the check prints until `send-push` is deployed from this branch.
- **`no bearer: 401`, then anything else** — JSON, a mention of a JWT or of an authorization header. The gateway answered, not the function: `send-push` is deployed with JWT verification **on**, and no push of the database gets through. This is finding B18. Deploy it again with the command of section 1, from the root of the checkout, and run the check again. If the line does not change, the CLI did not take the flag from `supabase/config.toml`: stop and report.
- **`no bearer: 500 send-push: not configured`** — the function runs and has no `INTERNAL_BEARER`. `supabase secrets list` must show the name; section 4 sets it.
- **`no bearer: 404`, then anything** — there is no function of that name in the project the `.env` points at.
- **`no bearer: 503`, then anything**, or a 500 that is not the line above — the function does not start. Read its log (Dashboard → Edge Functions → `send-push` → Logs), then go back to the version before ("Undo").
- **`no bearer: 200`, then anything** — the function answers a caller that shows nothing. Stop and report.
- **`bearer: 401 send-push: unauthorized`** — the value in your shell is not the function's secret. Straight after `supabase secrets set`, wait half a minute and run the check again; if it stays, run the rotation again from its first command.
- **`bearer: 500`, then `{"error":…}`** — the secret is right and the function could not read `push_subscriptions`. The message says why.
- **`rest push: 200 {"delivered":0}`** — the function that answers is the `send-push` from before wave 2: it has the gate and does not know a rest push. Deploy from the branch that carries this page (section 1) and run the check again. **Until that line reads as in the table, do not apply migration 19**; if its job is already switched on, switch it off first ([50](50-pg-cron.md), "Pausing a job, and starting it again").
- **`node: .env: not found`** — this folder has no `.env`. Run the check from the root of the main checkout.
- **`fetch failed`** — no network, or the URL in `.env` is wrong.

**The same for `dispatch-rest-push`**, after every deploy of it. One request that shows nothing: no token, no secret. Nothing is read, nothing is written and no notification is sent.

```bash
node --env-file=.env --input-type=module -e '
const url = new URL("/functions/v1/dispatch-rest-push", process.env.VITE_SUPABASE_URL);
const body = JSON.stringify({ scheduleId: "00000000-0000-0000-0000-000000000000" });
const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
const said = `${res.status} ${(await res.text()).replace(/\s+/g, " ").trim().slice(0, 120)}`;
console.log(`no credentials: ${said}`);
if (said !== "401 dispatch-rest-push: unauthorized") process.exit(1);
'
```

It prints one line, `no credentials: 401 dispatch-rest-push: unauthorized`: the function itself refused. So the gateway let the request through — which is what the requests the function makes to itself need — and the version that answers is the one of this page.

If it does not print that:

- **`no credentials: 401`, then anything else** — JSON, a mention of a JWT or of an authorization header. The gateway answered, not the function. **Before the first deploy from this branch that is expected**: the version in production runs behind the gateway's check. **After a deploy it is a fault that nothing else shows**: the app's own request still gets through, with the athlete's token, and a rest of a minute or less rings — but every request the function makes to itself is refused, so no longer rest does. Deploy again with the command of section 1, from the root of the checkout, and run this again. If the line does not change, the CLI did not take the flag from `supabase/config.toml`: stop and report.
- **`no credentials: 401 Unauthorized`** — one word. The version from before this page (v2) is deployed without the gateway's check, which is what "Undo" leaves. It checks the athlete's token itself: nothing is open. A rest of two and a half minutes or more does not ring.
- **`no credentials: 404`, then anything**, **`no credentials: 503`, then anything**, **`no credentials: 200`, then anything** — as for `send-push` above: no such function, a function that does not start (its log, then "Undo"), a function that answers a caller who shows nothing (stop and report).

What the two checks cannot see: whether a push reaches a phone. That needs a device whose user switched notifications on — on 2026-10-03 the coach account had none, so every push meant for the coach reached nobody (avatar → **Notifications** → *Enable*, on the coach's phone). The real test of `send-push` is a message from the coach to the test athlete, with the athlete's phone locked.

**The real test of `dispatch-rest-push` is a long rest, with the phone locked.** As the test athlete, with *Rest end notification* switched on: tick a set whose rest is **three minutes**, lock the phone, and wait. One notification, at the end of the rest. Then the same with a rest of **five minutes**. These are the two rests that never rang before; a rest of a minute proves nothing, because it takes one request and no hand-over. While the phone is locked, the log of the function shows one line a minute (section 5), and that is where to look if nothing arrives.

## 4. Rotating `INTERNAL_BEARER`

When: once now, if the value in use is the project's service-role key or anything that was ever pasted somewhere (the first set-up suggested that key as "convenient": it opens the whole database, and `send-push` needs nothing of the sort); then whenever the value may have been seen by someone else; otherwise about once a year.

The value is a random string that nobody has to know. It is made in the shell, sent to the two places that hold it, and forgotten.

Between the second and the third command the two places disagree, and a push the database sends in that moment is refused (its bell row is written all the same). Run them one right after the other, at an hour when nobody trains.

That hour matters for `dispatch-rest-push` too. A function reads the secret when one of its workers starts. A rest that is being waited for while the secret changes can be handed from a worker that still holds the old value to one that holds the new: the hand-over is refused, and that rest does not ring. The next one does.

```bash
export INTERNAL_BEARER="$(openssl rand -hex 32)"
```

```bash
supabase secrets set INTERNAL_BEARER="$INTERNAL_BEARER"
```

```bash
supabase db query --linked "select vault.update_secret(id, '$INTERNAL_BEARER') from vault.secrets where name = 'app_service_role_key'"
```

Then that both places hold the value of this shell. The function's side is the check of section 3: its second line now reads `bearer: 200 {"delivered":0}`. The database's side:

```bash
supabase db query --linked "select decrypted_secret = '$INTERNAL_BEARER' as vault_holds_the_value_of_this_shell from vault.decrypted_secrets where name = 'app_service_role_key'"
```

One row, `true`. `false`: the third command did not run in this shell, run it again. No row: the vault has no secret of that name, and the database was sending no push at all. Create it, then run the line above again, and check that `app_functions_url` exists too (section 2):

```bash
supabase db query --linked "select vault.create_secret('$INTERNAL_BEARER', 'app_service_role_key')"
```

Then let go of it:

```bash
unset INTERNAL_BEARER
```

Two things the earlier instructions got wrong, in case you remember them: the vault is changed with `vault.update_secret`, not with `UPDATE vault.secrets` (the value is stored encrypted, and the table cannot be written directly); and the secret is not the service-role key.

## 5. A push that did not arrive: the function's log

Dashboard → Edge Functions → `send-push` → **Logs**. Without pg_cron this is the only place where a push that failed is written down: the database queues its request and never reads the answer. With pg_cron, a line appears once an hour in the coach's list of errors when requests failed ([50](50-pg-cron.md), "What a line of the database in the coach's list means"), and it sends you here for the reason.

What the function writes for a message that four devices should have got and none did:

```text
send-push: push failed status=403 host=fcm.googleapis.com subscription=1c9d4f0e-6a57-4f0b-9d5e-0e2f4f6c7a11 body="the VAPID credentials in the authorization header do not correspond to the credentials used to create the subscriptions."
send-push: push failed status=none host=web.push.apple.com subscription=8e2b7a34-0c6d-4b1f-a2f9-5d3c1e7b9f20 error="Socket timeout"
send-push: push failed status=410 host=updates.push.services.mozilla.com subscription=4a7f2d91-b3e8-4c65-8f1a-9c0d2e5b6a37 body="{\"code\":410,\"errno\":106,\"message\":\"Request did not validate\"}"
send-push: push not sent host=push.example.org subscription=d3b6a1c8-5e2f-4d79-b0a4-7f1e9c2d8b46 reason="not an address at a push service of the list"
send-push: no device got the push (3 failed, 1 gone)
```

One line per device that did not take the message, then one for the request when nobody took it — the request that is answered `502`. `subscription` is the `id` of the row in `push_subscriptions`; `host` is the push service, and the rest of the device's address is never written. `body` is what the push service answered, cut at 200 characters; `error` stands in its place when it did not answer at all.

| The line says | What it means | What to do |
|---|---|---|
| `status=401` or `status=403` | the push service does not accept the function's signature for that device | on one device: nothing, it has to switch notifications off and on again. On every device at once: the VAPID pair of the functions is not the one the app was built with — section 2, "Do not change the VAPID pair" |
| `status=404` or `status=410` | the device is gone: the app was removed, or the permission taken back. Written as a warning, not as an error | nothing: the row is deleted, and the phone registers again when notifications are switched back on |
| `status=413` | the message is larger than a push service takes | report: it is a notification whose text is too long |
| `status=429`, or a number from 500 on | the push service is busy, or down | nothing, unless it lasts: the message of that moment is lost, the next one is sent as usual |
| `status=none` | there was no answer from the push service: it took longer than the time limit, the network failed, or the message could not be prepared for that device. `error` says which | the same |
| `push not sent host=…` | a row of `push_subscriptions` whose address is not at one of the four push services. Nothing was sent to it | [15](migrations/15-push-plumbing.md), "Devices whose endpoint is not at a known push service" |
| `no device got the push (N failed, M gone)` | the summary of a request that is answered `502` | read the lines above it |
| `rest push <id>: …` | the same, for the end of a rest: `<id>` is the row of `scheduled_pushes`, whose `status` and `error` say what became of it | [16](migrations/16-rest-push-scheduling.md), "The rest pushes that were left waiting" |

A line that says `rest push <id>: not sent — another sender took it, it was taken back, or its time is more than a minute past` is not a failure: the athlete started the next set before the rest was over, or the other function had sent the notification already.

**The end of a rest** is in the log of the other function: Dashboard → Edge Functions → `dispatch-rest-push` → **Logs**. Every request of a rest writes a line when it starts, so a rest of three minutes that rang reads:

```text
dispatch-rest-push: rest push 7b0e6c52-3a41-4d8f-9c1e-2f5a8d4b6e90: hop 1, hands over in 60 s (180 s before its time)
dispatch-rest-push: rest push 7b0e6c52-3a41-4d8f-9c1e-2f5a8d4b6e90: hop 2, hands over in 60 s (120 s before its time)
dispatch-rest-push: rest push 7b0e6c52-3a41-4d8f-9c1e-2f5a8d4b6e90: hop 3, sends in 60 s
dispatch-rest-push: rest push 7b0e6c52-3a41-4d8f-9c1e-2f5a8d4b6e90: sent to 1 device
```

And the same rest, where the function is deployed with JWT verification on:

```text
dispatch-rest-push: rest push 7b0e6c52-3a41-4d8f-9c1e-2f5a8d4b6e90: hop 1, hands over in 60 s (180 s before its time)
dispatch-rest-push: rest push 7b0e6c52-3a41-4d8f-9c1e-2f5a8d4b6e90: hop 2 did not take over, the rest does not ring: HTTP 401 {"code":401,"message":"Missing authorization header"}
```

`<id>` is the row of `scheduled_pushes`. A device that did not take the push is a `push failed` line as above, with `dispatch-rest-push` in front.

| The line says | What it means | What to do |
|---|---|---|
| `hop N, hands over in … s` | one of the requests of a rest: it waits, then calls the function for the next minute | nothing |
| `hop N, sends in … s`, then `sent to N device(s)` | the last request of a rest, and the notification | nothing |
| `no longer waiting after hop N — taken back, or sent by the other sender. Not handed over` | the athlete started the next set, or left the session, before the rest was over | nothing: that rest must not ring |
| `hop N did not take over, the rest does not ring: HTTP 401`, then JSON | the gateway refused the request the function made to itself: `dispatch-rest-push` is deployed with JWT verification **on**. Every rest longer than a minute is lost | deploy again (section 1), then the check of section 3 |
| `… did not take over …: HTTP 401 dispatch-rest-push: unauthorized` | the function refused its own request: the two workers do not hold the same secret. Expected in the minute of a rotation | nothing, unless it goes on: then set the secret again (section 4) |
| `… did not take over …: INTERNAL_BEARER is not set`, or `HTTP 500 dispatch-rest-push: not configured` | the function has no secret to show itself | `supabase secrets list` must show the name; section 4 sets it |
| `… did not take over …:` anything else — `HTTP 503`, a time limit, `fetch failed` | the platform did not start the next request within ten seconds | nothing, unless it goes on: that rest is lost, and there is no second try. pg_cron does not depend on it ([50](50-pg-cron.md)) |
| `claim_rest_push could not be asked, nothing is sent` | the database has no such function: migration 16 is not applied | [16](migrations/16-rest-push-scheduling.md), then nothing: the next rest rings |
| `refused, …` | a request that was not let in, or not understood: no token, a token the auth server does not accept, a row of somebody else | nothing. Many of them from one address is somebody trying |

## Undo

A function has no rollback file: going back is deploying the old code. The code in production before this page is `supabase/functions/send-push/index.ts` (v4) and `supabase/functions/dispatch-rest-push/index.ts` (v2) as commit `a61f0c31f2` has them. That commit is already on GitHub's `main`, so the commands find it whatever happens to the branch this page came with. One function at a time, and only the one that has to go back.

**`send-push`:**

```bash
git restore --source=a61f0c31f2 --worktree -- supabase/functions/send-push/index.ts
```

```bash
supabase functions deploy send-push --use-api
```

```bash
git restore -- supabase/functions/send-push/index.ts
```

The first command changes one file of the working tree, the last puts it back. In between, the check of section 3 prints `no bearer: 401 Unauthorized`. The flag still comes from `supabase/config.toml`, which is right for the old code too. The secret is not part of a deploy: undoing a rotation is rotating again.

**`dispatch-rest-push`:**

```bash
git restore --source=a61f0c31f2 --worktree -- supabase/functions/dispatch-rest-push/index.ts
```

```bash
supabase functions deploy dispatch-rest-push --use-api
```

```bash
git restore -- supabase/functions/dispatch-rest-push/index.ts
```

In between, its check of section 3 prints `no credentials: 401 Unauthorized`. The flag comes from `supabase/config.toml` here too, and says the gateway does not check: the old code asks the auth server about the athlete's token itself, so nothing is open. What is lost is what this page is for: a rest of two and a half minutes or more no longer rings.

When to, for either function: it does not start after a deploy, or its check prints something this page does not explain. Not for a failed rotation — the code is not the problem there. And not because a long rest did not ring once: read the log first (section 5), the line says which request was lost and why.

**Not while the job `sl-rest-push` is switched on.** That holds for both functions. The `send-push` this goes back to does not know a rest push that is handed over early: it sends it at once, to every device of the athlete, ten seconds before the rest is over, and the function the app calls rings them again at the time — every rest, twice. The `dispatch-rest-push` this goes back to does not ask the database before it sends: next to the job, the two send. Switch the job off first ([50](50-pg-cron.md), "Pausing a job, and starting it again"), then go back. Without pg_cron there is no such job and nothing to switch off. What else is lost by going back to the old `send-push`: the lines of section 5, the `502`, and the one-day limit on a message that waits for a phone.
