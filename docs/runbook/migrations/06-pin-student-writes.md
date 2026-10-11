# 06 — The set and session columns an athlete must not change

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_11_06_pin_student_writes.sql` |
| Audit | `supabase/audits/2026_10_11_06_pin_student_writes.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_11_06_pin_student_writes.down.sql` |
| Kind | required · adds 1 function and 1 trigger, replaces 3 function bodies; no table, no column, no policy, no row |
| Wave / checkpoint | 1 / A2 |
| Findings | P13, P14, B4 |
| Needs | migration 05 |

Safe with the app that is deployed today: an athlete sees no difference. A coach sees one, on a draft an athlete is writing — it is described below.

## What it does

An athlete writes three kinds of rows that also hold something that is not theirs to write. Each was a way to change it by calling the API by hand; the app itself never did.

- **A set.** The athlete records what they did: done, failed, RPE, actual reps and load. The coach's targets were already protected. Whether the set is a prescribed one or an *extra* the athlete added was not — and an athlete may delete their own extra sets. So a prescribed set could be marked "added by me", deleted, and inserted again with other targets. A set could also be given another number, or moved to another exercise, and a replacement inserted in the place it left. Records and the coach's off-plan review then read numbers the coach never prescribed (P14).
- **A session of a draft.** An athlete who writes their own program writes its sessions, every column of them — including the three that say a session was *reviewed by the coach*, *archived*, *trained*. A draft sent in with its sessions already marked reviewed gave, once approved, sessions that never appear in the coach's "to review" list and on which feedback is refused as already given (P13).
- **A submission.** Sending a draft in notifies the coach, in the bell and by push. The author could take the submission back and make it again, as often as they liked: one notification each time (B4).

The migration closes the three in the database:

1. **An athlete's own change to a set leaves four things as they were**: the targets (as before), whether it is an extra set, which exercise it belongs to, and its number. Silently: what the athlete did record in the same request is saved.
2. **A session of a draft has no review, no archive, no training date and no recommended date — whoever writes it.** They stay empty until the draft is approved.
3. **Approving a draft clears those four** on its sessions, so that a draft written before this migration starts clean too.
4. **A submission is made once.** The author cannot take it back or date it again. The coach's *Send back* still does, and the athlete then submits again — and the coach is told again, once.

## What the deployed client does differently

**An athlete: nothing.** The app never changes the number, the exercise or the "extra" mark of a set, writes a draft through one function that sets none of the four columns, and never takes a submission back. Ticking, failing, rating and skipping sets, logging actuals, adding and removing an extra set, confirming a session, writing and sending in a draft all go through as before.

**A coach, on a draft** — a program with the *DRAFT* or *SUBMITTED* mark, which an athlete wrote:

- archiving one of its sessions, or giving one a recommended date, shows no error and **does not stay**: after the next refresh the session is where it was, without a date. Do both after *Approve*.
- this was never reliable: the athlete's next save replaces the whole draft, with anything the coach changed in it.

On every other program — the ones you write, and an athlete's program once approved — archiving, recommended dates, reviews and training dates work as before. The coach's editor still renumbers an athlete's extra sets when it changes a set count.

**For somebody who calls the API by hand:** the request is accepted, and the protected columns keep their values. There is no error message.

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_11_06_pin_student_writes.audit.sql
```

What it prints, before and after the migration:

| # | check | before | after |
|---|---|---|---|
| 1 | running as | `postgres` | `postgres` |
| 2 | an athlete's update leaves the targets of a set as they were | `in place` | `in place` |
| 3 | … and its exercise, its number and whether it is an extra set (P14) | `no` | `yes` |
| 4 | a session of a draft is kept without review, archive, training date and recommended date (P13) | `missing` | `in place` |
| 5 | approving a draft clears those four columns on its sessions | `no` | `yes` |
| 6 | the author of a draft cannot take a submission back (B4) | `no` | `yes` |
| 7 | functions of this migration a request without a session may execute | `none` | `none` |
| 8 | functions of this migration a signed-in user may execute | `approve_program(uuid)` | `approve_program(uuid)` |
| 9 | functions of this migration without search_path = public, pg_temp | `none` | `none` |
| 10 | sessions of a draft that carry a review, an archive, a training date or a recommended date | `0` | `0` |
| 11 | sets marked as added by the athlete that carry a prescription | `0` | `0` |
| 12 | drafts | a sentence: *N draft(s), N of them sent in to the coach* | the same |

Line 12 is information: the programs athletes are writing right now, and how many of them wait for *Approve* or *Send back*.

If the "before" column is not what you see:

- **1** is not `postgres` — stop and report. The migration refuses to run as anyone else.
- **2** reads `missing` — go on, and report it. The protection of the targets, which should already be there, was dropped or switched off by hand; the migration puts it back.
- **3 to 6 already read as in the "after" column** — the migration is in the database. Read the ledger (below): if migration 06 is there, you are done.
- **7** is not `none`, or **9** is not `none` — migration 03 is not applied, or was rolled back. Stop: apply it first.
- **8** is not `approve_program(uuid)` — go on, and report it: the coach's app cannot approve a draft *today*. The migration opens the function again.
- **10 or 11** is not `0` — go on, and report the line. Neither stops the migration, and it changes none of those rows. What they are:
  - **10**: sessions of a draft that already carry one of the four dates. *Archived* or *with a recommended date* is most likely you, archiving or dating a session of a draft in the app. *Reviewed* or *with a training date* cannot come from the app: somebody wrote it through the hole. Nothing to do in either case: they are cleared when the draft is approved, and as soon as that session is next written.
  - **11**: an extra set — one "added by the athlete" — that has targets. The app creates extra sets without any. It is either a prescribed set an athlete marked as their own (the finding, used), or an extra set inserted by hand. The migration cannot tell which, and leaves them. As long as a set is marked as an extra, its athlete can delete it. Report the line before changing anything; marking one as prescribed again is one statement ([Correcting one of these columns by hand](#correcting-one-of-these-columns-by-hand)).

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_11_06_pin_student_writes.sql
```

A refusal changes nothing:

| Message contains | Meaning | Do |
|---|---|---|
| `needs 2026_10_11_05_students_role_gate, which is not applied` (code `SLM02`) | migration 05 is not in the database | apply it first, with its checks |
| `must be run as postgres` | line 1 of the audit | stop and report |
| `would not replace: …` | one of the functions of this file exists with other arguments | stop and report the names |
| `did not get the functions it meant: …` or `did not get the triggers it meant: …` | the file read its own result back and it was not the one described here | stop and report the full message |

## After

1. Run the audit again. Lines 3 to 6 read as the "after" column; the others are unchanged. **Line 8 must still read `approve_program(uuid)`**: otherwise the coach's app can no longer approve a draft — roll back.

2. Read the ledger:

   ```bash
   supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
   ```

   Expected: six rows, the last one `2026_10_11_06_pin_student_writes`.

3. See it for yourself. This does what the finding described — as an athlete, through the API's role, it marks one of their prescribed sets as "added by me" — and then fails **whatever happened**, so that nothing is kept. The answer is in the message:

   ```bash
   supabase db query --linked 'do $check$
   declare
     v_set uuid;
     v_athlete uuid;
     v_rows integer;
     v_marked boolean;
     v_answer text;
   begin
     select sl.id, st.profile_id into v_set, v_athlete
       from public.set_logs sl
       join public.exercise_slots es on es.id = sl.exercise_slot_id
       join public.sessions se on se.id = es.session_id
       join public.weeks w on w.id = se.week_id
       join public.programs p on p.id = w.program_id
       join public.students st on st.id = p.student_id
      where not sl.is_student_added and p.is_active and p.deleted_at is null
      order by sl.id limit 1;
     if v_set is null then
       raise exception $m$check only: no athlete has a prescribed set in an active program, nothing to try$m$;
     end if;
     perform set_config($m$request.jwt.claims$m$,
       json_build_object($m$sub$m$, v_athlete, $m$role$m$, $m$authenticated$m$)::text, true);
     perform set_config($m$role$m$, $m$authenticated$m$, true);
     update public.set_logs set is_student_added = true where id = v_set;
     get diagnostics v_rows = row_count;
     select sl.is_student_added into v_marked from public.set_logs sl where sl.id = v_set;
     if v_rows = 0 or v_marked is null then
       v_answer := $m$NOT TRIED: the update of the athlete matched no row$m$;
     elsif v_marked then
       v_answer := $m$NOT PROTECTED: the prescribed set is now marked as added by the athlete$m$;
     else
       v_answer := $m$protected: the set is still a prescribed one$m$;
     end if;
     raise exception $m$check only, nothing was written: %$m$, v_answer;
   end $check$'
   ```

   The command must fail with `check only, nothing was written: protected: the set is still a prescribed one`. Run before the migration, the same command fails with `… NOT PROTECTED: the prescribed set is now marked as added by the athlete` — and writes nothing either.

   A third answer is **not** `protected`: `… NOT TRIED: the update of the athlete matched no row`. The athlete was not allowed to update the set that was picked at all — a rule that is not in the database at this point of the sequence, and that a later migration may bring — so the protection was asked nothing. Stop and report it; until the check is corrected, line 3 of the audit is what says whether the protection is there.

4. In the app that is deployed, signed in as the **test athlete** — and only once step 3 has answered `protected`: open the next session, tick a set and untick it, add an extra set to an exercise and remove it. All four go through as before.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_11_06_pin_student_writes.down.sql
```

**It reopens the findings.** Run it only if, after the migration, something the app does is refused or lost that worked before: an athlete's set that no longer saves, a confirmed session that shows no training date, a coach who can no longer approve a draft. The database tests replay those writes as the deployed app sends them, so this is not expected. Report what was being done, and re-apply the migration once the cause is known.

It drops the trigger on sessions and its function, and gives the three other functions back the text they had. No table and no row is touched, in either direction: what *Approve* cleared on a draft while the migration was in place stays cleared.

It is refused (code `SLM04`) once a later migration is in the ledger. Roll those back first, last applied first.

## Correcting one of these columns by hand

The four protections apply to a signed-in athlete (the set, the submission) or to a draft (the session). From the SQL editor, which has no signed-in user:

- the number, the exercise and the "extra" mark of a set can be corrected with a plain update — the pin is for the athlete of the set. Making a set a prescribed one again, for a row of line 11 of the audit: `update public.set_logs set is_student_added = false where id = '<id of the set>'`;
- a submission can be taken back with `update public.programs set submitted_at = null where id = '<id of the draft>'` — it does what *Send back* does, without the notification to the athlete;
- the four dates of a session of a **draft** cannot be set, by you either: approve the draft first. On an approved program they are written as before.
