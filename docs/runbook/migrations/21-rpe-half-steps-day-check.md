# 21 — An RPE in half steps; the weekday of a session is a weekday, or none

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_16_21_rpe_half_steps_day_check.sql` |
| Audit | `supabase/audits/2026_10_16_21_rpe_half_steps_day_check.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_16_21_rpe_half_steps_day_check.down.sql` |
| Kind | required · changes the type of 1 column, adds 2 rules, replaces 1 function; clears the weekdays listed below |
| Wave / checkpoint | 3 / C1 |
| Findings | L34, B12 |
| Needs | migration 20 |

Safe with the app that is deployed today and with every version before it: it writes an RPE as a whole number and a weekday from 1 to 7 or none, and both are still what they were. **Read [the sessions that lose their weekday](#the-sessions-that-lose-their-weekday) before you apply it**: the weekdays it clears do not come back with the rollback.

## What it does

**An RPE in half steps (L34).** Until now an RPE was a whole number from 1 to 10: an athlete who felt 7.5 had to say 7 or 8. From this migration on it is a number from 1 to 10 **in steps of 0.5** — 6, 6.5, 7, 7.5 … 10. Every RPE logged so far keeps its value. Something between two half steps is refused: 7.3, 0.5, 10.5. A value with more decimals is rounded to one first — 7.04 is saved as 7.0, 7.26 becomes 7.3 and is refused. A failed set still takes no RPE.

**The weekday of a session (B12).** A session can carry the weekday it is advised for — 1 for Monday to 7 for Sunday — or none. It is advice: the order of the sessions does not depend on it. Until now nothing held the number to a weekday, and the blocks your athletes wrote themselves carry numbers nobody chose: the athlete's builder has no weekday control, and before August it wrote a position instead (the ninth session of a phase said 9), or Monday for every session. From this migration on:

1. **The weekdays that are not one are cleared** — every number outside 1 to 7, whoever wrote it.
2. **Every weekday of a block an athlete wrote is cleared** — their drafts, and the blocks you approved, trained and reviewed sessions included. Your own blocks keep theirs. You can set a weekday again on any session in the Program Sheet.
3. **A weekday is a number from 1 to 7, or none** — anything else is refused.
4. **The athlete's draft builder writes a number outside 1 to 7 as no weekday.** A phone that kept its draft from before the migration still sends what the draft held then; without this, its next save would be refused as a whole, and what it carried lost.

To keep the weekdays of the approved blocks your athletes wrote, the migration can clear those of the drafts only: [Apply](#apply) gives that command too.

## What the deployed client does differently

**Nothing, for the athlete and for the coach.** The app that is deployed offers an RPE from 1 to 10 in whole numbers, and reads the ones it wrote as it did: the API answers `8` for an RPE of 8. A weekday it writes is 1 to 7 or none. The athlete's draft saves as before; one that still held a position from an old version is saved without it.

The sessions listed below show no weekday from then on: in the Program Sheet, a session without a weekday pill.

**For somebody who calls the API by hand:**

| Who writes | What | Answer |
|---|---|---|
| the athlete | an RPE of 6, 7.5 or 10 on a set of theirs | saved |
| the athlete | an RPE of 7.3, 0.5 or 10.5 | refused: code `23514`, `set_logs_rpe_half_step` or `set_logs_rpe_check` |
| the coach | a weekday from 1 to 7, or none | saved |
| the coach | a weekday of 0 or 8 | refused: code `23514`, `sessions_day_number_weekday` |
| the athlete | `save_draft_tree` with a weekday of 9 on a session | the draft is saved, that session without a weekday |

The API hands an RPE over as a number: `7.5`, and `8.0` for 8 — which JavaScript reads as `8`.

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_16_21_rpe_half_steps_day_check.audit.sql
```

What it prints, before and after the migration:

| # | check | before | after |
|---|---|---|---|
| 1 | running as | `postgres` | `postgres` |
| 2 | what an RPE may be (L34) | `a whole number from 1 to 10` | `from 1 to 10, in steps of 0.5` |
| 3 | the RPEs logged, by value | a list | the same list |
| 4 | what the weekday of a session may be (B12) | `any number` | `none, or 1 to 7` |
| 5 | what save_draft_tree writes for a number that is no weekday | `the number` | `no weekday` |
| 6 | sessions whose weekday is not one (outside 1 to 7) | a number | `0` |
| 7 | sessions of a draft an athlete is writing, with a weekday | a number | `0` |
| 8 | sessions of an approved block an athlete wrote, with a weekday | a number | `0` — the same number with drafts only |
| 9 | sessions of a block of the coach, with a weekday from 1 to 7 | a number | the same number |

Lines 2, 4 and 5 are the migration. Lines 6 to 8 are the weekdays it clears.

If the "before" column is not what you see:

- **1** is not `postgres` — stop and report. The migration refuses to run as anyone else.
- **2** reads `from 1 to 10, in steps of 0.5`, **4** `none, or 1 to 7` or **5** `no weekday` — read the ledger (below). If migration 21 is there, you are done. If it is not, something of that name was made by hand: stop and report.
- **2** starts with `SOMETHING ELSE:` — **stop and report the line.** The column was changed by hand, and the migration refuses to change it.
- **5** starts with `SOMETHING ELSE:` or `NOT THERE:` — **stop and report the line.** The function is not the one of August, and the migration refuses to replace it. Its comments do not count: production was given the function by `supabase/migrations/2026_08_22_draft_day_number_optional.sql`, whose comment is not the one of `schema.sql`, and both read `the number`.
- **3** — a list like `6: 12, 7: 40, 8: 31`: how many sets were rated with each value. Whole numbers before; the same list after.
- **6 to 8** — any numbers: the sessions [listed below](#the-sessions-that-lose-their-weekday). Read the list before you apply.
- **9** — any number: the weekdays you chose. The migration leaves them alone.

## The sessions that lose their weekday

For lines 6 to 8 of the audit — every session the migration clears, before it runs:

```bash
supabase db query --linked "select pr.full_name as athlete, p.name as block, p.status as state, coalesce(w.label, 'phase ' || w.week_number) as phase, s.sort_order + 1 as position, s.title, s.day_number as weekday, case when s.day_number not between 1 and 7 then 'not a weekday' when p.status = 'draft' then 'a draft the athlete is writing' else 'a block the athlete wrote' end as why, s.id as session_id from public.sessions s join public.weeks w on w.id = s.week_id join public.programs p on p.id = w.program_id join public.students st on st.id = p.student_id join public.profiles pr on pr.id = st.profile_id where s.day_number is not null and (s.day_number not between 1 and 7 or p.created_by is not null) order by 1, 2, w.week_number, s.sort_order"
```

Keep its output: it is the only record of what was there. Under `why`:

- **`not a weekday`** — a number outside 1 to 7. Cleared whichever way you apply the file.
- **`a draft the athlete is writing`** — cleared whichever way you apply the file: a draft is theirs, and their builder cannot show a weekday.
- **`a block the athlete wrote`** — a block you approved. Cleared by the file as it is. **To keep these**, apply it with drafts only ([Apply](#apply), the second command): their weekdays then stay as they are — Monday on every session, or a position, wherever that is what the builder wrote.

After the migration the same command lists nothing — or, with drafts only, the lines `a block the athlete wrote`.

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_16_21_rpe_half_steps_day_check.sql
```

Or, **to keep the weekdays of the approved blocks your athletes wrote** — the same file, told to clear the drafts only:

```bash
supabase db query --linked "set app.day_number_clearing = 'drafts'; $(cat supabase/migrations/2026_10_16_21_rpe_half_steps_day_check.sql)"
```

It holds the sessions and the sets against writes while the sets are written again with the new type — a few seconds at most: an athlete who ticks a set in that instant waits for it.

A refusal changes nothing:

| Message contains | Meaning | Do |
|---|---|---|
| `needs 2026_10_16_20_drafts_coach_readonly, which is not applied` (code `SLM02`) | migration 20 is not in the database | apply it first, with its checks |
| `must be run as postgres` | line 1 of the audit | stop and report |
| `does not know app.day_number_clearing` | the second command was typed with another word than `drafts` | run it again as written |
| `would not change set_logs.rpe: …` | line 2 of the audit: the column was changed by hand | stop and report the full message |
| `would not create: … is already there` | one of the two rules exists, made by hand | stop and report the names |
| `would not replace save_draft_tree: …` | line 5 of the audit | stop and report the full message |
| `did not get what it meant: …` | the file read its own result back and it was not the one described here | stop and report the full message |
| `canceling statement due to lock timeout` | a request held the sessions or the sets for more than five seconds | nothing was changed: run it again |

## After

1. Run the audit again. Lines 2, 4 and 5 read as the "after" column; lines 6 to 8 read `0` — line 8 its number from before, with drafts only.

2. Read the ledger:

   ```bash
   supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
   ```

   Expected: twenty rows, the last one `2026_10_16_21_rpe_half_steps_day_check` — twenty-one where the optional migration 19 was applied at Checkpoint B.

3. See it for yourself. This creates a coach and an athlete, and a block the athlete trains: one session, one exercise, one set. Through the API's role, as the athlete, it rates the set 7.5, then 7.3, and saves a draft of their own whose session says 9 — what an old phone may still send. As the coach it gives the session the weekday 8, then 7. Then it fails **whatever happened**, so that nothing is kept, the two accounts included. The answer is in the message:

   ```bash
   supabase db query --linked 'do $check$
   declare
     v_coach uuid := gen_random_uuid();
     v_athlete uuid := gen_random_uuid();
     v_link uuid := gen_random_uuid();
     v_exercise uuid := gen_random_uuid();
     v_block uuid := gen_random_uuid();
     v_week uuid := gen_random_uuid();
     v_session uuid := gen_random_uuid();
     v_slot uuid := gen_random_uuid();
     v_set uuid := gen_random_uuid();
     v_draft uuid := gen_random_uuid();
     v_draft_week uuid := gen_random_uuid();
     v_draft_session uuid := gen_random_uuid();
     v_half text;
     v_between text;
     v_saved text;
     v_eight text;
     v_seven text;
     v_rpe numeric;
     v_weekday integer;
     v_draft_weekday integer;
     v_drafts integer;
     v_result text;
   begin
     if not exists (select 1 from pg_constraint c
                     where c.conrelid = to_regclass($m$public.sessions$m$)
                       and c.conname = $m$sessions_day_number_weekday$m$) then
       raise exception $m$check only, nothing was written: NOT THERE: an RPE is a whole number, and a weekday any number$m$;
     end if;

     insert into auth.users (id, email, aud, role) values
       (v_coach, $m$sl-check-21-coach@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$),
       (v_athlete, $m$sl-check-21-athlete@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$);
     update public.profiles set role = $m$coach$m$ where id = v_coach;
     if not exists (select 1 from public.profiles where id = v_coach and role = $m$coach$m$) then
       raise exception $m$check only, nothing was written: NOT TRIED: the account made for the check could not be made a coach$m$;
     end if;
     insert into public.students (id, profile_id, coach_id) values (v_link, v_athlete, v_coach);
     insert into public.exercise_library (id, coach_id, name, type, difficulty)
       values (v_exercise, v_coach, $m$sl-check-21$m$, $m$pull$m$, 1);
     insert into public.programs (id, student_id, name, is_active) values (v_block, v_link, $m$sl-check-21 block$m$, true);
     insert into public.weeks (id, program_id, week_number) values (v_week, v_block, 1);
     insert into public.sessions (id, week_id, title, sort_order, day_number) values (v_session, v_week, $m$one$m$, 0, 2);
     insert into public.exercise_slots (id, session_id, exercise_id, sets, reps, weight_kg, sort_order)
       values (v_slot, v_session, v_exercise, 1, 5, 20, 0);
     insert into public.set_logs (id, exercise_slot_id, set_number, target_reps, target_weight_kg)
       values (v_set, v_slot, 1, 5, 20);

     perform set_config($m$role$m$, $m$authenticated$m$, true);
     perform set_config($m$request.jwt.claims$m$, json_build_object($m$sub$m$, v_athlete, $m$role$m$, $m$authenticated$m$)::text, true);
     begin
       update public.set_logs set done = true, logged_at = now(), rpe = 7.5 where id = v_set;
       v_half := $m$saved$m$;
     exception when others then
       v_half := sqlstate || $m$ $m$ || sqlerrm;
     end;
     begin
       update public.set_logs set rpe = 7.3 where id = v_set;
       v_between := $m$saved$m$;
     exception when others then
       v_between := sqlstate;
     end;
     begin
       perform public.save_draft_tree(jsonb_build_object(
         $m$program$m$, jsonb_build_object($m$id$m$, v_draft, $m$name$m$, $m$sl-check-21 draft$m$),
         $m$weeks$m$, jsonb_build_array(jsonb_build_object($m$id$m$, v_draft_week, $m$week_number$m$, 1)),
         $m$sessions$m$, jsonb_build_array(jsonb_build_object($m$id$m$, v_draft_session, $m$week_id$m$, v_draft_week,
                                                              $m$title$m$, $m$Day 9$m$, $m$day_number$m$, 9, $m$sort_order$m$, 0)),
         $m$slots$m$, jsonb_build_array()));
       v_saved := $m$saved$m$;
     exception when others then
       v_saved := sqlstate || $m$ $m$ || sqlerrm;
     end;

     perform set_config($m$request.jwt.claims$m$, json_build_object($m$sub$m$, v_coach, $m$role$m$, $m$authenticated$m$)::text, true);
     begin
       update public.sessions set day_number = 8 where id = v_session;
       v_eight := $m$saved$m$;
     exception when others then
       v_eight := sqlstate;
     end;
     begin
       update public.sessions set day_number = 7 where id = v_session;
       v_seven := $m$saved$m$;
     exception when others then
       v_seven := sqlstate || $m$ $m$ || sqlerrm;
     end;

     perform set_config($m$role$m$, $m$postgres$m$, true);
     perform set_config($m$request.jwt.claims$m$, $m$$m$, true);
     select sl.rpe into v_rpe from public.set_logs sl where sl.id = v_set;
     select s.day_number into v_weekday from public.sessions s where s.id = v_session;
     select count(*), max(s.day_number) into v_drafts, v_draft_weekday from public.sessions s where s.id = v_draft_session;

     v_result := case
       when v_between = $m$saved$m$
         then $m$NOT PROTECTED: an RPE of 7.3 was saved$m$
       when v_eight = $m$saved$m$
         then $m$NOT PROTECTED: a session was given the weekday 8$m$
       when v_half <> $m$saved$m$ or v_rpe is distinct from 7.5
         then $m$BROKEN: the athlete could not rate a set 7.5: $m$ || coalesce(v_half, $m$?$m$) || $m$, the set holds $m$ || coalesce(v_rpe::text, $m$no RPE$m$)
       when v_between <> $m$23514$m$ or v_eight <> $m$23514$m$
         then $m$BROKEN: a refusal was not the rule of the migration: $m$ || v_between || $m$, $m$ || v_eight
       when v_seven <> $m$saved$m$ or v_weekday is distinct from 7
         then $m$BROKEN: the coach could not give the session the weekday 7: $m$ || v_seven
       when v_saved <> $m$saved$m$ or v_drafts <> 1 or v_draft_weekday is not null
         then $m$BROKEN: a draft whose session says 9 was not saved without a weekday: $m$ || v_saved
       else $m$in place: an RPE is saved in half steps and refused between them; a weekday is 1 to 7 or none; a draft whose session says 9 is saved without one$m$
     end;
     raise exception $m$check only, nothing was written: %$m$, v_result;
   end $check$'
   ```

   The command must fail with `check only, nothing was written: in place: an RPE is saved in half steps and refused between them; a weekday is 1 to 7 or none; a draft whose session says 9 is saved without one`. Run before the migration, the same command fails with `… NOT THERE: an RPE is a whole number, and a weekday any number` — and writes nothing either.

   Anything else is **not** the answer:

   - `… NOT THERE: …` after the migration — the migration is not in this database. Read the ledger.
   - `… NOT PROTECTED: …` or `… BROKEN: …` — the migration does not do what this page says: **roll back**, and report the full message.
   - `… NOT TRIED: the account made for the check could not be made a coach` — migration 07 is not in the database, or was rolled back. Read the ledger.
   - a message that does not start with `check only` — the check could not get as far as its questions (the message says why). Nothing was written. Report it; lines 2, 4 and 5 of the audit are then what says whether the migration is in place.

4. In the app, nothing to look at: RPEs read as before, and the sessions [listed above](#the-sessions-that-lose-their-weekday) show no weekday in the Program Sheet. The app that offers half steps comes with wave 3.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_16_21_rpe_half_steps_day_check.down.sql
```

It makes the RPE a whole number again, drops the rule on the weekday, and puts back the `save_draft_tree` of August.

- **An RPE in a half step is rounded up**: 7.5 becomes 8, 9.5 becomes 10. The half is lost; the set stays logged.
- **The weekdays the migration cleared do not come back.** The list you kept before the migration is what they were; set one again in the Program Sheet where it matters.

The app that is deployed works either way. The only reasons to run this file are step 3 answering `NOT PROTECTED` or `BROKEN`, or a migration applied to the wrong project. Once the app that offers half steps is deployed, rolling back refuses its 7.5 (code `22P02`).

It is refused (code `SLM04`) once a later migration is in the ledger. Roll those back first, last applied first.
