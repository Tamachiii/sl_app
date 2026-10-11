# 08 — Archived and reviewed sessions are read-only for the athlete

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_12_08_session_write_gates.sql` |
| Audit | `supabase/audits/2026_10_12_08_session_write_gates.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_12_08_session_write_gates.down.sql` |
| Kind | required · adds 4 functions, replaces 11 policies, splits 1 policy into 4; no table, no column, no trigger, no row |
| Wave / checkpoint | 1 / A2 |
| Findings | P58, L5 (the upload rule) |
| Needs | migration 07 |

Safe with the app that is deployed today: an athlete who trains, confirms and waits for feedback sees no difference, and neither does a coach.

One case to look at **before** you apply: a session you reviewed and its athlete has not confirmed. The app that is deployed still shows it to them as a session to do, and from this migration on nothing they log in it is saved. Line 13 of the audit counts those sessions; [Sessions reviewed that their athlete has not confirmed](#sessions-reviewed-that-their-athlete-has-not-confirmed) lists them and says what to do with each.

## What it does

"A session the coach archived is read-only" and "a reviewed session is what the coach saw" were rules of the app's screens. The database asked almost nothing about the state of a session, so a screen that was out of date — a second phone, a tab left open — or a request sent by hand could still change what the coach had already looked at, and nothing told the coach:

- **the sets** of a reviewed or archived session could still be ticked, rated, failed, skipped and given other reps or load;
- **a note** on an exercise could be rewritten after the review;
- **a swap or a skip** of an archived session could be edited or removed;
- **a video** could be replaced or removed on any session, of any block, at any time — the entry and the file;
- **any account**, one nobody coaches included, could upload files under its own id (L5).

The migration closes this in the database. From now on an athlete's write is accepted when three things hold:

1. the row is theirs;
2. its program is the block they are training (as before, for sets, notes, swaps and skips);
3. **its session is neither archived nor reviewed.**

This applies to sets, notes, swaps and skips, videos, and the video files. For a video, the file also has to be where the app has always put it — under the athlete's id and the exercise of the set — so nobody uploads under somebody else's exercise, and an account without a coach uploads nothing.

**Reading is untouched**: an athlete still sees every session they ever trained, with its sets, notes and videos, and so does their coach.

**The lock is the review, not the confirmation.** A session the athlete has confirmed and the coach has not reviewed yet is still written: sets logged without a connection are sent one by one, and one may arrive after the confirmation.

The lock opens again when the session stops being archived (the coach restores it in the app). A review is not taken back by the app; [by hand](#letting-an-athlete-write-a-reviewed-session-again) it is one statement.

## What the deployed client does differently

**An athlete, on a session in progress, or confirmed and not yet reviewed: nothing.** Ticking, failing, rating and skipping sets, logging actuals, adding and removing an extra set, notes, swaps and skips, uploading, replacing and deleting a video all go through as before.

**An athlete, on a session the coach reviewed or archived.** The app that is deployed locks part of this by itself, and the athlete meets the database's refusal wherever it does not:

- **archived**: the app shows the whole session as locked. A refusal is met only from a screen that is out of date.
- **reviewed and confirmed**: the app locks the sets, their videos, and the swap or skip of each exercise. It still offers the note of each exercise — and *Undo confirmation*. An athlete who writes a note after reading your feedback is refused.
- **reviewed and not confirmed** — you reviewed it while the athlete was still training, or they took the confirmation back afterwards: the app locks nothing. It goes by the confirmation, not by the review, lists the session as still to do and opens it like any other. Every set logged there is refused. Line 13 of the audit counts these sessions: [Sessions reviewed that their athlete has not confirmed](#sessions-reviewed-that-their-athlete-has-not-confirmed).

What a refusal looks like:

| What the athlete does | What they see |
|---|---|
| ticks, fails, rates or skips a set, logs an actual | "Couldn't save that. Please try again." — the set goes back to what it was |
| adds an extra set, writes a note, swaps or skips an exercise | "You don't have permission to do that." |
| uploads or replaces a video | the upload fails with its error; the video that was there stays |
| removes an extra set, a note, a swap or a skip, a video | nothing: no message, and it is back after the next refresh |
| asks the coach to make a swap or a skip permanent | nothing: no message, the button is back a moment later — and **the coach is not told** |

Nothing is lost in any of these: the write is refused, the data is what the coach saw.

**A coach: nothing.** The session editor, the review, feedback, *Adopt into program*, *Remove from upcoming* and *Decline* work on a reviewed or archived session as before.

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_12_08_session_write_gates.audit.sql
```

What it prints, before and after the migration:

| # | check | before | after |
|---|---|---|---|
| 1 | running as | `postgres` | `postgres` |
| 2 | an athlete writes a set only while its session is neither archived nor reviewed (P58) | `no` | `yes` |
| 3 | … and a note on an exercise | `no` | `yes` |
| 4 | … and a swap or a skip of an exercise | `no` | `yes` |
| 5 | … and the video of a set | `no` | `yes` |
| 6 | … and the file of that video, which goes under an exercise of their own (L5) | `no` | `yes` |
| 7 | a video is stored under its athlete and the exercise of its set | `no` | `yes` |
| 8 | functions of this migration a request without a session may execute | `none` | `none` |
| 9 | functions of this migration a signed-in user may execute | `none` | `session_writable_for_slot(uuid); set_video_slot(text); slot_for_set_log(uuid)` |
| 10 | functions of this migration without search_path = public, pg_temp | `none` | `none` |
| 11 | policies that write these tables and that the migration does not know | `none` | `none` |
| 12 | reviewed sessions of a block being trained, not archived | a number | the same number |
| 13 | … of which their athlete has not confirmed | `0` | `0` |
| 14 | … of which lack a set their exercise prescribes | `0` | `0` |
| 15 | videos | a sentence: *N video(s), N of them stored elsewhere than under their athlete and exercise* | the same sentence |

Line 12 is information: the sessions this migration closes for their athlete — the ones you gave feedback on, or finished without feedback, in the block each athlete is training. Lines 13 and 14 single out two kinds among them, on which the app that is deployed sends writes by itself or shows the session as open; each has its entry below, and the migration changes neither number.

If the "before" column is not what you see:

- **1** is not `postgres` — stop and report. The migration refuses to run as anyone else.
- **2 to 7 already read `yes`** — the migration is in the database. Read the ledger (below): if migration 08 is there, you are done.
- **8** is not `none`, or **10** is not `none` — stop and report: a function with one of the four names of this migration exists already.
- **9** is not `none` before the migration — same: stop and report.
- **11** is not `none` — **stop and report the line.** It names a rule, made by hand, that lets somebody write one of these tables. The migration would undo itself rather than leave it next to the new ones.
- **13** is not `0` — **before you apply, go to [Sessions reviewed that their athlete has not confirmed](#sessions-reviewed-that-their-athlete-has-not-confirmed).** It counts sessions you reviewed and their athlete has not confirmed. The app that is deployed shows such a session to its athlete as still to do, and open; from this migration on, each set they tick there answers "Couldn't save that. Please try again." and goes back to what it was. The section lists them and says which ones to open again. It does not stop the migration, and it is not a reason to roll it back.
- **14** is not `0` — go on, and report the line. It counts reviewed sessions in which an exercise says, for example, 4 sets and holds 3. The app that is deployed tries to add the missing set each time the athlete opens such a session; from this migration on that is refused there, and the athlete reads "You don't have permission to do that." when opening it. Nothing is lost. To avoid the message, add the sets first: [Adding the sets a reviewed session lacks](#adding-the-sets-a-reviewed-session-lacks).
- **15** counts videos stored elsewhere — go on, and report the line. The app has always stored a video under its athlete and its exercise, so this is a row written by hand. The migration leaves it; its athlete can still watch it.

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_12_08_session_write_gates.sql
```

A refusal changes nothing:

| Message contains | Meaning | Do |
|---|---|---|
| `needs 2026_10_11_07_profile_rules, which is not applied` (code `SLM02`) | migration 07 is not in the database | apply it first, with its checks |
| `must be run as postgres` | line 1 of the audit | stop and report |
| `would not replace: …` | one of the functions of this file exists with other arguments | stop and report the names |
| `did not get the functions it meant: …`, `did not get the policies it meant: …` or `would leave an athlete unable to read: …` | the file read its own result back and it was not the one described here — for the policies, most often line 11 of the audit | stop and report the full message |
| `must be owner of table objects`, or `permission denied` on `storage.objects` | the project no longer lets the SQL editor write the rules of the video files | stop and report |
| `canceling statement due to lock timeout` | the app was writing one of the tables at that moment | run the file again |

## After

1. Run the audit again. Lines 2 to 7 read `yes` and line 9 lists the three functions; the others are unchanged.

2. Read the ledger:

   ```bash
   supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
   ```

   Expected: eight rows, the last one `2026_10_12_08_session_write_gates`.

3. See it for yourself. This takes an athlete who has both a reviewed session and one in progress in the block they are training, and — as that athlete, through the API's role — writes a set of each without changing it. Then it fails **whatever happened**, so that nothing is kept. The answer is in the message:

   ```bash
   supabase db query --linked 'do $check$
   declare
     v_athlete uuid;
     v_reviewed uuid;
     v_open uuid;
     v_rows integer;
     v_answer text;
   begin
     select st.profile_id, r.set_id, o.set_id into v_athlete, v_reviewed, v_open
       from public.students st
       join lateral (
         select sl.id as set_id
           from public.set_logs sl
           join public.exercise_slots es on es.id = sl.exercise_slot_id
           join public.sessions se on se.id = es.session_id
           join public.weeks w on w.id = se.week_id
           join public.programs p on p.id = w.program_id
          where p.student_id = st.id and p.is_active and p.deleted_at is null
            and se.reviewed_at is not null and se.archived_at is null
          order by sl.id limit 1
       ) r on true
       join lateral (
         select sl.id as set_id
           from public.set_logs sl
           join public.exercise_slots es on es.id = sl.exercise_slot_id
           join public.sessions se on se.id = es.session_id
           join public.weeks w on w.id = se.week_id
           join public.programs p on p.id = w.program_id
          where p.student_id = st.id and p.is_active and p.deleted_at is null
            and se.reviewed_at is null and se.archived_at is null
          order by sl.id limit 1
       ) o on true
      order by st.id limit 1;
     if v_athlete is null then
       raise exception $m$check only: no athlete has both a reviewed session and one in progress in the block they are training, nothing to try$m$;
     end if;
     perform set_config($m$request.jwt.claims$m$,
       json_build_object($m$sub$m$, v_athlete, $m$role$m$, $m$authenticated$m$)::text, true);
     perform set_config($m$role$m$, $m$authenticated$m$, true);
     update public.set_logs set logged_at = logged_at where id = v_open;
     get diagnostics v_rows = row_count;
     if v_rows <> 1 then
       v_answer := $m$BROKEN: the athlete cannot write a set of a session in progress$m$;
     else
       update public.set_logs set logged_at = logged_at where id = v_reviewed;
       get diagnostics v_rows = row_count;
       if v_rows = 0 then
         v_answer := $m$protected: the athlete writes a set of a session in progress, and not one of a reviewed session$m$;
       else
         v_answer := $m$NOT PROTECTED: the athlete wrote a set of a reviewed session$m$;
       end if;
     end if;
     raise exception $m$check only, nothing was written: %$m$, v_answer;
   end $check$'
   ```

   The command must fail with `check only, nothing was written: protected: the athlete writes a set of a session in progress, and not one of a reviewed session`. Run before the migration, the same command fails with `… NOT PROTECTED: the athlete wrote a set of a reviewed session` — and writes nothing either.

   `… BROKEN: the athlete cannot write a set of a session in progress` after the migration means an athlete can no longer log their training: **roll back**, and report.

   `check only: no athlete has both a reviewed session and one in progress in the block they are training, nothing to try` is no answer either way: lines 2 to 7 of the audit are then what says the lock is there. Go on to step 4.

4. In the app that is deployed, signed in as the **test athlete** — and only once step 3 has answered `protected`: open the next session, tick a set and untick it, add a note to an exercise and delete it. All of it goes through as before.

   If the tick answers "Couldn't save that. Please try again.", look first at whether that session is one of line 13 of the audit — [the query that lists them](#sessions-reviewed-that-their-athlete-has-not-confirmed). If it is, the lock is doing what it should: try on another session.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_12_08_session_write_gates.down.sql
```

**It reopens the findings.** Run it only if, after the migration, an athlete can no longer do something on a session that is in progress, or confirmed and not yet reviewed — step 3 answers `BROKEN`, or a set, a note, a swap or a video no longer saves there. The database tests replay those writes as the deployed app sends them, so this is not expected. Report what was being done, and re-apply the migration once the cause is known.

**"My sets no longer save" is not that case when the session is a reviewed one — check before you roll back.** A session you reviewed and its athlete has not confirmed looks, in the app that is deployed, exactly like a session in progress: it is in their list as still to do, and nothing on it is locked. A set that no longer saves there is the lock, not a fault. Run the query of [Sessions reviewed that their athlete has not confirmed](#sessions-reviewed-that-their-athlete-has-not-confirmed): if the session is in its answer, open that one session again as the section says, and leave the migration in place. Roll back only for a session that is not in it.

It gives the eleven rules back the text they had, makes the four rules on videos one again, and removes the four functions. No table, no row and no file is touched, in either direction.

It is refused (code `SLM04`) once a later migration is in the ledger. Roll those back first, last applied first.

## Sessions reviewed that their athlete has not confirmed

For line 13 of the audit. In the app that is deployed, the review page offers the feedback box and *Finish without feedback* whether or not the athlete has confirmed the session. You reach it without a confirmation from the notification that an athlete swapped or skipped an exercise — they are still training —, from a *session completed* notification whose confirmation the athlete has undone since, or from an archived session you restore afterwards. And an athlete can take a confirmation back after your review: that app still offers *Undo confirmation* then.

**What the athlete sees.** The app that is deployed goes by the confirmation, not by the review. It lists such a session as still to do — as the next one, if it comes first — and opens it like a session in progress: nothing is locked, and nothing says you reviewed it apart from your feedback, if you sent one. From this migration on, what they do there is refused as in the table of [What the deployed client does differently](#what-the-deployed-client-does-differently): each set they tick answers "Couldn't save that. Please try again." and goes back to what it was; a note, a swap, a skip or an extra set answers "You don't have permission to do that." What they logged before your review stays as you read it. *Confirm session* still works, and a confirmed session leaves their list.

List them. The answer is the same before the migration and after:

```bash
supabase db query --linked "select se.id as session_id, pr.full_name as athlete, p.name as block, se.title as session, to_char(se.reviewed_at, 'YYYY-MM-DD') as reviewed_on, exists (select 1 from public.messages m where m.session_id = se.id) as feedback_sent, (select count(*) filter (where sl.done or sl.failed or sl.skipped) || ' of ' || count(*) from public.exercise_slots es join public.set_logs sl on sl.exercise_slot_id = es.id where es.session_id = se.id) as sets_logged from public.sessions se join public.weeks w on w.id = se.week_id join public.programs p on p.id = w.program_id join public.students st on st.id = p.student_id join public.profiles pr on pr.id = st.profile_id where se.reviewed_at is not null and se.archived_at is null and p.is_active and p.deleted_at is null and not exists (select 1 from public.session_confirmations c where c.session_id = se.id) order by pr.full_name, se.reviewed_at"
```

One row per session: its athlete, the block, the session, the day you reviewed it, whether you sent feedback, and how many of its sets are logged. For each row, one of two:

- **the athlete has trained it** — `sets_logged` says so, and they never confirmed it or took the confirmation back. Nothing to do in the database: ask them to confirm it. What they logged is what you reviewed, and it stays.
- **the athlete has still to train it, or was in the middle of it** — take your review back, with the `session_id` of the row: [Letting an athlete write a reviewed session again](#letting-an-athlete-write-a-reviewed-session-again). Done before the migration is applied, no set of theirs is ever refused. The session is then written like any other, and it comes into your *to review* list when the athlete confirms it.

Line 13 of the audit counts the rows of this answer: it reads `0` once every session is confirmed or open again, and the migration can be applied whatever it reads.

**This is not the case the rollback is for.** A set that no longer saves on one of these sessions is the lock doing what this page says, on a session the app wrongly shows as open. Rolling back would reopen every reviewed session of every athlete to change one.

The next version of the app closes both ends: it no longer offers you the review of a session that is not confirmed, and it shows a reviewed session to its athlete as locked, says why, and keeps *Confirm session*. It changes none of the sessions of this list: each one is still to be confirmed by its athlete, or opened again by you.

## Letting an athlete write a reviewed session again

An **archived** session opens again when you restore it in the app (Programming, *Show N archived*, then *restore*).

A **reviewed** one stays closed: the app has no way to take a review back. From the SQL editor, with the id of the session:

`update public.sessions set reviewed_at = null where id = '<id of the session>'`

The session is then open for its athlete, and it is back in your *to review* list — when its athlete confirms it, if they had not. A feedback message you already sent stays where it is, and the app accepts no second one for the same session. To close the session again:

`update public.sessions set reviewed_at = now() where id = '<id of the session>'`

## Adding the sets a reviewed session lacks

For line 14 of the audit. This adds, to every reviewed session of a block being trained, the sets an exercise prescribes and does not hold — as sets to do, with the exercise's own reps, load and rest, which is what the app adds when the athlete opens the session. It answers one line per set added, and none when there is nothing to add:

```sql
insert into public.set_logs (exercise_slot_id, set_number, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
select es.id, n, es.reps, es.duration_seconds, es.weight_kg, es.rest_seconds
  from public.exercise_slots es
  join public.sessions se on se.id = es.session_id
  join public.weeks w on w.id = se.week_id
  join public.programs p on p.id = w.program_id
  cross join lateral generate_series(1, es.sets) as n
 where se.reviewed_at is not null and se.archived_at is null
   and p.is_active and p.deleted_at is null
   and not exists (select 1 from public.set_logs sl where sl.exercise_slot_id = es.id and sl.set_number = n)
returning exercise_slot_id, set_number;
```

Line 14 of the audit then reads `0`. It can be run before or after the migration.
