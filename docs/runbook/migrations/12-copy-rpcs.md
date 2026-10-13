# 12 — A session, a phase and a block are duplicated, and sessions are copied, in one request each

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_13_12_copy_rpcs.sql` |
| Audit | `supabase/audits/2026_10_13_12_copy_rpcs.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_13_12_copy_rpcs.down.sql` |
| Kind | required · expand: adds 4 functions; no table, no column, no policy, no trigger, no row |
| Wave / checkpoint | 1 / A3 |
| Findings | P52 (the database's half) |
| Needs | migration 11 |

Safe with the app that is deployed today: nothing calls the four functions yet, and nothing that exists is changed. The version of the app that follows wave 1 calls them — this migration must be in the database before that version is published, and the deploy checks the ledger for it.

## What it does

*Duplicate* and *Copy to…* are done by the app today, one request per row or per table: the session, then its exercises, then the sets of those exercises — and for a block the same again for every phase and every session of it, thirty to forty requests, each saved on its own.

- **A request that is lost half-way** — the network, a tab that closes — leaves what the requests before it made: a session with no exercise, or exercises with no set, in the block the athlete is training, where they see it at once. Nothing tells the coach that the copy is not whole.
- **The sets are read back in one request** that names every exercise of the phase in its address and answers at most 1000 rows, without saying that there were more (P52).

The migration adds one function for each gesture, which makes the whole copy or nothing:

1. **`duplicate_session(p_session_id, p_title_suffix)`** — a copy of the session, right after it in its phase; the sessions that follow move down by one.
2. **`copy_sessions(p_session_ids, p_dest_week_id)`** — one copy per entry of the list, at the end of the phase, in the order of the list.
3. **`duplicate_week(p_week_id, p_dest_program_id, p_label_suffix)`** — a copy of the phase with its sessions, as the last phase of the block: its own, or another one.
4. **`duplicate_program(p_program_id, p_target_student_id, p_name_suffix)`** — a copy of the block with its phases and sessions, **not active**, last in the list of its athlete — or of another athlete of the same coach.

**A copy is the prescription, and nothing of what was trained**: the title and the recommended weekday of a session, everything the coach wrote on an exercise, the number and the targets of each set. Not the sets that were done, failed or skipped, not the RPE, the weights or the times, not the sets the athlete added, not their notes, swaps or videos, not the review, and not the day a session was trained. A phase or a block that is duplicated keeps its archived sessions archived; a session copied on its own arrives live. This is what the app copies today, column for column.

**An exercise from another coach's library is left out, and the answer says how many were.** Since migration 05 a session takes exercises from the library of its athlete's coach only. An athlete who changed coach still has blocks written with the former coach's exercises: copying one of those gives the sessions and whatever exercises are in the new coach's library, and `slots_left_out` counts the others. Without a change of coach it is always `0`.

They give nobody a right they did not have: they run with the rights of whoever calls them. What is copied is what the caller can read, where it goes is where the caller can write — so a coach copies for their own athletes and from one of them to another, and nobody else does. Nothing else changes: no table, no rule, no row.

## What the deployed client does differently

Nothing. The app that is deployed does not call these functions and goes on with its own requests, which work as before.

**For somebody who calls the API by hand:**

| Who calls | Answer |
|---|---|
| nobody signed in | `permission denied for function duplicate_session` (or `copy_sessions`, `duplicate_week`, `duplicate_program`) |
| a coach, for a session, a phase or a block of somebody else's athlete — or an id that is none | `session_not_found`, `week_not_found` or `program_not_found` |
| a coach, with a list of sessions in which one is not theirs to read | `session_not_found` — the details count them; none of the list is copied |
| a coach, for an athlete of another coach | `student_not_found` |
| the athlete of the block | `not authorized` |
| anybody, when what was to be copied was deleted or moved while the call waited | `copy_source_changed` — read again, then try again |

In every one of those cases nothing was written.

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_13_12_copy_rpcs.audit.sql
```

What it prints, before and after the migration:

| # | check | before | after |
|---|---|---|---|
| 1 | running as | `postgres` | `postgres` |
| 2 | a session is duplicated in one request (duplicate_session, P52) | `no` | `yes` |
| 3 | sessions are copied into a phase in one request (copy_sessions, P52) | `no` | `yes` |
| 4 | a phase is duplicated in one request (duplicate_week, P52) | `no` | `yes` |
| 5 | a block is duplicated in one request (duplicate_program, P52) | `no` | `yes` |
| 6 | functions of these names that the migration does not know | `none` | `none` |
| 7 | functions of this migration a request without a session may execute | `none` | `none` |
| 8 | functions of this migration a signed-in user may execute | `none` | `copy_sessions(uuid[], uuid); duplicate_program(uuid, uuid, text); duplicate_session(uuid, text); duplicate_week(uuid, uuid, text)` |
| 9 | functions of this migration that run as their owner | `none` | `none` |
| 10 | functions of this migration without search_path = public, pg_temp | `none` | `none` |
| 11 | sessions without an exercise | a number | the same number |
| 12 | exercises without a set | a number | the same number |
| 13 | exercises that are not in the library of their athlete's coach | `0` | `0` |

Lines 11 to 13 are for information. The migration changes none of them, and none of them stops it.

If the "before" column is not what you see:

- **1** is not `postgres` — stop and report. The migration refuses to run as anyone else.
- **2 to 5 already read `yes`** — read the ledger (below). If migration 12 is there, you are done. If it is not, a function of that name was made by hand: stop and report.
- **6** is not `none` — **stop and report the line.** A function with one of the four names and other arguments exists; the migration refuses to run next to it.
- **7, 9 or 10** is not `none`, or **8** is not `none` before the migration — same: stop and report.
- **11** is not `0` — go on, and read [Sessions without an exercise](#sessions-without-an-exercise) afterwards.
- **12** is not `0` — go on, and read [Exercises without a set](#exercises-without-a-set) afterwards.
- **13** is not `0` — go on, and read [Exercises of another coach's library](#exercises-of-another-coachs-library) afterwards.

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_13_12_copy_rpcs.sql
```

A refusal changes nothing:

| Message contains | Meaning | Do |
|---|---|---|
| `needs 2026_10_13_11_activate_reorder_rpcs, which is not applied` (code `SLM02`) | migration 11 is not in the database | apply it first, with its checks |
| `must be run as postgres` | line 1 of the audit | stop and report |
| `would not create: … is already there` | lines 2 to 6 of the audit: a function of one of the four names exists | stop and report the names |
| `does not find the columns its functions are written with: …` | a column of one of the seven tables the functions read or write is not there under its name | stop and report the full message |
| `did not get the functions it meant: …` | the file read its own result back and it was not the one described here | stop and report the full message |

## After

1. Run the audit again. Lines 2 to 5 read `yes` and line 8 lists the four functions; the others are unchanged.

2. Read the ledger:

   ```bash
   supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
   ```

   Expected: twelve rows, the last one `2026_10_13_12_copy_rpcs`.

3. See it for yourself. This creates a coach and two athletes: the first with a block of one phase and two sessions, of which one holds an exercise with two sets, one of them done; the second with an empty phase. Through the API's role, as the first athlete, it tries to duplicate a session; as the coach, it duplicates that session, copies both sessions to the second athlete, duplicates the phase, and duplicates the whole block for the second athlete. Then it fails **whatever happened**, so that nothing is kept, the three accounts included. The answer is in the message:

   ```bash
   supabase db query --linked 'do $check$
   declare
     v_coach uuid := gen_random_uuid();
     v_athlete uuid := gen_random_uuid();
     v_second uuid := gen_random_uuid();
     v_link uuid := gen_random_uuid();
     v_link_second uuid := gen_random_uuid();
     v_exercise uuid := gen_random_uuid();
     v_block uuid := gen_random_uuid();
     v_theirs uuid := gen_random_uuid();
     v_phase uuid := gen_random_uuid();
     v_their_phase uuid := gen_random_uuid();
     v_one uuid := gen_random_uuid();
     v_two uuid := gen_random_uuid();
     v_slot uuid := gen_random_uuid();
     v_made jsonb;
     v_answer text;
   begin
     if to_regprocedure($m$public.duplicate_session(uuid, text)$m$) is null
        or to_regprocedure($m$public.copy_sessions(uuid[], uuid)$m$) is null
        or to_regprocedure($m$public.duplicate_week(uuid, uuid, text)$m$) is null
        or to_regprocedure($m$public.duplicate_program(uuid, uuid, text)$m$) is null then
       raise exception $m$check only, nothing was written: NOT THERE: the four functions are not in the database$m$;
     end if;

     insert into auth.users (id, email, aud, role) values
       (v_coach, $m$sl-check-12-coach@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$),
       (v_athlete, $m$sl-check-12-athlete@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$),
       (v_second, $m$sl-check-12-second@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$);
     update public.profiles set role = $m$coach$m$ where id = v_coach;
     if not exists (select 1 from public.profiles where id = v_coach and role = $m$coach$m$) then
       raise exception $m$check only, nothing was written: NOT TRIED: the account made for the check could not be made a coach$m$;
     end if;
     insert into public.students (id, profile_id, coach_id) values
       (v_link, v_athlete, v_coach), (v_link_second, v_second, v_coach);
     insert into public.exercise_library (id, coach_id, name, type, difficulty) values
       (v_exercise, v_coach, $m$sl-check-12$m$, $m$pull$m$, 1);
     insert into public.programs (id, student_id, name, is_active) values
       (v_block, v_link, $m$sl-check-12 block$m$, true),
       (v_theirs, v_link_second, $m$sl-check-12 theirs$m$, true);
     insert into public.weeks (id, program_id, week_number, label) values
       (v_phase, v_block, 1, $m$base$m$), (v_their_phase, v_theirs, 1, null);
     insert into public.sessions (id, week_id, title, sort_order) values
       (v_one, v_phase, $m$one$m$, 0), (v_two, v_phase, $m$two$m$, 1);
     insert into public.exercise_slots (id, session_id, exercise_id, sets, reps, sort_order) values
       (v_slot, v_one, v_exercise, 2, 5, 0);
     insert into public.set_logs (exercise_slot_id, set_number, target_reps, done, rpe, logged_at) values
       (v_slot, 1, 5, true, 8, now()), (v_slot, 2, 4, false, null, null);

     perform set_config($m$role$m$, $m$authenticated$m$, true);
     perform set_config($m$request.jwt.claims$m$,
       json_build_object($m$sub$m$, v_athlete, $m$role$m$, $m$authenticated$m$)::text, true);
     begin
       perform public.duplicate_session(v_one);
       v_answer := $m$NOT PROTECTED: an athlete duplicated a session of their block$m$;
     exception when insufficient_privilege then
       null;
     end;

     if v_answer is null then
       perform set_config($m$request.jwt.claims$m$,
         json_build_object($m$sub$m$, v_coach, $m$role$m$, $m$authenticated$m$)::text, true);
       perform public.duplicate_session(v_one);
       perform public.copy_sessions(array[v_two, v_one], v_their_phase);
       perform public.duplicate_week(v_phase);
       v_made := public.duplicate_program(v_block, v_link_second);

       v_answer := case
         when (select string_agg(s.title, $m$, $m$ order by s.sort_order) from public.sessions s where s.week_id = v_phase)
              is distinct from $m$one, one (copy), two$m$
           then $m$BROKEN: after duplicate_session the copy is not right after its source$m$
         when (select string_agg(s.title, $m$, $m$ order by s.sort_order) from public.sessions s where s.week_id = v_their_phase)
              is distinct from $m$two, one$m$
           then $m$BROKEN: after copy_sessions the copies are not at the end of the phase, in the order of the list$m$
         when (select string_agg(coalesce(w.label, $m$-$m$), $m$, $m$ order by w.week_number) from public.weeks w where w.program_id = v_block)
              is distinct from $m$base, base (copy)$m$
           then $m$BROKEN: after duplicate_week the copy is not the last phase of the block$m$
         when not exists (select 1 from public.programs p
                           where p.id = (v_made ->> $m$program_id$m$)::uuid and p.student_id = v_link_second
                             and not p.is_active and p.name = $m$sl-check-12 block (copy)$m$)
           then $m$BROKEN: after duplicate_program the other athlete has no inactive copy of the block$m$
         when (select count(*) from public.set_logs) <> 18 or (v_made ->> $m$set_logs$m$)::int <> 8
           then $m$BROKEN: a copy does not hold the sets of its source$m$
         when (select count(*) from public.set_logs sl where sl.done or sl.rpe is not null or sl.logged_at is not null) <> 1
           then $m$BROKEN: a copy holds what the athlete trained$m$
         else $m$in place: a coach duplicates a session, a phase and a block and copies sessions to another athlete in one request each, a copy holds the targets and nothing that was trained, and an athlete does not$m$
       end;
     end if;
     raise exception $m$check only, nothing was written: %$m$, v_answer;
   end $check$'
   ```

   The command must fail with `check only, nothing was written: in place: a coach duplicates a session, a phase and a block and copies sessions to another athlete in one request each, a copy holds the targets and nothing that was trained, and an athlete does not`. Run before the migration, the same command fails with `… NOT THERE: the four functions are not in the database` — and writes nothing either.

   Anything else is **not** the answer:

   - `… NOT THERE: …` after the migration — the migration is not in this database. Read the ledger.
   - `… NOT PROTECTED: …` or `… BROKEN: …` — a function does not do what this page says: **roll back**, and report the full message.
   - `… NOT TRIED: the account made for the check could not be made a coach` — migration 07 is not in the database, or was rolled back. Read the ledger.
   - a message that does not start with `check only` — the check could not get as far as its questions (the message says why). Nothing was written. Report it; lines 2 to 10 of the audit are then what says whether the migration is in place.

4. Nothing to look at in the app that is deployed: it does not use the functions.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_13_12_copy_rpcs.down.sql
```

It drops the four functions. No row is written: the sessions, phases and blocks they copied stay where they are, with their exercises and their sets.

**Not once the version of the app that follows wave 1 is published.** That version duplicates and copies through these functions and through nothing else: without them each of those gestures fails, for every coach, until the migration is applied again. Before that, nothing calls them, and the only reasons to run this file are step 3 answering `NOT PROTECTED` or `BROKEN`, or a migration applied to the wrong project.

It is refused (code `SLM04`) once a later migration is in the ledger. Roll those back first, last applied first.

## Sessions without an exercise

For line 11 of the audit: sessions that hold no exercise, in approved blocks that are not in the trash, archived sessions left out. A session the coach has just added and not written yet looks like that — and so does what a *Duplicate* or a *Copy to…* of the app leaves behind when the request after the session is lost: the athlete sees a session with a title and nothing to do in it. List them:

```bash
supabase db query --linked "select pr.full_name as athlete, p.name as block, coalesce(s.title, '(no title)') as session, s.created_at::date as created from public.sessions s join public.weeks w on w.id = s.week_id join public.programs p on p.id = w.program_id join public.students st on st.id = p.student_id join public.profiles pr on pr.id = st.profile_id where p.status = 'approved' and p.deleted_at is null and s.archived_at is null and not exists (select 1 from public.exercise_slots es where es.session_id = s.id) order by 1, 2, s.created_at, s.id"
```

One row per session. Nothing to repair in the database: tell the coach, who opens each one and writes it, or deletes it — a title that ends in *(copy)* is a copy that did not finish.

## Exercises without a set

For line 12 of the audit: exercises that hold no set at all, in approved blocks that are not in the trash. It is what the same lost request leaves one step later — the exercises were copied, their sets were not — and what a copy of an athlete's draft looks like, because a draft has no sets before it is approved. List the blocks concerned:

```bash
supabase db query --linked "select pr.full_name as athlete, p.name as block, count(distinct s.id) as sessions, count(*) as exercises from public.exercise_slots es join public.sessions s on s.id = es.session_id join public.weeks w on w.id = s.week_id join public.programs p on p.id = w.program_id join public.students st on st.id = p.student_id join public.profiles pr on pr.id = st.profile_id where p.status = 'approved' and p.deleted_at is null and not exists (select 1 from public.set_logs sl where sl.exercise_slot_id = es.id) group by pr.full_name, p.id, p.name order by 1, 2"
```

One row per block. Nothing to repair in the database: the athlete's app adds the missing sets when the session is opened, from the numbers of the exercise itself — every set with the same targets. Where the coach had written sets that differ (a back-off set, a drop set), those are not in the copy: tell the coach of the blocks listed to look at them. The four functions copy the sets with their exercises, so a copy made after the next version of the app is published cannot end that way.

## Exercises of another coach's library

For line 13 of the audit: exercises whose library is not the one of their athlete's coach. `0` is expected: it can only be something else after an athlete was moved to another coach (`public.transfer_student`), whose blocks then still name the former coach's exercises. List them:

```bash
supabase db query --linked "select pr.full_name as athlete, coach.full_name as coach, owner.full_name as library_of, count(*) as exercises from public.exercise_slots es join public.exercise_library el on el.id = es.exercise_id join public.sessions s on s.id = es.session_id join public.weeks w on w.id = s.week_id join public.programs p on p.id = w.program_id join public.students st on st.id = p.student_id join public.profiles pr on pr.id = st.profile_id join public.profiles coach on coach.id = st.coach_id join public.profiles owner on owner.id = el.coach_id where el.coach_id <> st.coach_id group by pr.full_name, coach.full_name, owner.full_name order by 1, 3"
```

One row per athlete and former coach. Nothing is wrong with those rows, and nothing needs repair: the athlete's history stays as it was trained. What it means for a copy: the four functions leave those exercises out — the copy holds the sessions and the exercises that are in the new coach's library — and answer how many were left out, so that the app can say so. The coach writes them again with their own exercises.
