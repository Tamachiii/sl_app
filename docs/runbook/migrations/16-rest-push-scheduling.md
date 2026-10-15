# 16 — The end of a rest is scheduled by the database, and a rest push is sent once

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_13_16_rest_push_scheduling.sql` |
| Audit | `supabase/audits/2026_10_13_16_rest_push_scheduling.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_13_16_rest_push_scheduling.down.sql` |
| Kind | required · adds 4 functions and 2 columns, replaces 1 rule on a column, adds a condition to 2 policies, closes the rest pushes left waiting; no table, no trigger, no row deleted |
| Wave / checkpoint | 2 / B |
| Findings | P10, B14; the database's half of B35 and B38 |
| Needs | migration 15 |

Safe with the app that is deployed today and with the version that follows wave 1. Safe with the two Edge Functions as they are deployed today. **Within Checkpoint B it comes before the Edge Functions of wave 2 are deployed**: those call a function this migration creates.

## What it does

When an athlete ticks a set, the app starts a rest timer and asks for a notification at its end — the one thing that reaches a locked phone. Today the app does that in two requests of its own: it writes a row into `scheduled_pushes`, then calls the `dispatch-rest-push` Edge Function, which waits inside that request until the time has come.

- **A rest of 150 seconds or more never rings (P10).** The platform ends a request after 150 seconds. The function is gone by then and nothing else reads the row. The long rests are the ones with the phone locked.
- **The rows stay (B14).** Nothing deletes a row, and a row whose function died stays `pending` for ever. Anything that looked for work in that table would start by sending months of old notifications.
- **The time is the phone's (B35), and every device rings (B38).** The app writes the time from the clock of the device, and a row does not say which device asked.

This migration is the database's half of the repair. **By itself it changes nothing about who sends a rest push**: it adds what the Edge Functions of wave 2, the optional job of migration 19 and the app of wave 3 are written with.

1. **A row can say more.** Two more statuses — `sending` (a sender has taken the row and is sending it) and `expired` (nobody had sent it a minute after its time) — and two more columns: `endpoint`, the device the notification is for (empty: every device of the account, which is what a row of today's app means), and `dispatched_at`, when the job of migration 19 handed the row over.
2. **An account names a device of its own only.** The two rules through which the app writes that table itself now also ask that `endpoint` is empty or one of the caller's own devices.
3. **`schedule_rest_push(p_seconds, p_payload, p_endpoint)`** is the whole request of the next app. The time is computed on the server; what the caller still had waiting is closed (one rest at a time); the caller's rows older than 7 days are deleted; and the answer says who will send: `mode` `cron` while the job of migration 19 runs, `edge` otherwise — then the app calls `dispatch-rest-push`, as it does today.
4. **`cancel_rest_push(p_id)`** takes a rest back that ends early.
5. **`claim_rest_push(p_id)`** is the one way a row gets sent. Whoever sends asks it first, at the time of the notification, and sends only what it is answered. It answers a row **once**, never a row that was taken back, and never one more than a minute late. With two ways to send, this is what makes one notification of them. For the Edge Functions only.
6. **`dispatch_due_rest_pushes()`** is what the job of migration 19 will run every ten seconds: it closes the rows more than a minute late, and hands each row due within ten seconds to `send-push`, once. **Nothing calls it until that job exists.**
7. **The rows that were left waiting are closed.** Every row still `pending` more than a minute after its time becomes `expired` — or `canceled`, where its athlete had asked for that. No row is deleted, and a rest that is running while the migration is applied is not touched.

## Who sends a rest push, and in which order things are switched on

| The database has | Deployed | Who sends | A rest of 3 minutes |
|---|---|---|---|
| migration 16 | the Edge Functions of today | `dispatch-rest-push`, as before | does not ring |
| migration 16 | the Edge Functions of wave 2 | `dispatch-rest-push`, in hops of a minute | rings |
| migrations 16 and 19 (pg_cron) | the Edge Functions of wave 2 | the job, through `send-push` | rings |

The order is the order of the lines: **this migration, then the two Edge Functions of wave 2, then — if you choose pg_cron — migration 19.** Never migration 19 before the `send-push` of wave 2 is deployed: the `send-push` of today does not know what the job hands it, and would ring every device of the athlete at once, ten seconds early.

## What the deployed client does differently

**Nothing.** The app that is deployed, and the one of wave 1, go on with their own two requests and their own cancel. None of them names a device, so the new condition lets their rows through as before. The `dispatch-rest-push` that is deployed goes on reading and writing the rows it is given.

**For somebody who calls the API by hand:**

| Who calls | Answer |
|---|---|
| nobody signed in, any of the four functions | `permission denied for function schedule_rest_push` (or the name of the one called) |
| an account, `claim_rest_push` or `dispatch_due_rest_pushes` | `permission denied for function claim_rest_push` (or `dispatch_due_rest_pushes`) |
| an account, a rest of less than 1 or more than 900 seconds | `rest_seconds_out_of_range` |
| an account, a payload that is not a JSON object, or longer than 2000 bytes | `payload_invalid` |
| an account, for a device that is not one of its own — or for none, when it has no device at all | `device_not_registered` |
| an account, writing a row of `scheduled_pushes` itself with the endpoint of somebody else's device | `new row violates row-level security policy for table "scheduled_pushes"` |
| an account, taking back a row that is not waiting any more, or not its own | `{"canceled": false}` — not an error |

In every one of those cases nothing was written.

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_13_16_rest_push_scheduling.audit.sql
```

What it prints, before and after the migration:

| # | check | before | after |
|---|---|---|---|
| 1 | running as | `postgres` | `postgres` |
| 2 | the end of a rest is scheduled by the database (schedule_rest_push, P10) | `no` | `yes` |
| 3 | functions of these names that the migration does not know | `none` | `none` |
| 4 | functions of this migration a request without a session may execute | `none` | `none` |
| 5 | functions of this migration a signed-in user may execute | `none` | `cancel_rest_push(uuid); schedule_rest_push(integer, jsonb, text)` |
| 6 | functions of this migration that run as their owner | `none` | `cancel_rest_push(uuid); dispatch_due_rest_pushes(); schedule_rest_push(integer, jsonb, text)` |
| 7 | functions of this migration without search_path = public, pg_temp | `none` | `none` |
| 8 | what the status of a rest push can be | `canceled, failed, pending, sent` | `canceled, expired, failed, pending, sending, sent` |
| 9 | a rest push says which device it is for, and when it was handed over (endpoint, dispatched_at) | `no` | `yes` |
| 10 | an account names a device of its own only (the two policies it writes through) | `no` | `yes` |
| 11 | the function a rest push is handed to send-push with (send_push_event, migration 15) | `yes` | `yes` |
| 12 | rest pushes, by status | a list | the same list, with the rows of line 13 moved to `expired` and `canceled` |
| 13 | rest pushes still waiting more than a minute after their time (the backlog, B14) | a number | `0` |
| 14 | … of which their athlete had taken back | a number | `0` |
| 15 | … the oldest of them was due on | a date | `none` |
| 16 | rest pushes waiting for a time still to come, or less than a minute past | the rests that are running | the rests that are running then |
| 17 | rest pushes older than 7 days | a number | the same number |
| 18 | who sends a rest push | a sentence | the same sentence |

Line 6 is meant: three of the four functions run as their owner; `claim_rest_push` runs with the rights of its caller, which is the service role. Lines 12 to 17 are the rows. The migration deletes none of them, and none of them stops it.

If the "before" column is not what you see:

- **1** is not `postgres` — stop and report. The migration refuses to run as anyone else.
- **2 already reads `yes`**, or **9** or **10** does — read the ledger (below). If migration 16 is there, you are done. If it is not, something of that name was made by hand: stop and report.
- **3** is not `none` — **stop and report the line.** A function with one of the four names and other arguments exists; the migration refuses to run next to it.
- **4, 5, 6 or 7** is not `none` before the migration — same: stop and report.
- **8** is not `canceled, failed, pending, sent` — stop and report the line. The rule on the status was changed by hand, and the migration refuses to replace a rule it was not written for.
- **11** reads `no` — stop and report. Migration 15 is in the ledger and its function is not in the database.
- **13** is any number: that is what the migration is for. [The rest pushes that were left waiting](#the-rest-pushes-that-were-left-waiting) shows whose they are. **14** is part of 13.
- **16** is not `0` — somebody is resting right now. Go on: the migration does not touch those rows, and their notification is sent as it would have been.
- **17** — any number. Nothing deletes those rows today; after this migration an account's own go when it next rests, and migration 18 brings the function that removes the others.
- **18** reads `pg_cron is installed: …` — pg_cron was switched on before this checkpoint. That does not stop the migration; the job itself is made by migration 19.

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_13_16_rest_push_scheduling.sql
```

It holds the table of the rest pushes for an instant: a rest timer that starts in that instant waits for it.

A refusal changes nothing:

| Message contains | Meaning | Do |
|---|---|---|
| `needs 2026_10_13_15_push_plumbing, which is not applied` (code `SLM02`) | migration 15 is not in the database | apply it first, with its checks |
| `must be run as postgres` | line 1 of the audit | stop and report |
| `would not create: … is already there` | lines 2 and 3 of the audit: a function of one of the four names exists | stop and report the names |
| `would not add: … is already there` | line 9 of the audit: `scheduled_pushes` already has a column named `endpoint` or `dispatched_at` | stop and report the names |
| `does not find the columns its functions are written with: …` | a column of `scheduled_pushes` or `push_subscriptions` is not there under its name | stop and report the full message |
| `does not find the function its functions call: …` | line 11 of the audit | stop and report the full message |
| `would not replace the rule on public.scheduled_pushes.status: …` | line 8 of the audit | stop and report the full message |
| `does not find the policies of public.scheduled_pushes it adds a condition to: …` | one of the two rules through which the app writes the table is not there under its name | stop and report the full message |
| `did not get the functions it meant: …` or `did not get the table it meant: …` | the file read its own result back and it was not the one described here | stop and report the full message |
| `canceling statement due to lock timeout` | another request held the table for more than five seconds | nothing was changed: run it again |

## After

1. Run the audit again. Lines 2, 5, 6, 8, 9 and 10 read as the "after" column, lines 13 and 14 read `0`, and line 12 shows the rows of line 13 under `expired` and `canceled`.

2. Read the ledger:

   ```bash
   supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
   ```

   Expected: sixteen rows, the last one `2026_10_13_16_rest_push_scheduling`.

3. See it for yourself. This creates two accounts and registers a phone for the first — an address made up for the check: nothing is sent to it. Through the API's role, as the first account, it schedules a rest of 90 seconds, then one of 120, then tries one for a device that is not its own, and tries the two functions that are not for an account. As the second account it tries to take the rest of the first back. As the owner it writes two rows the way today's app does, one due now and one five minutes late. As the service role — the Edge Functions — it takes each row to send, the second rest twice. Then it fails **whatever happened**, so that nothing is kept, the two accounts included. The answer is in the message:

   ```bash
   supabase db query --linked 'do $check$
   declare
     v_athlete uuid := gen_random_uuid();
     v_other uuid := gen_random_uuid();
     v_phone text := $m$https://fcm.googleapis.com/fcm/send/sl-check-16-$m$ || gen_random_uuid();
     v_payload jsonb := jsonb_build_object($m$title$m$, $m$sl-check-16$m$, $m$tag$m$, $m$rest-timer$m$);
     v_due uuid := gen_random_uuid();
     v_late uuid := gen_random_uuid();
     v_first jsonb;
     v_second jsonb;
     v_theirs jsonb;
     v_taken jsonb;
     v_twice jsonb;
     v_closed jsonb;
     v_gone jsonb;
     v_as_today jsonb;
     v_back jsonb;
     v_rows text;
     v_answer text;
   begin
     if to_regprocedure($m$public.schedule_rest_push(integer, jsonb, text)$m$) is null
        or to_regprocedure($m$public.cancel_rest_push(uuid)$m$) is null
        or to_regprocedure($m$public.claim_rest_push(uuid)$m$) is null
        or to_regprocedure($m$public.dispatch_due_rest_pushes()$m$) is null then
       raise exception $m$check only, nothing was written: NOT THERE: the four functions are not in the database$m$;
     end if;

     insert into auth.users (id, email, aud, role) values
       (v_athlete, $m$sl-check-16-athlete@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$),
       (v_other, $m$sl-check-16-other@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$);
     insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       values (v_athlete, v_phone, $m$key$m$, $m$secret$m$, $m$sl-check-16$m$);

     perform set_config($m$role$m$, $m$authenticated$m$, true);
     perform set_config($m$request.jwt.claims$m$,
       json_build_object($m$sub$m$, v_athlete, $m$role$m$, $m$authenticated$m$)::text, true);
     v_first := public.schedule_rest_push(90, v_payload, v_phone);
     v_second := public.schedule_rest_push(120, v_payload, v_phone);
     begin
       perform public.schedule_rest_push(90, v_payload, v_phone || $m$-of-somebody-else$m$);
       v_answer := $m$NOT PROTECTED: a rest push was scheduled for a device its account has not registered$m$;
     exception when raise_exception then
       null;
     end;
     begin
       perform public.claim_rest_push((v_second->>$m$id$m$)::uuid);
       v_answer := coalesce(v_answer, $m$NOT PROTECTED: a signed-in user took a rest push to send$m$);
     exception when insufficient_privilege then
       null;
     end;
     begin
       perform public.dispatch_due_rest_pushes();
       v_answer := coalesce(v_answer, $m$NOT PROTECTED: a signed-in user ran the job$m$);
     exception when insufficient_privilege then
       null;
     end;

     perform set_config($m$request.jwt.claims$m$,
       json_build_object($m$sub$m$, v_other, $m$role$m$, $m$authenticated$m$)::text, true);
     v_theirs := public.cancel_rest_push((v_second->>$m$id$m$)::uuid);

     perform set_config($m$role$m$, $m$postgres$m$, true);
     perform set_config($m$request.jwt.claims$m$, $m$$m$, true);
     insert into public.scheduled_pushes (id, user_id, fire_at, payload) values
       (v_due, v_athlete, now(), v_payload),
       (v_late, v_athlete, now() - interval $m$5 minutes$m$, v_payload);

     perform set_config($m$role$m$, $m$service_role$m$, true);
     perform set_config($m$request.jwt.claims$m$, json_build_object($m$role$m$, $m$service_role$m$)::text, true);
     v_taken := public.claim_rest_push((v_second->>$m$id$m$)::uuid);
     v_twice := public.claim_rest_push((v_second->>$m$id$m$)::uuid);
     v_closed := public.claim_rest_push((v_first->>$m$id$m$)::uuid);
     v_gone := public.claim_rest_push(v_late);
     v_as_today := public.claim_rest_push(v_due);

     perform set_config($m$role$m$, $m$authenticated$m$, true);
     perform set_config($m$request.jwt.claims$m$,
       json_build_object($m$sub$m$, v_athlete, $m$role$m$, $m$authenticated$m$)::text, true);
     v_back := public.cancel_rest_push((v_second->>$m$id$m$)::uuid);

     perform set_config($m$role$m$, $m$postgres$m$, true);
     perform set_config($m$request.jwt.claims$m$, $m$$m$, true);
     select string_agg(sp.status, $m$ $m$ order by array_position(
              array[(v_first->>$m$id$m$)::uuid, (v_second->>$m$id$m$)::uuid, v_due, v_late], sp.id))
       into v_rows
       from public.scheduled_pushes sp where sp.user_id = v_athlete;

     v_answer := coalesce(v_answer, case
       when (v_first->>$m$fire_at$m$)::timestamptz is distinct from now() + interval $m$90 seconds$m$
         or (v_second->>$m$fire_at$m$)::timestamptz is distinct from now() + interval $m$120 seconds$m$
         then $m$BROKEN: schedule_rest_push did not answer the time of the server plus the seconds asked for$m$
       when (v_second->>$m$mode$m$) is null or (v_second->>$m$mode$m$) not in ($m$cron$m$, $m$edge$m$)
         then $m$BROKEN: schedule_rest_push did not say who sends$m$
       when (v_theirs->>$m$canceled$m$) is distinct from $m$false$m$
         then $m$NOT PROTECTED: an account took back the rest push of another one$m$
       when v_twice is not null
         then $m$NOT PROTECTED: a rest push was handed to a sender twice$m$
       when v_closed is not null
         then $m$NOT PROTECTED: a rest push that was taken back was handed to a sender$m$
       when v_gone is not null
         then $m$NOT PROTECTED: a rest push more than a minute late was handed to a sender$m$
       when v_taken is null or (v_taken->>$m$endpoint$m$) is distinct from v_phone
         or (v_taken->>$m$user_id$m$)::uuid is distinct from v_athlete
         then $m$BROKEN: claim_rest_push did not answer the rest push with its account and its device$m$
       when v_as_today is null or (v_as_today->>$m$endpoint$m$) is not null
         then $m$BROKEN: a rest push written the way the app of today writes it was not answered, for every device$m$
       when (v_back->>$m$canceled$m$) is distinct from $m$false$m$
         then $m$BROKEN: a rest push that a sender had taken was taken back$m$
       when v_rows is distinct from $m$canceled sending sending expired$m$
         then $m$BROKEN: the four rest pushes are not canceled, sending, sending and expired$m$
       else $m$in place, mode $m$ || (v_second->>$m$mode$m$) || $m$: a rest push is scheduled at the time of the server for a device of its account, taken back by its account only, and handed to a sender once — never after it was taken back, never more than a minute late$m$
     end);
     raise exception $m$check only, nothing was written: %$m$, v_answer;
   end $check$'
   ```

   The command must fail with `check only, nothing was written: in place, mode edge: a rest push is scheduled at the time of the server for a device of its account, taken back by its account only, and handed to a sender once — never after it was taken back, never more than a minute late`. Once the job of migration 19 runs, the same command says `in place, mode cron: …`. Run before the migration, it fails with `… NOT THERE: the four functions are not in the database` — and writes nothing either.

   Anything else is **not** the answer:

   - `… NOT THERE: …` after the migration — the migration is not in this database. Read the ledger.
   - `… NOT PROTECTED: …` or `… BROKEN: …` — a function does not do what this page says: **roll back**, and report the full message.
   - `in place, mode cron: …` when migration 19 was not applied — a job named `sl-rest-push` was made by hand. Report it: the app of wave 3 would rely on it.
   - a message that does not start with `check only` — the check could not get as far as its questions (the message says why). Nothing was written. Report it; lines 2 to 11 of the audit are then what says whether the migration is in place.

4. In the app that is deployed, as an athlete with notifications switched on: tick a set with a rest of a minute or less, lock the phone. The notification arrives as it did before. A rest of three minutes still does not ring: that comes with the Edge Functions of wave 2.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_13_16_rest_push_scheduling.down.sql
```

It drops the four functions and the two columns, takes the condition out of the two policies, and puts the rule of four statuses back.

**Not once the Edge Functions of wave 2 are deployed**, unless the ones from before are deployed again first: the functions of wave 2 ask `claim_rest_push` before they send, and after this file no rest push is sent by anybody. With the Edge Functions of today it changes nothing anybody sees — the app of wave 3 falls back on today's two requests where `schedule_rest_push` is missing — and the only reasons to run it are step 3 answering `NOT PROTECTED` or `BROKEN`, or a migration applied to the wrong project.

Rows are rewritten, and do not come back:

- the rule of four statuses cannot hold a row that is `expired` or `sending`: both become `failed`, with a sentence in `error` that says which it was;
- the rows the migration closed stay closed. They are not made `pending` again: nothing was going to send them;
- which device a rest was for goes with its column: a rest that is running while the file is run rings on every device of its athlete.

No row is deleted. It is refused (code `SLM04`) once a later migration is in the ledger. Roll those back first, last applied first.

## The rest pushes that were left waiting

For lines 12 to 15 of the audit: the rows that have been `pending` since the request that was to send them ended. One line per account, **before** the migration:

```bash
supabase db query --linked "select pr.role, pr.full_name as account, count(*) as left_waiting, count(*) filter (where sp.canceled_at is not null) as taken_back, min(sp.fire_at)::date as oldest, max(sp.fire_at)::date as latest from public.scheduled_pushes sp join public.profiles pr on pr.id = sp.user_id where sp.status = 'pending' and sp.fire_at <= now() - interval '60 seconds' group by pr.id, pr.role, pr.full_name order by 3 desc, 2"
```

`left_waiting` minus `taken_back` is the number of notifications that account never got: every rest of 150 seconds or more, and every rest during which the function failed. Nothing to repair: the migration closes them, and they stop being counted as work.

**After** the migration the same statement returns no row. What became of them, and what happens to rest pushes from then on, by day:

```bash
supabase db query --linked "select sp.fire_at::date as day, count(*) filter (where sp.status = 'sent') as sent, count(*) filter (where sp.status = 'canceled') as taken_back, count(*) filter (where sp.status = 'expired') as never_sent, count(*) filter (where sp.status = 'failed') as failed, count(*) filter (where sp.status = 'sending') as never_reported, count(*) filter (where sp.status = 'pending') as waiting from public.scheduled_pushes sp group by 1 order by 1 desc limit 14"
```

`never_sent` is the number to watch once the Edge Functions of wave 2 are deployed: a day on which long rests were trained and it is not `0` is a day on which the function did not get to the end of its wait. With the job of migration 19 it stays `0` unless `send-push` is down. `never_reported` is a sender that took a row and did not say what became of it.

A row is kept for 7 days after its account's next rest; migration 18 removes the rows of the accounts that stopped training.
