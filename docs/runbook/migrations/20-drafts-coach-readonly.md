# 20 — The draft an athlete is writing is theirs alone: the coach approves it, sends it back, renames it — and changes nothing in it

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_16_20_drafts_coach_readonly.sql` |
| Audit | `supabase/audits/2026_10_16_20_drafts_coach_readonly.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_16_20_drafts_coach_readonly.down.sql` |
| Kind | required · adds 4 triggers and their functions, replaces 1 function; no table, no column, no policy, no row |
| Wave / checkpoint | 3 / C1 |
| Findings | P53 (the database's half) |
| Needs | migration 18 |

Safe with the app that is deployed today and with every version before it: the athlete's side is unchanged, and so are *Approve*, *Send back*, renaming a draft and the trash. What changes for the coach is said below.

## What it does

An athlete can write a block of their own — a **draft** — and send it to you; you approve it or send it back. Until now the database let you change what is in a draft the way you change one of your blocks, and the app let you try: a draft opens in the Program Sheet like any block. Two things then went wrong (P53):

- **Your change was lost.** Each time the athlete saves their draft, the app sends the whole draft as their phone holds it, and the database writes it again from that: your note, a superset, a video you asked for, a target set by set — gone at their next save, and nobody is told.
- **Sets without reps or load.** Raising *Sets* in a draft added the new sets with the targets of the last set the editor finds — and a draft has none. Approving the draft did not replace them: the athlete got sessions with empty sets.

From this migration on:

1. **The phases, sessions, exercises and sets of a draft are written by its author alone.** Anybody else who is signed in — you included — is refused, with the word `draft_read_only`, and nothing is written. That holds for adding, changing, removing, and for moving something into a draft or out of one. A draft in the trash is still a draft.
2. **The draft itself stays yours to handle**: approve it, send it back, rename it, put it in the trash, take it out of the trash, delete it, duplicate it into a new block of yours.
3. **Approving a draft gives every set its target.** The approval now marks the program approved first, then drops the sets that have neither reps nor a duration (the ones your editor added to a draft), and writes the missing sets from each exercise — reps or a duration, the load and the rest the exercise says. A set with a target is kept, as before.

What does not change:

- **The athlete writes their draft as before** — the app's save, discarding the draft, everything their own rights let them do.
- **Your blocks, and the blocks your athletes wrote once you approved them**, are edited as before.
- **The SQL editor and the service role** write a draft as before: nothing that runs without a user id is refused.
- **A new name you give a draft is the athlete's to keep or not**: their next save writes the name their phone holds, as before.

## What the deployed client does differently

**The athlete: nothing.**

**The coach — the app that is deployed, and every one before it:** a draft still opens in the Program Sheet. A change to it — a phase, a session, an exercise, a set, a reorder, a copy into it — is refused with the toast *Couldn't save that. Please try again.* Trying again gives the same answer: approve the draft or send it back first. Before the migration the change was accepted, and lost at the athlete's next save. *Approve*, *Send back*, renaming and the trash work as before. The next app says why, and does not offer the change on a draft.

**For somebody who calls the API by hand:**

| Who writes | What | Answer |
|---|---|---|
| the coach of the athlete | a phase, a session, an exercise or a set of a draft — inserted, updated, deleted, moved in or out; directly or through `move_session`, `reorder_sessions`, `reorder_weeks`, `duplicate_session`, `copy_sessions`, `duplicate_week` | refused: `draft_read_only` (code `P0001`); nothing is written |
| the coach of the athlete | the row of the draft: `approve_program`, `send_back_program`, a new name, the trash and back, a delete; `duplicate_program` of a draft | as before |
| the author of the draft | `save_draft_tree`, discarding the draft, any write their policies let through | as before |
| another account | a row of somebody else's draft | as before for an update or a delete: no row is reached. An insert is refused as before, now with `draft_read_only` instead of the message of row-level security |
| the SQL editor, the service role | anything | as before |

`approve_program` answers what it answered: `{ "approved": true, "set_logs_created": n }` — `n` counts the sets it wrote, the ones written again included — or `{ "approved": false }` for a program that is not a draft. Two approvals of the same draft sent at the same instant: the first approves, the second answers `{ "approved": false }`.

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_16_20_drafts_coach_readonly.audit.sql
```

What it prints, before and after the migration:

| # | check | before | after |
|---|---|---|---|
| 1 | running as | `postgres` | `postgres` |
| 2 | who writes the phases, sessions, exercises and sets of a draft (P53) | `its author, and the coach of its athlete` | `its author only` |
| 3 | the triggers that keep a draft its author's (block_draft_tree_write) | `none` | `weeks, sessions, exercise_slots, set_logs` |
| 4 | what approve_program does with the sets of a draft (P53) | `adds the missing sets, then marks the program approved` | `marks the program approved, drops the sets without a target, adds the missing sets` |
| 5 | functions of these names that the migration does not know | `none` | `none` |
| 6 | functions of this migration a request without a session may execute | `none` | `none` |
| 7 | functions of this migration a signed-in user may execute | `approve_program(uuid)` | `approve_program(uuid)` |
| 8 | functions of this migration that run as their owner | `approve_program(uuid)` | `approve_program(uuid); block_draft_session_write(); block_draft_set_log_write(); block_draft_slot_write(); block_draft_week_write()` |
| 9 | functions of this migration without search_path = public, pg_temp | `none` | `none` |
| 10 | drafts out of the trash | a sentence | the same sentence |
| 11 | drafts in the trash | a number | the same number |
| 12 | drafts nobody wrote: a block made a draft again by its coach (no author) | a number | the same number |
| 13 | sets in drafts — written by a coach, before the migration | a number | the same number |
| 14 | … without a target: dropped and written again from their exercise when the draft is approved | a number | the same number |
| 15 | … the others — a target, or logged, added or filmed: kept when the draft is approved | a number | the same number |

Line 7 is meant, before and after: the app calls the approval with the rights of the coach. Lines 10 to 15 are the rows; the migration writes none of them.

If the "before" column is not what you see:

- **1** is not `postgres` — stop and report. The migration refuses to run as anyone else.
- **2** reads `its author only`, **3** names tables or **4** reads `marks the program approved, drops …` — read the ledger (below). If migration 20 is there, you are done. If it is not, something of that name was made by hand: stop and report.
- **2** starts with `PARTLY:` — **stop and report the line.** Some of the triggers exist, made by hand.
- **4** starts with `SOMETHING ELSE:` or `NOT THERE:` — **stop and report the line.** The approval is not the one of migration 15, and the migration refuses to replace it.
- **5** is not `none` — **stop and report the line.** A function with one of the five names and other arguments exists.
- **6** or **9** is not `none`, or **7** or **8** is not what the column says — stop and report.
- **10 and 11** — any numbers. `N being written, M sent in`: the M wait for you to approve them or send them back. From the migration on you change nothing in any of them.
- **12** — `0`, or a block that was made a draft again by hand. Nobody who signs in can change what is in it once the migration is applied, you included: see [A draft nobody wrote](#a-draft-nobody-wrote).
- **13 to 15** — `0` when no coach changed the sets of a draft. Otherwise: line 14 counts the sets of a higher *Sets* your editor wrote without reps or load; approving the draft writes them again from the exercise. [The drafts and their sets](#the-drafts-and-their-sets) lists them by draft. Nothing to do before the migration.

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_16_20_drafts_coach_readonly.sql
```

It holds the four tables of a block — phases, sessions, exercises, sets — against writes for an instant: an athlete who ticks a set in that instant waits for it.

A refusal changes nothing:

| Message contains | Meaning | Do |
|---|---|---|
| `needs 2026_10_13_18_retention, which is not applied` (code `SLM02`) | migration 18 is not in the database | apply it first, with its checks |
| `must be run as postgres` | line 1 of the audit | stop and report |
| `would not create: … is already there` | lines 2, 3 and 5 of the audit: a trigger or a function of this migration exists | stop and report the names |
| `would not replace approve_program: …` | lines 4 and 5 of the audit | stop and report the full message |
| `does not find what its functions are written with: …` | a column or a function the triggers read is not there under its name | stop and report the full message |
| `did not get what it meant: …` | the file read its own result back and it was not the one described here | stop and report the full message |
| `canceling statement due to lock timeout` | a request held one of the four tables for more than five seconds | nothing was changed: run it again |

## After

1. Run the audit again. Lines 2, 3, 4 and 8 read as the "after" column; the others are unchanged.

2. Read the ledger:

   ```bash
   supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
   ```

   Expected: nineteen rows, the last one `2026_10_16_20_drafts_coach_readonly` — twenty where the optional migration 19 was applied at Checkpoint B.

3. See it for yourself. This creates a coach and an athlete, and a draft the athlete wrote and sent in: one phase, one session, one exercise of 3 sets of 5 at 20 kg — and one set without a target in it, the way the coach's editor wrote a higher *Sets* in a draft before the migration. Through the API's role, as the coach, it tries six changes to the draft, each on its own. As the athlete it changes the reps of the exercise. As the coach it renames the draft and approves it, then reads the sets of the approved block. Then it fails **whatever happened**, so that nothing is kept, the two accounts included. The answer is in the message:

   ```bash
   supabase db query --linked 'do $check$
   declare
     v_coach uuid := gen_random_uuid();
     v_athlete uuid := gen_random_uuid();
     v_link uuid := gen_random_uuid();
     v_exercise uuid := gen_random_uuid();
     v_draft uuid := gen_random_uuid();
     v_week uuid := gen_random_uuid();
     v_session uuid := gen_random_uuid();
     v_slot uuid := gen_random_uuid();
     v_bare uuid := gen_random_uuid();
     v_as_coach text;
     v_as_athlete text;
     v_what text;
     v_rows integer;
     v_written text := $m$$m$;
     v_odd text := $m$$m$;
     v_author integer;
     v_renamed integer;
     v_answer jsonb;
     v_sets integer;
     v_without integer;
     v_status text;
     v_result text;
   begin
     if not exists (select 1 from pg_trigger t
                     where t.tgrelid = to_regclass($m$public.set_logs$m$)
                       and t.tgname = $m$block_draft_tree_write$m$ and not t.tgisinternal) then
       raise exception $m$check only, nothing was written: NOT THERE: the coach of an athlete still writes in their draft$m$;
     end if;

     insert into auth.users (id, email, aud, role) values
       (v_coach, $m$sl-check-20-coach@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$),
       (v_athlete, $m$sl-check-20-athlete@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$);
     update public.profiles set role = $m$coach$m$ where id = v_coach;
     if not exists (select 1 from public.profiles where id = v_coach and role = $m$coach$m$) then
       raise exception $m$check only, nothing was written: NOT TRIED: the account made for the check could not be made a coach$m$;
     end if;
     insert into public.students (id, profile_id, coach_id) values (v_link, v_athlete, v_coach);
     insert into public.exercise_library (id, coach_id, name, type, difficulty)
       values (v_exercise, v_coach, $m$sl-check-20$m$, $m$pull$m$, 1);
     insert into public.programs (id, student_id, name, status, is_active, created_by, submitted_at)
       values (v_draft, v_link, $m$sl-check-20 draft$m$, $m$draft$m$, false, v_athlete, now());
     insert into public.weeks (id, program_id, week_number) values (v_week, v_draft, 1);
     insert into public.sessions (id, week_id, title, sort_order) values (v_session, v_week, $m$one$m$, 0);
     insert into public.exercise_slots (id, session_id, exercise_id, sets, reps, weight_kg, rest_seconds, sort_order)
       values (v_slot, v_session, v_exercise, 3, 5, 20, 90, 0);
     insert into public.set_logs (id, exercise_slot_id, set_number) values (v_bare, v_slot, 1);

     v_as_coach := json_build_object($m$sub$m$, v_coach, $m$role$m$, $m$authenticated$m$)::text;
     v_as_athlete := json_build_object($m$sub$m$, v_athlete, $m$role$m$, $m$authenticated$m$)::text;
     perform set_config($m$role$m$, $m$authenticated$m$, true);
     perform set_config($m$request.jwt.claims$m$, v_as_coach, true);

     for v_what in select unnest(array[$m$a phase added$m$, $m$a session renamed$m$, $m$more sets for the exercise$m$,
                                        $m$a set added$m$, $m$a set removed$m$, $m$the exercise removed$m$]) loop
       begin
         case v_what
           when $m$a phase added$m$ then
             insert into public.weeks (program_id, week_number) values (v_draft, 2);
           when $m$a session renamed$m$ then
             update public.sessions set title = $m$renamed$m$ where id = v_session;
           when $m$more sets for the exercise$m$ then
             update public.exercise_slots set sets = 4 where id = v_slot;
           when $m$a set added$m$ then
             insert into public.set_logs (exercise_slot_id, set_number) values (v_slot, 4);
           when $m$a set removed$m$ then
             delete from public.set_logs where id = v_bare;
           else
             delete from public.exercise_slots where id = v_slot;
         end case;
         get diagnostics v_rows = row_count;
         if v_rows > 0 then
           v_written := v_written || $m$, $m$ || v_what;
         else
           v_odd := v_odd || $m$, $m$ || v_what || $m$: no row$m$;
         end if;
       exception when others then
         if sqlstate <> $m$P0001$m$ or sqlerrm <> $m$draft_read_only$m$ then
           v_odd := v_odd || $m$, $m$ || v_what || $m$: $m$ || sqlerrm;
         end if;
       end;
     end loop;

     perform set_config($m$request.jwt.claims$m$, v_as_athlete, true);
     begin
       update public.exercise_slots set reps = 6 where id = v_slot;
       get diagnostics v_author = row_count;
     exception when others then
       v_author := -1;
     end;

     perform set_config($m$request.jwt.claims$m$, v_as_coach, true);
     update public.programs set name = $m$sl-check-20 renamed$m$ where id = v_draft;
     get diagnostics v_renamed = row_count;
     begin
       v_answer := public.approve_program(v_draft);
     exception when others then
       v_answer := jsonb_build_object($m$error$m$, sqlerrm);
     end;

     perform set_config($m$role$m$, $m$postgres$m$, true);
     perform set_config($m$request.jwt.claims$m$, $m$$m$, true);
     select count(*), count(*) filter (where sl.target_reps is distinct from 6 or sl.target_weight_kg is distinct from 20)
       into v_sets, v_without
       from public.set_logs sl where sl.exercise_slot_id = v_slot;
     select p.status into v_status from public.programs p where p.id = v_draft;

     v_result := case
       when v_written <> $m$$m$
         then $m$NOT PROTECTED: the coach wrote in a draft of their athlete: $m$ || substr(v_written, 3)
       when v_odd <> $m$$m$
         then $m$BROKEN: a change of the coach to a draft was not answered draft_read_only: $m$ || substr(v_odd, 3)
       when v_author is distinct from 1
         then $m$BROKEN: the athlete could not change their own draft$m$
       when v_renamed is distinct from 1
         then $m$BROKEN: the coach could not rename a draft$m$
       when v_answer is distinct from jsonb_build_object($m$approved$m$, true, $m$set_logs_created$m$, 3) or v_status <> $m$approved$m$
         then $m$BROKEN: approve_program answered $m$ || coalesce(v_answer::text, $m$nothing$m$) || $m$ and the draft is $m$ || coalesce(v_status, $m$gone$m$)
       when v_sets <> 3 or v_without <> 0
         then $m$BROKEN: the approved block has $m$ || v_sets || $m$ sets, $m$ || v_without || $m$ of them without the reps and load of their exercise$m$
       else $m$in place: the coach changes nothing in a draft of their athlete and is answered draft_read_only; the athlete writes it as before; the coach renames it and approves it, and every set of the approved block has the reps and load of its exercise$m$
     end;
     raise exception $m$check only, nothing was written: %$m$, v_result;
   end $check$'
   ```

   The command must fail with `check only, nothing was written: in place: the coach changes nothing in a draft of their athlete and is answered draft_read_only; the athlete writes it as before; the coach renames it and approves it, and every set of the approved block has the reps and load of its exercise`. Run before the migration, the same command fails with `… NOT THERE: the coach of an athlete still writes in their draft` — and writes nothing either.

   Anything else is **not** the answer:

   - `… NOT THERE: …` after the migration — the migration is not in this database. Read the ledger.
   - `… NOT PROTECTED: …` or `… BROKEN: …` — the migration does not do what this page says: **roll back**, and report the full message.
   - `… NOT TRIED: the account made for the check could not be made a coach` — migration 07 is not in the database, or was rolled back. Read the ledger.
   - a message that does not start with `check only` — the check could not get as far as its questions (the message says why). Nothing was written. Report it; lines 2 to 9 of the audit are then what says whether the migration is in place.

4. In the app, as a coach with an athlete who has a draft: open the draft in the Program Sheet and change anything — the toast *Couldn't save that. Please try again.* answers, and the change is not there when you reload. Nothing else to look at: approve the draft when you would have anyway — the block it becomes has every set with its reps and load.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_16_20_drafts_coach_readonly.down.sql
```

It drops the four triggers and their functions, and puts back the approval of migration 15.

**It reopens P53**: from then on a change you make in a draft is accepted — and lost at the athlete's next save —, and the sets your editor adds to a draft without a target outlive its approval. Every app works without the migration as it did before it. The only reasons to run this file are step 3 answering `NOT PROTECTED` or `BROKEN`, or a migration applied to the wrong project.

No row is written or deleted by it. A draft approved while the migration was in place keeps the sets it was given.

It is refused (code `SLM04`) once a later migration is in the ledger. Roll those back first, last applied first.

## The drafts and their sets

For lines 10 to 15 of the audit: every draft, one line each, with the sets it holds — before or after the migration:

```bash
supabase db query --linked "select pr.full_name as athlete, p.name as draft, case when p.submitted_at is null then 'being written' else 'sent in' end as state, p.deleted_at is not null as in_trash, coalesce(au.full_name, '(nobody)') as written_by, count(sl.id) as sets, count(sl.id) filter (where not sl.is_student_added and sl.target_reps is null and sl.target_duration_seconds is null and not public.set_log_is_logged(sl) and not exists (select 1 from public.set_log_videos v where v.set_log_id = sl.id)) as without_a_target, p.id as draft_id from public.programs p join public.students st on st.id = p.student_id join public.profiles pr on pr.id = st.profile_id left join public.profiles au on au.id = p.created_by left join public.weeks w on w.program_id = p.id left join public.sessions s on s.week_id = w.id left join public.exercise_slots es on es.session_id = s.id left join public.set_logs sl on sl.exercise_slot_id = es.id where p.status = 'draft' group by pr.full_name, p.name, p.submitted_at, p.deleted_at, au.full_name, p.id order by 1, 2"
```

- **`sets` is not 0** — an athlete writes no set in a draft: those are the coach's, written before the migration. Nothing to do: approving the draft keeps the ones with a target and writes the others (`without_a_target`) again from their exercise. If the athlete saves the draft again before it is approved, the sets go with the phases their save deletes — as before the migration.
- **`written_by` is `(nobody)`** — see the next section.

## A draft nobody wrote

For line 12 of the audit. A draft whose author is empty is a block that was made a draft again by hand — by its coach through the API (no screen of the app does it), or from the SQL editor. Once the migration is applied nobody who signs in changes what is in it, the coach included.

**The coach approves it** in the app: *Approve* is offered on every draft. It becomes a block again, not active; the sets it held are kept — those with a target, and every set that was logged — and a missing set is written from its exercise. Nothing else is needed, and nothing else works from the SQL editor: a statement there that sets `status` back is undone without a word on a draft without an author (the pin of migration 06 holds the status for "its author", and the SQL editor has no user id either).

## Changing a draft for your athlete

The draft is theirs until you approve it. To get a change into it:

- **send it back** with what you want changed — they change it and send it in again; or
- **approve it, then change it** — it is then a block like any other. It is not active until you set it active, so the athlete trains nothing of it before you are done.

The SQL editor can still write a draft — it runs without a user id. Their next save replaces whatever it wrote, as it did your changes before the migration: don't.
