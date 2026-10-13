# edge-send-push-v5 — docs to fold (wave 2, items P35)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — Web Push (rest-timer "Rest done" lock-screen notification)

Add after the bullet that starts "**A function the gateway does not guard opens with `admitInternalRequest`, and nothing runs for a caller it refuses.**":

- **A push that was not taken is a line of the log, and a request nobody took is a 502.** `sendToDevices` in `supabase/functions/_shared/push.js` is the one place that calls `webpush.sendNotification`: for every device that did not take the message it writes `<function>: push failed status=<code|none> host=<host> subscription=<row id> body="…"` (`error="…"` when the push service did not answer), and `send-push` answers `502 {"delivered":0,"failed":N}` when the user had devices and none took it for another reason than being gone. `200 {"delivered":N}` otherwise — also `200 {"delivered":0}` for a user without a device and for one whose every device answered 404 or 410: those rows are deleted, the line is a warning, and no device is not an error. Nobody reads the answer at the time, so the log line is the trace: do not catch a send without writing it, and do not answer 200 for "nobody got it". **The line names the host and never the rest of the endpoint**, which is the device's own address; `pushHost()` gives the host, and an answer that echoes the address or a key has it removed. `docs/runbook/30-edge-functions.md` (section 5) quotes the lines, and `supabase/functions/runbook.test.js` reproduces each one through `send-push/index.ts`: reword a line on the page and in the code together.
- **Every send carries its options: how long the message is kept, how urgent it is, and a time limit.** `sendOptions(body, fallback)` reads `ttl` (seconds) and `urgency` (`very-low`, `low`, `normal`, `high`) from the request — `send_push_event` puts them at the top level of the body — and falls back to one day and `normal` for an event, one minute and `high` for a rest push. A value the push services would not take is replaced by the fallback with a warning: the web-push library refuses to send at all when handed one, and a notification is worth more than an option. Without options the library keeps a message four weeks. Each send has the library's 5 second limit (`SEND_TIMEOUT_MS`) and is over after 8 (`SEND_DEADLINE_MS`) whatever the library does: pg_net waits 10 seconds for the function.
- **The functions send to an address of the list and nowhere else.** `sendToDevices` asks `isPushEndpoint` (`supabase/functions/_shared/pushHosts.js`) before each send. An endpoint that is not at one of the four push services is not called: it is logged (`push not sent host=…`), counted as a failed device, and its row is kept — only a push service's 404 or 410 deletes a row. The function does not rely on the check constraint of `push_subscriptions`: rows that predate it are still read. `supabase/functions/_shared/pushHosts.test.js` holds `PUSH_ENDPOINT_PATTERN` to the constraint in `supabase/schema.sql`, character for character, and both to `supabase/tests/fixtures/push-endpoints.json`.
- **A request to `send-push` that names a row is a rest push: answered 202, sent after the claim, with what the claim answered.** `schedule_id` in the body — whatever its value — takes the request out of the fan-out: it is never sent at once to every device. The function refuses a `schedule_id` that is not a uuid and a `not_before` that is not a time or is more than 120 seconds ahead (`MAX_WAIT_MS`: a function may run for 150 seconds), answers `202 {"accepted":true}`, and under `EdgeRuntime.waitUntil` waits until `not_before` and calls `sendRestPush`: `claim_rest_push(schedule_id)`, then the devices of the CLAIM's `user_id` (filtered by the claim's `endpoint` when it names one), the claim's `payload`, and `sent` or `failed` written on the row — `no_subscriptions`, `all_subscriptions_failed`, or `sender_failed` when something broke after the claim, because a claimed row that nobody closes reads `sending` for ever. A claim that answers nothing, or that cannot be asked, sends nothing and writes nothing. The `user_id`, `payload` and `endpoint` of the request are not used for a rest push. `sendRestPush` is what any sender of a rest push calls at the time of the push; it never rejects.
- **The adapter reads `EdgeRuntime` when a request comes in, from `globalThis`.** Deno does not know the name: a bare `EdgeRuntime` fails `deno check`, and one read at module load is `undefined` under vitest. Without a runtime to hand the work to, `answerPush` does the work before it answers — late for the caller, and sent.
- **`send-push` of wave 2 is deployed before the job `sl-rest-push` exists, and is not replaced by an older version while the job runs.** A `send-push` that does not know `schedule_id` sends what the job hands it at once, to every device, ten seconds early. The two versions have the same gate and cannot be told apart without the secret: the third line of the check in `docs/runbook/30-edge-functions.md` (section 3), sent only when the shell holds `INTERNAL_BEARER`, is a rest push whose id is not an id — this version answers `400 send-push: schedule_id is not a uuid`, the one before answers `200 {"delivered":0}`. Do not reword that refusal without the page.

## docs/INVARIANTS.md — Web Push (rest-timer "Rest done" lock-screen notification)

Add after the bullet that starts "**What an Edge Function decides lives in `supabase/functions/_shared/*.js`; `index.ts` is an adapter.**":

- **A shared module hands out its names in one `export { … };` list at its end, and never puts a quoted text after `import` or `export` on a line.** The expression with which `supabase functions deploy --use-api` finds the files to upload takes any quoted text that follows one of the two words on the same line for a file: `export const REASON = 'no_subscriptions'`, a default argument that is a string on an exported function, a comment that quotes an import. `supabase/functions/deploy.test.js` fails with "the CLI would take '…' for an import"; `supabase/functions/_shared/push.js` and `pushHosts.js` show the form that passes — constants on `const` lines, one list at the end.

## CLAUDE.md — Repo map

Replace, in the `supabase/` block, the lines "adapter)  functions/_shared/ (what a function decides: auth.js," and "runtime-neutral, under vitest)  functions/_test/harness.js" with:

```
                 adapter)  functions/_shared/ (what a function decides: auth.js
                 the gate, push.js the fan-out and the rest push, pushHosts.js
                 the push services; runtime-neutral, under vitest)  functions/_test/harness.js
```

## CLAUDE.md — Feature → files map, row "Event push fan-out (send-push Edge Function via pg_net)"

Replace "`supabase/functions/send-push/` (`index.ts` adapter + `index.test.js`), `supabase/functions/_shared/auth.js` (`admitInternalRequest` — the gate: POST only, `INTERNAL_BEARER` via `timingSafeEqual`, 8 kB body, no CORS)." with:

`supabase/functions/send-push/` (`index.ts` adapter + `index.test.js`), `supabase/functions/_shared/auth.js` (`admitInternalRequest` — the gate: POST only, `INTERNAL_BEARER` via `timingSafeEqual`, 8 kB body, no CORS), `supabase/functions/_shared/push.js` (`answerPush` — what the function does behind the gate: an event to every device of the user, `200 {"delivered":N}` or `502` when there were devices and none took it; a request with `schedule_id` answered 202 and sent at `not_before` through `sendRestPush` — the claim, the push, the row; `sendToDevices` — the one caller of web-push, with `ttl` / `urgency` / a time limit, a log line per device that did not take it, the row deleted on 404/410; `sendOptions`), `supabase/functions/_shared/pushHosts.js` (`isPushEndpoint`, `pushHost` — the four push services, the same expression as the check constraint of `push_subscriptions`), tests `supabase/functions/_shared/push.test.js` + `pushHosts.test.js`, and `docs/runbook/30-edge-functions.md` section 5 for the lines of the log.

## CLAUDE.md — When you add a feature

Add to step 3, after the bullet that starts "A new Edge Function is a directory under `supabase/functions/`":

   - A function that sends a Web Push does not call `webpush.sendNotification` itself: it hands the devices it read — by user id — to `sendToDevices` of `supabase/functions/_shared/push.js`, and a rest push goes through `sendRestPush`, which asks `claim_rest_push` first. A line of the log that `docs/runbook/30-edge-functions.md` quotes is changed on the page and in the code together (`supabase/functions/runbook.test.js` writes the page's lines through `send-push/index.ts`). `fakeAdmin(tables, { rpc })` of `supabase/functions/_test/harness.js` answers `admin.rpc(name, args)` and applies updates and deletes to the arrays it was given. `deno check supabase/functions/*/index.ts` (with `DENO_NO_PACKAGE_JSON=1`) holds the JSDoc types of a shared module against the adapter that calls it — Deno is not installed here; CI runs it.

## README.md — Rest Timer (in-app + Web Push)

Add after the paragraph that starts "A second Edge Function, [`send-push`](supabase/functions/send-push/index.ts), is the fan-out":

What it does behind the gate is in [`_shared/push.js`](supabase/functions/_shared/push.js). An event goes to every device of its user, kept one day for a phone that is offline; the answer is `200 {"delivered":N}`, or `502` when the user has devices and none took the message — and every device that did not take it is a line of the function's log, with the push service's status and host. It sends only to the four push services ([`_shared/pushHosts.js`](supabase/functions/_shared/pushHosts.js)). Where pg_cron is switched on, the database also hands it the rest pushes that are due: those are answered `202`, sent at their time after `claim_rest_push` has said the row is still to be sent, and recorded on the row.

## README.md — Testing Conventions

Replace "and `supabase/functions/runbook.test.js` runs the runbook's check after a deploy against `send-push` behind a real port." with:

and `supabase/functions/runbook.test.js` runs the runbook's check after a deploy against `send-push` behind a real port and writes the log lines the page quotes through the function itself. `supabase/functions/_shared/push.test.js` holds what `send-push` answers, logs and records with nothing real behind it — the web-push library, the service-role client (`fakeAdmin`, which also answers `rpc`) and the clock are handed in.

## docs/RUNBOOK.md — Optional — `send-push` with its new gate

Replace the paragraph that starts "Page: [runbook/30-edge-functions.md](runbook/30-edge-functions.md). Not a migration, and nothing waits for it:" with:

Page: [runbook/30-edge-functions.md](runbook/30-edge-functions.md). Not a migration. Since wave 2 the function this command deploys is no longer the gate alone: it also writes every push that failed in its log, answers 502 when nobody got a message, sends to the four push services only, and can send a rest push at its time (findings L25 and P35). It belongs to Checkpoint B, **after migrations 15 and 16 and before migration 19** — the audit of migration 15 is what shows that no device is registered at an address this version would refuse, and the job of migration 19 must never run against an older `send-push`. The database in production calls the new version exactly as it calls the old one. Deploying a function is asked each time ([Who runs a checkpoint](#who-runs-a-checkpoint)).

## docs/RUNBOOK.md — new section "Checkpoint B — …", after the section of Checkpoint A3

Add when Checkpoint B is handed over (its row marked **ready**), after the parts that belong to migrations 15 and 16 and before the optional part of pg_cron. The part of the sequence that belongs to `send-push`, every command taken from `docs/runbook/30-edge-functions.md` as it stands there, one per fence:

1. `supabase functions deploy send-push --use-api` (section 1).
2. The check of section 3. Its first line must read `no bearer: 401 send-push: unauthorized`.
3. **Before migration 19, if pg_cron is chosen**: the same check with the secret in the shell — the end of a rotation, section 4 — must print a third line, `rest push: 400 send-push: schedule_id is not a uuid`. `rest push: 200 {"delivered":0}` is the `send-push` from before wave 2: deploy again, and do not apply migration 19.
4. To report: the lines the check printed, and — from the day after — whether the log of the function (section 5 of the page) shows a line that starts `send-push: push failed` with a status other than 404 or 410.
