# edge-dispatch-rest-push-v3 — docs to fold (wave 2, items none)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — Web Push (rest-timer "Rest done" lock-screen notification)

Replace, in the bullet that starts "**Two Edge Functions handle delivery, split by call shape.**", the sentence "[dispatch-rest-push](../supabase/functions/dispatch-rest-push/index.ts) is **user-invoked** — the client posts `{ scheduleId }` with its own JWT, the function auths the caller, loads the `scheduled_pushes` row with the service role, sleeps until `fire_at`, re-reads to honor a late `canceled_at`, then fans out." with:

[dispatch-rest-push](../supabase/functions/dispatch-rest-push/index.ts) is **called by the app, and by itself** — the client posts `{ scheduleId }` with its own JWT; the function checks the token with the auth server, loads the `scheduled_pushes` row with the service role and asks whose it is, answers `202`, and under `EdgeRuntime.waitUntil` waits a minute at most. A longer rest is handed to a new request to its own address, which shows the `INTERNAL_BEARER` secret and no user token; the last request asks `claim_rest_push` and sends what the claim answered.

## docs/INVARIANTS.md — Web Push (rest-timer "Rest done" lock-screen notification)

Replace, in the bullet that starts "**`supabase/config.toml` says, for every Edge Function, whether the gateway asks for a user JWT.**", the sentence "`verify_jwt = false` for send-push (its caller is the database, which has no user JWT), `true` for dispatch-rest-push." with:

`verify_jwt = false` for both: each is also called by the project itself, which has no user JWT to show — send-push by the database, dispatch-rest-push by its own hops. With `true` in front of dispatch-rest-push the app's request still gets through, and every request the function makes to itself is refused by the gateway: a rest of a minute or less rings and no longer one does, with nothing to show for it but a line in the function's log.

## docs/INVARIANTS.md — Web Push (rest-timer "Rest done" lock-screen notification)

Replace the bold lead of the bullet that starts "**A function the gateway does not guard opens with `admitInternalRequest`, and nothing runs for a caller it refuses.**" with:

**A function the gateway does not guard judges its caller before anything else, and nothing runs for a caller it refuses. One that only the project calls opens with `admitInternalRequest`.**

## docs/INVARIANTS.md — Web Push (rest-timer "Rest done" lock-screen notification)

Add after the bullet that starts "**A function the gateway does not guard**":

- **`dispatch-rest-push` has two ways in, and the header decides which one is judged.** `authenticate` in `supabase/functions/_shared/restPush.js` runs before a byte of the body is read and before a client is made. A request that carries `x-internal-bearer` is a hop: the value is compared with `INTERNAL_BEARER` by `checkSecret` (constant time), a wrong or empty one is a 401 whatever else the request shows, and an unset secret is a 500 for a hop only — the app is still served. Any other request is the app's: `Authorization: Bearer <token>`, refused without a call when it is not shaped like a JWT, otherwise handed to the auth server through `auth.getUser(token)` with the anon key; a 4xx is a 401, no answer is a 503. The service-role client is made only for a caller that was let in, and the function then asks `row.user_id === caller.userId` itself — the client that reads the row holds every row. A hop has no user: its first request was asked. Never accept the secret in `Authorization` or a token in `x-internal-bearer`, and never fall back from one to the other.
- **`dispatch-rest-push` answers a browser, and its CORS headers do not allow `x-internal-bearer`.** The app calls it from its page, so `OPTIONS` is answered and every answer carries `CORS_HEADERS` — unlike send-push, which gives a browser nothing. `Access-Control-Allow-Headers` is `authorization, x-client-info, apikey, content-type`: adding the internal header would let any page try the secret from a visitor's browser.
- **`401 dispatch-rest-push: unauthorized` is read by the runbook's check.** A refusal is plain text that starts with the function's name. `docs/runbook/30-edge-functions.md` (section 3) sends one request that shows nothing and tells that line from the gateway's JSON, which means the function is deployed with JWT verification on; `supabase/functions/runbook.test.js` runs the command off the page against `dispatch-rest-push/index.ts`. Do not reword it without the page.

## docs/INVARIANTS.md — Web Push (rest-timer "Rest done" lock-screen notification)

Add after the bullet that starts "**A request to `send-push` that names a row is a rest push**":

- **A rest is waited for a minute at a time (`HOP_MS`), not for the 150 seconds a function may run.** The 150 seconds of the free plan are a worker's, not a request's: a worker of Supabase's runtime takes every request that arrives during the first half of its life and retires at 75 seconds, so a request can land on a worker that is 75 seconds old and is promised the other 75. A hop is a wait of 60 seconds at most, then the claim and the push (`SEND_DEADLINE_MS`, 8 s, plus `TOP_UP_MAX_MS`) or the hand-over (`HANDOVER_DEADLINE_MS`, 10 s). `planHop(remainingMs)` in `supabase/functions/_shared/restPush.js` is the whole plan: a rest takes the fewest requests that fit (`ceil(remaining / HOP_MS)`: three for 180 s, five for 300 s, fifteen for 900 s), no wait is longer than a minute, and a hop that hands over leaves the next one `LAST_HOP_MIN_MS` (30 s) so that a worker that has to start never takes its start from the time of the push. Calls from a function to a function of its project are counted by the platform — 30 in 60 seconds for one chain, then the call throws: a rest makes two in a minute at most. Raising `HOP_MS` above what half a worker's life leaves loses rests whenever two requests reach one worker — two athletes, or one athlete who re-ticks a set — and no test of the repository can see it.
- **A hop is a request the function makes to its own address, with the secret and nothing of the athlete.** `handOver` posts `{ scheduleId, hop }` to `functionUrl(SUPABASE_URL, name)` with `content-type` and `x-internal-bearer`, `redirect: 'manual'` and a time limit. It never forwards the user's token — which can run out in the middle of a rest, and which the next hop does not need. One attempt: there is no retry and no sweeper, a hand-over that fails is a rest that does not ring and one `error` line of the log (`hop N did not take over, the rest does not ring: <why>`). Each hop reads the row again when it starts and computes its wait from `fire_at`, so the seconds a hand-over takes are not added to the rest; before it hands over it reads the row once more and stops the chain when the rest is no longer waiting (`status` other than `pending`, or `canceled_at` set — the app from before wave 3 cancels by writing `canceled_at` alone). A stopped chain writes nothing on the row. `MAX_HOPS` ends a chain that would not end; the number of a hop is believed from a hop only.
- **`dispatch-rest-push` sends through `sendRestPush`, at the time of the push by its own clock.** Its last hop waits what is left, looks at the clock once more — a timer counts its own seconds; `claim_rest_push` does not refuse a row that is early — and then asks the claim. It never sends a row it has merely read and never writes `sending`, `canceled` or `expired` itself: those are the claim's. A row more than `MAX_AHEAD_MS` ahead (the 900 s of `schedule_rest_push` plus half a minute for two clocks that disagree) is refused with a 422 and left as it is.
- **`dispatch-rest-push` of wave 2 needs migration 16, and is deployed before the job `sl-rest-push` exists.** Without `claim_rest_push` it sends nothing (`claim_rest_push could not be asked, nothing is sent`). The version before it (v2) sends without asking: next to the job, both send. `docs/runbook/30-edge-functions.md` ("When", "Undo") has the order; the function reads only columns `scheduled_pushes` has had since it was made, so the read itself works on either side of the migration.
- **The lines of the log of `dispatch-rest-push` are quoted by the runbook.** `docs/runbook/30-edge-functions.md` (section 5) shows what a rest of three minutes writes, request by request, and what it writes where the gateway refuses a hop; `supabase/functions/runbook.test.js` runs that rest through `dispatch-rest-push/index.ts` and compares to the character. Reword a line on the page and in `restPush.js` together.

## docs/ARCHITECTURE.md — Rest push: scheduled by the database, sent once

Add after the paragraph that starts "**The two modes.**" (the section is folded from `sql-11-rest-push-scheduling`):

**How the Edge Function waits.** `dispatch-rest-push` cannot hold a request until the end of a rest: a worker of the platform lives 150 seconds on the free plan, and takes new requests only during the first 75. So it answers `202` at once and works on under `EdgeRuntime.waitUntil`, a minute at a time (`supabase/functions/_shared/restPush.js`):

```
app ── POST { scheduleId }, the athlete's JWT ──▶ hop 1   auth server: whose token? · the row: theirs, still pending?
                                                   │       202 · wait ≤ 60 s · the row again: still pending?
          POST { scheduleId, hop: 2 }, x-internal-bearer
                                                   ▼
                                                 hop 2    the secret, in constant time · the row · 202 · wait ≤ 60 s
                                                   ⋮
                                                 hop n    wait what is left · claim_rest_push · push · sent | failed
```

A rest of 180 s is three requests, one of 900 s fifteen. A hop that finds the rest taken back, or sent by the other sender, ends the chain. A hand-over that fails is not tried again: the rest does not ring, and the log of the function says why. That is the difference with the job of pg_cron, which needs one step for a rest of any length.

## docs/ARCHITECTURE.md — What runs on a timer: pg_cron, where it is switched on

Replace, in the row `sl-rest-push` of the table (the section is folded from `sql-13b-pg-cron-jobs`), "the app calling `dispatch-rest-push`, which waits in hops of two minutes" with:

the app calling `dispatch-rest-push`, which waits in hops of a minute

## docs/ENVIRONMENT.md — Edge Function secrets (production)

Replace the row "| `INTERNAL_BEARER` | `send-push` |" with:

| `INTERNAL_BEARER` | `send-push`, `dispatch-rest-push` | the secret the database presents to `send-push`, and the one `dispatch-rest-push` shows itself from one minute of a rest to the next (header `x-internal-bearer`); a random string (`openssl rand -hex 32`), not the service-role key |

## README.md — Rest Timer (in-app + Web Push)

Replace "The function sleeps until `fire_at`, re-checks `canceled_at`, and sends a VAPID-signed Web Push to every `push_subscriptions` row for that user." with:

The function answers at once and waits for `fire_at` after its answer, a minute at a time — a function of the platform cannot wait longer in one go, so a longer rest is handed from one request of the function to the next ([`_shared/restPush.js`](supabase/functions/_shared/restPush.js)). At the time of the push it asks the database whether the push is still its to send (`claim_rest_push`: never a rest that was taken back, never one that was sent already) and sends a VAPID-signed Web Push to the devices of that user.

## README.md — Rest Timer (in-app + Web Push)

Replace "Delays > 350s are refused (Supabase Edge Function wall-time limit is 400s); typical rest periods (30–300s) are well within." with:

The function waits for a rest of up to 15 minutes; the app asks for no push beyond 350 s (`useRestTimerPush`).

## README.md — Rest Timer (in-app + Web Push)

Replace "The app and the Edge Function described above do not use them yet." (folded from `sql-11-rest-push-scheduling`) with:

The Edge Function asks `claim_rest_push` before it sends; the app does not call `schedule_rest_push` and `cancel_rest_push` yet.

## README.md — Testing Conventions

Add after the sentence that starts "`supabase/functions/_shared/push.test.js` holds what `send-push` answers" (folded from `edge-send-push-v5`):

`supabase/functions/_shared/restPush.test.js` does the same for `dispatch-rest-push`: who is let in, how a rest is cut into hops, and whole chains — the request a hop makes to the function is answered by the function, on a clock of the test — down to the one claim and the one push per device. `supabase/functions/dispatch-rest-push/index.test.js` holds the adapter, and `runbook.test.js` runs the page's second check and writes the page's log lines through it.

## CLAUDE.md — Repo map

Replace, in the `supabase/` block, the three lines that start "adapter)  functions/_shared/ (what a function decides: auth.js" (as `edge-send-push-v5` leaves them) with:

```
                 adapter)  functions/_shared/ (what a function decides: auth.js
                 the gate, push.js the fan-out and the rest push, pushHosts.js
                 the push services, restPush.js the hops of dispatch-rest-push;
                 runtime-neutral, under vitest)  functions/_test/harness.js
```

## CLAUDE.md — Feature → files map, row "Rest timer (in-app cues + Web Push)"

Replace "`supabase/functions/dispatch-rest-push/`" in the row's file list (also as `sql-11-rest-push-scheduling` leaves it) with:

`supabase/functions/dispatch-rest-push/` (`index.ts` adapter + `index.test.js`; `verify_jwt = false`), `supabase/functions/_shared/restPush.js` (`dispatchRestPush` — the whole function: `authenticate`, the athlete's JWT through the auth server or `x-internal-bearer` for a hop; 202, then under `waitUntil` a wait of a minute at most and a request to its own address for the next one; the last hop sends through `sendRestPush` of `_shared/push.js`, which asks `claim_rest_push`; `planHop`, `HOP_MS`, `MAX_AHEAD_MS`) + `restPush.test.js`, `docs/runbook/30-edge-functions.md` (its check after a deploy, the lines of its log)

## CLAUDE.md — Feature → files map, row "Edge Function deploy, secrets, bearer rotation (by hand, by the owner)"

Replace "`supabase/functions/runbook.test.js` (page ↔ config; the page's check run against `send-push/index.ts` behind a port)" with:

`supabase/functions/runbook.test.js` (page ↔ config; the page's two checks run against `send-push/index.ts` and `dispatch-rest-push/index.ts` behind a port; the lines of both logs written through the functions; the way back of each function)

## CLAUDE.md — When you add a feature

Replace, in step 3, in the bullet that starts "A new Edge Function is a directory under `supabase/functions/`", the sentence "With `verify_jwt = false` the function opens with `admitInternalRequest`." with:

With `verify_jwt = false` the function judges its caller before anything else: with `admitInternalRequest` when only the project calls it, or — when the app calls it too — with a check of its own built from `checkSecret` and `bearerToken` of `_shared/auth.js`, as `authenticate` of `_shared/restPush.js` is; the adapter compares nothing itself (`supabase/functions/deploy.test.js`). No function runs with `verify_jwt = true` once it is also called by the database or by a function: such a caller has no user JWT. A function may run for 150 seconds, but a request is only sure of 75: anything longer is cut into requests, as `planHop` does.

## docs/RUNBOOK.md — new section "Checkpoint B — …", after the section of Checkpoint A3

Add when Checkpoint B is handed over (its row marked **ready**), right after the part that belongs to `send-push` (snippet `edge-send-push-v5`) and before the optional part of pg_cron. The part of the sequence that belongs to `dispatch-rest-push`, every command taken from `docs/runbook/30-edge-functions.md` as it stands there, one per fence:

1. **Only after migration 16 is in the ledger**: the function asks `claim_rest_push`. Deployed before, it sends nothing.
2. `supabase functions deploy dispatch-rest-push --use-api` (section 1). Deploying a function is asked each time ([Who runs a checkpoint](#who-runs-a-checkpoint)).
3. The second check of section 3. It must print `no credentials: 401 dispatch-rest-push: unauthorized`. JSON after the `401` means the gateway still checks JWTs in front of the function: a rest of a minute rings and no longer one does. Deploy again; if the line does not change, stop and report.
4. On the phone of the test athlete, with *Rest end notification* on and the phone locked: a rest of **three minutes**, then one of **five**. One notification each, at the end of the rest. These two are the proof — a rest of a minute takes one request and proves nothing — and nothing in the repository can stand in for them: they are the only test of the function calling itself at its real address.
5. To report: the line of the check, whether the two rests rang, and the lines of the function's log for one of them (section 5 of the page: `hop 1, hands over in 60 s …` down to `sent to 1 device`, or the line that says which hop did not take over).

Say with the order: **migration 16, then `send-push`, then `dispatch-rest-push`, then — only if pg_cron is chosen — the extension and migration 19.** Never migration 19 while the `dispatch-rest-push` from before wave 2 is deployed: it sends without asking the database, next to the job.

## docs/RUNBOOK.md — new section "Checkpoint B — …", after the section of Checkpoint A3

Replace, in the text folded from `sql-11-rest-push-scheduling`, "Without pg_cron nothing is lost: the app calls `dispatch-rest-push`, which waits in hops of two minutes." with:

Without pg_cron nothing is lost: the app calls `dispatch-rest-push`, which waits in hops of a minute.

## docs/runbook/migrations/16-rest-push-scheduling.md — Who sends a rest push, and in which order things are switched on

Replace, in the second row of the table, "`dispatch-rest-push`, in hops of two minutes" with:

`dispatch-rest-push`, in hops of a minute

## docs/runbook/50-pg-cron.md — the table "Without pg_cron / With pg_cron"

Replace, in the row "**The notification at the end of a rest**", "A function may run for 150 seconds at most, so for a longer rest it hands over to a copy of itself, every two minutes." with:

A function may run for 150 seconds at most, and a request is only sure of half of that, so for a longer rest it hands over to a copy of itself, every minute: three requests for a rest of three minutes, fifteen for one of fifteen.
