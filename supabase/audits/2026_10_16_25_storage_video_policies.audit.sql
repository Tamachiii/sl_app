-- Audit for 2026_10_16_25_storage_video_policies. Read-only, one result table.
-- Run it before applying the migration, and again after.
--
--    check                                                        before                      after
--    1 running as                                                 postgres                    postgres
--    2 which files of set-videos a coach reads (B7)               every file in the folder of one of their athletes
--                                                                                             the files a video of one of their athletes names
--    3 policies that read the files of set-videos and that this migration does not know
--                                                                 none                        none
--    4 files in set-videos                                        a number                    the same number
--    5 … that no video names                                      a number                    the same number
--    6 … of which uploaded more than a day ago                    a number                    the same number
--    7 videos whose file is not in set-videos                     a number                    the same number
--    8 videos stored outside the folder of their athlete          0                           0
--
-- Line 2 is the migration: it reads as the "after" column once it is applied.
-- A line 2 that starts with SOMETHING ELSE: stop and report it — the policy
-- was changed by hand, and the migration refuses.
-- Line 3 MUST read `none`, before and after: a policy listed there lets a
-- coach read the files whatever the migration does, and the migration
-- refuses to run next to it. Stop and report it.
-- Lines 4 to 7 are information, and the migration changes none of them: the
-- files of line 5 are the ones the coach stops reading — the athlete still
-- reads them. Line 6 leaves out the files of the last day: an upload has no
-- row for a moment. The runbook page lists them, and says how one is removed
-- ("Files that no video names"). Line 7 counts rows that name a file that is
-- gone: the app shows such a video as one that does not play.
-- Line 8 reads 0 since migration 08, which refuses a row anywhere else. A
-- video counted there is one its coach no longer reads after the migration.
with pol as (
  select p.polname, p.polcmd, p.polpermissive, p.polroles,
         pg_get_expr(p.polqual, p.polrelid) as qual
    from pg_policy p
   where p.polrelid = 'storage.objects'::regclass
),
coach_rule as (
  select case
           when not exists (select 1 from pol where polname = 'Coaches read student set videos')
             then 'SOMETHING ELSE: the policy "Coaches read student set videos" is not there'
           when (select qual from pol where polname = 'Coaches read student set videos') like '%set-videos%'
            and (select qual from pol where polname = 'Coaches read student set videos') like '%foldername(name)%'
            and (select qual from pol where polname = 'Coaches read student set videos') like '%coach_id = auth.uid()%'
            and (select qual from pol where polname = 'Coaches read student set videos') not like '% OR %'
            and (select qual from pol where polname = 'Coaches read student set videos') not like '%set_log_videos%'
             then 'every file in the folder of one of their athletes'
           when (select qual from pol where polname = 'Coaches read student set videos') like '%set-videos%'
            and (select qual from pol where polname = 'Coaches read student set videos') like '%coach_id = auth.uid()%'
            and (select qual from pol where polname = 'Coaches read student set videos') like '%set_log_videos v%'
            and (select qual from pol where polname = 'Coaches read student set videos') like '%v.storage_path = objects.name%'
            and (select qual from pol where polname = 'Coaches read student set videos') like '%student_profile_for_set_log(v.set_log_id)%'
            and (select qual from pol where polname = 'Coaches read student set videos') not like '% OR %'
             then 'the files a video of one of their athletes names'
           else 'SOMETHING ELSE: ' || coalesce((select qual from pol where polname = 'Coaches read student set videos'), 'every row')
         end as said
),
unknown as (
  select polname
    from pol
   where polcmd in ('r', '*') and polpermissive
     and (qual is null or qual like '%set-videos%' or qual not like '%bucket_id%')
     and polname <> 'Coaches read student set videos'
     and not (polname = 'Students read own set videos'
              and qual like '%set-videos%'
              and qual like '%(storage.foldername(name))[1] = (auth.uid())::text%'
              and qual not like '% OR %')
),
file as (
  select o.name, o.created_at,
         exists (select 1 from public.set_log_videos v where v.storage_path = o.name) as named
    from storage.objects o
   where o.bucket_id = 'set-videos'
)
select "check", value, expected
  from (
    values
      (1, 'running as',
          current_user::text,
          'postgres'),
      (2, 'which files of set-videos a coach reads (B7)',
          (select said from coach_rule),
          'every file in the folder of one of their athletes before — otherwise stop and report; the other after'),
      (3, 'policies that read the files of set-videos and that this migration does not know',
          coalesce((select string_agg('"' || polname || '"', ', ' order by polname) from unknown), 'none'),
          'none, before and after — otherwise stop and report the line'),
      (4, 'files in set-videos',
          (select count(*)::text from file),
          'information; the same before and after'),
      (5, '… that no video names',
          (select count(*)::text from file where not named),
          'information; the same before and after'),
      (6, '… of which uploaded more than a day ago',
          (select count(*)::text from file where not named and created_at < now() - interval '1 day'),
          'information; the same before and after'),
      (7, 'videos whose file is not in set-videos',
          (select count(*)::text
             from public.set_log_videos v
            where not exists (select 1 from storage.objects o where o.bucket_id = 'set-videos' and o.name = v.storage_path)),
          'information; the same before and after'),
      (8, 'videos stored outside the folder of their athlete',
          (select count(*)::text
             from public.set_log_videos v
            where public.student_profile_for_set_log(v.set_log_id)::text is distinct from (storage.foldername(v.storage_path))[1]),
          '0 — otherwise read the runbook page: their coach no longer reads those files')
  ) as t (n, "check", value, expected)
 order by n;
