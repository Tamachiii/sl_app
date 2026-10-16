# 25 — A coach reads a set video through its row

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_16_25_storage_video_policies.sql` |
| Audit | `supabase/audits/2026_10_16_25_storage_video_policies.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_16_25_storage_video_policies.down.sql` |
| Kind | required · rewrites 1 policy of `storage.objects` under its name; no table, no column, no row, no file |
| Wave / checkpoint | 3 / C1 |
| Findings | B7 |
| Needs | migration 24 |

Safe with the app that is deployed today and with every version before it: the coach is shown the videos of their athletes as before.

## What it does

An athlete's video is two things: a file in the `set-videos` bucket, stored under the athlete's folder, and a row of `set_log_videos` that names that file for one set. Until now a coach read **every file of the folder of one of their athletes**. The two are not tied together in the database, so a file that no video names any more stayed readable by the coach — they could list it and open it outside the app:

- the old file of a video the athlete replaced, when the app could not remove it;
- the file of a video the athlete deleted, same;
- an upload the athlete cancelled, or whose video was refused.

From this migration on, **a coach reads a file of `set-videos` when it is in the folder of one of their athletes and a video of that athlete names it**. Everything else in the bucket is read by the athlete whose folder holds it, and by nobody else (B7).

What does not change:

- **The athlete** reads every file of their own folder, and adds or removes one under an exercise of theirs while its session is open — [migration 08](08-session-write-gates.md), [migration 17](17-replay-grace-window.md).
- **The rows of `set_log_videos`**: who reads and writes them is what it was.
- **After a change of coach** ([`transfer_student`, migration 10](10-goals-fk-coach-links.md)), the new coach reads the files the videos of the athlete name, and the former coach none of them — as with every other row of the athlete.
- **No file and no row is written, moved or removed.** The files no video names stay where they are: [Files that no video names](#files-that-no-video-names) lists them.

## What the deployed client does differently

**Nothing.** The app reads the videos of a session from `set_log_videos` and asks Storage for a link to the file of each row: every file the coach is shown is named by a row. A link it signed before the migration works until it expires (one hour).

**For somebody who calls the Storage API by hand:**

| Who reads | A file of `set-videos` that… | Answer |
|---|---|---|
| the athlete | is in their folder | the file, whether a video names it or not, as before |
| their coach of today | is in the athlete's folder, and a video of the athlete names it | the file, as before |
| their coach of today | is in the athlete's folder, and no video of the athlete names it | nothing — **the change** |
| a former coach, another coach, another athlete | — | nothing |
| a request without a session | — | nothing, as before |

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_16_25_storage_video_policies.audit.sql
```

What it prints, before and after the migration:

| # | check | before | after |
|---|---|---|---|
| 1 | running as | `postgres` | `postgres` |
| 2 | which files of set-videos a coach reads (B7) | `every file in the folder of one of their athletes` | `the files a video of one of their athletes names` |
| 3 | policies that read the files of set-videos and that this migration does not know | `none` | `none` |
| 4 | files in set-videos | a number | the same number |
| 5 | … that no video names | a number | the same number |
| 6 | … of which uploaded more than a day ago | a number | the same number |
| 7 | videos whose file is not in set-videos | a number | the same number |
| 8 | videos stored outside the folder of their athlete | `0` | `0` |

Line 2 is the migration.

If the "before" column is not what you see:

- **1** is not `postgres` — stop and report. The migration refuses to run as anyone else.
- **2** reads the "after" column — read the ledger (below). If migration 25 is there, you are done. If it is not, the policy was rewritten by hand: stop and report.
- **2** starts with `SOMETHING ELSE:` — **stop and report the line.** The policy was changed by hand; the migration refuses to run.
- **3** is not `none` — **stop and report the line.** A policy made by hand lets somebody read the files whatever this migration says; the migration refuses to run next to it.
- **4 to 7** — numbers, `0` while nobody has uploaded a video. Line 5 is the files the coach stops reading — the athlete still reads them. Line 6 leaves out the files of the last day: an upload has no video for a moment. [Files that no video names](#files-that-no-video-names) lists them. Line 7 is a video whose file is gone: the app shows it as a video that does not play, before and after.
- **8** is not `0` — go on, and report the line. Since migration 08 nothing but the owner can write a video anywhere else than under its athlete's folder; the coach no longer reads those files.

## Files that no video names

For lines 5 and 6 of the audit — every file of `set-videos` that no video names, before or after the migration, the oldest first:

```bash
supabase db query --linked "select o.name as file, pa.full_name as athlete, pc.full_name as coach_today, to_char(o.created_at, 'YYYY-MM-DD HH24:MI') as uploaded, o.created_at < now() - interval '1 day' as older_than_a_day, o.metadata ->> 'size' as bytes from storage.objects o left join public.profiles pa on pa.id::text = (storage.foldername(o.name))[1] left join public.students st on st.profile_id = pa.id left join public.profiles pc on pc.id = st.coach_id where o.bucket_id = 'set-videos' and not exists (select 1 from public.set_log_videos v where v.storage_path = o.name) order by o.created_at, o.name"
```

Each one is a video the athlete no longer has in the app: the old file of a replace, the file of a deleted video, an upload that was cancelled or refused. The app removes them itself; the ones it could not remove are in the coach's list of errors, as `set-videos: … left in the bucket at <file>`. A file of the last day (`older_than_a_day` is `false`) may be an upload under way: leave it.

They are the athlete's, and nothing in the app lists them. To look at one, or remove it:

1. **Look first.** Dashboard → Storage → `set-videos` → the folder of the athlete (the first part of `file`), then of the exercise (the second part) → the file. **The bytes of a video are in no backup** ([`BACKUPS.md`](../../../BACKUPS.md), "What it does NOT hold"): a file removed is gone for good.
2. **Remove it** in the same place: select the file, then **Delete**. The dashboard goes through the Storage API, which removes the bytes and the row of `storage.objects` together. Removing it changes nothing for the athlete: no video of theirs names it.

**Never `delete from storage.objects`.** It removes the row and leaves the bytes in the object store, where nothing lists them any more — and a project of today may refuse it outright. A file is removed through the Storage API: the dashboard, or `remove()` of a client with the service-role key.

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_16_25_storage_video_policies.sql
```

It holds the table of the bucket's files for an instant: an upload, or a link the app asks for to play a video, waits for it in that instant.

A refusal changes nothing:

| Message contains | Meaning | Do |
|---|---|---|
| `needs 2026_10_16_24_indexes_cleanup, which is not applied` (code `SLM02`) | migration 24 is not in the database | apply it first, with its checks |
| `must be run as postgres` | line 1 of the audit | stop and report |
| `does not find the policy "Coaches read student set videos" of storage.objects as migration 08 left it: …` | line 2 of the audit: the policy was changed by hand, or is not there | stop and report the full message |
| `found a policy that reads the files of set-videos and that it does not know: …` | line 3 of the audit | stop and report the names |
| `does not find what its policy is written with: …` | a column or a function the policy asks is not there under its name, or a signed-in user may not execute it | stop and report the full message |
| `did not get what it meant: …` | the file read its own result back and it was not the one described here | stop and report the full message |
| `must be owner of table objects`, or `permission denied` on `storage.objects` | the project no longer lets the SQL editor write the rules of the video files | stop and report |
| `canceling statement due to lock timeout` | a request held the files' table for more than five seconds | nothing was changed: run it again |

## After

1. Run the audit again. Line 2 reads as the "after" column; the others are unchanged.

2. Read the ledger:

   ```bash
   supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
   ```

   Expected: twenty-four rows, the last one `2026_10_16_25_storage_video_policies` — twenty-five where the optional migration 19 was applied at Checkpoint B.

3. See it for yourself. This creates two coaches and an athlete of the first, a block with one set, a video of that set, and two files in the athlete's folder: the one the video names, and one no video names. Through the API's role, the coach, the athlete and the other coach each read the two files. Then it fails **whatever happened**, so that nothing is kept, the three accounts and the two files included. The answer is in the message:

   ```bash
   supabase db query --linked 'do $check$
   declare
     v_coach uuid := gen_random_uuid();
     v_stranger uuid := gen_random_uuid();
     v_athlete uuid := gen_random_uuid();
     v_link uuid := gen_random_uuid();
     v_exercise uuid := gen_random_uuid();
     v_block uuid := gen_random_uuid();
     v_week uuid := gen_random_uuid();
     v_session uuid := gen_random_uuid();
     v_slot uuid := gen_random_uuid();
     v_set uuid := gen_random_uuid();
     v_named text;
     v_orphan text;
     v_who uuid;
     v_read text[] := array[]::text[];
     v_files text;
     v_result text;
   begin
     if not exists (select 1 from pg_policy p
                     where p.polrelid = to_regclass($m$storage.objects$m$)
                       and p.polname = $m$Coaches read student set videos$m$
                       and pg_get_expr(p.polqual, p.polrelid) like $m$%set_log_videos%$m$) then
       raise exception $m$check only, nothing was written: NOT THERE: a coach reads every file in the folder of one of their athletes$m$;
     end if;

     insert into auth.users (id, email, aud, role) values
       (v_coach, $m$sl-check-25-coach@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$),
       (v_stranger, $m$sl-check-25-stranger@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$),
       (v_athlete, $m$sl-check-25-athlete@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$);
     update public.profiles set role = $m$coach$m$ where id in (v_coach, v_stranger);
     if (select count(*) from public.profiles where id in (v_coach, v_stranger) and role = $m$coach$m$) <> 2 then
       raise exception $m$check only, nothing was written: NOT TRIED: the accounts made for the check could not be made coaches$m$;
     end if;
     insert into public.students (id, profile_id, coach_id) values (v_link, v_athlete, v_coach);
     insert into public.exercise_library (id, coach_id, name, type, difficulty)
       values (v_exercise, v_coach, $m$sl-check-25 pull-up$m$, $m$pull$m$, 1);
     insert into public.programs (id, student_id, name, is_active) values (v_block, v_link, $m$sl-check-25 block$m$, true);
     insert into public.weeks (id, program_id, week_number) values (v_week, v_block, 1);
     insert into public.sessions (id, week_id, title, sort_order) values (v_session, v_week, $m$one$m$, 0);
     insert into public.exercise_slots (id, session_id, exercise_id, sets, reps, sort_order)
       values (v_slot, v_session, v_exercise, 1, 5, 0);
     insert into public.set_logs (id, exercise_slot_id, set_number) values (v_set, v_slot, 1);
     v_named := v_athlete || $m$/$m$ || v_slot || $m$/1-named.mp4$m$;
     v_orphan := v_athlete || $m$/$m$ || v_slot || $m$/1-orphan.mp4$m$;
     insert into public.set_log_videos (set_log_id, storage_path, mime_type, size_bytes)
       values (v_set, v_named, $m$video/mp4$m$, 1000);
     begin
       insert into storage.objects (bucket_id, name) values ($m$set-videos$m$, v_named), ($m$set-videos$m$, v_orphan);
     exception when others then
       raise exception $m$check only, nothing was written: NOT TRIED: the two files of the check could not be written into storage.objects (%)$m$, sqlerrm;
     end;

     perform set_config($m$role$m$, $m$authenticated$m$, true);
     foreach v_who in array array[v_coach, v_athlete, v_stranger] loop
       perform set_config($m$request.jwt.claims$m$, json_build_object($m$sub$m$, v_who, $m$role$m$, $m$authenticated$m$)::text, true);
       select coalesce(string_agg(case when o.name = v_named then $m$named$m$ else $m$orphan$m$ end, $m$+$m$ order by o.name), $m$none$m$)
         into v_files
         from storage.objects o
        where o.bucket_id = $m$set-videos$m$ and o.name in (v_named, v_orphan);
       v_read := v_read || v_files;
     end loop;
     perform set_config($m$role$m$, $m$postgres$m$, true);
     perform set_config($m$request.jwt.claims$m$, $m$$m$, true);

     v_result := case
       when v_read[3] <> $m$none$m$
         then $m$NOT PROTECTED: another coach read $m$ || v_read[3]
       when v_read[1] like $m$%orphan%$m$
         then $m$NOT PROTECTED: the coach read a file that no video names$m$
       when v_read[1] <> $m$named$m$
         then $m$BROKEN: the coach does not read the file the video of their athlete names$m$
       when v_read[2] <> $m$named+orphan$m$
         then $m$BROKEN: the athlete read $m$ || v_read[2] || $m$ of the two files of their folder, not named+orphan$m$
       else $m$in place: a coach reads the file a video of their athlete names, and not the one no video names; the athlete reads both, and another coach neither$m$
     end;
     raise exception $m$check only, nothing was written: %$m$, v_result;
   end $check$'
   ```

   The command must fail with `check only, nothing was written: in place: a coach reads the file a video of their athlete names, and not the one no video names; the athlete reads both, and another coach neither`. Run before the migration, the same command fails with `… NOT THERE: a coach reads every file in the folder of one of their athletes` — and writes nothing either.

   Anything else is **not** the answer:

   - `… NOT THERE: …` after the migration — the migration is not in this database. Read the ledger.
   - `… NOT PROTECTED: …` — a policy lets a coach read a file it should not: run the audit, and report line 3 with the full message. Rolling back does not close it.
   - `… BROKEN: …` — the coach, or the athlete, no longer reads a video of theirs: **roll back**, and report the full message.
   - `… NOT TRIED: the accounts made for the check could not be made coaches` — migration 07 is not in the database, or was rolled back. Read the ledger.
   - `… NOT TRIED: the two files of the check could not be written into storage.objects (…)` — the project does not let the SQL editor write a row of the files' table. Nothing was written. Line 2 of the audit is then what says the migration is in place; report the message.
   - a message that does not start with `check only` — the check could not get as far as its questions (the message says why). Nothing was written. Report it; line 2 of the audit is then what says whether the migration is in place.

4. In the app, as the coach, open the review of a session whose athlete recorded a video — if there is one: it plays as before.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_16_25_storage_video_policies.down.sql
```

It gives the policy back the text migration 08 left it with.

**It reopens B7**: from then on a coach reads every file of the folder of one of their athletes again, the files no video names included. Every app works without the migration as it did before it. The only reasons to run this file are step 3 answering `BROKEN`, or a migration applied to the wrong project.

No row and no file is written or removed by it.

It is refused (code `SLM04`) once a later migration is in the ledger. Roll those back first, last applied first.
