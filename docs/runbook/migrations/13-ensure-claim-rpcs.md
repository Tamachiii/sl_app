# 13 — The missing sets of a session are added by the database, and a device follows the account that signs in

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_13_13_ensure_claim_rpcs.sql` |
| Audit | `supabase/audits/2026_10_13_13_ensure_claim_rpcs.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_13_13_ensure_claim_rpcs.down.sql` |
| Kind | required · expand: adds 2 functions; no table, no column, no policy, no trigger, no row |
| Wave / checkpoint | 1 / A3 |
| Findings | L8, P22, P15 (the database's half); what L6 needs later |
| Needs | migration 12 |

Safe with the app that is deployed today: nothing calls the two functions yet, and nothing that exists is changed. The version of the app that follows wave 1 calls them — this migration must be in the database before that version is published, and the deploy checks the ledger for it.

## What it does

Two things an account does for itself are done by the app today, with the rights the database gives every account — and those rights do not fit:

- **The sets of a session.** Each set is a row. When an exercise has fewer rows than its number of sets, the athlete's app adds the others as the session is opened — with the number of sets, the reps and the load it has in its own memory, which it keeps for fourteen days. A set the coach has removed since comes back (P22, L8). And because the app must be able to add a set with targets, an athlete may add one with the targets of their choosing (L6): that cannot be closed while the app inserts.
- **The device.** Switching notifications on registers the browser or the phone under the account that is signed in. The browser keeps that registration when the account signs out, so the next account on the same device is handed the same one — and may not take it over. The device goes on receiving the notifications of the first account, and the second can never switch its own on (P15).

The migration adds one function for each:

1. **`ensure_set_logs(p_session_id)`** adds the sets that are missing in one session, reading the exercises as they are in the database at that moment, and answers how many it added. For the athlete of the session only, and only where an athlete may write: the block being trained, a session the coach has neither archived nor reviewed. Nothing that exists is touched.
2. **`claim_push_subscription(p_endpoint, p_p256dh, p_auth, p_user_agent)`** registers the device for the account that calls. An address nobody holds is created; the caller's own is refreshed; one that **another** account holds moves to the caller only when the two keys sent are the ones stored with it — which the browser that holds the registration can present, and nobody who merely learnt the address.

Both run with the rights of the owner of the database, not of the caller — they do what no rule lets an account do by itself — and each asks who calls before it does anything. Nothing else changes: no table, no rule, no row.

`ensure_set_logs` also marks the rows it adds, for the length of its own `INSERT`, with a setting called `app.trusted_set_log_insert`. Nothing reads it yet. A later migration (Checkpoint Z) will turn a set an athlete inserts by hand into an extra set without targets, and tell the rows of this function from those by that mark.

## What the deployed client does differently

Nothing. The app that is deployed does not call these functions: it goes on adding the missing sets and registering the device with its own requests, which work as before.

**For somebody who calls the API by hand:**

| Who calls | Answer |
|---|---|
| nobody signed in | `permission denied for function ensure_set_logs` (or `claim_push_subscription`) |
| an account, for a session that is not its own — another athlete's, one of an athlete it coaches, an id that is no session | `not authorized` |
| the athlete, for a session of a past block, of a draft or of a block in the trash | `program_not_active` |
| the athlete, for a session the coach has archived or reviewed | `session_not_writable` |
| an account, with an address or a key that is missing or empty | `subscription_incomplete` |
| an account, for an address another account holds, with other keys than the ones stored with it | `endpoint_keys_mismatch` |

In every one of those cases nothing was written.

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_13_13_ensure_claim_rpcs.audit.sql
```

What it prints, before and after the migration:

| # | check | before | after |
|---|---|---|---|
| 1 | running as | `postgres` | `postgres` |
| 2 | the missing sets of a session are added by the database (ensure_set_logs, L8) | `no` | `yes` |
| 3 | a device's push subscription follows the account that signs in (claim_push_subscription, P15) | `no` | `yes` |
| 4 | functions of these names that the migration does not know | `none` | `none` |
| 5 | functions of this migration a request without a session may execute | `none` | `none` |
| 6 | functions of this migration a signed-in user may execute | `none` | `claim_push_subscription(text, text, text, text); ensure_set_logs(uuid)` |
| 7 | functions of this migration that run as their owner | `none` | `claim_push_subscription(text, text, text, text); ensure_set_logs(uuid)` |
| 8 | functions of this migration without search_path = public, pg_temp | `none` | `none` |
| 9 | exercises of a session in progress that miss a set | a number | the same number |
| 10 | devices registered for notifications | a number | the same number |

Line 7 is meant: unlike the functions of migrations 11 and 12, these two run as their owner. Lines 9 and 10 are what the two functions work on. The migration changes neither, and neither stops it.

If the "before" column is not what you see:

- **1** is not `postgres` — stop and report. The migration refuses to run as anyone else.
- **2 or 3 already reads `yes`** — read the ledger (below). If migration 13 is there, you are done. If it is not, a function of that name was made by hand: stop and report.
- **4** is not `none` — **stop and report the line.** A function with one of the two names and other arguments exists; the migration refuses to run next to it.
- **5 or 8** is not `none`, or **6 or 7** is not `none` before the migration — same: stop and report.
- **9** is not `0` — go on, and read [Exercises that miss a set](#exercises-that-miss-a-set) afterwards.
- **10** — any number. [Devices registered for notifications](#devices-registered-for-notifications) says who holds them.

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_13_13_ensure_claim_rpcs.sql
```

A refusal changes nothing:

| Message contains | Meaning | Do |
|---|---|---|
| `needs 2026_10_13_12_copy_rpcs, which is not applied` (code `SLM02`) | migration 12 is not in the database | apply it first, with its checks |
| `must be run as postgres` | line 1 of the audit | stop and report |
| `would not create: … is already there` | lines 2 to 4 of the audit: a function of one of the two names exists | stop and report the names |
| `does not find the columns its functions are written with: …` | a column of `exercise_slots`, `set_logs` or `push_subscriptions` is not there under its name | stop and report the full message |
| `does not find the functions its functions call: …` | one of the three functions of migration 08 and before that say whose a session is and whether it can be written is not there | stop and report the full message |
| `does not find the unique keys its functions are written with: …` | `set_logs` no longer holds one row per exercise and set number, or `push_subscriptions` one row per address | stop and report the full message |
| `did not get the functions it meant: …` | the file read its own result back and it was not the one described here | stop and report the full message |

## After

1. Run the audit again. Lines 2 and 3 read `yes`, lines 6 and 7 list the two functions; the others are unchanged.

2. Read the ledger:

   ```bash
   supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
   ```

   Expected: thirteen rows, the last one `2026_10_13_13_ensure_claim_rpcs`.

3. See it for yourself. This creates a coach and two athletes. The first athlete trains a block with one session and one exercise of three sets, of which only the first is in the database. Through the API's role, as the second athlete, it tries to complete that session; as the first, it completes it, twice, and registers a device; as the second, it tries to take that device over with a wrong key, then with the right ones. The device is an address made up for the check: nothing is sent to it. Then it fails **whatever happened**, so that nothing is kept, the three accounts included. The answer is in the message:

   ```bash
   supabase db query --linked 'do $check$
   declare
     v_coach uuid := gen_random_uuid();
     v_athlete uuid := gen_random_uuid();
     v_second uuid := gen_random_uuid();
     v_link uuid := gen_random_uuid();
     v_exercise uuid := gen_random_uuid();
     v_block uuid := gen_random_uuid();
     v_week uuid := gen_random_uuid();
     v_session uuid := gen_random_uuid();
     v_slot uuid := gen_random_uuid();
     v_endpoint text := $m$https://fcm.googleapis.com/fcm/send/sl-check-13-$m$ || gen_random_uuid();
     v_added integer;
     v_again integer;
     v_sets text;
     v_first jsonb;
     v_moved jsonb;
     v_seen_by_first integer;
     v_seen_by_second integer;
     v_answer text;
   begin
     if to_regprocedure($m$public.ensure_set_logs(uuid)$m$) is null
        or to_regprocedure($m$public.claim_push_subscription(text, text, text, text)$m$) is null then
       raise exception $m$check only, nothing was written: NOT THERE: the two functions are not in the database$m$;
     end if;

     insert into auth.users (id, email, aud, role) values
       (v_coach, $m$sl-check-13-coach@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$),
       (v_athlete, $m$sl-check-13-athlete@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$),
       (v_second, $m$sl-check-13-second@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$);
     update public.profiles set role = $m$coach$m$ where id = v_coach;
     if not exists (select 1 from public.profiles where id = v_coach and role = $m$coach$m$) then
       raise exception $m$check only, nothing was written: NOT TRIED: the account made for the check could not be made a coach$m$;
     end if;
     insert into public.students (id, profile_id, coach_id) values
       (v_link, v_athlete, v_coach), (gen_random_uuid(), v_second, v_coach);
     insert into public.exercise_library (id, coach_id, name, type, difficulty)
       values (v_exercise, v_coach, $m$sl-check-13$m$, $m$pull$m$, 1);
     insert into public.programs (id, student_id, name, is_active) values (v_block, v_link, $m$sl-check-13$m$, true);
     insert into public.weeks (id, program_id, week_number) values (v_week, v_block, 1);
     insert into public.sessions (id, week_id, title, sort_order) values (v_session, v_week, $m$one$m$, 0);
     insert into public.exercise_slots (id, session_id, exercise_id, sets, reps, sort_order)
       values (v_slot, v_session, v_exercise, 3, 5, 0);
     insert into public.set_logs (exercise_slot_id, set_number, target_reps) values (v_slot, 1, 8);

     perform set_config($m$role$m$, $m$authenticated$m$, true);
     perform set_config($m$request.jwt.claims$m$,
       json_build_object($m$sub$m$, v_second, $m$role$m$, $m$authenticated$m$)::text, true);
     begin
       perform public.ensure_set_logs(v_session);
       v_answer := $m$NOT PROTECTED: an athlete added sets to the session of another one$m$;
     exception when insufficient_privilege then
       null;
     end;

     if v_answer is null then
       perform set_config($m$request.jwt.claims$m$,
         json_build_object($m$sub$m$, v_athlete, $m$role$m$, $m$authenticated$m$)::text, true);
       v_added := public.ensure_set_logs(v_session);
       v_again := public.ensure_set_logs(v_session);
       if current_setting($m$app.trusted_set_log_insert$m$, true) = $m$on$m$ then
         v_answer := $m$BROKEN: the mark of ensure_set_logs is still on after the call$m$;
       end if;
       select string_agg(sl.set_number || $m$x$m$ || sl.target_reps, $m$ $m$ order by sl.set_number) into v_sets
         from public.set_logs sl where sl.exercise_slot_id = v_slot;
       v_first := public.claim_push_subscription(v_endpoint, $m$key$m$, $m$secret$m$, $m$sl-check-13$m$);
     end if;

     if v_answer is null then
       perform set_config($m$request.jwt.claims$m$,
         json_build_object($m$sub$m$, v_second, $m$role$m$, $m$authenticated$m$)::text, true);
       begin
         perform public.claim_push_subscription(v_endpoint, $m$key$m$, $m$not the secret$m$);
         v_answer := $m$NOT PROTECTED: a device was taken over by an account that did not have its keys$m$;
       exception when raise_exception then
         null;
       end;
     end if;

     if v_answer is null then
       v_moved := public.claim_push_subscription(v_endpoint, $m$key$m$, $m$secret$m$);
       select count(*) into v_seen_by_second from public.push_subscriptions ps where ps.endpoint = v_endpoint;
       perform set_config($m$request.jwt.claims$m$,
         json_build_object($m$sub$m$, v_athlete, $m$role$m$, $m$authenticated$m$)::text, true);
       select count(*) into v_seen_by_first from public.push_subscriptions ps where ps.endpoint = v_endpoint;
       v_answer := case
         when v_added is distinct from 2 or v_again is distinct from 0
           then $m$BROKEN: ensure_set_logs did not add the two missing sets, once$m$
         when v_sets is distinct from $m$1x8 2x5 3x5$m$
           then $m$BROKEN: after ensure_set_logs the sets are not the one that was there and the two of the exercise$m$
         when v_first->>$m$outcome$m$ is distinct from $m$created$m$ or v_moved->>$m$outcome$m$ is distinct from $m$rehomed$m$
           then $m$BROKEN: claim_push_subscription did not create the device, then move it$m$
         when v_seen_by_second is distinct from 1 or v_seen_by_first is distinct from 0
           then $m$BROKEN: after claim_push_subscription the device is not with the account that presented its keys$m$
         else $m$in place: the missing sets of a session are added for its athlete and for nobody else, and a device moves to the account that presents its keys and to no other$m$
       end;
     end if;
     raise exception $m$check only, nothing was written: %$m$, v_answer;
   end $check$'
   ```

   The command must fail with `check only, nothing was written: in place: the missing sets of a session are added for its athlete and for nobody else, and a device moves to the account that presents its keys and to no other`. Run before the migration, the same command fails with `… NOT THERE: the two functions are not in the database` — and writes nothing either.

   Anything else is **not** the answer:

   - `… NOT THERE: …` after the migration — the migration is not in this database. Read the ledger.
   - `… NOT PROTECTED: …` or `… BROKEN: …` — a function does not do what this page says: **roll back**, and report the full message.
   - `… NOT TRIED: the account made for the check could not be made a coach` — migration 07 is not in the database, or was rolled back. Read the ledger.
   - a message that does not start with `check only` — the check could not get as far as its questions (the message says why). Nothing was written. Report it; lines 2 to 8 of the audit are then what says whether the migration is in place.

4. Nothing to look at in the app that is deployed: it does not use the functions.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_13_13_ensure_claim_rpcs.down.sql
```

It drops the two functions. No row is written: the sets that were added stay, and a device stays with the account it was registered for last.

**Not once the version of the app that follows wave 1 is published.** That version completes the sets of a session and registers a device through these functions: without `claim_push_subscription` nobody can switch notifications on, on any device, until the migration is applied again. Before that, nothing calls them, and the only reasons to run this file are step 3 answering `NOT PROTECTED` or `BROKEN`, or a migration applied to the wrong project.

It is refused (code `SLM04`) once a later migration is in the ledger. Roll those back first, last applied first.

## Exercises that miss a set

For line 9 of the audit: exercises that have fewer sets in the database than their number of sets says, in a session its athlete can still write — the block being trained, a session neither archived nor reviewed. It happens to a block that was copied from a draft, and when a request of the coach's editor was lost. List them:

```bash
supabase db query --linked "select pr.full_name as athlete, p.name as block, coalesce(s.title, 'Session') as session, el.name as exercise, es.sets as prescribed, (select count(*) from public.set_logs sl where sl.exercise_slot_id = es.id and sl.set_number <= es.sets) as there from public.exercise_slots es join public.exercise_library el on el.id = es.exercise_id join public.sessions s on s.id = es.session_id join public.weeks w on w.id = s.week_id join public.programs p on p.id = w.program_id join public.students st on st.id = p.student_id join public.profiles pr on pr.id = st.profile_id where p.is_active and p.deleted_at is null and s.archived_at is null and s.reviewed_at is null and exists (select 1 from generate_series(1, es.sets) as wanted (n) where not exists (select 1 from public.set_logs sl where sl.exercise_slot_id = es.id and sl.set_number = wanted.n)) order by 1, 2, w.week_number, s.sort_order, es.sort_order"
```

One row per exercise: how many sets it should have, and how many of those are there. Nothing to repair in the database: the missing ones are added when the athlete opens the session — by the app that is deployed, with its own request, and through `ensure_set_logs` with the next version. Until then the coach sees fewer sets than they wrote when they review that session.

## Devices registered for notifications

For line 10 of the audit. One row per account, with the number of browsers and phones on which it has switched notifications on:

```bash
supabase db query --linked "select pr.role, pr.full_name as account, count(ps.id) as devices, max(ps.last_seen_at)::date as last_seen from public.profiles pr left join public.push_subscriptions ps on ps.user_id = pr.id group by pr.id, pr.role, pr.full_name order by 1, 2"
```

An account with `0` receives no notification on any device: a coach with `0` is not told when a session is confirmed. They switch it on in the installed app: avatar → **Notifications** → *Enable*.

A device that two accounts use is with the one that switched notifications on first, and stays there with the app that is deployed: the second account cannot take it over, and receives nothing on it. With the version that follows wave 1, the device moves to the account that switches notifications on — through `claim_push_subscription` — and the migration needs no clean-up for it.
