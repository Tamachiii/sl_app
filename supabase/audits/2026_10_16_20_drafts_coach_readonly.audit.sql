-- Audit for 2026_10_16_20_drafts_coach_readonly. Read-only, one result table.
-- Run it before applying the migration, and again after.
--
--    check                                                        before                      after
--    1 running as                                                 postgres                    postgres
--    2 who writes the phases, sessions, exercises and sets of a draft (P53)
--                                                                 its author, and the coach of its athlete
--                                                                                             its author only
--    3 the triggers that keep a draft its author's (block_draft_tree_write)
--                                                                 none                        weeks, sessions, exercise_slots, set_logs
--    4 what approve_program does with the sets of a draft (P53)
--                                                                 adds the missing sets, then marks the program approved
--                                                                                             marks the program approved, drops the sets without a target, adds the missing sets
--    5 functions of these names that the migration does not know  none                        none
--    6 functions of this migration a request without a session may execute
--                                                                 none                        none
--    7 functions of this migration a signed-in user may execute   approve_program(uuid)       approve_program(uuid)
--    8 functions of this migration that run as their owner        approve_program(uuid)
--                                                                                             approve_program(uuid); block_draft_session_write(); block_draft_set_log_write(); block_draft_slot_write(); block_draft_week_write()
--    9 functions of this migration without search_path = public, pg_temp
--                                                                 none                        none
--   10 drafts out of the trash                                    a sentence                  the same sentence
--   11 drafts in the trash                                        a number                    the same number
--   12 drafts nobody wrote: a block made a draft again by its coach (no author)
--                                                                 0                           0
--   13 sets in drafts — written by a coach, before the migration  0                           0
--   14 … without a target: dropped and written again from their exercise when the draft is approved
--                                                                 0                           0
--   15 … the others — a target, or logged, added or filmed: kept when the draft is approved
--                                                                 0                           0
--
-- Lines 2, 3, 4 and 8 are the migration: they read as the "after" column
-- once it is applied. Line 7 is meant, before and after: the app calls
-- approve_program with the rights of the coach.
-- Lines 2, 4 and 5 decide whether the migration runs at all:
--    2  MUST read `its author, and the coach of its athlete` before. A line
--       that starts with PARTLY names the triggers that are there, made by
--       hand: stop and report it.
--    4  MUST read `adds the missing sets, then marks the program approved`
--       before: the migration replaces that function and refuses to replace
--       another one. A line that starts with SOMETHING ELSE or NOT THERE:
--       stop and report it.
--    5  MUST read `none`: a function listed there has one of the five names
--       and was made by hand. Stop and report it.
-- Lines 10 to 15 are the rows. The migration writes none of them:
--   10  `N being written, M sent in`: the drafts the coach can approve or
--       send back (the M) and the ones their athlete has not sent yet. From
--       the migration on, the coach changes nothing in any of them.
--   12  a draft whose author is empty: a block that was made a draft again
--       by hand (no screen of the app does it). From the migration on nobody
--       who signs in writes what is in it, the coach included, until it is
--       approved. The runbook page says what to do.
--   13  sets in a draft: an athlete writes none — the coach's editor added
--       them, before the migration. 0 is what production held at migration
--       06 (no draft at all).
--   14  the rows of a higher "Sets" in a draft, which the editor wrote
--       without reps or load. Approving the draft drops them and writes the
--       sets again from the exercise — with reps or a duration, the load and
--       the rest the exercise says.
--   15  kept by the approval, as before.
with fn (signature) as (
  values ('public.approve_program(uuid)'),
         ('public.block_draft_week_write()'),
         ('public.block_draft_session_write()'),
         ('public.block_draft_slot_write()'),
         ('public.block_draft_set_log_write()')
),
-- Those of the five that exist: approve_program before the migration, the
-- five after.
f as (
  select fn.signature,
         p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as shown,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon_may,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as user_may,
         p.prosecdef as as_owner,
         exists (select 1 from unnest(p.proconfig) as setting
                  where setting = 'search_path=public, pg_temp') as pinned_path
    from fn
    join pg_proc p on p.oid = to_regprocedure(fn.signature)
),
-- Every function of public under one of the five names, whatever its
-- arguments.
named as (
  select p.oid, p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as shown
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('approve_program', 'block_draft_week_write', 'block_draft_session_write',
                       'block_draft_slot_write', 'block_draft_set_log_write')
),
-- The four triggers, by table, as they are.
tr as (
  select t.n, t.tbl, t.short,
         (select tg.tgenabled from pg_trigger tg
           where tg.tgrelid = to_regclass(t.tbl)
             and tg.tgname = 'block_draft_tree_write' and not tg.tgisinternal) as enabled
    from (values (1, 'public.weeks', 'weeks'), (2, 'public.sessions', 'sessions'),
                 (3, 'public.exercise_slots', 'exercise_slots'), (4, 'public.set_logs', 'set_logs')) as t (n, tbl, short)
),
-- approve_program as it is written today, without regard to how the text is
-- laid out: the md5 of its text with every run of spaces, tabs and line
-- breaks folded into one space. c45a0a8b… is the text of migration 15,
-- b5ee6c0d… the text of this migration.
rule as (
  select md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '[[:space:]]+', ' ', 'g')) as body
    from pg_proc p
   where p.oid = to_regprocedure('public.approve_program(uuid)')
),
-- The drafts, and the sets they hold.
d as (
  select p.id, p.created_by, p.submitted_at, p.deleted_at is not null as in_trash
    from public.programs p
   where p.status = 'draft'
),
ds as (
  select sl.is_student_added
         or sl.target_reps is not null
         or sl.target_duration_seconds is not null
         or public.set_log_is_logged(sl)
         or exists (select 1 from public.set_log_videos v where v.set_log_id = sl.id) as kept
    from d
    join public.weeks w           on w.program_id = d.id
    join public.sessions s        on s.week_id = w.id
    join public.exercise_slots es on es.session_id = s.id
    join public.set_logs sl       on sl.exercise_slot_id = es.id
)
select "check", value, expected
  from (
    values
      (1, 'running as',
          current_user::text,
          'postgres'),
      (2, 'who writes the phases, sessions, exercises and sets of a draft (P53)',
          case
            when (select count(*) from tr where enabled is not null) = 0
              then 'its author, and the coach of its athlete'
            when (select count(*) from tr where enabled = 'O') = 4
              then 'its author only'
            else 'PARTLY: the trigger is there and switched on for '
                 || coalesce((select string_agg(short, ', ' order by n) from tr where enabled = 'O'), 'none')
                 || ' — not for '
                 || (select string_agg(short, ', ' order by n) from tr where enabled is distinct from 'O')
          end,
          'its author, and the coach of its athlete before — otherwise stop and report; its author only, after'),
      (3, 'the triggers that keep a draft its author''s (block_draft_tree_write)',
          coalesce((select string_agg(short || case when enabled = 'O' then '' else ' (SWITCHED OFF)' end, ', ' order by n)
                      from tr where enabled is not null), 'none'),
          'none before, the four tables after'),
      (4, 'what approve_program does with the sets of a draft (P53)',
          coalesce(
            (select case r.body
                      when 'c45a0a8b10a0e9ffa3d8dc812a35d10b'
                        then 'adds the missing sets, then marks the program approved'
                      when 'b5ee6c0dac1f6380c42e5393e9abbcc2'
                        then 'marks the program approved, drops the sets without a target, adds the missing sets'
                      else 'SOMETHING ELSE: a text this migration does not know (md5 ' || r.body || ')'
                    end
               from rule r),
            'NOT THERE: no function approve_program(uuid)'),
          'adds the missing sets, then marks the program approved before — otherwise stop and report; the other after'),
      (5, 'functions of these names that the migration does not know',
          (select coalesce(string_agg(n.shown, '; ' order by n.shown collate "C"), 'none')
             from named n
            where not exists (select 1 from fn where to_regprocedure(fn.signature) = n.oid)),
          'none — otherwise stop and report the line'),
      (6, 'functions of this migration a request without a session may execute',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where anon_may),
          'none, before and after'),
      (7, 'functions of this migration a signed-in user may execute',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where user_may),
          'approve_program, before and after: the app calls it'),
      (8, 'functions of this migration that run as their owner',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where as_owner),
          'approve_program before; the five after'),
      (9, 'functions of this migration without search_path = public, pg_temp',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where not pinned_path),
          'none, before and after'),
      (10, 'drafts out of the trash',
          (select count(*) filter (where d.submitted_at is null) || ' being written, '
                  || count(*) filter (where d.submitted_at is not null) || ' sent in'
             from d where not d.in_trash),
          'information; the same before and after'),
      (11, 'drafts in the trash',
          (select count(*)::text from d where d.in_trash),
          'information; the same before and after'),
      (12, 'drafts nobody wrote: a block made a draft again by its coach (no author)',
          (select count(*)::text from d where d.created_by is null),
          '0 — otherwise the runbook page says what each means'),
      (13, 'sets in drafts — written by a coach, before the migration',
          (select count(*)::text from ds),
          'information; the same before and after'),
      (14, '… without a target: dropped and written again from their exercise when the draft is approved',
          (select count(*)::text from ds where not ds.kept),
          'information; the same before and after'),
      (15, '… the others — a target, or logged, added or filmed: kept when the draft is approved',
          (select count(*)::text from ds where ds.kept),
          'information; the same before and after')
  ) as t (n, "check", value, expected)
 order by n;
