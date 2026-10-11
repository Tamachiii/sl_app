-- Audit for 2026_10_12_08_session_write_gates. Read-only, one result table.
-- Run it before applying the migration, and again after.
--
--    check                                                        before                      after
--    1 running as                                                 postgres                    postgres
--    2 an athlete writes a set only while its session is neither archived nor reviewed (P58)
--                                                                 no                          yes
--    3 … and a note on an exercise                                no                          yes
--    4 … and a swap or a skip of an exercise                      no                          yes
--    5 … and the video of a set                                   no                          yes
--    6 … and the file of that video, which goes under an exercise of their own (L5)
--                                                                 no                          yes
--    7 a video is stored under its athlete and the exercise of its set
--                                                                 no                          yes
--    8 functions of this migration a request without a session may execute
--                                                                 none                        none
--    9 functions of this migration a signed-in user may execute   none                        session_writable_for_slot(uuid); set_video_slot(text); slot_for_set_log(uuid)
--   10 functions of this migration without search_path = public, pg_temp
--                                                                 none                        none
--   11 policies that write these tables and that the migration does not know
--                                                                 none                        none
--   12 reviewed sessions of a block being trained, not archived   a number                    the same number
--   13 … of which their athlete has not confirmed                 0                           0
--   14 … of which lack a set their exercise prescribes            0                           0
--   15 videos                                                     a sentence                  the same sentence
--
-- Lines 2 to 7 and 9 are the findings: they read as the "after" column once
-- the migration is applied.
-- Line 11 MUST read `none` before the migration: it undoes itself otherwise.
-- A policy listed there lets somebody write one of the five tables under a
-- name this migration does not replace. Stop and report it.
-- Line 12 is information: the sessions the migration closes for their
-- athlete. They are the ones the coach has given feedback on, or finished
-- without feedback, in the block each athlete is training.
-- Line 13 does not stop the migration, and is the one to read BEFORE applying
-- it: the sessions of line 12 that have no confirmation — reviewed while the
-- athlete was still training, or whose confirmation the athlete took back
-- afterwards. The app that is deployed goes by the confirmation, not by the
-- review: it shows such a session to its athlete as still to do, and open,
-- and from this migration on nothing they log there is saved. The runbook
-- page lists them, says what the athlete sees, and how one is opened again
-- (docs/runbook/migrations/08-session-write-gates.md, "Sessions reviewed
-- that their athlete has not confirmed").
-- Line 14 is information and does not stop the migration: the same page says
-- what the athlete sees on such a session.
-- Line 15 is information: how many videos there are, and how many of them are
-- stored somewhere else than <athlete>/<exercise slot of the set>/. The
-- migration changes none.
with fn (signature) as (
  values ('public.session_writable(uuid)'),
         ('public.session_writable_for_slot(uuid)'),
         ('public.slot_for_set_log(uuid)'),
         ('public.set_video_slot(text)')
),
-- Those of the four that exist: none before the migration, all after.
f as (
  select p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as shown,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon_may,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as user_may,
         exists (select 1 from unnest(p.proconfig) as setting
                  where setting = 'search_path=public, pg_temp') as pinned_path
    from fn
    join pg_proc p on p.oid = to_regprocedure(fn.signature)
),
-- Every policy that WRITES one of the five tables, with what it asks of a row
-- that is there (USING) and of the row that is written (WITH CHECK).
pol as (
  select n.nspname || '.' || c.relname as tbl,
         p.polname as name,
         p.polcmd::text as cmd,
         coalesce(pg_get_expr(p.polqual, p.polrelid), '') as judged,
         coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as checked
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where (n.nspname, c.relname) in (('public', 'set_logs'), ('public', 'slot_comments'),
                                    ('public', 'slot_deviations'), ('public', 'set_log_videos'),
                                    ('storage', 'objects'))
     and p.polcmd <> 'r'
),
-- The athlete's write policies the migration leaves behind. `line` is the
-- line of this audit that speaks of the table.
wanted (line, tbl, name, cmd) as (
  values (2, 'public.set_logs',        'Students insert own set logs',        'a'),
         (2, 'public.set_logs',        'Students update own set logs',        'w'),
         (2, 'public.set_logs',        'Students delete own set logs',        'd'),
         (3, 'public.slot_comments',   'Students insert own slot comments',   'a'),
         (3, 'public.slot_comments',   'Students update own slot comments',   'w'),
         (3, 'public.slot_comments',   'Students delete own slot comments',   'd'),
         (4, 'public.slot_deviations', 'Students insert own slot deviations', 'a'),
         (4, 'public.slot_deviations', 'Students update own slot deviations', 'w'),
         (4, 'public.slot_deviations', 'Students delete own slot deviations', 'd'),
         (5, 'public.set_log_videos',  'Students insert own set log videos',  'a'),
         (5, 'public.set_log_videos',  'Students update own set log videos',  'w'),
         (5, 'public.set_log_videos',  'Students delete own set log videos',  'd'),
         (6, 'storage.objects',        'Students upload own set videos',      'a'),
         (6, 'storage.objects',        'Students delete own set videos',      'd')
),
-- A table is gated when every one of its policies above is there and asks
-- whether the session is writable wherever it judges a row.
gated as (
  select w.line,
         bool_and(p.name is not null
                  and (w.cmd = 'a' or p.judged like '%session_writable_for_slot(%')
                  and (w.cmd = 'd' or p.checked like '%session_writable_for_slot(%')) as yes
    from wanted w
    left join pol p on p.tbl = w.tbl and p.name = w.name and p.cmd = w.cmd
   group by w.line
),
-- The sessions the migration closes for their athlete.
reviewed as (
  select s.id
    from public.sessions s
    join public.weeks w on w.id = s.week_id
    join public.programs p on p.id = w.program_id
   where s.reviewed_at is not null
     and s.archived_at is null
     and p.is_active
     and p.deleted_at is null
),
-- A video with the athlete and the slot of its set, and where its file is.
video as (
  select v.id,
         st.profile_id::text as athlete,
         sl.exercise_slot_id::text as slot,
         string_to_array(v.storage_path, '/') as folders
    from public.set_log_videos v
    join public.set_logs sl on sl.id = v.set_log_id
    join public.exercise_slots es on es.id = sl.exercise_slot_id
    join public.sessions se on se.id = es.session_id
    join public.weeks w on w.id = se.week_id
    join public.programs p on p.id = w.program_id
    join public.students st on st.id = p.student_id
)
select "check", value, expected
  from (
    values
      (1, 'running as',
          current_user::text,
          'postgres'),
      (2, 'an athlete writes a set only while its session is neither archived nor reviewed (P58)',
          (select case when yes then 'yes' else 'no' end from gated where line = 2),
          'no before, yes after'),
      (3, '… and a note on an exercise',
          (select case when yes then 'yes' else 'no' end from gated where line = 3),
          'no before, yes after'),
      (4, '… and a swap or a skip of an exercise',
          (select case when yes then 'yes' else 'no' end from gated where line = 4),
          'no before, yes after'),
      (5, '… and the video of a set',
          (select case when yes then 'yes' else 'no' end from gated where line = 5),
          'no before, yes after'),
      (6, '… and the file of that video, which goes under an exercise of their own (L5)',
          (select case when yes then 'yes' else 'no' end from gated where line = 6),
          'no before, yes after'),
      (7, 'a video is stored under its athlete and the exercise of its set',
          case when (select count(*) from pol
                      where tbl = 'public.set_log_videos'
                        and name in ('Students insert own set log videos', 'Students update own set log videos')
                        and checked like '%set_video_slot(storage_path)%'
                        and checked like '%slot_for_set_log(set_log_id)%') = 2
               then 'yes' else 'no' end,
          'no before, yes after'),
      (8, 'functions of this migration a request without a session may execute',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where anon_may),
          'none, before and after'),
      (9, 'functions of this migration a signed-in user may execute',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where user_may),
          'none before; after: session_writable_for_slot(uuid); set_video_slot(text); slot_for_set_log(uuid)'),
      (10, 'functions of this migration without search_path = public, pg_temp',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where not pinned_path),
          'none, before and after'),
      (11, 'policies that write these tables and that the migration does not know',
          (select coalesce(string_agg(p.tbl || ': ' || p.name, '; ' order by p.tbl collate "C", p.name collate "C"), 'none')
             from pol p
            where not exists (select 1 from wanted w where w.tbl = p.tbl and w.name = p.name)
              and (p.tbl, p.name) not in (('public.set_logs', 'Coaches manage set log prescriptions'),
                                          ('public.set_log_videos', 'Students manage own set log videos'))),
          'none — otherwise stop and report the line'),
      (12, 'reviewed sessions of a block being trained, not archived',
          (select count(*)::text from reviewed),
          'information; the same before and after'),
      (13, '… of which their athlete has not confirmed',
          (select count(*)::text
             from reviewed r
            where not exists (select 1 from public.session_confirmations c where c.session_id = r.id)),
          '0 — otherwise read the runbook page before applying: their athlete sees them as still to do'),
      (14, '… of which lack a set their exercise prescribes',
          (select count(*)::text
             from reviewed r
            where exists (
              select 1
                from public.exercise_slots es
               where es.session_id = r.id
                 and es.sets > (select count(*) from public.set_logs sl
                                 where sl.exercise_slot_id = es.id
                                   and sl.set_number between 1 and es.sets))),
          '0 — otherwise go on, and report the line'),
      (15, 'videos',
          (select count(*) || ' video(s), '
                  || count(*) filter (where not (cardinality(folders) >= 3
                                                 and folders[1] = athlete
                                                 and folders[2] = slot))
                  || ' of them stored elsewhere than under their athlete and exercise'
             from video),
          'information; the same before and after')
  ) as t (n, "check", value, expected)
 order by n;
