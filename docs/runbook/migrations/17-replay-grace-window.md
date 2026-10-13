# 17 — A block stays open for its athlete for 72 hours after it is switched off

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_13_17_replay_grace_window.sql` |
| Audit | `supabase/audits/2026_10_13_17_replay_grace_window.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_13_17_replay_grace_window.down.sql` |
| Kind | required · adds 1 column, 1 trigger and its function, replaces 1 function; no table, no policy, no row |
| Wave / checkpoint | 2 / B |
| Findings | P55 (the database's half) |
| Needs | migration 16 |

Safe with the app that is deployed today and with every version before it: none of them reads the new column, and what each of them shows is unchanged.

## What it does

An athlete writes only in the block they are training. That is a rule of the database, asked for every set, note, swap, skip, video and confirmation.

The app keeps what an athlete logs without a connection — in a gym, mostly — and sends it when the connection is back. When the coach sets the next block active in between, the whole workout arrives for a block that is no longer the one being trained: **every set is refused, then the confirmation, and none of it can be sent again** — the block will not be active again. The session the athlete trained is lost, and the coach never sees it (P55). Nobody did anything wrong: a coach who prepares the next block on Sunday evening, an athlete whose phone was offline on Sunday afternoon.

From this migration on a block stays open for its athlete for **72 hours** after it is switched off:

1. **A block says when it was switched off.** `programs.deactivated_at` is the time *Set active* on another block — or anything else — last switched it off. It is empty for the block being trained, and for a block that never was.
2. **A trigger writes that time, and nobody who is signed in can.** It is written whichever way a block is switched off (the two requests of the app that is deployed, the function of migration 11, a block that goes to the trash while it is active) and emptied when the block is switched on again. A coach or an athlete who sends a value for it is not refused: the value is left out, and the rest of what they sent is saved.
3. **An athlete writes in a block that is the active one, or was switched off less than 72 hours ago.** One function says that for every kind of write, so the window is the same for all of them.

What does not change:

- **A session you archived or reviewed is closed for its athlete**, window or not.
- **A block in the trash is closed**, window or not. Taken out of the trash inside its 72 hours, it is open again for what is left of them.
- **Nobody else gets in**: whose row it is, is still asked first.
- **A block that was switched off before the migration gets no window**: nothing says when it was switched off. The migration writes no row.

The app goes on showing a block that is not active as a past block, read-only. The window is for what was already waiting on a phone.

## What the deployed client does differently

**On every screen: nothing.**

**What was waiting on a phone when you switched blocks is saved.** For three days after a switch, sets, notes, swaps, skips and the confirmation that an athlete logged in the block that was switched off are saved when their phone sends them — instead of *Couldn't save that. Please try again.* on each one. The coach sees the result where they would have seen it: the session of the past block shows as trained and to review, and the confirmation rings the bell (*session completed*) — up to three days after the switch.

After the 72 hours a write to that block is refused as before.

**For somebody who calls the API by hand:**

| Who writes | What | Answer |
|---|---|---|
| the athlete | a set, a note, a swap, a skip, a video, a confirmation — in a block switched off less than 72 hours ago, session neither archived nor reviewed | written |
| the athlete | the same in a block switched off earlier, in a block that never was active, in a block in the trash, in a draft | as before: an update or a delete reaches no row; an insert is refused with `new row violates row-level security policy` |
| the athlete | `ensure_set_logs` for a session of such a closed block | `program_not_active`, as before |
| the coach, or the author of a draft | `deactivated_at` of a block, in an insert or an update | accepted, and the column is what it was: nothing says so |

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_13_17_replay_grace_window.audit.sql
```

What it prints, before and after the migration:

| # | check | before | after |
|---|---|---|---|
| 1 | running as | `postgres` | `postgres` |
| 2 | when an athlete may write in a block (program_active_for_session, P55) | `while it is the active one` | `while it is the active one, and for 72 hours after it was switched off` |
| 3 | a block says when it was switched off (programs.deactivated_at) | `no` | `yes` |
| 4 | the trigger that writes that time (trg_stamp_program_deactivated_at) | `no` | `yes` |
| 5 | functions of these names that the migration does not know | `none` | `none` |
| 6 | functions of this migration a request without a session may execute | `none` | `none` |
| 7 | functions of this migration a signed-in user may execute | `program_active_for_session(uuid)` | `program_active_for_session(uuid)` |
| 8 | functions of this migration that run as their owner | `program_active_for_session(uuid)` | `program_active_for_session(uuid); stamp_program_deactivated_at()` |
| 9 | functions of this migration without search_path = public, pg_temp | `none` | `none` |
| 10 | blocks out of the trash | a sentence | the same sentence |
| 11 | blocks in the trash | a number | the same number |
| 12 | blocks that are not active and that their athlete may still write in (switched off less than 72 hours ago) | `0` | `0` |
| 13 | … the last of them closes on | `none` | `none` |
| 14 | blocks switched off less than 72 hours ago that are closed all the same: in the trash | `0` | `0` |
| 15 | blocks that hold a time of switching off and should not: the active one, a draft, or a time still to come | `0` | `0` |

Line 7 is meant, before and after: the rules an athlete's write goes through call that function with the rights of the athlete. Lines 10 to 15 are the rows; the migration writes none of them. Lines 12 to 14 read `0` right after the migration and count from then on: run the audit again any day to see which blocks are inside their 72 hours.

If the "before" column is not what you see:

- **1** is not `postgres` — stop and report. The migration refuses to run as anyone else.
- **2** reads `while it is the active one, and for 72 hours after it was switched off`, or **3** or **4** reads `yes` — read the ledger (below). If migration 17 is there, you are done. If it is not, something of that name was made by hand: stop and report.
- **2** starts with `SOMETHING ELSE:` or `NOT THERE:` — **stop and report the line.** The rule on when an athlete writes in a block is not the one the migration was written for, and it refuses to replace it.
- **4** reads `THERE, AND SWITCHED OFF` — after the migration only: somebody disabled the trigger. No block gets a time, so no block gets a window, and a signed-in user can write the column. Stop and report.
- **5** is not `none` — **stop and report the line.** A function with one of the two names and other arguments exists.
- **6** or **9** is not `none`, or **7** or **8** is not what the column says — stop and report.
- **10 and 11** — any numbers. `N being trained, M not active, K drafts`: the M are closed for their athlete today and stay closed.
- **12 to 15** are not `0` before the migration — they cannot be: the column they read is not there. Read the ledger.

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_13_17_replay_grace_window.sql
```

It holds the table of the blocks for an instant: a request that reads or writes a block in that instant waits for it.

A refusal changes nothing:

| Message contains | Meaning | Do |
|---|---|---|
| `needs 2026_10_13_16_rest_push_scheduling, which is not applied` (code `SLM02`) | migration 16 is not in the database | apply it first, with its checks |
| `must be run as postgres` | line 1 of the audit | stop and report |
| `would not add: public.programs.deactivated_at is already there` | line 3 of the audit | stop and report |
| `would not create: … is already there` | lines 4 and 5 of the audit: the trigger or its function exists | stop and report the names |
| `would not replace: …` | line 5 of the audit: a second function named `program_active_for_session` | stop and report the names |
| `would not replace the rule on when an athlete writes in a block: …` | line 2 of the audit | stop and report the full message |
| `does not find what its functions are written with: …` | a column of `programs` is not there under its name | stop and report the full message |
| `did not get what it meant: …` | the file read its own result back and it was not the one described here | stop and report the full message |
| `canceling statement due to lock timeout` | another request held the table of the blocks for more than five seconds | nothing was changed: run it again |

## After

1. Run the audit again. Lines 2, 3, 4 and 8 read as the "after" column; lines 12 to 15 read `0`; the others are unchanged.

2. Read the ledger:

   ```bash
   supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
   ```

   Expected: seventeen rows, the last one `2026_10_13_17_replay_grace_window`.

3. See it for yourself. This creates a coach and an athlete, with a block that is trained — one session, one set — and a second block. Through the API's role, as the coach, it switches to the second block with the two requests of the app that is deployed, and tries to write the time of the switch itself. As the athlete, it logs the set of the block that was switched off. As the owner it moves the switch 73 hours back, then one hour back with the block in the trash, and the athlete tries again each time. As the coach it switches back through `activate_program`. Then it fails **whatever happened**, so that nothing is kept, the two accounts included. The answer is in the message:

   ```bash
   supabase db query --linked 'do $check$
   declare
     v_coach uuid := gen_random_uuid();
     v_athlete uuid := gen_random_uuid();
     v_link uuid := gen_random_uuid();
     v_exercise uuid := gen_random_uuid();
     v_first uuid := gen_random_uuid();
     v_next uuid := gen_random_uuid();
     v_week uuid := gen_random_uuid();
     v_session uuid := gen_random_uuid();
     v_slot uuid := gen_random_uuid();
     v_set uuid := gen_random_uuid();
     v_as_coach text;
     v_as_athlete text;
     v_stamped timestamptz;
     v_forged timestamptz;
     v_inside integer;
     v_after integer;
     v_in_trash integer;
     v_back timestamptz;
     v_other timestamptz;
     v_answer text;
   begin
     if not exists (select 1 from pg_attribute a
                     where a.attrelid = to_regclass($m$public.programs$m$)
                       and a.attname = $m$deactivated_at$m$ and not a.attisdropped) then
       raise exception $m$check only, nothing was written: NOT THERE: a block does not say when it was switched off$m$;
     end if;

     insert into auth.users (id, email, aud, role) values
       (v_coach, $m$sl-check-17-coach@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$),
       (v_athlete, $m$sl-check-17-athlete@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$);
     update public.profiles set role = $m$coach$m$ where id = v_coach;
     if not exists (select 1 from public.profiles where id = v_coach and role = $m$coach$m$) then
       raise exception $m$check only, nothing was written: NOT TRIED: the account made for the check could not be made a coach$m$;
     end if;
     insert into public.students (id, profile_id, coach_id) values (v_link, v_athlete, v_coach);
     insert into public.exercise_library (id, coach_id, name, type, difficulty)
       values (v_exercise, v_coach, $m$sl-check-17$m$, $m$pull$m$, 1);
     insert into public.programs (id, student_id, name, is_active) values
       (v_first, v_link, $m$sl-check-17 first$m$, true),
       (v_next, v_link, $m$sl-check-17 next$m$, false);
     insert into public.weeks (id, program_id, week_number) values (v_week, v_first, 1);
     insert into public.sessions (id, week_id, title, sort_order) values (v_session, v_week, $m$one$m$, 0);
     insert into public.exercise_slots (id, session_id, exercise_id, sets, reps, sort_order)
       values (v_slot, v_session, v_exercise, 1, 5, 0);
     insert into public.set_logs (id, exercise_slot_id, set_number, target_reps) values (v_set, v_slot, 1, 5);

     v_as_coach := json_build_object($m$sub$m$, v_coach, $m$role$m$, $m$authenticated$m$)::text;
     v_as_athlete := json_build_object($m$sub$m$, v_athlete, $m$role$m$, $m$authenticated$m$)::text;

     perform set_config($m$role$m$, $m$authenticated$m$, true);
     perform set_config($m$request.jwt.claims$m$, v_as_coach, true);
     update public.programs set is_active = false where student_id = v_link and is_active = true;
     update public.programs set is_active = true where id = v_next;
     select p.deactivated_at into v_stamped from public.programs p where p.id = v_first;
     update public.programs set deactivated_at = now() + interval $m$10 years$m$ where id = v_first;
     select p.deactivated_at into v_forged from public.programs p where p.id = v_first;

     perform set_config($m$request.jwt.claims$m$, v_as_athlete, true);
     update public.set_logs set done = true, logged_at = now() where id = v_set;
     get diagnostics v_inside = row_count;

     perform set_config($m$role$m$, $m$postgres$m$, true);
     perform set_config($m$request.jwt.claims$m$, $m$$m$, true);
     update public.programs set deactivated_at = now() - interval $m$73 hours$m$ where id = v_first;
     perform set_config($m$role$m$, $m$authenticated$m$, true);
     perform set_config($m$request.jwt.claims$m$, v_as_athlete, true);
     update public.set_logs set rpe = 8 where id = v_set;
     get diagnostics v_after = row_count;

     perform set_config($m$role$m$, $m$postgres$m$, true);
     perform set_config($m$request.jwt.claims$m$, $m$$m$, true);
     update public.programs set deactivated_at = now() - interval $m$1 hour$m$, deleted_at = now() where id = v_first;
     perform set_config($m$role$m$, $m$authenticated$m$, true);
     perform set_config($m$request.jwt.claims$m$, v_as_athlete, true);
     update public.set_logs set rpe = 9 where id = v_set;
     get diagnostics v_in_trash = row_count;

     perform set_config($m$role$m$, $m$postgres$m$, true);
     perform set_config($m$request.jwt.claims$m$, $m$$m$, true);
     update public.programs set deleted_at = null where id = v_first;
     perform set_config($m$role$m$, $m$authenticated$m$, true);
     perform set_config($m$request.jwt.claims$m$, v_as_coach, true);
     perform public.activate_program(v_first);

     perform set_config($m$role$m$, $m$postgres$m$, true);
     perform set_config($m$request.jwt.claims$m$, $m$$m$, true);
     select p.deactivated_at into v_back from public.programs p where p.id = v_first;
     select p.deactivated_at into v_other from public.programs p where p.id = v_next;

     v_answer := case
       when v_stamped is distinct from now()
         then $m$BROKEN: a block switched off by the two requests of the app does not say when$m$
       when v_forged is distinct from v_stamped
         then $m$NOT PROTECTED: a signed-in user wrote the time a block was switched off$m$
       when v_inside <> 1
         then $m$BROKEN: the athlete cannot write a set of a block that was switched off a moment ago$m$
       when v_after <> 0
         then $m$NOT PROTECTED: the athlete wrote a set of a block switched off 73 hours ago$m$
       when v_in_trash <> 0
         then $m$NOT PROTECTED: the athlete wrote a set of a block in the trash$m$
       when v_back is not null or v_other is distinct from now()
         then $m$BROKEN: activate_program did not empty the time of the block it switched on and write the time of the one it switched off$m$
       else $m$in place: a block says when it was switched off, by the two requests of the app and by activate_program alike; its athlete writes in it for 72 hours, no longer, and never once it is in the trash; a signed-in user does not write that time$m$
     end;
     raise exception $m$check only, nothing was written: %$m$, v_answer;
   end $check$'
   ```

   The command must fail with `check only, nothing was written: in place: a block says when it was switched off, by the two requests of the app and by activate_program alike; its athlete writes in it for 72 hours, no longer, and never once it is in the trash; a signed-in user does not write that time`. Run before the migration, the same command fails with `… NOT THERE: a block does not say when it was switched off` — and writes nothing either.

   Anything else is **not** the answer:

   - `… NOT THERE: …` after the migration — the migration is not in this database. Read the ledger.
   - `… NOT PROTECTED: …` or `… BROKEN: …` — the window does not do what this page says: **roll back**, and report the full message.
   - `… NOT TRIED: the account made for the check could not be made a coach` — migration 07 is not in the database, or was rolled back. Read the ledger.
   - a message that does not start with `check only` — the check could not get as far as its questions (the message says why). Nothing was written. Report it; lines 2 to 9 of the audit are then what says whether the migration is in place.

4. Nothing to look at in the app that is deployed: every screen is what it was. The first switch of block after this migration is the first block with a window; [The blocks that are still open](#the-blocks-that-are-still-open) lists it.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_13_17_replay_grace_window.down.sql
```

It puts back the rule "an athlete writes only in the block that is the active one" and drops the trigger, its function and the column.

**It reopens P55, and it closes every open window at once**: what is waiting on a phone for a block that was switched off in the last three days is refused when it arrives, and is lost. Every app works without the migration as it did before it. The only reasons to run this file are step 3 answering `NOT PROTECTED` or `BROKEN`, or a migration applied to the wrong project.

The times do not come back: applied again, the migration starts with no block on record. No row is deleted, and nothing that was saved inside a window is touched.

It is refused (code `SLM04`) once a later migration is in the ledger. Roll those back first, last applied first.

## The blocks that are still open

For lines 12 to 14 of the audit: the blocks that were switched off in the last 72 hours. One line per block, **after** the migration:

```bash
supabase db query --linked "select pr.full_name as athlete, p.name as block, to_char(p.deactivated_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as switched_off_utc, to_char((p.deactivated_at + interval '72 hours') at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as open_until_utc, case when p.deleted_at is not null then 'no: in the trash' when p.status <> 'approved' then 'no: a draft' else 'yes' end as open_for_its_athlete, p.id as block_id from public.programs p join public.students st on st.id = p.student_id join public.profiles pr on pr.id = st.profile_id where not p.is_active and p.deactivated_at > now() - interval '72 hours' order by p.deactivated_at desc"
```

Nothing to do about them: each closes by itself at `open_until_utc`. What their athletes send until then is saved in the session it was logged in, and the coach finds it there.

## Closing a window early, or opening one again

Both are for the owner, from the SQL editor or the CLI: nobody who is signed in can write the time. `block_id` is the last column of the list above.

**Close it now** — the block is closed for its athlete at once, as if it had been switched off long ago. What is still waiting on a phone for it will be refused:

```bash
supabase db query --linked "update public.programs set deactivated_at = null where id = '<id of the block>' and not is_active returning name"
```

**Open it again for 72 hours from now** — for an athlete who tells you their phone has been without a connection since before the switch, and longer than three days:

```bash
supabase db query --linked "update public.programs set deactivated_at = now() where id = '<id of the block>' and not is_active and deleted_at is null returning name"
```

Each returns the name of the block, or no row: the id is the block being trained, or no block at all — or, for the second statement, a block in the trash. Opening a window helps for what a phone has **not sent yet**. What was already refused is not sent again by the app.

Neither is needed to give an athlete their block back: that is *Set active*, in the app.

## A time that should not be there

For line 15 of the audit, which reads `0` unless the column was written by hand, from the SQL editor:

```bash
supabase db query --linked "select pr.full_name as athlete, p.name as block, p.is_active, p.status, p.deactivated_at, p.id as block_id from public.programs p join public.students st on st.id = p.student_id join public.profiles pr on pr.id = st.profile_id where p.deactivated_at is not null and (p.is_active or p.status = 'draft' or p.deactivated_at > now()) order by 1, 2"
```

- **the active block** — the time means nothing there: the block is open anyway, and the time is emptied the next time the block is written. Leave it.
- **a draft** — the time is not read: a draft is never trained in, window or not. Leave it, or empty it with the first statement of the section above.
- **a time still to come** — the block stays open for its athlete until 72 hours after that time. If nobody meant that, close it with the first statement of the section above.
