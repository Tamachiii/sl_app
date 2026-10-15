# 10 — Goals outlive a library clean-up and a change of coach

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_13_10_goals_fk_coach_links.sql` |
| Audit | `supabase/audits/2026_10_13_10_goals_fk_coach_links.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_13_10_goals_fk_coach_links.down.sql` |
| Kind | required · re-creates 3 foreign keys, adds 1 column and 1 function, replaces 1 function body; no policy, no trigger, no row |
| Wave / checkpoint | 1 / A2 |
| Findings | P18, L7, P21, B9 |
| Needs | migration 09 |

Safe with the app that is deployed today. One thing changes for a coach: deleting a library exercise that a goal is set on is refused, with the message the app already shows for an exercise that a session uses. One thing changes for **you**: an athlete is moved to another coach with one statement — [Moving an athlete to another coach](#moving-an-athlete-to-another-coach).

## What it does

A goal is set by a coach, on an exercise of their library, for one athlete; the athlete logs their attempts against it. Three things could take those rows away, or leave them in the wrong hands.

- **Tidying the library deleted goals.** An exercise that is in a session cannot be deleted; an exercise that only a goal is set on could, and the goal went with it — with every attempt the athlete had logged. The dialog only said *Delete "…"?* (P18, L7).
- **Deleting a coach's account deleted their athletes' training.** The link of each athlete went with the account, and with the link the athlete's programs, sessions and sets; the goals went too. What could stand in the way was not a rule about accounts: the protection of logged sets, whose message — *move it to the trash instead* — names a remedy that does not exist there (B9).
- **A former coach kept reading an athlete's attempts.** Who may read the progress of a goal was decided by who had *set* the goal, never by who coaches the athlete today. After an athlete had moved to another coach, the former one still read every weight and note, and the new one could neither see nor manage those goals (P21). Nothing moved an athlete properly either: the link was rewritten by hand and the goals stayed behind.

The migration closes this in the database:

1. **A library exercise that a goal is set on is not deleted**, like one that a session uses.
2. **The profile of a coach is not deleted while an athlete is linked to it, or while a goal names it.** An athlete's own account still goes with what is theirs.
3. **An exercise can be archived** — a new, empty column. Nothing reads it yet: a later version of the app offers *Archive* for an exercise that is in use, takes it out of the pickers and keeps it for the sessions, the goals and the history that name it.
4. **A coach reads the progress of a goal only while they coach its athlete.**
5. **`transfer_student`** moves an athlete to another coach together with their goals. Only you can call it.

## What the deployed client does differently

**A coach who deletes a library exercise that a goal is set on** sees *Can’t do that — this is still in use elsewhere.* The exercise, the goal and its attempts stay. Until now the exercise was deleted, and the goal with it. An exercise that nothing uses is deleted as before. The version of the app that is published at Checkpoint A3 shows where an exercise is used before it offers to delete it.

**Everything else is unchanged.** A coach reads the goals they set for their athletes and the attempts logged against them; an athlete reads and logs their own. The library loads with one more column, which is empty.

**For somebody who calls the API by hand:** `transfer_student` answers `permission denied for function transfer_student`.

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_13_10_goals_fk_coach_links.audit.sql
```

What it prints, before and after the migration:

| # | check | before | after |
|---|---|---|---|
| 1 | running as | `postgres` | `postgres` |
| 2 | a library exercise that a goal is set on cannot be deleted (P18, L7) | `no` | `yes` |
| 3 | the profile of a coach cannot be deleted while an athlete is linked to it (B9) | `no` | `yes` |
| 4 | … nor while a goal names it | `no` | `yes` |
| 5 | an exercise can be archived | `no` | `yes` |
| 6 | a coach reads the progress of a goal only while they coach its athlete (P21) | `no` | `yes` |
| 7 | an athlete is moved to another coach together with their goals (transfer_student) | `no` | `yes` |
| 8 | functions of this migration a request without a session may execute | `none` | `none` |
| 9 | functions of this migration a signed-in user may execute | `coach_profile_for_goal(uuid)` | `coach_profile_for_goal(uuid)` |
| 10 | functions of this migration without search_path = public, pg_temp | `none` | `none` |
| 11 | policies on goal_progress that the migration does not know | `none` | `none` |
| 12 | goals whose athlete has another coach today | `0` | `0` |
| 13 | goals whose athlete has no coach today | `0` | `0` |
| 14 | library exercises with a goal and in no program | a number | the same number |
| 15 | archived exercises | `0` | `0` |
| 16 | goals | a sentence: *N goal(s) on N exercise(s), with N logged attempt(s)* | the same |
| 17 | accounts | a sentence: *N coach(es), N athlete(s) with a coach* | the same |

Lines 14, 16 and 17 are information. Line 14 counts the exercises whose deletion took goals with it until now.

If the "before" column is not what you see:

- **1** is not `postgres` — stop and report. The migration refuses to run as anyone else.
- **2 to 7 already read `yes`** — the migration is in the database. Read the ledger (below): if migration 10 is there, you are done.
- **8 or 10** is not `none`, or **9** is not `coach_profile_for_goal(uuid)` — migration 03 is not applied, or was rolled back. Stop: apply it first.
- **11** is not `none` — stop and report the line. Somebody reads or writes the athletes' attempts through a rule this migration does not know, and the migration undoes itself rather than leave it.
- **12 or 13** is not `0` — go on. Those goals were set by a coach who no longer coaches the athlete. Today that coach still reads their progress; after the migration the athlete alone does, until you hand the goals over: [Goals left with a former coach](#goals-left-with-a-former-coach).

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_13_10_goals_fk_coach_links.sql
```

A refusal changes nothing:

| Message contains | Meaning | Do |
|---|---|---|
| `needs 2026_10_13_09_review_lifecycle, which is not applied` (code `SLM02`) | migration 09 is not in the database | apply it first, with its checks |
| `must be run as postgres` | line 1 of the audit | stop and report |
| `would not replace: …` | one of the functions of this file exists with other arguments | stop and report the names |
| `does not find the foreign keys it rewrites: …` | one of the three foreign keys is not there under the name it was created with, or its column has a second one | stop and report the full message |
| `already has a column archived_at` | the column was added by hand | stop and report |
| `did not get the foreign keys it meant: …`, `did not get the column it meant: …`, `did not get the functions it meant: …` or `did not get the policies it meant: …` | the file read its own result back and it was not the one described here — for the policies, line 11 of the audit | stop and report the full message |
| `canceling statement due to lock timeout` or `deadlock detected` | the app was reading or writing one of the tables at that moment: this file holds `profiles`, `students`, `goals` and `exercise_library` for an instant | run the file again |

## After

1. Run the audit again. Lines 2 to 7 read `yes`; the others are unchanged.

2. Read the ledger:

   ```bash
   supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
   ```

   Expected: ten rows, the last one `2026_10_13_10_goals_fk_coach_links`.

3. See it for yourself. This creates two coaches and an athlete of the first one, with an exercise, a goal on it and one logged attempt. It tries to delete the exercise; it moves the athlete to the second coach; it tries to delete the profile of that coach; then, through the API's role, it reads the attempt as the former coach, as the new coach and as the athlete. Then it fails **whatever happened**, so that nothing is kept, the three accounts included. The answer is in the message:

   ```bash
   supabase db query --linked 'do $check$
   declare
     v_coach uuid := gen_random_uuid();
     v_next uuid := gen_random_uuid();
     v_athlete uuid := gen_random_uuid();
     v_exercise uuid := gen_random_uuid();
     v_goal uuid := gen_random_uuid();
     v_coaches integer;
     v_former integer;
     v_new integer;
     v_own integer;
     v_answer text;
   begin
     insert into auth.users (id, email, aud, role) values
       (v_coach, $m$sl-check-10-coach@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$),
       (v_next, $m$sl-check-10-next@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$),
       (v_athlete, $m$sl-check-10-athlete@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$);
     update public.profiles set role = $m$coach$m$ where id in (v_coach, v_next);
     select count(*) into v_coaches from public.profiles where id in (v_coach, v_next) and role = $m$coach$m$;
     if v_coaches <> 2 then
       raise exception $m$check only, nothing was written: NOT TRIED: the accounts made for the check could not be made coaches$m$;
     end if;
     insert into public.students (profile_id, coach_id) values (v_athlete, v_coach);
     insert into public.exercise_library (id, coach_id, name, type, difficulty)
     values (v_exercise, v_coach, $m$sl-check-10$m$, $m$pull$m$, 1);
     insert into public.goals (id, student_id, coach_id, exercise_id, kind, target_weight_kg)
     values (v_goal, v_athlete, v_coach, v_exercise, $m$one_rm$m$, 100);
     insert into public.goal_progress (goal_id, weight_kg) values (v_goal, 80);

     begin
       delete from public.exercise_library where id = v_exercise;
       v_answer := $m$NOT PROTECTED: a library exercise was deleted, and the goal set on it with it$m$;
     exception when foreign_key_violation then
       null;
     end;

     if v_answer is null then
       perform public.transfer_student(v_athlete, v_next);
       begin
         delete from public.profiles where id = v_next;
         v_answer := $m$NOT PROTECTED: the profile of a coach was deleted while an athlete was linked to it$m$;
       exception when foreign_key_violation then
         null;
       end;
     end if;

     if v_answer is null then
       perform set_config($m$role$m$, $m$authenticated$m$, true);
       perform set_config($m$request.jwt.claims$m$,
         json_build_object($m$sub$m$, v_coach, $m$role$m$, $m$authenticated$m$)::text, true);
       select count(*) into v_former from public.goal_progress where goal_id = v_goal;
       perform set_config($m$request.jwt.claims$m$,
         json_build_object($m$sub$m$, v_next, $m$role$m$, $m$authenticated$m$)::text, true);
       select count(*) into v_new from public.goal_progress where goal_id = v_goal;
       perform set_config($m$request.jwt.claims$m$,
         json_build_object($m$sub$m$, v_athlete, $m$role$m$, $m$authenticated$m$)::text, true);
       select count(*) into v_own from public.goal_progress where goal_id = v_goal;
       v_answer := case
         when v_former <> 0 then $m$NOT PROTECTED: the former coach still reads the progress of an athlete who moved$m$
         when v_new <> 1 or v_own <> 1 then $m$BROKEN: after the move the new coach reads $m$ || v_new
           || $m$ attempt(s) and the athlete $m$ || v_own || $m$, of 1$m$
         else $m$protected: an exercise with a goal and a coach with an athlete are not deleted, and after a move the attempts are read by the athlete and the new coach, not by the former one$m$
       end;
     end if;
     raise exception $m$check only, nothing was written: %$m$, v_answer;
   end $check$'
   ```

   The command must fail with `check only, nothing was written: protected: an exercise with a goal and a coach with an athlete are not deleted, and after a move the attempts are read by the athlete and the new coach, not by the former one`. Run before the migration, the same command fails with `… NOT PROTECTED: a library exercise was deleted, and the goal set on it with it` — and writes nothing either.

   Anything else is **not** the answer:

   - `… NOT PROTECTED: …` after the migration — one of the rules is not there. Stop and report the full message.
   - `… BROKEN: …` — after a move, the new coach or the athlete does not read the attempts: **roll back**, and report.
   - `… NOT TRIED: the accounts made for the check could not be made coaches` — migration 07 is not in the database, or was rolled back. Read the ledger.
   - a message that does not start with `check only` — the check could not get as far as its questions (the message says why). Nothing was written. Report it; lines 2 to 7 of the audit are then what says whether the migration is in place.

4. In the app that is deployed, signed in as the **coach** — and only once step 3 has answered `protected`: open the test athlete, section Goals. The goals and the attempts logged against them read as before.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_13_10_goals_fk_coach_links.down.sql
```

**It reopens the findings.** Run it only if, after the migration, something the app does with a goal, with the exercise library or with the roster is refused or answers wrongly — step 3 answers `BROKEN`, a coach no longer reads the attempts of an athlete they coach, an exercise that *nothing* uses cannot be deleted, the library does not load. The database tests replay those requests as the deployed app sends them, so this is not expected. Report what was being done, and re-apply the migration once the cause is known.

**"I cannot delete this exercise" is not that case when a goal is set on it**: that is the rule. Delete the goal first if it is no longer wanted — its attempts go with it — or leave the exercise.

It gives the three foreign keys and the function back the text they had and drops `transfer_student`. No row is deleted: an athlete you moved stays with their new coach, and so do their goals. **It drops the column `archived_at`**: an exercise archived while the migration was in place is an ordinary exercise again, back in every picker — line 15 of the audit says how many there are; read it first.

It is refused (code `SLM04`) once a later migration is in the ledger. Roll those back first, last applied first.

## Moving an athlete to another coach

From this migration on, this is how an athlete changes coach — the app has no screen for it, and the API refuses. Do not rewrite `coach_id` by hand: the goals would stay with the former coach.

**Before Checkpoint C1, move only an athlete who has no program yet.** The exercises in an athlete's sessions belong to the library of the coach who wrote them, and neither the athlete nor the new coach can read another coach's library: after the move those sessions show exercises without a name, and the app that is deployed fails to open them. [Migration 23](23-library-read-follows-program.md) (Checkpoint C1) makes an exercise readable through the session, the swap and the goal that use it.

1. The new coach has an account with the role *coach*: [07, Making a coach](07-profile-rules.md#making-a-coach).
2. Move the athlete, in Dashboard → SQL Editor, with the two e-mail addresses:

```sql
select athlete.email as athlete, coach.email as new_coach,
       public.transfer_student(athlete.id, coach.id) as moved
  from auth.users athlete, auth.users coach
 where athlete.email = '<e-mail of the athlete>'
   and coach.email = '<e-mail of the new coach>';
```

It returns one row. Under `moved`: `"link_moved": true`, and under `goals_moved` the number of goals that went to the new coach. The athlete sees their new coach, and the new coach sees the athlete in the roster — with their programs, their history and their goals — the next time each opens the app. The former coach no longer sees any of it.

| It answers | Meaning |
|---|---|
| no row | one of the two addresses is not an account: check the spelling in Authentication → Users |
| `"link_moved": false` | the athlete was already with this coach. Nothing moved but the goals a former coach still held (`goals_moved`) |
| `students.coach_id … is not a coach: its profile has the role student` | the second address is not a coach's. Nothing was written. Make that account a coach first (step 1) |
| `profile … is not the athlete of a coach: there is no link to move` | the first address has no coach. A first link is made with [05, Linking an athlete to a coach](05-students-role-gate.md#linking-an-athlete-to-a-coach) |
| `students: profile … cannot be its own coach` | the same address twice |
| `permission denied for table users` | the SQL editor is not running as `postgres`: the role selector of the editor is set to a user of the app. Set it back to `postgres` and run the statement again |

What the move leaves where it was:

- **The exercises** — see above. The athlete's goals keep the exercise they were set on too, and show it without its name to the athlete and to the new coach — until migration 23, which gives it back to both. The former coach's library stays theirs, and they cannot delete an exercise that the athlete's sessions or goals still use.
- **The conversation with the former coach.** Both keep their messages; the app shows the athlete the conversation with their coach of today, and the two can no longer write to each other. A message of the former coach that the athlete had not opened keeps the badge of their Messages tab lit, and the app gives them no way to open it. Mark it as read:

  `update public.messages m set read_at = now() from auth.users athlete, auth.users coach where athlete.email = '<e-mail of the athlete>' and coach.email = '<e-mail of the former coach>' and m.recipient_id = athlete.id and m.sender_id = coach.id and m.read_at is null`

- **The former coach's notifications** about the athlete. They open pages that coach can no longer read; *Mark all read* clears them.

## Goals left with a former coach

For lines 12 and 13 of the audit: goals set by a coach who is no longer the coach of the athlete, because a link was rewritten or removed by hand. List them:

```bash
supabase db query --linked "select athlete.full_name as athlete, former.full_name as set_by, today.full_name as coach_today, count(*) as goals from public.goals g join public.profiles athlete on athlete.id = g.student_id join public.profiles former on former.id = g.coach_id left join public.students s on s.profile_id = g.student_id left join public.profiles today on today.id = s.coach_id where s.coach_id is distinct from g.coach_id group by 1, 2, 3 order by 1, 2"
```

One row per athlete and former coach. The migration changes none of those goals. From the migration on, the athlete still reads them and logs against them, and no coach reads them or their attempts.

- **`coach_today` names a coach** (line 12) — hand the goals over: the statement of [Moving an athlete to another coach](#moving-an-athlete-to-another-coach), with the address of the coach the athlete has **today**. It answers `"link_moved": false` and, under `goals_moved`, the number of goals that coach now manages.
- **`coach_today` is empty** (line 13) — the athlete has no coach. Nothing to do until they get one ([05, Linking an athlete to a coach](05-students-role-gate.md#linking-an-athlete-to-a-coach)); then hand the goals over as above.

Then run the audit again: lines 12 and 13 read `0`.

## Removing a coach's account

Deleting the account of a coach — Authentication → Users → *Delete user* — is now refused, with nothing removed, while any of these is true. The dashboard reports an error and does not say which:

- an athlete is linked to them — move each one first ([Moving an athlete to another coach](#moving-an-athlete-to-another-coach));
- a goal names them — [Goals left with a former coach](#goals-left-with-a-former-coach);
- one of their exercises is in a session, in a swap or under a goal — as before this migration. That is the case of every coach whose athletes moved on with their programs: the account stays.

What is in the way, for one account:

```bash
supabase db query --linked "select u.email, (select count(*) from public.students s where s.coach_id = u.id) as athletes, (select count(*) from public.goals g where g.coach_id = u.id) as goals, (select count(*) from public.exercise_library el where el.coach_id = u.id and (exists (select 1 from public.exercise_slots es where es.exercise_id = el.id) or exists (select 1 from public.slot_deviations d where d.substitute_exercise_id = el.id) or exists (select 1 from public.goals g where g.exercise_id = el.id))) as exercises_in_use from auth.users u where u.email = '<e-mail of the coach>'"
```

With three zeros the account can be deleted. Its library goes with it, and so do its conversations — the copies its former athletes hold included.

An athlete's account is deleted as before: their link, programs, goals and messages are theirs and go with it, unless they have logged a set ([04, logged training](04-logged-history-guards.md)).
