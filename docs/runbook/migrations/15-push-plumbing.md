# 15 — Every push leaves the database through one function, with a time limit; a device's endpoint is an address at a push service

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_13_15_push_plumbing.sql` |
| Audit | `supabase/audits/2026_10_13_15_push_plumbing.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_13_15_push_plumbing.down.sql` |
| Kind | required · adds 1 function and 1 rule on a column, re-creates 11 functions; no table, no column, no policy, no trigger, no row |
| Wave / checkpoint | 2 / B |
| Findings | P35 (the database's half), B3; the name of the secret that L25 asks for |
| Needs | migration 14 |

Safe with the app that is deployed today and with the version that follows wave 1. Safe with the `send-push` function that is deployed today and with the one of wave 2: within Checkpoint B it can be applied before the functions are deployed, or after.

## What it does

Eleven things make the database send a notification to a phone: an athlete confirms a session, swaps or skips an exercise, asks to make a change permanent, submits a draft; the coach sends feedback, adopts a swap or a skip, declines one, approves a draft or sends it back; and a chat message, either way. The database does not send the notification itself. It asks the `send-push` Edge Function to, with a request that leaves once the write is saved.

**One way out, with a time limit (P35).** Each of the eleven carried its own copy of that request, and none said how long the answer may take. The database then waits 2 or 5 seconds, depending on its version — less than the function needs when it has not run for a while. The request is dropped, it is not tried again, and nothing says so: the line in the bell is written, the phone stays silent.

The migration adds one function, `send_push_event`, which is now the only place where the database reads the two secrets and calls `send-push`: same address, same secret, same request, and **ten seconds** for the answer. The eleven are re-created and ask it instead. Who is told, the line in the bell, the title, the text and the link of the notification are what they were. As before, a notification that cannot be sent is a warning in the database log and never the failure of what caused it: the confirmation, the feedback, the message are saved either way.

The request also says how long a notification is worth delivering to a phone that is offline: one day (`"ttl": 86400`). Without it the push service keeps a message for four weeks. The `send-push` that is deployed today ignores that line; the one of wave 2 reads it.

`send_push_event` is for the owner of the database and for the service role. A signed-in user cannot call it: whoever can, sends any text and any link to any account.

**The secret under its own name (L25).** The secret the database presents to `send-push` is stored in the vault as `app_service_role_key`. It is not the service-role key. Until now eleven functions read that name, so it could not be renamed. `send_push_event` reads `app_internal_bearer` first and, while the vault has nothing under that name, `app_service_role_key`. The migration renames nothing, and nothing needs the rename: [Renaming the secret](#renaming-the-secret) is optional.

**An endpoint is an address at a push service (B3).** When notifications are switched on, the browser hands the app an address at its push service, and the app stores it. The account writes that row itself, and the Edge Functions send to whatever it holds: any signed-in account could make them call an address of its choosing. From now on the address must be one a browser can hand over:

| It starts with | The push service of |
|---|---|
| `https://fcm.googleapis.com/` | Chrome and the browsers built on it |
| `https://updates.push.services.mozilla.com/` | Firefox |
| `https://`*anything*`.push.apple.com/` | Safari, and the web apps of iOS |
| `https://`*anything*`.notify.windows.com/` | Edge |

The rule judges a row when it is written. The rows that are there are not changed and not deleted, whatever they hold. When none of them breaks the rule — line 9 of the audit reads `0` — the migration also records that the whole table satisfies it; otherwise it applies to new and changed rows only, and [Devices whose endpoint is not at a known push service](#devices-whose-endpoint-is-not-at-a-known-push-service) says what to do with the others.

## What the deployed client does differently

**Nothing**, on a browser whose push service is one of the four — line 9 of the audit says whether every device that is registered today is on one. A notification that used to be lost when the function was slow to answer now arrives.

On a browser that hands over an address at another push service, switching notifications on fails. The app that is deployed today shows nothing when that happens: the switch stays off. The version of wave 2 shows the refusal.

**For somebody who calls the API by hand:**

| Who calls | Answer |
|---|---|
| anybody, signed in or not, `send_push_event` | `permission denied for function send_push_event` |
| an account, registering a device at an address that is not one of the four | `new row for relation "push_subscriptions" violates check constraint "push_subscriptions_endpoint_known_push_service"` (code `23514`) |

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_13_15_push_plumbing.audit.sql
```

What it prints, before and after the migration:

| # | check | before | after |
|---|---|---|---|
| 1 | running as | `postgres` | `postgres` |
| 2 | every push leaves through one function, with a time limit of 10 seconds (send_push_event, P35) | `no` | `yes` |
| 3 | functions that read the vault or call pg_net themselves | `adopt_skip, adopt_swap, approve_program, decline_promote_request, notify_coach_on_program_submit, notify_coach_on_promote_request, notify_coach_on_session_confirm, notify_coach_on_slot_deviation, notify_recipient_on_chat_message, notify_student_on_session_feedback, send_back_program` | `send_push_event` |
| 4 | functions that ask send_push_event for their push | `none` | `adopt_skip, adopt_swap, approve_program, decline_promote_request, notify_coach_on_program_submit, notify_coach_on_promote_request, notify_coach_on_session_confirm, notify_coach_on_slot_deviation, notify_recipient_on_chat_message, notify_student_on_session_feedback, send_back_program` |
| 5 | functions of these names that the migration does not know | `none` | `none` |
| 6 | who may execute send_push_event | `no such function` | `postgres, service_role` |
| 7 | an endpoint must be an address at a known push service (B3) | `no` | `yes` |
| 8 | devices registered for notifications | a number | the same number |
| 9 | devices whose endpoint is NOT at a known push service | `0` | `0` |
| 10 | vault: the address of the functions (app_functions_url) | `set` | `set` |
| 11 | vault: the bearer of send-push | `app_service_role_key` | `app_service_role_key` |
| 12 | pg_net takes a time limit (net.http_post … timeout_milliseconds) | `yes` | `yes` |

Lines 8 to 11 are what the migration works with. It changes none of them.

If the "before" column is not what you see:

- **1** is not `postgres` — stop and report. The migration refuses to run as anyone else.
- **2 already reads `yes`**, or **6** is not `no such function` — read the ledger (below). If migration 15 is there, you are done. If it is not, a function of that name was made by hand: stop and report.
- **3** lists another function than the eleven, or lacks one of them — stop and report the line. A twelfth function sends a push and the migration does not know it, or one of the eleven is not what the repository holds.
- **4** is not `none` before the migration, or **5** is not `none` — stop and report the line.
- **7** already reads `yes` before the migration — a rule of that name was made by hand: stop and report.
- **9** is not `0` — it reads a number, then the hosts: `2: example.org (1), sl-test.invalid (1)`. **Read [Devices whose endpoint is not at a known push service](#devices-whose-endpoint-is-not-at-a-known-push-service) before applying.** It decides between going on and stopping.
- **10** reads `MISSING: no push is sent`, or **11** does — the database sends no notification today, and will send none after the migration either. That is not this migration's to repair and does not stop it: go on, and set the secrets afterwards ([30, section 2](../30-edge-functions.md)).
- **11** reads `app_internal_bearer`, alone or with `app_service_role_key` — the secret was renamed or stored a second time **before** the migration. With `app_internal_bearer` alone, the database sends no notification today, because the functions that are there read the other name; the migration puts that right. With both and `ANOTHER value`: stop and report — after the migration the database would present the one stored as `app_internal_bearer`, and only one of the two can be the function's.
- **12** reads `no` — stop and report. The database's HTTP extension is not the version the migration is written for, and the migration refuses to run.

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_13_15_push_plumbing.sql
```

A refusal changes nothing:

| Message contains | Meaning | Do |
|---|---|---|
| `needs 2026_10_13_14_table_grants_lockdown, which is not applied` (code `SLM02`) | migration 14 is not in the database | apply it first, with its checks |
| `must be run as postgres` | line 1 of the audit | stop and report |
| `would not create: … is already there` | lines 2 and 6 of the audit: a function named `send_push_event` exists | stop and report the name |
| `would not replace the eleven functions it means: …` | lines 3 and 5 of the audit: one of the eleven is missing, or stands next to a copy with other arguments | stop and report the full message |
| `does not find what its functions are written with: …` | line 12 of the audit, or the vault or the table of the devices is not where the functions read it | stop and report the full message |
| `would not add: the constraint … is already there` | line 7 of the audit | stop and report |
| `did not get the functions it meant: …`, `left a function that reads the vault or calls pg_net itself: …` or `did not get the rule it meant …` | the file read its own result back and it was not the one described here | stop and report the full message |

When line 9 of the audit was not `0`, the migration also prints a notice: `push_subscriptions_endpoint_known_push_service is NOT validated: …`. That is the case this page describes, not a failure.

## After

1. Run the audit again. Lines 2 to 4, 6 and 7 read as the "after" column; the others are unchanged. Line 7 reads `yes, for new and changed rows only (NOT validated)` when line 9 is not `0`.

2. Read the ledger:

   ```bash
   supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
   ```

   Expected: fifteen rows, the last one `2026_10_13_15_push_plumbing`.

3. See it for yourself. This creates a coach and an athlete. As the owner of the database, it asks `send_push_event` for a notification to the athlete; through the API's role, as the athlete, it asks for one to the coach, registers a device at a made-up address, then one at a push service, and sends the coach a chat message. Then it fails **whatever happened**, so that nothing is kept — the two accounts, the device, the message — and no request leaves the database: a request is sent only once what queued it is saved, and nothing here is. The answer is in the message:

   ```bash
   supabase db query --linked 'do $check$
   declare
     v_coach uuid := gen_random_uuid();
     v_athlete uuid := gen_random_uuid();
     v_configured boolean;
     v_queued bigint;
     v_devices integer;
     v_messages integer;
     v_answer text;
   begin
     if to_regprocedure($m$public.send_push_event(uuid, jsonb, jsonb)$m$) is null then
       raise exception $m$check only, nothing was written: NOT THERE: send_push_event is not in the database$m$;
     end if;

     insert into auth.users (id, email, aud, role) values
       (v_coach, $m$sl-check-15-coach@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$),
       (v_athlete, $m$sl-check-15-athlete@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$);
     update public.profiles set role = $m$coach$m$ where id = v_coach;
     if not exists (select 1 from public.profiles where id = v_coach and role = $m$coach$m$) then
       raise exception $m$check only, nothing was written: NOT TRIED: the account made for the check could not be made a coach$m$;
     end if;
     insert into public.students (profile_id, coach_id) values (v_athlete, v_coach);

     select exists (select 1 from vault.decrypted_secrets
                     where name = $m$app_functions_url$m$ and coalesce(decrypted_secret, $m$$m$) <> $m$$m$)
        and exists (select 1 from vault.decrypted_secrets
                     where name in ($m$app_internal_bearer$m$, $m$app_service_role_key$m$)
                       and coalesce(decrypted_secret, $m$$m$) <> $m$$m$)
       into v_configured;
     v_queued := public.send_push_event(v_athlete, jsonb_build_object($m$title$m$, $m$sl-check-15$m$));

     perform set_config($m$role$m$, $m$authenticated$m$, true);
     perform set_config($m$request.jwt.claims$m$,
       json_build_object($m$sub$m$, v_athlete, $m$role$m$, $m$authenticated$m$)::text, true);
     begin
       perform public.send_push_event(v_coach, jsonb_build_object($m$title$m$, $m$sl-check-15$m$));
       v_answer := $m$NOT PROTECTED: a signed-in user sent a notification to another account$m$;
     exception when insufficient_privilege then
       null;
     end;
     begin
       insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
         values (v_athlete, $m$https://sl-check-15.invalid/$m$ || gen_random_uuid(), $m$key$m$, $m$secret$m$);
       v_answer := coalesce(v_answer, $m$NOT PROTECTED: a device was registered at an address that is not at a push service$m$);
     exception when check_violation then
       null;
     end;
     insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
       values (v_athlete, $m$https://fcm.googleapis.com/fcm/send/sl-check-15-$m$ || gen_random_uuid(), $m$key$m$, $m$secret$m$);
     insert into public.messages (sender_id, recipient_id, body) values (v_athlete, v_coach, $m$sl-check-15$m$);
     select count(*) into v_devices from public.push_subscriptions ps where ps.user_id = v_athlete;
     select count(*) into v_messages from public.messages m where m.sender_id = v_athlete;

     v_answer := coalesce(v_answer, case
       when v_devices is distinct from 1
         then $m$BROKEN: a device at a push service was not registered$m$
       when v_messages is distinct from 1
         then $m$BROKEN: a chat message was not saved$m$
       when v_configured and v_queued is null
         then $m$BROKEN: send_push_event queued nothing although the vault holds the address and the bearer$m$
       when not v_configured and v_queued is not null
         then $m$BROKEN: send_push_event queued a request although the vault lacks the address or the bearer$m$
       when not v_configured
         then $m$in place, and NOT CONFIGURED: send_push_event is refused to a signed-in user and a device is registered at a push service only — and no notification is sent, because the vault lacks the address of the functions or the bearer$m$
       else $m$in place: send_push_event queues a notification for the owner of the database and is refused to a signed-in user, and a device is registered at a push service and nowhere else$m$
     end);
     raise exception $m$check only, nothing was written: %$m$, v_answer;
   end $check$'
   ```

   The command must fail with `check only, nothing was written: in place: send_push_event queues a notification for the owner of the database and is refused to a signed-in user, and a device is registered at a push service and nowhere else`. Run before the migration, the same command fails with `… NOT THERE: send_push_event is not in the database` — and writes nothing either.

   Anything else is **not** the answer:

   - `… in place, and NOT CONFIGURED: …` — the migration is in place, and line 10 or 11 of the audit reads `MISSING`: the database sends no notification, as before the migration. Set the secrets ([30, section 2](../30-edge-functions.md)), then run the check again.
   - `… NOT THERE: …` after the migration — the migration is not in this database. Read the ledger.
   - `… NOT PROTECTED: …` or `… BROKEN: …` — something does not do what this page says: **roll back**, and report the full message.
   - `… NOT TRIED: the account made for the check could not be made a coach` — migration 07 is not in the database, or was rolled back. Read the ledger.
   - a message that does not start with `check only` — the check could not get as far as its questions (the message says why). Nothing was written. Report it; lines 2 to 7 of the audit are then what says whether the migration is in place. One such message means **roll back**: `function net.http_post(…) does not exist`, or any other that names `net.http_post` — the database's HTTP extension does not take the request the way `send_push_event` writes it, and every notification would be a warning in the log instead.

4. In the app: send a message from the coach's account to the test athlete, with the athlete's phone locked. The notification arrives, as before. This is the one thing no query can show; it needs a phone on which the athlete has switched notifications on.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_13_15_push_plumbing.down.sql
```

It gives the eleven functions the text they had, drops `send_push_event`, and drops the rule on the address of a device. No row is touched: every device stays registered, whatever its address. The text it restores is the repository's from before the migration; the behaviour is the one production had.

**It reopens the findings**: a notification is lost again whenever `send-push` takes longer than a few seconds to answer, and an account can again register any address. Run it only when step 3 answers `NOT PROTECTED` or `BROKEN` or names `net.http_post`, when something that used to work now fails where it sent a notification before, or when the migration was applied to the wrong project. *A browser can no longer switch notifications on* is that case only when its push service is a real one: report the host first ([below](#devices-whose-endpoint-is-not-at-a-known-push-service)).

**If the secret was renamed**, the rollback refuses to run: `the vault holds the bearer of send-push as app_internal_bearer only`. The functions it puts back read `app_service_role_key` and no other name. Rename it back first, then run the rollback again:

```bash
supabase db query --linked "select vault.update_secret(id, null, 'app_service_role_key') from vault.secrets where name = 'app_internal_bearer' and not exists (select 1 from vault.secrets where name = 'app_service_role_key')"
```

One row: renamed. The value is not changed.

It is refused (code `SLM04`) once a later migration is in the ledger. Roll those back first, last applied first.

## Devices whose endpoint is not at a known push service

For line 9 of the audit. One row per device, with the account it belongs to and the **host** of its address — never the address itself, which is a secret of that device:

```bash
supabase db query --linked "select pr.role, pr.full_name as account, coalesce(nullif(substring(ps.endpoint from '^[A-Za-z][A-Za-z0-9+.-]*://([^/?#]*)'), ''), 'not a URL') as host, ps.user_agent, ps.created_at::date as registered, ps.last_seen_at::date as last_seen, ps.id from public.push_subscriptions ps join public.profiles pr on pr.id = ps.user_id where not (ps.endpoint ~ '^https://(fcm[.]googleapis[.]com|updates[.]push[.]services[.]mozilla[.]com|[a-z0-9.-]+[.]push[.]apple[.]com|[a-z0-9.-]+[.]notify[.]windows[.]com)/') order by 1, 2, 3"
```

No row: line 9 reads `0`, and there is nothing to do. Otherwise each row is one of two things, and the host and the browser (`user_agent`) say which:

- **The push service of a real browser that the list does not have** — a host of a browser maker (a name under `google.com`, `googleapis.com`, `mozilla.com`, `apple.com`, `windows.com`, or of another browser), on a row whose `user_agent` is a browser and whose `last_seen` is recent. **Stop: do not apply the migration, and report the host.** The list is one short, and it is written in two places — the migration and the Edge Functions — which are changed together, in the repository. Applied all the same, the migration leaves that device as it is, but the device can no longer be refreshed, the `send-push` of wave 2 refuses to send to it, and nobody else on that browser can switch notifications on.
- **Not a device** — an address made up for a test, `localhost`, the project's own URL, something that is not a URL. Nothing can be delivered there. Apply the migration; the row is left as it is, and can only be deleted from then on. Delete it, one row at a time, with the `id` of the list — this is a statement that deletes a row of the app, and it is asked before it is run ([RUNBOOK, Who runs a checkpoint](../../RUNBOOK.md#who-runs-a-checkpoint)):

  ```bash
  supabase db query --linked "delete from public.push_subscriptions where id = '<id of the row>' returning user_agent, last_seen_at"
  ```

When the list is empty again and the migration is applied, record that the whole table satisfies the rule:

```bash
supabase db query --linked "alter table public.push_subscriptions validate constraint push_subscriptions_endpoint_known_push_service"
```

Line 7 of the audit then reads `yes`. While a row is still in the way the statement fails (code `23514`, `check constraint … is violated by some row`) and changes nothing.

Until then: the rule holds for every row that is written, the rows in the way keep receiving notifications from the `send-push` that is deployed today, and a backup of the database does not restore into a fresh one — the restore drill of [BACKUPS.md](../../../BACKUPS.md) stops at the first of those rows. That is the reason not to leave them.

## Renaming the secret

Optional. Nothing needs it: the name is misleading, not wrong. Do it only **after** the migration is applied — the functions from before it read `app_service_role_key` and no other name — and only once [30, sections 2 and 4](../30-edge-functions.md) name `app_internal_bearer` in their statements. As long as that page looks for `app_service_role_key`, its rotation would find nothing after the rename, and its last statement would store the new secret a second time under the old name, where `send_push_event` does not read it while `app_internal_bearer` exists.

```bash
supabase db query --linked "select vault.update_secret(id, null, 'app_internal_bearer') from vault.secrets where name = 'app_service_role_key' and not exists (select 1 from vault.secrets where name = 'app_internal_bearer')"
```

One row: renamed. The value is not changed, and nothing has to be done on the function's side. No row: there was nothing under the old name, or there is something under the new one already — line 11 of the audit says which.

Then run the audit: line 11 reads `app_internal_bearer`. And step 4 of [After](#after): a notification still arrives. If it does not, rename it back with the statement of [Rollback](#rollback) — that one does not need the rollback itself.

If line 11 ever reads `app_internal_bearer, and app_service_role_key with ANOTHER value`: the database presents the one stored as `app_internal_bearer`. One of the two is not the function's secret; the rotation of [30, section 4](../30-edge-functions.md) puts a fresh value in both places, and the leftover is then deleted by its owner.
