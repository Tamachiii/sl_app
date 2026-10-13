# sql-10-push-plumbing — docs to fold (wave 2, items B3, P35, L25)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — Web Push (rest-timer "Rest done" lock-screen notification)

Replace the bullet that starts "**Supabase Vault feeds the triggers; the function checks `INTERNAL_BEARER`.**" with:

- **One function hands a push to `send-push`, and every notification asks it.** `public.send_push_event(p_user, p_payload, p_options)` (migration `2026_10_13_15_push_plumbing.sql`) is the only function of `public` that reads the vault or calls `net.http_post`: the address is `app_functions_url` followed by `/send-push`, the bearer is `app_internal_bearer` — and `app_service_role_key` while the vault has nothing under that name —, the time limit is 10 seconds, and the body is `{ user_id, payload, ttl: 86400 }` plus the keys of `p_options` at the top level. It answers the id pg_net gave the request, or NULL when the vault lacks the address or the bearer: nothing is queued then and nothing is raised, so the feature degrades cleanly where push is not set up. The six notification triggers and the five coach RPCs call it inside a block of their own, after their bell row: `BEGIN PERFORM public.send_push_event(…); EXCEPTION WHEN OTHERS THEN RAISE WARNING '… failed: %', SQLERRM; END;` — a push that cannot be queued never fails the write that caused it. **A new function that notifies does the same and joins `LATER_SENDERS` in `supabase/tests/push-plumbing.test.js`**, which reads the text of every function of `public`: a second one that reads the vault or calls pg_net, or a call outside such a block, fails it.
- **`send_push_event` is for the owner and the service role, and has no right of its own.** It is `SECURITY INVOKER` and not in the allow-list: whoever may call it sends any text and any link to any account. Its callers are `SECURITY DEFINER`, so it runs as their owner, who reads the vault. Called from a function that runs with a signed-in user's rights it is refused, and the caller's `EXCEPTION` block turns the refusal into a warning — no push, and no error on the screen. Do not grant it to `authenticated`, and do not make it `SECURITY DEFINER`.
- **Nobody reads what `send-push` answers.** pg_net sends the request after `COMMIT`, once, and the database never looks at the response: a warning in the log means the request could not be queued, not that a push failed to arrive. The bell row is the record. The 10 seconds are for the function's answer; pg_net's own default is 2 or 5 seconds depending on its version, which a cold start does not fit in.
- **The secret `send-push` checks is `INTERNAL_BEARER`, and the vault holds the same value.** It is a random string made for this purpose — never the service-role key, whatever the older vault name `app_service_role_key` suggests — because whoever has it can push any text and any link to any user. Supabase's auto-injected `SUPABASE_SERVICE_ROLE_KEY` is not reused for the check either: newer projects get an `sb_secret_*` key whose full value cannot be read back, so the two ends would drift. `ALTER DATABASE postgres SET app.*` is denied on Supabase's managed Postgres — don't reach for GUCs. The vault's copy is changed with `vault.update_secret(id, '<new>')`, never with `UPDATE vault.secrets`. Rotation is the owner's, by hand (`docs/runbook/30-edge-functions.md`, section 4, whose statements `supabase/tests/push-secrets.test.js` reads off the page and runs); renaming the secret to `app_internal_bearer` is optional and is on `docs/runbook/migrations/15-push-plumbing.md`. With both names in the vault, `app_internal_bearer` is the one that is sent.

## docs/INVARIANTS.md — Web Push (rest-timer "Rest done" lock-screen notification)

Add after the bullet that starts "**Live Activities / Dynamic Island are native-iOS-only.**":

- **An endpoint is an address at a known push service, and the list is one list in four places.** `push_subscriptions.endpoint` carries the check `push_subscriptions_endpoint_known_push_service`: `https://`, then `fcm.googleapis.com`, `updates.push.services.mozilla.com`, a host under `push.apple.com` or one under `notify.windows.com`, then a path — lower case, no port, no user name. Without it a row is a way to make the Edge Functions POST to any URL (review B3). A refused write is `23514` and names the constraint, for every writer — the app's own upsert, `claim_push_subscription`, the service role. The same hosts are in `supabase/functions/_shared/pushHosts.js`, which the functions ask before they send, in the migration that last wrote the constraint, and in `supabase/tests/fixtures/push-endpoints.json`, which holds both sides to the same examples: a push service is added in all four, in one commit. A browser whose push service is not listed cannot switch notifications on.

## docs/INVARIANTS.md — Web Push (rest-timer "Rest done" lock-screen notification)

Replace, in the bullet that starts "**Two Edge Functions handle delivery, split by call shape.**", the sentence "It takes `{ user_id, payload }` and immediately fans out." with:

It takes `{ user_id, payload }` — plus `ttl` and whatever options `send_push_event` was given, at the top level of the body — and fans out.

## docs/INVARIANTS.md — Messaging / notifications

Replace the bullet that starts "**Feedback notifications also fan out a Web Push.**" with:

- **Feedback notifications also fan out a Web Push.** Inside `notify_student_on_session_feedback`, after the in-app `notifications` INSERT, the trigger asks `send_push_event` for a push to the athlete; the [`send-push`](../supabase/functions/send-push/index.ts) Edge Function fans the payload out to every `push_subscriptions` row of the recipient — the web-push + VAPID stack of the rest timer. The call stands in an `EXCEPTION` block: when the request cannot be queued the trigger logs `send-push fan-out failed: …` and goes on, and when the vault is not configured nothing is queued and nothing is logged — the in-app bell path is never blocked. Whether the push arrived is not known to the database. Push delivery is one-shot (no `scheduled_pushes` row) because the event fires immediately; the unique partial index on `messages.session_id` already keeps it idempotent. The payload's `data.url` deep-links to `/sl_app/#/student/session/<id>` so `notificationclick` lands on the structured feedback card in `SessionView`.

## docs/INVARIANTS.md — Messaging / notifications

Replace, in the bullet that starts "**Ordinary chat messages fan out a Web Push too — but never a bell row**", the sentence "Same Vault secrets + best-effort EXCEPTION wrapper as the feedback push; degrades to nothing when unset." with:

Same `send_push_event` call inside a best-effort `EXCEPTION` block as the feedback push; nothing is queued while the vault is not configured.

## docs/ENVIRONMENT.md — Edge Function secrets (production)

Replace the table under "The database's vault (read by the notification triggers):" and the sentence after it ("`INTERNAL_BEARER` and `app_service_role_key` are rotated together …") with:

| Name | What it is |
|---|---|
| `app_functions_url` | `https://<project ref>.supabase.co/functions/v1` |
| `app_service_role_key` | the same value as `INTERNAL_BEARER` (the name is historical: it is not the service-role key) |
| `app_internal_bearer` | the same secret under its own name, once the owner has renamed it — optional, `docs/runbook/migrations/15-push-plumbing.md` |

Since migration 15 one function reads them, `public.send_push_event`: the bearer under `app_internal_bearer`, and under `app_service_role_key` while the vault has nothing of that name. The vault holds one of the two names, not both; with both, `app_internal_bearer` is the one that is sent. `INTERNAL_BEARER` and the vault's copy are rotated together (runbook page, section 4). The VAPID pair is not rotated: every device's subscription is tied to the public key.

## CLAUDE.md — Feature → files map, row "Event push fan-out (send-push Edge Function via pg_net)"

Replace the sentence "Triggers that call it, all Vault-gated + EXCEPTION-wrapped: `notify_student_on_session_feedback` (`2026_05_12_feedback_push.sql`), `notify_coach_on_session_confirm` (`2026_07_17_session_confirm_push.sql`), `notify_coach_on_slot_deviation` (in `2026_06_28_slot_deviations.sql`)." with:

The database's side is one function, `public.send_push_event(p_user, p_payload, p_options)` (migration `2026_10_13_15_push_plumbing.sql`: the vault, pg_net, a 10 s time limit; owner and service role only), which the six notification triggers and the five coach RPCs call inside their own `EXCEPTION` block; `supabase/tests/push-plumbing.test.js` holds it, with `supabase/tests/fixtures/push-endpoints.json` for what `push_subscriptions.endpoint` may hold.

## CLAUDE.md — Feature → files map, row "DB / RLS test suite (`npm run test:db`)"

Add before the sentence "The migration tests are the next row.":

`push-plumbing.test.js` (the one function that sends a push and the eleven that ask it, each event fired the way the app fires it; what a device's endpoint may hold, from `fixtures/push-endpoints.json`; migration `2026_10_13_15_push_plumbing.sql` on the frozen baseline — the eleven pushes before, after and after its rollback); `enablePush({ bearerName })` stores the bearer under either vault name and `httpCalls()` gives the time limit of each request; `db.platform(sql)` of a `scratchDatabase()` runs one statement as the platform's own role, for a test about a pg_net or a vault that is not production's.

## CLAUDE.md — When you add a feature

Add to step 3, after the bullet that starts "A new Edge Function is a directory under `supabase/functions/`":

   - A database function that notifies somebody writes its bell row, then calls `public.send_push_event(recipient, payload)` inside a `BEGIN … EXCEPTION WHEN OTHERS THEN RAISE WARNING … END` block of its own, is `SECURITY DEFINER`, and joins `LATER_SENDERS` in `supabase/tests/push-plumbing.test.js`. It never reads the vault or calls `net.http_post` itself: the test fails on a second function that does (`supabase/migrations/README.md`, "A migration that tells somebody something").

## README.md — Database Tests

Replace "`enablePush()` + `httpCalls()` to assert the Web Push fan-out." with:

`enablePush()` + `httpCalls()` to assert the Web Push fan-out — `enablePush({ bearerName: 'app_internal_bearer' })` stores the bearer under its new vault name, and each call of `httpCalls()` carries its `timeout_milliseconds`.

## README.md — Database Tests

Replace "`scratchDatabase()` gives a test a database of its own to load SQL files into (`db.runFile`, `db.runSql`, `db.readOnly`, `db.query`), starting from an empty Supabase project or from a copy of `schema.sql`." with:

`scratchDatabase()` gives a test a database of its own to load SQL files into (`db.runFile`, `db.runSql`, `db.readOnly`, `db.query`), starting from an empty Supabase project or from a copy of `schema.sql`; `db.platform(sql)` runs one statement there as the platform's own role, which owns `net` and `vault` — for a test about a project whose pg_net is not production's, never for what the app or a migration does.

## README.md — Database Tests

Add after the bullet that starts "`push-secrets.test.js` runs the vault statements":

- `push-plumbing.test.js` holds "a push leaves the database through one function". It reads the text of every function of `public` — one may read the vault or call pg_net, and the eleven that notify call it inside an `EXCEPTION` block of their own — and fires the eleven events the way the app does, with pg_net raising, the function raising and the function gone: every write and every bell row is there all the same. The requests the eleven hand to pg_net are compared before the migration, after it and after its rollback, on the frozen baseline: the same address, bearer and payload, with the time limit added. What a device's endpoint may hold comes from `fixtures/push-endpoints.json`, three lists the Edge Functions' own list of hosts can be held to as well. A new function that sends a push joins `LATER_SENDERS` at the top of the file (`THE_ELEVEN` is the list of migration 15).

## README.md — Rest Timer (in-app + Web Push)

Replace "It is internal: the triggers present a shared secret, `INTERNAL_BEARER`, which they read from Supabase Vault (`app_service_role_key`, next to `app_functions_url`), and the function's gate" with:

It is internal: the database presents a shared secret, `INTERNAL_BEARER`, which one function — `send_push_event` — reads from Supabase Vault (`app_internal_bearer`, or `app_service_role_key` while the secret has not been renamed, next to `app_functions_url`) and sends with a time limit of ten seconds, and the function's gate

## docs/ARCHITECTURE.md — Auth and Row-Level Security

Add after the paragraph that starts "Trigger functions are on no list:":

One function is on no list on purpose: `send_push_event(p_user, p_payload, p_options)` hands a push to the `send-push` Edge Function, and whoever may call it sends any text and any link to any account. It is executable by `postgres` and `service_role`, and `SECURITY INVOKER`: the functions that notify are `SECURITY DEFINER` and call it as their owner. What `send-push` receives from it — the contract between the database and the function — is one JSON object: `user_id` (the recipient's profile id), `payload` (what the service worker shows: `title`, `body`, `tag`, `data.url`), `ttl` (seconds the push service keeps the message for a device that is offline; 86400 unless the caller passes another), and whatever else the caller passed as options, at the top level next to them, never nested. A key the function does not know is ignored by it. The request carries `Authorization: Bearer <INTERNAL_BEARER>`, and the database waits ten seconds for the answer, which it never reads.

## docs/RUNBOOK.md — new section "Checkpoint B — …", after the section of Checkpoint A3

Add when Checkpoint B is handed over (its row marked **ready**). The part of the sequence that belongs to migration 15, the first of the checkpoint, every command taken from `docs/runbook/migrations/15-push-plumbing.md` as it stands there, one per fence. It can be applied before or after the two Edge Functions are deployed: the `send-push` that is deployed today ignores what the migration adds to the request.

1. the audit of migration 15 — it reads as the "before" column of the page's table. **Line 5 must read `none`, line 12 `yes`, line 3 the eleven functions and no other, line 2 `no` and line 6 `no such function`**: otherwise stop and report, the migration refuses to run. **Line 9 decides**: `0` is clean. Anything else is a number and the hosts of the devices the rule refuses: run the list of the page's section "Devices whose endpoint is not at a known push service" and stop when a host is the push service of a real browser — the list of hosts is then one short, in the migration and in the Edge Functions, and that is a change of the repository, not a step of the checkpoint. A host that is no push service does not stop the migration; its row is deleted afterwards, which is asked before it is run. **Lines 8, 10 and 11 are noted**: the number of devices, and whether the vault holds the address of the functions and the bearer, and under which name — `MISSING` on either means the database sends no notification today, and will send none afterwards until the secrets are set (`docs/runbook/30-edge-functions.md`, section 2);
2. the migration;
3. the audit again — lines 2, 3, 4, 6 and 7 read as the "after" column, the others are those of step 1. Line 7 reads `yes`, or `yes, for new and changed rows only (NOT validated)` when line 9 was not `0`;
4. the ledger: fifteen rows, the last one `2026_10_13_15_push_plumbing`;
5. the page's check, which must fail with `check only, nothing was written: in place: send_push_event queues a notification for the owner of the database and is refused to a signed-in user, and a device is registered at a push service and nowhere else` — `in place, and NOT CONFIGURED` is the same with a vault that lacks a secret, as lines 10 and 11 said; `NOT PROTECTED`, `BROKEN` or a message that names `net.http_post` means roll back; `NOT THERE`, `NOT TRIED` or another message that does not start with `check only` means stop and report;
6. a message from the coach's account to the test athlete, with the athlete's phone locked: the notification arrives. It is the one thing no query shows;
7. when line 9 of step 1 was not `0` and the rows were deleted: the statement of the page that validates the rule, then the audit — line 7 reads `yes`.

Say with the rollback of migration 15, in the words of its page: it reopens the findings — a notification is lost again whenever `send-push` is slow to answer, and any address can be registered as a device — touches no row, and refuses to run while the vault holds the bearer as `app_internal_bearer` only: the secret is renamed back first, with the statement of the page.

Say with the secret: renaming `app_service_role_key` to `app_internal_bearer` is optional, comes after the migration, and waits until the statements of `docs/runbook/30-edge-functions.md` (sections 2 and 4) name the new secret — with the page as it stands, a rotation after the rename would store the new bearer under the old name, where `send_push_event` does not read it.
