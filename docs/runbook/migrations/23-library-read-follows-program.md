# 23 — An exercise is read by whoever reads what uses it

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_16_23_library_read_follows_program.sql` |
| Audit | `supabase/audits/2026_10_16_23_library_read_follows_program.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_16_23_library_read_follows_program.down.sql` |
| Kind | required · adds 1 policy and the function it asks; no table, no column, no row |
| Wave / checkpoint | 3 / C1 |
| Findings | B8 |
| Needs | migration 22 |

Safe with the app that is deployed today and with every version before it: an athlete who never changed coach, and their coach, read exactly what they read before.

## What it does

An exercise of your library is read by you and by your athletes. When an athlete moves to another coach ([`transfer_student`, migration 10](10-goals-fk-coach-links.md)), their blocks keep the exercises of your library: an exercise of a session, an exercise they swapped to, the exercise of a goal. Until now nobody who reads those blocks could read those exercises any more — the athlete is no longer yours, and the new coach does not own them. The app reads the exercise with each session, got nothing, and the athlete's session, the review and the session editor of the coach broke on it (B8).

From this migration on, **an exercise is also read by whoever reads something that uses it**:

- an exercise of a session of a block of an athlete — by the athlete and by their coach of today;
- an exercise an athlete swapped to — by the same two;
- the exercise of a goal — by the athlete and by the coach who holds the goal.

What does not change:

- **Who writes an exercise**: the coach whose library it is — nobody else changes it, renames it or deletes it.
- **Which exercise a new session, a new swap or a copy may take**: one of the library of the athlete's coach of today, as before. The exercises of a former coach are left out of a copy and counted, as before.
- **Your library**: what you read of your own library and your athletes read of it is what it was.
- **A goal takes an exercise of any library**, as before: the database asks whether the exercise of a session or of a swap is in the library of the coach ([migration 05](05-students-role-gate.md)), not the exercise of a goal. A coach who writes a goal for one of their athletes on an exercise of another library — by its id, through the API: the app offers the coach's own library only — reads that exercise from then on.

**Before this migration, move only an athlete who has no program yet** ([page 10](10-goals-fk-coach-links.md)). After it, an athlete moves with their blocks.

## What the deployed client does differently

**Nothing, for an athlete who never changed coach.**

**After a change of coach**, the sessions, the review, the editor and the goals of the blocks written before it show their exercises with their names again — for the athlete and for the new coach. The app that is deployed lists the library of an athlete without a filter: the exercises of the former coach their blocks use appear in the list of exercises an athlete can swap to, next to the library of their coach of today. Swapping to one of them is refused (the toast *Couldn't save that*), as it is for an exercise of any other library. They appear in the athlete's own program builder too: a draft that takes one is refused as a whole when it is saved (`exercise_unavailable`) — it stays on the phone, with the toast *One exercise is no longer in your coach’s library — remove or replace it*, and is saved again once that exercise is taken out.

**For somebody who calls the API by hand:**

| Who reads | An exercise of a former coach's library that… | Answer |
|---|---|---|
| the athlete | a session of their block, a swap of theirs or a goal of theirs uses | the exercise |
| the coach of today | a session or a swap of their athlete's block, or a goal they hold, uses | the exercise |
| the former coach | — | their own library, as before |
| anybody else | — | nothing, as before |
| anybody but the owner of the library | an update or a delete of it | no row is reached, as before |

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_16_23_library_read_follows_program.audit.sql
```

What it prints, before and after the migration:

| # | check | before | after |
|---|---|---|---|
| 1 | running as | `postgres` | `postgres` |
| 2 | who reads an exercise of a library (B8) | `its coach and that coach's athletes` | `its coach, that coach's athletes, and whoever reads what uses it` |
| 3 | functions of this migration a signed-in user may execute | `none` | `exercise_readable_through_use(uuid)` |
| 4 | functions of this migration open without a session, or without search_path = public, pg_temp | `none` | `none` |
| 5 | slots whose exercise is not in the library of the coach of their athlete | a number | the same number |
| 6 | swaps whose exercise is not in the library of the coach of their athlete | a number | the same number |
| 7 | goals whose exercise is not in the library of the coach of their athlete | a number | the same number |
| 8 | athletes those belong to | a number | the same number |

Lines 2 and 3 are the migration. Line 3 is meant: the policy asks the function with the rights of the user who reads.

If the "before" column is not what you see:

- **1** is not `postgres` — stop and report. The migration refuses to run as anyone else.
- **2** reads the "after" column or **3** names the function — read the ledger (below). If migration 23 is there, you are done. If it is not, something of that name was made by hand: stop and report.
- **2** starts with `SOMETHING ELSE:` — **stop and report the line.** A policy that reads the library was made by hand.
- **4** is not `none` — stop and report.
- **5 to 8** — `0` when no athlete with a program ever changed coach. Otherwise: the exercises the app shows without a name today, which the migration gives back to the athlete and to their coach. [The exercises of a former coach](#the-exercises-of-a-former-coach) lists them.

## The exercises of a former coach

For lines 5 to 8 of the audit — each exercise a block or a goal of an athlete uses that is not in the library of their coach of today, before or after the migration:

```bash
supabase db query --linked "select pa.full_name as athlete, pc.full_name as coach_today, el.name as exercise, po.full_name as library_of, count(*) filter (where u.kind = 'slot') as slots, count(*) filter (where u.kind = 'swap') as swaps, count(*) filter (where u.kind = 'goal') as goals, el.id as exercise_id from (select st.id as link, es.exercise_id, 'slot' as kind from public.exercise_slots es join public.sessions se on se.id = es.session_id join public.weeks w on w.id = se.week_id join public.programs p on p.id = w.program_id join public.students st on st.id = p.student_id union all select st.id, d.substitute_exercise_id, 'swap' from public.slot_deviations d join public.exercise_slots es on es.id = d.exercise_slot_id join public.sessions se on se.id = es.session_id join public.weeks w on w.id = se.week_id join public.programs p on p.id = w.program_id join public.students st on st.id = p.student_id where d.substitute_exercise_id is not null union all select st.id, g.exercise_id, 'goal' from public.goals g join public.students st on st.profile_id = g.student_id) u join public.students st on st.id = u.link join public.exercise_library el on el.id = u.exercise_id join public.profiles pa on pa.id = st.profile_id join public.profiles pc on pc.id = st.coach_id join public.profiles po on po.id = el.coach_id where el.coach_id is distinct from st.coach_id group by pa.full_name, pc.full_name, el.name, po.full_name, el.id order by 1, 3"
```

Nothing to do about them. The athlete trains them as before; the new coach reads them, and may replace one in a session with an exercise of their own library. The former coach keeps them in their library, archived or not: an exercise that a block uses cannot be deleted ([page 10](10-goals-fk-coach-links.md)).

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_16_23_library_read_follows_program.sql
```

It holds the library against writes for an instant: an exercise saved in that instant waits for it.

A refusal changes nothing:

| Message contains | Meaning | Do |
|---|---|---|
| `needs 2026_10_16_22_client_errors_scope, which is not applied` (code `SLM02`) | migration 22 is not in the database | apply it first, with its checks |
| `must be run as postgres` | line 1 of the audit | stop and report |
| `would not create: … is already there` | lines 2 and 3 of the audit: the policy or the function exists, made by hand | stop and report the names |
| `does not find what its function is written with: …` | a column the function reads is not there under its name | stop and report the full message |
| `did not get what it meant: …` | the file read its own result back and it was not the one described here | stop and report the full message |
| `canceling statement due to lock timeout` | a request held the library for more than five seconds | nothing was changed: run it again |

## After

1. Run the audit again. Lines 2 and 3 read as the "after" column; the others are unchanged.

2. Read the ledger:

   ```bash
   supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
   ```

   Expected: twenty-two rows, the last one `2026_10_16_23_library_read_follows_program` — twenty-three where the optional migration 19 was applied at Checkpoint B.

3. See it for yourself. This creates three coaches and an athlete of the first. The first coach writes four exercises; the athlete's block uses the first in a session, the athlete swaps to the second, and the coach sets a goal on the third; the fourth is used by nothing. As the owner, it moves the athlete to the second coach with `transfer_student`. Through the API's role, the athlete, the new coach, the former coach and the third coach each read the four exercises; the new coach tries to rename one, and to put one in a new session of the athlete's block. Then it fails **whatever happened**, so that nothing is kept, the four accounts included. The answer is in the message:

   ```bash
   supabase db query --linked 'do $check$
   declare
     v_coach uuid := gen_random_uuid();
     v_new_coach uuid := gen_random_uuid();
     v_stranger uuid := gen_random_uuid();
     v_athlete uuid := gen_random_uuid();
     v_link uuid := gen_random_uuid();
     v_used uuid := gen_random_uuid();
     v_swapped uuid := gen_random_uuid();
     v_goal uuid := gen_random_uuid();
     v_unused uuid := gen_random_uuid();
     v_block uuid := gen_random_uuid();
     v_week uuid := gen_random_uuid();
     v_session uuid := gen_random_uuid();
     v_slot uuid := gen_random_uuid();
     v_other_slot uuid := gen_random_uuid();
     v_who uuid;
     v_read integer[] := array[]::integer[];
     v_count integer;
     v_renamed integer;
     v_put text;
     v_result text;
   begin
     if to_regprocedure($m$public.exercise_readable_through_use(uuid)$m$) is null then
       raise exception $m$check only, nothing was written: NOT THERE: an exercise is read by its coach and the athletes of that coach only$m$;
     end if;

     insert into auth.users (id, email, aud, role) values
       (v_coach, $m$sl-check-23-coach@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$),
       (v_new_coach, $m$sl-check-23-new-coach@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$),
       (v_stranger, $m$sl-check-23-stranger@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$),
       (v_athlete, $m$sl-check-23-athlete@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$);
     update public.profiles set role = $m$coach$m$ where id in (v_coach, v_new_coach, v_stranger);
     if (select count(*) from public.profiles where id in (v_coach, v_new_coach, v_stranger) and role = $m$coach$m$) <> 3 then
       raise exception $m$check only, nothing was written: NOT TRIED: the accounts made for the check could not be made coaches$m$;
     end if;
     insert into public.students (id, profile_id, coach_id) values (v_link, v_athlete, v_coach);
     insert into public.exercise_library (id, coach_id, name, type, difficulty) values
       (v_used, v_coach, $m$sl-check-23 used$m$, $m$pull$m$, 1),
       (v_swapped, v_coach, $m$sl-check-23 swapped$m$, $m$pull$m$, 1),
       (v_goal, v_coach, $m$sl-check-23 goal$m$, $m$pull$m$, 1),
       (v_unused, v_coach, $m$sl-check-23 unused$m$, $m$pull$m$, 1);
     insert into public.programs (id, student_id, name, is_active) values (v_block, v_link, $m$sl-check-23 block$m$, true);
     insert into public.weeks (id, program_id, week_number) values (v_week, v_block, 1);
     insert into public.sessions (id, week_id, title, sort_order) values (v_session, v_week, $m$one$m$, 0);
     insert into public.exercise_slots (id, session_id, exercise_id, sets, reps, sort_order)
       values (v_slot, v_session, v_used, 3, 5, 0), (v_other_slot, v_session, v_used, 3, 5, 1);
     insert into public.slot_deviations (exercise_slot_id, student_id, kind, substitute_exercise_id)
       values (v_other_slot, v_athlete, $m$swap$m$, v_swapped);
     insert into public.goals (student_id, coach_id, exercise_id, kind, target_weight_kg)
       values (v_athlete, v_coach, v_goal, $m$one_rm$m$, 100);
     perform public.transfer_student(v_athlete, v_new_coach);

     perform set_config($m$role$m$, $m$authenticated$m$, true);
     foreach v_who in array array[v_athlete, v_new_coach, v_coach, v_stranger] loop
       perform set_config($m$request.jwt.claims$m$, json_build_object($m$sub$m$, v_who, $m$role$m$, $m$authenticated$m$)::text, true);
       select count(*) into v_count from public.exercise_library where id in (v_used, v_swapped, v_goal, v_unused);
       v_read := v_read || v_count;
     end loop;

     perform set_config($m$request.jwt.claims$m$, json_build_object($m$sub$m$, v_new_coach, $m$role$m$, $m$authenticated$m$)::text, true);
     update public.exercise_library set name = $m$renamed$m$ where id = v_used;
     get diagnostics v_renamed = row_count;
     begin
       insert into public.exercise_slots (session_id, exercise_id, sets, reps, sort_order) values (v_session, v_used, 3, 5, 2);
       v_put := $m$saved$m$;
     exception when others then
       v_put := sqlstate;
     end;

     perform set_config($m$role$m$, $m$postgres$m$, true);
     perform set_config($m$request.jwt.claims$m$, $m$$m$, true);

     v_result := case
       when v_read[1] > 3 or v_read[2] > 3 or v_read[4] > 0
         then $m$NOT PROTECTED: an exercise was read by somebody nothing of theirs uses it: $m$ || array_to_string(v_read, $m$, $m$) || $m$ read$m$
       when v_renamed > 0
         then $m$NOT PROTECTED: the new coach renamed an exercise of the former coach$m$
       when v_put = $m$saved$m$
         then $m$NOT PROTECTED: the new coach put an exercise of the former coach in a new session$m$
       when v_read <> array[3, 3, 4, 0]
         then $m$BROKEN: the athlete, the new coach, the former coach and a third coach read $m$ || array_to_string(v_read, $m$, $m$) || $m$ of the four exercises, not 3, 3, 4 and 0$m$
       when v_put <> $m$23514$m$
         then $m$BROKEN: a new session of the new coach with an exercise of the former coach was answered $m$ || v_put
       else $m$in place: after a change of coach, the athlete and the new coach read the exercises their sessions, swaps and goals use, and nobody else does; nobody but its coach writes one, and a new session takes an exercise of the library of today$m$
     end;
     raise exception $m$check only, nothing was written: %$m$, v_result;
   end $check$'
   ```

   The command must fail with `check only, nothing was written: in place: after a change of coach, the athlete and the new coach read the exercises their sessions, swaps and goals use, and nobody else does; nobody but its coach writes one, and a new session takes an exercise of the library of today`. Run before the migration, the same command fails with `… NOT THERE: an exercise is read by its coach and the athletes of that coach only` — and writes nothing either.

   Anything else is **not** the answer:

   - `… NOT THERE: …` after the migration — the migration is not in this database. Read the ledger.
   - `… NOT PROTECTED: …` or `… BROKEN: …` — the migration does not do what this page says: **roll back**, and report the full message.
   - `… NOT TRIED: the accounts made for the check could not be made coaches` — migration 07 is not in the database, or was rolled back. Read the ledger.
   - a message that does not start with `check only` — the check could not get as far as its questions (the message says why). Nothing was written. Report it; lines 2 and 3 of the audit are then what says whether the migration is in place.

4. In the app, nothing to look at unless an athlete with a program changed coach: their sessions then show every exercise with its name, for them and for their new coach.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_16_23_library_read_follows_program.down.sql
```

It drops the policy and its function.

**It reopens B8**: from then on an athlete who changed coach, and their new coach, read the blocks written before the change with exercises that have no name, and the app breaks on them. Every app works without the migration for an athlete who never changed coach. The only reasons to run this file are step 3 answering `NOT PROTECTED` or `BROKEN`, or a migration applied to the wrong project.

No row is written or deleted by it.

It is refused (code `SLM04`) once a later migration is in the ledger. Roll those back first, last applied first.
