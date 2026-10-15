# 22 — A client error is read by its author and the coach of its author; an account reports 30 an hour at most

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_16_22_client_errors_scope.sql` |
| Audit | `supabase/audits/2026_10_16_22_client_errors_scope.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_16_22_client_errors_scope.down.sql` |
| Kind | required · replaces 1 policy, adds 1 trigger and its function; no table, no column, no row |
| Wave / checkpoint | 3 / C1 |
| Findings | B6, L20 |
| Needs | migration 21 |

Safe with the app that is deployed today and with every version before it: the athlete's app reports its errors as before, and the coach's list of errors shows what it should.

## What it does

When the app breaks on a phone, it reports the error: the message, the code that failed, the page and the browser. You see the 20 most recent at the bottom of the Athletes roster. Until now:

- **every coach read every line** — the errors of the athletes of any other coach included (B6);
- **an account could report without end**: a page caught in a loop, or somebody with a script, filled the table (L20).

From this migration on:

1. **A line is read by its author and by the coach of its author.** An athlete reads their own lines (the app shows them none); you read those of your athletes and your own.
2. **A line without an author is read by every coach**: the lines the database writes itself — *Push: 3 of 41 requests … failed*, with the role `DATABASE`, where pg_cron is on (migration 19) — and those of an account that was deleted.
3. **An account reports 30 lines an hour at most.** The 31st and the next are dropped without a word: the app is not told, and does not need to be — it ignores the answer anyway. An hour later it reports again.
4. **A line is dated when it arrives**, whatever date the request carries: one sent with a date long past would escape both the count of the hour and the deletion after 90 days.

What does not change:

- **Who writes a line**: a signed-in account, for itself, with its own role — as before.
- **Old lines**: `run_retention()` (migration 18) deletes a line 90 days after it was reported, as before. This migration deletes nothing.
- **The SQL editor and the service role** write and read every line, uncapped — so does the job of migration 19.

## What the deployed client does differently

**The coach:** the list of errors at the bottom of the roster shows the lines of your athletes, your own, and the lines without an author — not those of an account that is no longer, or never was, your athlete. With one coach, that is the lines of a former athlete, and nothing else.

**The athlete: nothing.** The app reports an error as before. Past the 30th of an hour, it is not kept.

**For somebody who calls the API by hand:**

| Who | What | Answer |
|---|---|---|
| an athlete | read `client_errors` | their own lines |
| a coach | read `client_errors` | their own lines, those of their athletes, and those without an author |
| a coach | the lines of the athlete of another coach | none |
| an account | report a 31st line within an hour | `201`, as for a line that is kept — nothing is written |
| an account | report a line with a date in it | kept, dated when it arrived |
| the SQL editor, the service role | anything | as before |

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_16_22_client_errors_scope.audit.sql
```

What it prints, before and after the migration:

| # | check | before | after |
|---|---|---|---|
| 1 | running as | `postgres` | `postgres` |
| 2 | who reads a client error (B6) | `every coach, every line` | `its author and the coach of its author; every coach, a line without an author` |
| 3 | how many lines an account reports in an hour (L20) | `no limit` | `30 — the next ones are dropped` |
| 4 | policies of client_errors that the migration does not know | `none` | `none` |
| 5 | lines | a number | the same number |
| 6 | … without an author: the database's, or of an account that was deleted | a number | the same number |
| 7 | … of an account that no coach of today coaches, other than a coach's own | a number | the same number |
| 8 | the most lines one account reported within one hour | a number | the same number |
| 9 | lines older than 90 days, which run_retention() deletes | a number | the same number |

Lines 2 and 3 are the migration. Lines 5 to 9 are the rows; the migration writes none of them.

If the "before" column is not what you see:

- **1** is not `postgres` — stop and report. The migration refuses to run as anyone else.
- **2** or **3** already reads the "after" column — read the ledger (below). If migration 22 is there, you are done. If it is not, something of that name was made by hand: stop and report.
- **2** starts with `SOMETHING ELSE:` or **4** is not `none` — **stop and report the line.** A policy on the table was made by hand; the migration refuses to run next to it.
- **6** — any number: read by every coach, before and after.
- **7** — any number: lines of a former athlete. You read them before; after, only their author does. [Who reported what](#who-reported-what) lists them by account.
- **8** — above 30: an account that reported more than 30 errors within an hour. From the migration on, the lines past the 30th of an hour are not kept. [Who reported what](#who-reported-what) says which account.
- **9** — 0 where `run_retention()` runs; otherwise the lines it deletes at its next run.

## Who reported what

For lines 5 to 8 of the audit — every account that reported, with who reads its lines once the migration is applied:

```bash
supabase db query --linked "select coalesce(pr.full_name, '(no account)') as account, coalesce(pr.role, min(e.role)) as role, count(*) as lines, max(e.created_at) as last_line, case when e.user_id is null then 'every coach' when pr.role = 'coach' then 'that coach' when exists (select 1 from public.students s where s.profile_id = e.user_id) then 'the athlete and their coach' else 'that account only' end as read_after, e.user_id from public.client_errors e left join public.profiles pr on pr.id = e.user_id group by e.user_id, pr.full_name, pr.role order by 3 desc, 1"
```

`read_after` is who reads that account's lines once the migration is applied:

- **`every coach`** — the lines without an author (`(no account)`): the database's (role `database`) and those of a deleted account.
- **`that coach`** — a coach's own lines.
- **`the athlete and their coach`** — an athlete's lines: they and you.
- **`that account only`** — an account that is nobody's athlete any more, or never was. You no longer see its lines in the app. Read them here when you need them.

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_16_22_client_errors_scope.sql
```

It holds the table of errors against writes for an instant: an error reported in that instant waits for it.

A refusal changes nothing:

| Message contains | Meaning | Do |
|---|---|---|
| `needs 2026_10_16_21_rpe_half_steps_day_check, which is not applied` (code `SLM02`) | migration 21 is not in the database | apply it first, with its checks |
| `must be run as postgres` | line 1 of the audit | stop and report |
| `found a policy it does not know on client_errors` | line 4 of the audit | stop and report the full message |
| `would not replace "Coaches read client errors"` | line 2 of the audit | stop and report |
| `would not create: … is already there` | a trigger on the table, or a function of that name, made by hand | stop and report the names |
| `did not get what it meant: …` | the file read its own result back and it was not the one described here | stop and report the full message |
| `canceling statement due to lock timeout` | a request held the table for more than five seconds | nothing was changed: run it again |

## After

1. Run the audit again. Lines 2 and 3 read as the "after" column; the others are unchanged.

2. Read the ledger:

   ```bash
   supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
   ```

   Expected: twenty-one rows, the last one `2026_10_16_22_client_errors_scope` — twenty-two where the optional migration 19 was applied at Checkpoint B.

3. See it for yourself. This creates two coaches, each with an athlete. As the owner it writes a line for the first athlete, one for the second athlete, one for the first coach, and one without an author, as the database writes them. Through the API's role, each of the four accounts reads the lines of the check. The second athlete reports a line dated in the year 2000; the first athlete reports 31 lines; then the owner writes one more for them. Then it fails **whatever happened**, so that nothing is kept, the four accounts included. The answer is in the message:

   ```bash
   supabase db query --linked 'do $check$
   declare
     v_coach uuid := gen_random_uuid();
     v_athlete uuid := gen_random_uuid();
     v_other_coach uuid := gen_random_uuid();
     v_other_athlete uuid := gen_random_uuid();
     v_who uuid;
     v_seen integer[] := array[]::integer[];
     v_count integer;
     v_dated timestamptz;
     v_kept integer;
     v_after_owner integer;
     v_odd text := $m$$m$;
     v_result text;
   begin
     if not exists (select 1 from pg_trigger t
                     where t.tgrelid = to_regclass($m$public.client_errors$m$)
                       and t.tgname = $m$trg_cap_client_errors$m$ and not t.tgisinternal) then
       raise exception $m$check only, nothing was written: NOT THERE: every coach reads every client error, and an account reports without end$m$;
     end if;

     insert into auth.users (id, email, aud, role) values
       (v_coach, $m$sl-check-22-coach@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$),
       (v_athlete, $m$sl-check-22-athlete@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$),
       (v_other_coach, $m$sl-check-22-other-coach@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$),
       (v_other_athlete, $m$sl-check-22-other-athlete@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$);
     update public.profiles set role = $m$coach$m$ where id in (v_coach, v_other_coach);
     if (select count(*) from public.profiles where id in (v_coach, v_other_coach) and role = $m$coach$m$) <> 2 then
       raise exception $m$check only, nothing was written: NOT TRIED: the accounts made for the check could not be made coaches$m$;
     end if;
     insert into public.students (profile_id, coach_id) values (v_athlete, v_coach), (v_other_athlete, v_other_coach);
     insert into public.client_errors (user_id, role, message) values
       (v_athlete, $m$student$m$, $m$sl-check-22 athlete$m$),
       (v_other_athlete, $m$student$m$, $m$sl-check-22 other athlete$m$),
       (v_coach, $m$coach$m$, $m$sl-check-22 coach$m$),
       (null, $m$database$m$, $m$sl-check-22 database$m$);

     perform set_config($m$role$m$, $m$authenticated$m$, true);
     foreach v_who in array array[v_athlete, v_coach, v_other_coach, v_other_athlete] loop
       perform set_config($m$request.jwt.claims$m$, json_build_object($m$sub$m$, v_who, $m$role$m$, $m$authenticated$m$)::text, true);
       select count(*) into v_count from public.client_errors where message like $m$sl-check-22 %$m$;
       v_seen := v_seen || v_count;
     end loop;

     perform set_config($m$request.jwt.claims$m$, json_build_object($m$sub$m$, v_other_athlete, $m$role$m$, $m$authenticated$m$)::text, true);
     begin
       insert into public.client_errors (user_id, role, message, created_at)
         values (v_other_athlete, $m$student$m$, $m$sl-check-22 dated$m$, $m$2000-01-01$m$);
     exception when others then
       v_odd := v_odd || $m$, a line of the second athlete: $m$ || sqlerrm;
     end;

     perform set_config($m$request.jwt.claims$m$, json_build_object($m$sub$m$, v_athlete, $m$role$m$, $m$authenticated$m$)::text, true);
     for v_count in 1 .. 31 loop
       begin
         insert into public.client_errors (user_id, role, message) values (v_athlete, $m$student$m$, $m$sl-check-22 loop$m$);
       exception when others then
         v_odd := v_odd || $m$, line $m$ || v_count || $m$: $m$ || sqlerrm;
       end;
     end loop;

     perform set_config($m$role$m$, $m$postgres$m$, true);
     perform set_config($m$request.jwt.claims$m$, $m$$m$, true);
     select min(created_at) into v_dated from public.client_errors where message = $m$sl-check-22 dated$m$;
     select count(*) into v_kept from public.client_errors where user_id = v_athlete;
     insert into public.client_errors (user_id, role, message) values (v_athlete, $m$student$m$, $m$sl-check-22 owner$m$);
     select count(*) into v_after_owner from public.client_errors where user_id = v_athlete;

     v_result := case
       when v_seen[1] > 1 or v_seen[2] > 3 or v_seen[3] > 2 or v_seen[4] > 1
         then $m$NOT PROTECTED: a line was read by somebody who is neither its author nor the coach of its author: $m$ || array_to_string(v_seen, $m$, $m$) || $m$ lines read$m$
       when v_kept > 30
         then $m$NOT PROTECTED: an account kept $m$ || v_kept || $m$ lines within an hour$m$
       when v_odd <> $m$$m$
         then $m$BROKEN: a line was refused: $m$ || substr(v_odd, 3)
       when v_seen <> array[1, 3, 2, 1]
         then $m$BROKEN: the athlete, their coach, the other coach and the other athlete read $m$ || array_to_string(v_seen, $m$, $m$) || $m$ lines of the check, not 1, 3, 2 and 1$m$
       when v_dated is distinct from now()
         then $m$BROKEN: a line sent with a date kept $m$ || coalesce(v_dated::text, $m$nothing$m$)
       when v_kept <> 30
         then $m$BROKEN: an account kept $m$ || v_kept || $m$ lines within an hour, not 30$m$
       when v_after_owner <> 31
         then $m$BROKEN: the owner could not write a 31st line for an account$m$
       else $m$in place: a line is read by its author and the coach of its author, a line without an author by every coach; an account keeps 30 lines an hour, dated when they arrive; the owner is not counted$m$
     end;
     raise exception $m$check only, nothing was written: %$m$, v_result;
   end $check$'
   ```

   The command must fail with `check only, nothing was written: in place: a line is read by its author and the coach of its author, a line without an author by every coach; an account keeps 30 lines an hour, dated when they arrive; the owner is not counted`. Run before the migration, the same command fails with `… NOT THERE: every coach reads every client error, and an account reports without end` — and writes nothing either.

   Anything else is **not** the answer:

   - `… NOT THERE: …` after the migration — the migration is not in this database. Read the ledger.
   - `… NOT PROTECTED: …` or `… BROKEN: …` — the migration does not do what this page says: **roll back**, and report the full message.
   - `… NOT TRIED: the accounts made for the check could not be made coaches` — migration 07 is not in the database, or was rolled back. Read the ledger.
   - a message that does not start with `check only` — the check could not get as far as its questions (the message says why). Nothing was written. Report it; lines 2 and 3 of the audit are then what says whether the migration is in place.

4. In the app, as the coach: the list of errors at the bottom of the roster shows what [Who reported what](#who-reported-what) says you read — the lines `that account only` are gone from it.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_16_22_client_errors_scope.down.sql
```

It drops the trigger and its function, and puts back the policy under which every coach reads every line.

**It reopens B6 and the cap of L20**: from then on any coach reads the errors of every account, and an account reports without end. Every app works without the migration as it did before it. The only reasons to run this file are step 3 answering `NOT PROTECTED` or `BROKEN`, or a migration applied to the wrong project.

No row is written or deleted by it. The lines the cap dropped were never written.

It is refused (code `SLM04`) once a later migration is in the ledger. Roll those back first, last applied first.
