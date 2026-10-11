# 04 — Logged training cannot be deleted or rewritten below the session

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_11_04_logged_history_guards.sql` |
| Audit | `supabase/audits/2026_10_11_04_logged_history_guards.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_11_04_logged_history_guards.down.sql` |
| Kind | required · adds 6 functions and 4 triggers, replaces 5 function bodies; no table, no column, no policy, no row |
| Wave / checkpoint | 1 / A2 |
| Findings | P3 (critical), P17 |
| Needs | migration 03 |

Safe with the app that is deployed today: an athlete sees no difference, and a coach is refused only where the app was destroying something.

## What it does

The rule "logged training is never hard-deleted" was enforced on programs, weeks and sessions. Below the session there was nothing, and the coach's session editor opens every session, trained ones included. There:

- the × on a set deleted that set, with its RPE, its actuals and its video;
- typing a lower number in *Sets* deleted the sets above it;
- *Remove exercise* deleted the exercise with all its sets, the athlete's comment and their swap or skip;
- changing reps, load or rest wrote the new numbers onto every set of the exercise, the ones already done included. A set done as prescribed has no numbers of its own: what the athlete "lifted" is read from those targets, so stats and records changed after the fact.

No warning, and nothing could be recovered.

The migration closes this in the database, so it holds whatever the app does:

1. **One definition of a logged set**: ticked done, failed, skipped, rated (RPE), or logged with an actual. A set that carries a video counts as one for points 2 and 3.
2. **Such a set cannot be deleted** — not directly, not with its exercise, session, phase, program, athlete or account. One exception: an *extra* set, deleted by the athlete who added it.
3. ***Sets* cannot go below a logged set.**
4. **The targets of a logged set stay what they were** when a signed-in user edits them. This one is silent: the edit goes through for the sets still to come, and the logged ones keep their numbers.
5. ***Adopt into program* and *Remove from upcoming*** (`adopt_swap`, `adopt_skip`) leave alone an upcoming exercise on which the athlete already has a failed or rated set, a video or a comment. They used to count only done and skipped sets, and could delete an attempt made minutes earlier (P17).
6. **One way through, for you**: a setting you switch on for one transaction in the SQL editor ([Deleting training history on purpose](#deleting-training-history-on-purpose)). The app cannot use it.

Anything nobody trained is deleted and edited as before.

## What the deployed client does differently

**An athlete: nothing.** They still remove an extra set they added, done or not.

**A coach**, in the session editor, on a session the athlete has started:

- × on a logged set, a lower *Sets* that would drop one, *Remove exercise* on an exercise that has one: the red message *This has logged training — archive it instead of deleting.* and nothing is changed. Reload the page if the field still shows the number you typed.
- reps, load or rest changed: no message. The sets already logged keep their numbers and the others take the new ones. From then on the editor shows that exercise set by set, because its sets are no longer all alike; *back to uniform* leaves the logged sets as they are too, and a number typed on a logged set comes back as it was.
- deleting a session, a phase or — from the trash — a block that holds a set with a video and nothing else is now refused with the same message. It went through before.
- *Adopt into program* and *Remove from upcoming* may announce fewer sessions than before.

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_11_04_logged_history_guards.audit.sql
```

What it prints, before and after the migration:

| # | check | before | after |
|---|---|---|---|
| 1 | running as | `postgres` | `postgres` |
| 2 | tables whose logged rows cannot be deleted (P3) | `programs; sessions; weeks` | `exercise_slots; programs; sessions; set_logs; weeks` |
| 3 | the set count cannot go below a logged set | `missing` | `in place` |
| 4 | the targets of a logged set are pinned | `missing` | `in place` |
| 5 | functions that read the shared set_log_is_logged | `none` | `all 9` |
| 6 | adopt functions that overlook a failed set, a video or a comment (P17) | `adopt_skip; adopt_swap` | `none` |
| 7 | guards that honour app.allow_history_delete | `none` | `all 6` |
| 8 | functions of this migration a request without a session may execute | `none` | `none` |
| 9 | functions of this migration a signed-in user may execute | `adopt_skip(uuid, boolean); adopt_swap(uuid, uuid, boolean)` | `adopt_skip(uuid, boolean); adopt_swap(uuid, uuid, boolean)` |
| 10 | functions of this migration without search_path = public, pg_temp | `none` | `none` |
| 11 | sets the athletes have logged | a number, as *N of M* | the same |
| 12 | sets that carry a video | a number | the same |
| 13 | sets left at a parked number (100000 or more) | `0` | `0` |
| 14 | logged sets numbered above their exercise's set count | `0` | `0` |
| 15 | exercises whose set count is not their number of prescribed sets | `0` | `0` |

Lines 11 and 12 are information: what the migration protects. It reads and writes no row, so they are the same before and after.

If the "before" column is not what you see:

- **1** is not `postgres` — stop and report. The migration refuses to run as anyone else.
- **2** lacks `programs`, `sessions` or `weeks` — go on, and report it. One of the three guards that should already be there is missing or switched off; the migration puts it back.
- **2 to 7 already read as in the "after" column** — the migration is in the database. Read the ledger (below): if migration 04 is there, you are done.
- **8** is not `none`, or **10** is not `none` — migration 03 is not applied, or was rolled back. Stop: apply it first.
- **9** lacks one of the two — go on, and report it: the coach's app cannot call that function *today*. The migration opens it.
- **13, 14 or 15** is not `0` — go on, and report the line. None of them stops the migration, and it changes none of those rows. What they are:
  - **13**: sets whose number is 100000 or more. The editor renumbers sets in two steps, and one was interrupted halfway. The athlete sees them as "Set 100003". They are repaired by hand, one exercise at a time.
  - **14**: a logged set numbered above the *Sets* of its exercise. From now on *Sets* of that exercise cannot be lowered, and the set cannot be deleted from the app.
  - **15**: an exercise that says, for example, 4 sets and holds 3 or 5 rows. Fewer rows is harmless: the app adds the missing ones when the athlete opens the session. More rows is the trace of an interrupted edit.

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_11_04_logged_history_guards.sql
```

A refusal changes nothing:

| Message contains | Meaning | Do |
|---|---|---|
| `needs 2026_10_11_03_function_grants_lockdown, which is not applied` (code `SLM02`) | Checkpoint A1 is not done | apply migration 03 first, with its checks |
| `must be run as postgres` | line 1 of the audit | stop and report |
| `would not replace: …` | one of the functions of this file exists with other arguments | stop and report the names |
| `did not get the functions it meant: …` or `did not get the triggers it meant: …` | the file read its own result back and it was not the one described here | stop and report the full message |

## After

1. Run the audit again. Lines 2 to 7 read as the "after" column; lines 8 to 15 are unchanged. **Line 9 must still list both functions**: one missing is a function the coach's app can no longer call — roll back.

2. Read the ledger:

   ```bash
   supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
   ```

   Expected: four rows, the last one `2026_10_11_04_logged_history_guards`.

3. See the refusal for yourself. This tries to delete one set that an athlete has ticked done, and then fails **whatever happened**, so that nothing is kept — the answer is in the message:

   ```bash
   supabase db query --linked 'do $check$
   declare
     v_set uuid;
     v_answer text;
   begin
     select sl.id into v_set from public.set_logs sl
      where sl.done and not sl.is_student_added order by sl.id limit 1;
     if v_set is null then
       raise exception $m$check only: no set is ticked done in this database, nothing to try$m$;
     end if;
     begin
       delete from public.set_logs where id = v_set;
       v_answer := $m$NOT PROTECTED: the delete went through$m$;
     exception when raise_exception then
       v_answer := $m$protected: $m$ || sqlerrm;
     end;
     raise exception $m$check only, nothing was deleted: %$m$, v_answer;
   end $check$'
   ```

   The command must fail with `check only, nothing was deleted: protected: set … of exercise slot … is a logged set — it cannot be deleted`. Run before the migration, the same command fails with `… NOT PROTECTED: the delete went through` — and deletes nothing either.

4. In the app that is deployed, signed in as the coach, on the **test athlete** — and only once step 3 has answered `protected`:
   - open a session nobody trained, add a set to an exercise, then remove it: both go through as before;
   - open a session the test athlete has trained (✓ in the list), and in an exercise whose last set is done type a lower number in *Sets*: the red message *This has logged training — archive it instead of deleting.* appears. Reload the page: the number of sets is the old one.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_11_04_logged_history_guards.down.sql
```

**It reopens the findings.** Run it only if, after the migration, a coach is refused on something nobody trained — a set that is not ticked, failed, skipped, rated or filmed. The database tests replay the editor's writes on untrained and on trained sessions, so this is not expected. Report the session, and re-apply the migration once the cause is known.

It is **not** the way to delete training history on purpose: use the section below, which leaves the guards in place.

It drops the four new triggers and their functions, gives the three older guards and the two adopt functions back the text they had, and drops the two helper functions. No table and no row is touched, in either direction: what the guards protected while they were in place is still there, and nothing protects it afterwards.

It is refused (code `SLM04`) once a later migration is in the ledger. Roll those back first, last applied first.

## Deleting training history on purpose

Until this migration the recipe was "drop the trigger, delete, re-create the trigger" — and a trigger that is not re-created leaves the door open for everyone. It is replaced by a setting that lasts for one transaction and that only you can use.

Take a backup first ([00, section 2](../00-before-you-start.md)). Then, in Dashboard → SQL Editor, as one paste:

```sql
begin;
set local app.allow_history_delete = 'on';
delete from public.set_logs where id = '<id of the set>';
commit;
```

- The `delete` line is yours to write: a set, an exercise (`public.exercise_slots`), a session, a phase (`public.weeks`), a program. With the setting on, none of the guards refuses, and everything below the row goes with it.
- The setting ends with the transaction. There is nothing to switch back, and the next statement is guarded again.
- It is read only when the statement comes without a signed-in user: the SQL editor, the CLI, a function called with the service-role key. From the app it does nothing, for the coach as for an athlete.
- Without `begin` / `commit` around it, `set local` has no effect and the delete is refused: paste the four lines together.
- A video file is not removed with its set: delete it in Dashboard → Storage → `set-videos` (folder of the athlete, then of the exercise).
- Correcting the reps or the load of a logged set needs no setting: the pin of point 4 only applies to a signed-in user. An `update public.set_logs set target_reps = … where id = …` from the SQL editor goes through.
