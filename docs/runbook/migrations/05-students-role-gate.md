# 05 — The coach–athlete link cannot be forged

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_11_05_students_role_gate.sql` |
| Audit | `supabase/audits/2026_10_11_05_students_role_gate.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_11_05_students_role_gate.down.sql` |
| Kind | required · drops 2 policies, rewrites 2, adds 4 functions and 3 triggers; no table, no column, no row |
| Wave / checkpoint | 1 / A2 |
| Findings | P7, L2 |
| Needs | migration 04 |

Safe with the app that is deployed today: neither an athlete nor a coach sees a difference. It **refuses to run** while the database holds a link that should not exist — line 11 of the audit tells you beforehand.

## What it does

The table `students` says who coaches whom, and everything a coach may read or write about an athlete — programs, sets, videos, bodyweight, goals, messages — is decided by it. Until now any signed-in account could write that table through the API, as long as it put its own id in the "coach" column:

- an athlete could register **their own coach as their athlete**. The coach has no row of their own, so nothing stood in the way. The athlete then appears in the coach's roster as a card the coach cannot remove, and can write programs and feedback that reach the coach;
- a row could be pointed at another account, and an athlete's whole training went to somebody else;
- one request deleted an athlete with everything they own.

The app never did any of this: it only reads the table. The exercise library had the same gap — any account could fill a library of its own — and nothing checked whose library an exercise in a session, or the replacement in a swap, came from.

The migration closes this in the database:

1. **Nobody creates or deletes a link through the app or the API.** You do, in the SQL editor ([Linking an athlete to a coach](#linking-an-athlete-to-a-coach)).
2. **Every link, whoever writes it, joins a coach to an athlete**: the coach's account has the role *coach*, the athlete's has the role *student*, and they are two accounts. This holds for you in the SQL editor too, so a slip of the hand is refused with a sentence that says which side is wrong.
3. **A signed-in user cannot move a link** to another athlete or another coach.
4. **Only a coach adds or edits library exercises.**
5. **An exercise put in a session, and the replacement chosen in a swap, come from the library of that athlete's coach.**

## What the deployed client does differently

**Nothing, for an athlete and for a coach.** The app does not write `students`. A coach adds, edits and deletes library exercises as before. The exercise pickers — in the session editor and in the athlete's swap — only offer the coach's own library, which is what the database now requires.

**For somebody who calls the API by hand:** creating or deleting a link is refused (`new row violates row-level security policy for table "students"`, or nothing deleted); moving one answers `the coach-athlete link … cannot be changed from the app`; a library row written by an account that is not a coach is refused; an exercise from another library answers `… is not in the library of the coach of this program`.

**Without a session** (a sign-in that expired and could not be renewed): adding or editing a library exercise now answers `permission denied for function is_coach` where it answered a row-level-security error or did nothing. The app shows its "not allowed" message. Reading the library is unchanged.

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_11_05_students_role_gate.audit.sql
```

What it prints, before and after the migration:

| # | check | before | after |
|---|---|---|---|
| 1 | running as | `postgres` | `postgres` |
| 2 | policies that let a signed-in user write students (P7, L2) | `Coaches delete their students (DELETE); Coaches insert students (INSERT); Coaches update their students (UPDATE)` | `Coaches update their students (UPDATE)` |
| 3 | the update policy on students checks the new row and asks for a coach | `no` | `yes` |
| 4 | a students row is checked when it is written | `missing` | `in place` |
| 5 | policies that write the exercise library without asking for a coach | `Coaches manage own library` | `none` |
| 6 | the exercise of a slot is checked against the coach's library | `missing` | `in place` |
| 7 | the substitute of a swap is checked against the coach's library | `missing` | `in place` |
| 8 | functions of this migration a request without a session may execute | `none` | `none` |
| 9 | functions of this migration a signed-in user may execute | `none` | `is_coach()` |
| 10 | functions of this migration without search_path = public, pg_temp | `none` | `none` |
| 11 | coach-athlete links the gate refuses | `0` | `0` |
| 12 | library exercises that belong to an account that is not a coach | `0` | `0` |
| 13 | exercise slots that hold an exercise of another coach's library | `0` | `0` |
| 14 | swaps whose substitute is from another coach's library | `0` | `0` |
| 15 | accounts | a sentence: *N coach(es), N athlete(s) with a coach, N athlete(s) without one* | the same |

Line 15 is information. Read it once: the number of coaches is the number of accounts you promoted, and an *athlete without one* is an account that can sign in and has no coach yet.

If the "before" column is not what you see:

- **1** is not `postgres` — stop and report. The migration refuses to run as anyone else.
- **2** lists a policy with another name — stop and report. The migration would refuse (`did not get the policies it meant`): a policy it does not know could keep the door open.
- **2** lists fewer than three — go on, and report it: one was already removed by hand.
- **2 to 7 already read as in the "after" column** — the migration is in the database. Read the ledger (below): if migration 05 is there, you are done.
- **8, 9 or 10** is not `none` — a function with a name of this migration already exists. Stop and report.
- **11 is not `0`** — do not apply yet. Go to [Links the gate refuses](#links-the-gate-refuses), then run the audit again.
- **12, 13 or 14** is not `0` — go on, and report the line. None of them stops the migration, and it changes none of those rows. What they are:
  - **12**: exercises in a "library" that belongs to an account that is not a coach — written through the hole. Nobody but that account sees them. After the migration it can still read and delete them, and can no longer add or edit one.
  - **13**: an exercise in a session that comes from another coach's library — the trace of an athlete who changed coach, or of an id pasted by hand. The session still works and can still be edited; the exercise can be replaced by one of the right library and not by another foreign one. A copy of that session (duplicate, copy to…) is refused until it is replaced.
  - **14**: the same for the replacement exercise of a swap an athlete made.

## Links the gate refuses

Line 11 counts the rows of `students` that break the rule of point 2. Each one is either the hole, already used, or a mistake made by hand — and as long as it is there, its "coach" keeps the reach of a coach over the other account. The migration refuses to run until there is none (`SLM05`).

List them:

```bash
supabase db query --linked "select s.id as link, s.created_at::date as since, cp.full_name as coach, cp.role as coach_role, ap.full_name as athlete, ap.role as athlete_role, (select count(*) from public.programs p where p.student_id = s.id) as programs from public.students s join public.profiles cp on cp.id = s.coach_id join public.profiles ap on ap.id = s.profile_id where s.profile_id = s.coach_id or cp.role <> 'coach' or ap.role <> 'student' order by s.created_at"
```

What a row means:

- **`coach_role` is `student`** — an account that is not a coach holds an athlete. This is what the finding describes. If you did not create that link yourself, somebody forged it: remove it. If you did, and that account is meant to be a coach, it is missing its role: stop and report.
- **`athlete_role` is `coach`** — a coach is listed as somebody's athlete. An account is a coach or an athlete, not both. If you did not create that link yourself, remove it. If you did, stop and report before removing anything: that coach's own training hangs on it.
- **`coach` and `athlete` are the same name** on a row whose two roles look right — the account is linked to itself. Remove it.

Remove one, with the `link` value of its row:

```bash
supabase db query --linked "delete from public.students where id = '<link>' returning id"
```

- It prints the id it removed. The programs written under that link — the `programs` column of the list — go with it.
- If it is refused with `… still has N logged set(s) …`, somebody logged training under that link. Stop and report: do not force it.
- Then run the audit again: line 11 must read `0`.

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_11_05_students_role_gate.sql
```

A refusal changes nothing:

| Message contains | Meaning | Do |
|---|---|---|
| `needs 2026_10_11_04_logged_history_guards, which is not applied` (code `SLM02`) | migration 04 is not in the database | apply it first, with its checks |
| `link profiles the gate refuses` (code `SLM05`) | line 11 of the audit is not 0 — the message names up to five of the links | [Links the gate refuses](#links-the-gate-refuses), then run the file again |
| `must be run as postgres` | line 1 of the audit | stop and report |
| `would not replace: …` | one of the functions of this file exists with other arguments | stop and report the names |
| `did not get the functions it meant: …`, `did not get the triggers it meant: …` or `did not get the policies it meant: …` | the file read its own result back and it was not the one described here | stop and report the full message |

## After

1. Run the audit again. Lines 2 to 7 and 9 read as the "after" column; the others are unchanged.

2. Read the ledger:

   ```bash
   supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
   ```

   Expected: five rows, the last one `2026_10_11_05_students_role_gate`.

3. See the refusal for yourself. This does what the finding described — as an athlete, through the API's role, it registers their coach as their own athlete — and then fails **whatever happened**, so that nothing is kept. The answer is in the message:

   ```bash
   supabase db query --linked 'do $check$
   declare
     v_coach uuid;
     v_athlete uuid;
     v_answer text;
   begin
     select s.coach_id, s.profile_id into v_coach, v_athlete
       from public.students s order by s.created_at, s.id limit 1;
     if v_coach is null then
       raise exception $m$check only: no athlete is linked to a coach in this database, nothing to try$m$;
     end if;
     perform set_config($m$request.jwt.claims$m$,
       json_build_object($m$sub$m$, v_athlete, $m$role$m$, $m$authenticated$m$)::text, true);
     perform set_config($m$role$m$, $m$authenticated$m$, true);
     begin
       insert into public.students (profile_id, coach_id) values (v_coach, v_athlete);
       v_answer := $m$NOT PROTECTED: the forged link went in$m$;
     exception when check_violation or insufficient_privilege then
       v_answer := $m$protected: $m$ || sqlerrm;
     end;
     raise exception $m$check only, nothing was written: %$m$, v_answer;
   end $check$'
   ```

   The command must fail with `check only, nothing was written: protected: students.coach_id … is not a coach: its profile has the role student`. Run before the migration, the same command fails with `… NOT PROTECTED: the forged link went in` — and writes nothing either.

4. In the app that is deployed, signed in as the coach — and only once step 3 has answered `protected`:
   - in the exercise library, add an exercise, rename it, delete it: all three go through as before;
   - open a session of the **test athlete** that nobody trained, add an exercise to it, then remove it: both go through as before.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_11_05_students_role_gate.down.sql
```

**It reopens the findings.** Run it only if, after the migration, something the app does for a coach or an athlete is refused with one of the sentences of this page, or by row-level security on `students` or `exercise_library`. The database tests replay the app's writes to the library, to the sessions and to the swaps, so this is not expected. Report what was being done, and re-apply the migration once the cause is known.

It gives the four policies back the text they had, and drops the three triggers and the four functions. No table and no row is touched, in either direction: a link written while the gate was in place is a link that passed it.

It is refused (code `SLM04`) once a later migration is in the ledger. Roll those back first, last applied first.

## Linking an athlete to a coach

From this migration on, this is the only way a link is made — the app has no screen for it, and the API refuses.

1. Create the account, if it does not exist: Dashboard → Authentication → Users → **Add user** ([20, Auth settings](../20-auth-config.md)). Every new account is an athlete.
2. Link it, in Dashboard → SQL Editor, with the two e-mail addresses:

```sql
insert into public.students (profile_id, coach_id)
select athlete.id, coach.id
  from auth.users athlete, auth.users coach
 where athlete.email = '<e-mail of the athlete>'
   and coach.email = '<e-mail of the coach>'
returning id, profile_id, coach_id;
```

It returns one row: the link. The athlete sees their coach, and the coach sees the athlete in the roster, the next time each opens the app.

| It answers | Meaning |
|---|---|
| no row | one of the two addresses is not an account: check the spelling in Authentication → Users |
| `students.coach_id … is not a coach: its profile has the role student` | the second address is not a coach's. Nothing was written. To make that account a coach first: [07, Making a coach](07-profile-rules.md#making-a-coach) |
| `students.profile_id … is not an athlete: its profile has the role coach` | the first address is a coach's: a coach cannot be somebody's athlete. Nothing was written |
| `students: profile … cannot be its own coach` | the same address twice |
| `duplicate key value violates unique constraint "students_profile_id_key"` | this athlete already has a coach |

Two things this page does not cover, on purpose:

- **Moving an athlete to another coach.** Do not rewrite `coach_id` by hand: the athlete's goals belong to the former coach, and so do the exercises in their programs. Migration 10 of this checkpoint brings a function for it ([10, Moving an athlete to another coach](10-goals-fk-coach-links.md#moving-an-athlete-to-another-coach)); until it is applied, do not move an athlete.
- **Removing an athlete.** `delete from public.students …` takes the athlete's programs with it, and is refused as soon as they have logged a set ([04, logged training](04-logged-history-guards.md)). Leave the link in place.
