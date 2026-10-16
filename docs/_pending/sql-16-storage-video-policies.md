# sql-16-storage-video-policies — docs to fold (wave 3, items B7)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — RLS / DB conventions

In the bullet that starts "**A set video is stored at `<athlete's profile id>/<exercise slot of its set>/<file>`, and nowhere else.**", replace "a file whose row is gone stays in the bucket, readable by its athlete and their coach, and removable by the athlete only while the session of the slot in its path is writable" with:

a file whose row is gone stays in the bucket, readable by its athlete alone — since migration `2026_10_16_25_storage_video_policies.sql` the coach reads a file only through a video that names it (next bullet) — and removable by the athlete only while the session of the slot in its path is writable

and replace "nothing in the app lists or removes them afterwards." with:

nothing in the app lists or removes them afterwards; `docs/runbook/migrations/25-storage-video-policies.md` ("Files that no video names") lists them for the owner, who removes one through the Storage API (the dashboard) — never with `delete from storage.objects`, which leaves the bytes behind.

## docs/INVARIANTS.md — RLS / DB conventions

Add after the bullet that starts "**A set video is stored at `<athlete's profile id>/<exercise slot of its set>/<file>`, and nowhere else.**":

- **A coach reads a set video's file through the video that names it, never through the folder alone.** "Coaches read student set videos" on `storage.objects` (migration `2026_10_16_25_storage_video_policies.sql`, review B7) lets a coach read a file of `set-videos` when it is in the folder of one of their athletes (`students.coach_id = auth.uid()`) and a row of `set_log_videos` names it: `storage_path = objects.name`, and `student_profile_for_set_log(set_log_id)` is the athlete whose folder holds the file. The row is read with the coach's rights ("Coaches read student set log videos"), so after `transfer_student` the new coach reads the files the athlete's videos name and the former coach none; a row written by hand that names a file of another folder lends nobody that file. `storage.objects` has no foreign key to `set_log_videos`, and without the rule the coach listed and signed links to the old file of a replace, the file of a deleted video and an upload that was cancelled. The athlete's own policy ("Students read own set videos") still reads every file of their folder. The app is not concerned: `useSetVideoSignedUrl` signs the paths it read from `set_log_videos`. The policy casts no part of the path, so a file of another shape is not read and does not fail the statement. `supabase/tests/storage-policies.test.js` holds it, and `rls-matrix.test.js` has a file no video names (the coach reads 3 of the 5 files).

## docs/ARCHITECTURE.md — Set video uploads

In the bullet that starts "**Path convention**", replace "Reading is by first folder: `auth.uid()` for the athlete, a `profile_id` of one of their athletes for the coach." with:

Reading: the athlete reads every file whose first folder is `auth.uid()`; a coach reads a file whose first folder is a `profile_id` of one of their athletes only when a `set_log_videos` row of that athlete names it (`storage_path = objects.name`, read under the coach's own policy of `set_log_videos` — migration `2026_10_16_25_storage_video_policies.sql`). A file no row names — the old file of a replace, the file of a deleted video, a cancelled upload — is its athlete's alone, and `docs/runbook/migrations/25-storage-video-policies.md` lists them.

## CLAUDE.md — Feature → files map, row "Set video upload/playback"

At the end of the row, after "tests `supabase/tests/session-gates.test.js`", add:

; a coach reads a file only when a video of its athlete names it — "Coaches read student set videos" asks `set_log_videos` (migration `2026_10_16_25_storage_video_policies.sql`, tests `supabase/tests/storage-policies.test.js`; the files no video names are listed for the owner on `docs/runbook/migrations/25-storage-video-policies.md`, "Files that no video names")

## CLAUDE.md — Feature → files map, row "DB / RLS test suite (`npm run test:db`)"

After the description of `cron-jobs.test.js`, before "The migration tests are the next row.", add:

`storage-policies.test.js` (who reads the files of `set-videos`: the coach a file a video of their athlete names, and not a cancelled upload, the old file of a replace or the file of a deleted video, which the athlete still reads and removes; nobody else — another athlete, another coach and their athlete, a coach with none, `anon`; after `transfer_student` the new coach and not the former one; a row written by the owner that names a file of another folder lends it to nobody; a file of another shape is not an error; migration `2026_10_16_25_storage_video_policies.sql` tried on the frozen baseline — the coach reads the files no video names before, not after, again after its rollback — with the audit table, the list of files and the check of its runbook page read off the page).
