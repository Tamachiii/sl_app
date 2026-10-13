# 18 — The rows nobody reads any more are deleted by one function

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_13_18_retention.sql` |
| Audit | `supabase/audits/2026_10_13_18_retention.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_13_18_retention.down.sql` |
| Kind | required · adds 1 function; no table, no column, no policy, no trigger, and no row written or deleted |
| Wave / checkpoint | 2 / B |
| Findings | L27; the retention that B14 and L20 ask for |
| Needs | migration 17 |

Safe with the app that is deployed today and with every version before it: none of them calls the function, and applying the migration changes no row.

## What it does

Three tables hold rows that are of use for a while and of none afterwards, and nothing ever deleted one of them (L27):

- **`scheduled_pushes`** — one row per rest timer. It is the largest table after the sets themselves, and the one that grows with every set an athlete ticks. A row is of use until its notification is sent, taken back, or a minute late.
- **`notifications`** — the lines of the bell. The app shows the 30 most recent ones of an account.
- **`client_errors`** — what the app reports when it breaks, for the list at the bottom of the coach's roster: the 20 most recent.

Migration 16 makes an account's own rest pushes older than 7 days go when it next rests — for the app that starts its rests through the function of that migration. The app from before wave 3 writes its rows itself, and nothing deletes those. And where every app is a newer one, that leaves the rows of every account that stopped training, and the two other tables as they were. A job would do the rest, and pg_cron — which runs jobs — is not installed: without it nothing inside the database happens on a timer.

**The migration creates one function and deletes no row.** `run_retention()` deletes, each time it is run:

| What | When |
|---|---|
| a rest push | created more than **7 days** ago, whatever became of it — sent, failed, taken back, expired, or left waiting long after its time |
| a notification | **read** more than **90 days** ago |
| a client error | reported more than **90 days** ago |

and answers how many rows of each it deleted: `{"client_errors": 4, "notifications": 12, "scheduled_pushes": 3100}`.

What it never deletes:

- **a notification that was never read**, however old: it is still on its account's bell;
- **a rest push that is still to be sent** — waiting, not taken back, for a time still to come or less than a minute past. No rest is a week long, so there is no such row unless a phone's clock is days ahead ([below](#a-rest-push-that-is-kept));
- **anything else.** No other table is named in it: not a set, not a session, not a message.

**Who runs it: you, once a month** — [70 — By hand, outside a checkpoint](../70-admin-procedures.md#once-a-month-delete-what-nobody-reads-any-more) has the three steps. Or nobody: where pg_cron is switched on, the optional migration 19 makes a job that runs it every night. Nothing else calls it — no trigger, no other function, no app. It is for the owner of the database and for the service role, and it runs with the rights of whoever calls it: it has none of its own.

**A month that is skipped breaks nothing.** The rows wait a month longer. Once the app from before wave 3 is no longer in use, the table that grows fastest is bounded without it, by the athletes' own next rest.

It never waits for the app: a row that another request holds at that instant — an athlete who is starting a rest — is passed over, and goes with the next run.

## What the deployed client does differently

**When the migration is applied: nothing.** No row changes.

**After a run**, in every version of the app:

- **The bell.** A line its account read more than 90 days ago is gone. The app showed it only to an account with fewer than 30 newer lines. The number on the bell counts the unread lines, and none of those is deleted. A bell that is open while the function runs shows the line until it is next loaded: an app that is open is told of each deleted line over its live connection, and does nothing with it.
- **The coach's list of errors.** Errors older than 90 days leave it.
- **Rest timers.** Nothing: no screen reads a rest push once it is sent, taken back or late.

**For somebody who calls the API by hand:**

| Who calls | Answer |
|---|---|
| nobody signed in, or any account | `permission denied for function run_retention` |
| the service-role key | it runs, and answers the three counts |

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_13_18_retention.audit.sql
```

What it prints, before and after the migration:

| # | check | before | after |
|---|---|---|---|
| 1 | running as | `postgres` | `postgres` |
| 2 | the rows nobody reads any more are deleted by one function (run_retention, L27) | `no` | `yes` |
| 3 | functions of that name that the migration does not know | `none` | `none` |
| 4 | who may execute it, besides its owner | `it is not there` | `service_role` |
| 5 | it runs with the rights of | `it is not there` | `its caller` |
| 6 | its search_path | `it is not there` | `public, pg_temp` |
| 7 | rest pushes | a number | the same number |
| 8 | rest pushes created more than 7 days ago: what a run deletes | a number | the same number |
| 9 | … the oldest of them is from | a date | the same date |
| 10 | rest pushes created more than 7 days ago that are still to be sent: kept | `0` | `0` |
| 11 | notifications | a sentence | the same sentence |
| 12 | notifications read more than 90 days ago: what a run deletes | a number | the same number |
| 13 | notifications never read that are older than 90 days: kept | a number | the same number |
| 14 | client errors | a number | the same number |
| 15 | client errors older than 90 days: what a run deletes | a number | the same number |
| 16 | who runs it | a sentence | the same sentence |

Lines 7 to 15 are the rows. **The migration deletes none of them: every number is the same before and after it.** Lines 8, 12 and 15 are what a run of the function deletes — which is why this audit is also the first step of the monthly routine.

If the "before" column is not what you see:

- **1** is not `postgres` — stop and report. The migration refuses to run as anyone else.
- **2 already reads `yes`** — read the ledger (below). If migration 18 is there, you are done. If it is not, a function of that name was made by hand: stop and report.
- **3** is not `none` — **stop and report the line.** A function named `run_retention` with arguments exists; the migration refuses to run next to it.
- **4, 5 or 6** is not `it is not there` before the migration — same as 2.
- **8** is nearly all of line 7 — expected the first time: nothing has deleted a row of that table so far. **9** says how far back they go.
- **10** is not `0` — it does not stop the migration: [A rest push that is kept](#a-rest-push-that-is-kept).
- **12, 13 and 15** — any numbers. 13 is never deleted.
- **16** reads `pg_cron is installed: …` — pg_cron was switched on before this checkpoint. That does not stop the migration; the job itself is made by migration 19.

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_13_18_retention.sql
```

It creates a function and holds no table: no request waits for it.

A refusal changes nothing:

| Message contains | Meaning | Do |
|---|---|---|
| `needs 2026_10_13_17_replay_grace_window, which is not applied` (code `SLM02`) | migration 17 is not in the database | apply it first, with its checks |
| `must be run as postgres` | line 1 of the audit | stop and report |
| `would not create: … is already there` | lines 2 and 3 of the audit: a function named `run_retention` exists | stop and report the names |
| `does not find the columns its function is written with: …` | a column of one of the three tables is not there under its name | stop and report the full message |
| `did not get the function it meant: …` | the file read its own result back and it was not the one described here | stop and report the full message |

## After

1. Run the audit again. Lines 2, 4, 5 and 6 read as the "after" column; **lines 7 to 15 are the numbers they were**.

2. Read the ledger:

   ```bash
   supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
   ```

   Expected: eighteen rows, the last one `2026_10_13_18_retention`.

3. See it for yourself. This creates an account with eight rows of its own: three rest pushes — one of 8 days ago, one of 6 days ago, one of 8 days ago that is waiting for a time still to come —, three notifications — read 91 days ago, read 89 days ago, never read and 400 days old — and two client errors, of 91 and of 89 days ago. Through the API's role, as that account, it tries to run the function. Then it runs it as you do — **for real: the run deletes what lines 8, 12 and 15 of the audit count** — and looks which of the eight rows are left. Then it fails **whatever happened**, so that nothing is kept: the account, its rows, and everything the run deleted are back. The answer is in the message:

   ```bash
   supabase db query --linked 'do $check$
   declare
     v_account uuid := gen_random_uuid();
     v_push_old uuid := gen_random_uuid();
     v_push_recent uuid := gen_random_uuid();
     v_push_waiting uuid := gen_random_uuid();
     v_note_old uuid := gen_random_uuid();
     v_note_recent uuid := gen_random_uuid();
     v_note_unread uuid := gen_random_uuid();
     v_error_old uuid := gen_random_uuid();
     v_error_recent uuid := gen_random_uuid();
     v_ran jsonb;
     v_gone text;
     v_left text;
     v_answer text;
   begin
     if to_regprocedure($m$public.run_retention()$m$) is null then
       raise exception $m$check only, nothing was written: NOT THERE: the function run_retention is not in the database$m$;
     end if;

     insert into auth.users (id, email, aud, role)
       values (v_account, $m$sl-check-18@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$);
     insert into public.scheduled_pushes (id, user_id, fire_at, status, created_at) values
       (v_push_old, v_account, now() - interval $m$8 days$m$, $m$sent$m$, now() - interval $m$8 days$m$),
       (v_push_recent, v_account, now() - interval $m$6 days$m$, $m$sent$m$, now() - interval $m$6 days$m$),
       (v_push_waiting, v_account, now() + interval $m$1 minute$m$, $m$pending$m$, now() - interval $m$8 days$m$);
     insert into public.notifications (id, recipient_id, kind, read_at, created_at) values
       (v_note_old, v_account, $m$sl-check-18$m$, now() - interval $m$91 days$m$, now() - interval $m$100 days$m$),
       (v_note_recent, v_account, $m$sl-check-18$m$, now() - interval $m$89 days$m$, now() - interval $m$100 days$m$),
       (v_note_unread, v_account, $m$sl-check-18$m$, null, now() - interval $m$400 days$m$);
     insert into public.client_errors (id, user_id, message, created_at) values
       (v_error_old, v_account, $m$sl-check-18$m$, now() - interval $m$91 days$m$),
       (v_error_recent, v_account, $m$sl-check-18$m$, now() - interval $m$89 days$m$);

     perform set_config($m$role$m$, $m$authenticated$m$, true);
     perform set_config($m$request.jwt.claims$m$,
       json_build_object($m$sub$m$, v_account, $m$role$m$, $m$authenticated$m$)::text, true);
     begin
       perform public.run_retention();
       v_answer := $m$NOT PROTECTED: a signed-in user ran the function$m$;
     exception when insufficient_privilege then
       null;
     end;

     perform set_config($m$role$m$, $m$postgres$m$, true);
     perform set_config($m$request.jwt.claims$m$, $m$$m$, true);
     v_ran := public.run_retention();

     select string_agg(w.what, $m$, $m$ order by w.n) filter (where w.kept and not w.there),
            string_agg(w.what, $m$, $m$ order by w.n) filter (where not w.kept and w.there)
       into v_gone, v_left
       from (values
         (1, false, $m$the rest push of 8 days ago$m$,
             exists (select 1 from public.scheduled_pushes sp where sp.id = v_push_old)),
         (2, true, $m$the rest push of 6 days ago$m$,
             exists (select 1 from public.scheduled_pushes sp where sp.id = v_push_recent)),
         (3, true, $m$the rest push that is still to be sent$m$,
             exists (select 1 from public.scheduled_pushes sp where sp.id = v_push_waiting)),
         (4, false, $m$the notification read 91 days ago$m$,
             exists (select 1 from public.notifications n where n.id = v_note_old)),
         (5, true, $m$the notification read 89 days ago$m$,
             exists (select 1 from public.notifications n where n.id = v_note_recent)),
         (6, true, $m$the notification that was never read$m$,
             exists (select 1 from public.notifications n where n.id = v_note_unread)),
         (7, false, $m$the client error of 91 days ago$m$,
             exists (select 1 from public.client_errors ce where ce.id = v_error_old)),
         (8, true, $m$the client error of 89 days ago$m$,
             exists (select 1 from public.client_errors ce where ce.id = v_error_recent))
       ) as w (n, kept, what, there);

     v_answer := coalesce(v_answer, case
       when v_gone is not null
         then $m$NOT PROTECTED: the run deleted $m$ || v_gone
       when v_left is not null
         then $m$BROKEN: the run left $m$ || v_left
       when coalesce((v_ran->>$m$scheduled_pushes$m$)::integer, 0) < 1
         or coalesce((v_ran->>$m$notifications$m$)::integer, 0) < 1
         or coalesce((v_ran->>$m$client_errors$m$)::integer, 0) < 1
         then $m$BROKEN: run_retention did not answer how many rows of each table it deleted$m$
       else $m$in place: a run deletes the rest pushes older than 7 days, the notifications read more than 90 days ago and the client errors older than 90 days; it keeps what is more recent, a rest push that is still to be sent and a notification that was never read; a signed-in user cannot run it$m$
     end);
     raise exception $m$check only, nothing was written: %$m$, v_answer;
   end $check$'
   ```

   The command must fail with `check only, nothing was written: in place: a run deletes the rest pushes older than 7 days, the notifications read more than 90 days ago and the client errors older than 90 days; it keeps what is more recent, a rest push that is still to be sent and a notification that was never read; a signed-in user cannot run it`. Run before the migration, it fails with `… NOT THERE: the function run_retention is not in the database` — and writes nothing either.

   Anything else is **not** the answer:

   - `… NOT THERE: …` after the migration — the migration is not in this database. Read the ledger.
   - `… NOT PROTECTED: …` or `… BROKEN: …` — the function does not do what this page says: **roll back, and do not run it**. Report the full message.
   - a message that does not start with `check only` — the check could not get as far as its questions (the message says why). Nothing was written. Report it; lines 2 to 6 of the audit are then what says whether the migration is in place.

4. Run the audit a last time: lines 7 to 15 are still the numbers of step 1. The check deleted nothing that stayed deleted.

5. **The first run** is not part of the migration. It deletes the rows of lines 8, 12 and 15 — on the first run, nearly every rest push there is. It is the monthly routine, done for the first time: [70 — By hand, outside a checkpoint](../70-admin-procedures.md#once-a-month-delete-what-nobody-reads-any-more). The backup of this checkpoint is the one that holds those rows.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_13_18_retention.down.sql
```

It drops the function, and nothing else.

**It reopens L27**: nothing deletes the rest pushes of an account that stopped training, a notification that was read or a client error any more. Nothing anybody sees changes, and every app works without the function as it did before it. The only reasons to run this file are step 3 answering `NOT PROTECTED` or `BROKEN`, or a migration applied to the wrong project.

**What a run deleted does not come back.** The migration deletes no row and its rollback writes none: the rows a run of the function removed are in the backup taken before that run, and nowhere else.

It is refused (code `SLM04`) once a later migration is in the ledger — the job of migration 19 calls the function every night. Roll those back first, last applied first.

## A rest push that is kept

For line 10 of the audit, which reads `0` unless a phone's clock is days ahead. The app from before wave 3 writes the time of a rest push from the clock of the phone: a rest that "ends" in nine days is a row that is still waiting a week after it was written. The function leaves it alone — a row that is waiting for its time belongs to whoever will send it — and deletes it on the first run after that time has passed.

```bash
supabase db query --linked "select pr.full_name as account, sp.created_at::date as written_on, sp.fire_at as due, sp.id as rest_push_id from public.scheduled_pushes sp join public.profiles pr on pr.id = sp.user_id where sp.created_at < now() - interval '7 days' and sp.status = 'pending' and sp.canceled_at is null and sp.fire_at > now() - interval '60 seconds' order by sp.fire_at"
```

Nothing to do about one that is due within days. One that is due in months is a notification *Rest done* that its athlete will get out of nowhere, where the job of migration 19 runs. Take it back — the row stays, closed, and goes with the next run:

```bash
supabase db query --linked "update public.scheduled_pushes set status = 'canceled', canceled_at = now() where id = '<id of the rest push>' and status = 'pending' returning id"
```

It returns the id, or no row: the rest push was sent or closed in the meantime.
