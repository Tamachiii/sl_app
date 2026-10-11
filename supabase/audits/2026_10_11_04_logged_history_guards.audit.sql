-- Audit for 2026_10_11_04_logged_history_guards. Read-only, one result table.
-- Run it before applying the migration, and again after.
--
--    check                                                        before                      after
--    1 running as                                                 postgres                    postgres
--    2 tables whose logged rows cannot be deleted (P3)            programs; sessions; weeks   exercise_slots; programs; sessions; set_logs; weeks
--    3 the set count cannot go below a logged set                 missing                     in place
--    4 the targets of a logged set are pinned                     missing                     in place
--    5 functions that read the shared set_log_is_logged           none                        all 9
--    6 adopt functions that overlook a failed set, a video or a comment (P17)
--                                                                 adopt_skip; adopt_swap      none
--    7 guards that honour app.allow_history_delete                none                        all 6
--    8 functions of this migration a request without a session may execute
--                                                                 none                        none
--    9 functions of this migration a signed-in user may execute   adopt_skip(uuid, boolean); adopt_swap(uuid, uuid, boolean)
--                                                                                             adopt_skip(uuid, boolean); adopt_swap(uuid, uuid, boolean)
--   10 functions of this migration without search_path = public, pg_temp
--                                                                 none                        none
--   11 sets the athletes have logged                              a number                    the same number
--   12 sets that carry a video                                    a number                    the same number
--   13 sets left at a parked number (100000 or more)              0                           0
--   14 logged sets numbered above their exercise's set count      0                           0
--   15 exercises whose set count is not their number of prescribed sets
--                                                                 0                           0
--
-- Lines 2 to 7 are the findings: they read as the "after" column once the
-- migration is applied.
-- Line 9 must read the same before and after: the two functions the coach's
-- app calls. A name missing there afterwards is a function it can no longer
-- call.
-- Lines 11 and 12 are information: what the migration protects. It reads and
-- writes no row, so they do not move.
-- Lines 13 to 15 are information too, and do not stop the migration: a number
-- other than 0 is data an interrupted edit left behind. The runbook page says
-- what each one means (docs/runbook/migrations/04-logged-history-guards.md).
with fn (name, signature, kind) as (
  values
    ('set_log_is_logged',                     'public.set_log_is_logged(public.set_logs)',          'helper'),
    ('history_delete_allowed',                'public.history_delete_allowed()',                    'helper'),
    ('block_program_delete_with_logged_sets', 'public.block_program_delete_with_logged_sets()',     'guard'),
    ('block_week_delete_with_logged_sets',    'public.block_week_delete_with_logged_sets()',        'guard'),
    ('block_session_delete_with_logged_sets', 'public.block_session_delete_with_logged_sets()',     'guard'),
    ('block_slot_delete_with_logged_sets',    'public.block_slot_delete_with_logged_sets()',        'guard'),
    ('block_set_log_delete_when_logged',      'public.block_set_log_delete_when_logged()',          'guard'),
    ('block_slot_sets_below_logged_set',      'public.block_slot_sets_below_logged_set()',          'guard'),
    ('pin_logged_set_log_targets',            'public.pin_logged_set_log_targets()',                'pin'),
    ('adopt_swap',                            'public.adopt_swap(uuid, uuid, boolean)',             'rpc'),
    ('adopt_skip',                            'public.adopt_skip(uuid, boolean)',                   'rpc')
),
-- Those of the eleven that exist: five before the migration, all after.
f as (
  select fn.name, fn.kind,
         p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as shown,
         p.prosrc,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon_may,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as user_may,
         exists (select 1 from unnest(p.proconfig) as setting
                  where setting = 'search_path=public, pg_temp') as pinned_path
    from fn
    join pg_proc p on p.oid = to_regprocedure(fn.signature)
),
-- The triggers, by table: in place means there, and not switched off.
trg as (
  select c.relname as tbl, t.tgname as name
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
   where c.relnamespace = 'public'::regnamespace
     and not t.tgisinternal
     and t.tgenabled in ('O', 'A')
),
-- "Logged" as the migration defines it, written out: the function does not
-- exist before.
sl as (
  select l.*,
         (l.done or l.failed or l.skipped or l.rpe is not null
          or l.actual_reps is not null or l.actual_weight_kg is not null) as logged
    from public.set_logs l
),
-- Prescribed rows per slot, drafts aside: a draft has none until it is approved.
slot as (
  select es.id, es.sets,
         (select count(*) from public.set_logs l
           where l.exercise_slot_id = es.id and not l.is_student_added) as prescribed
    from public.exercise_slots es
    join public.sessions s on s.id = es.session_id
    join public.weeks w on w.id = s.week_id
    join public.programs p on p.id = w.program_id
   where p.status <> 'draft'
),
-- A set of names: "none", the names, or "all N" when it is every one that
-- should be there.
named (n, value) as (
  select 5, case when count(*) = 0 then 'none' when count(*) = 9 then 'all 9'
                 else string_agg(name, '; ' order by name collate "C") end
    from f where kind <> 'helper' and prosrc like '%set_log_is_logged(%'
  union all
  select 6, coalesce(string_agg(name, '; ' order by name collate "C"), 'none')
    from f where kind = 'rpc'
     and not (prosrc like '%set_log_is_logged(%' and prosrc like '%set_log_videos%' and prosrc like '%slot_comments%')
  union all
  select 7, case when count(*) = 0 then 'none' when count(*) = 6 then 'all 6'
                 else string_agg(name, '; ' order by name collate "C") end
    from f where kind = 'guard' and prosrc like '%history_delete_allowed()%'
  union all
  select 8, coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where anon_may
  union all
  select 9, coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where user_may
  union all
  select 10, coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where not pinned_path
)
select "check", value, expected
  from (
    values
      (1, 'running as',
          current_user::text,
          'postgres'),
      (2, 'tables whose logged rows cannot be deleted (P3)',
          (select coalesce(string_agg(tbl, '; ' order by tbl collate "C"), 'none')
             from trg
            where (tbl, name) in (('programs', 'block_program_delete_with_logged_sets'),
                                  ('weeks', 'block_week_delete_with_logged_sets'),
                                  ('sessions', 'block_session_delete_with_logged_sets'),
                                  ('exercise_slots', 'block_slot_delete_with_logged_sets'),
                                  ('set_logs', 'block_set_log_delete_when_logged'))),
          'programs; sessions; weeks before — exercise_slots; programs; sessions; set_logs; weeks after'),
      (3, 'the set count cannot go below a logged set',
          case when exists (select 1 from trg where tbl = 'exercise_slots' and name = 'block_slot_sets_below_logged_set')
               then 'in place' else 'missing' end,
          'missing before, in place after'),
      (4, 'the targets of a logged set are pinned',
          case when exists (select 1 from trg where tbl = 'set_logs' and name = 'trg_pin_logged_set_log_targets')
               then 'in place' else 'missing' end,
          'missing before, in place after'),
      (5, 'functions that read the shared set_log_is_logged',
          (select value from named where n = 5),
          'none before, all 9 after'),
      (6, 'adopt functions that overlook a failed set, a video or a comment (P17)',
          (select value from named where n = 6),
          'adopt_skip; adopt_swap before, none after'),
      (7, 'guards that honour app.allow_history_delete',
          (select value from named where n = 7),
          'none before, all 6 after'),
      (8, 'functions of this migration a request without a session may execute',
          (select value from named where n = 8),
          'none, before and after'),
      (9, 'functions of this migration a signed-in user may execute',
          (select value from named where n = 9),
          'adopt_skip(uuid, boolean); adopt_swap(uuid, uuid, boolean) — before and after'),
      (10, 'functions of this migration without search_path = public, pg_temp',
          (select value from named where n = 10),
          'none, before and after'),
      (11, 'sets the athletes have logged',
          (select count(*) filter (where logged) || ' of ' || count(*) from sl),
          'information: what the migration protects; the same before and after'),
      (12, 'sets that carry a video',
          (select count(*)::text from public.set_log_videos),
          'information; the same before and after'),
      (13, 'sets left at a parked number (100000 or more)',
          (select case when count(*) = 0 then '0'
                       else count(*) || ' in ' || count(distinct exercise_slot_id) || ' exercise(s), '
                            || count(*) filter (where logged) || ' of them logged' end
             from sl where set_number >= 100000),
          '0 — otherwise go on, and report the line'),
      (14, 'logged sets numbered above their exercise''s set count',
          (select case when count(*) = 0 then '0'
                       else count(*) || ' in ' || count(distinct sl.exercise_slot_id) || ' exercise(s)' end
             from sl
             join public.exercise_slots es on es.id = sl.exercise_slot_id
            where not sl.is_student_added
              and sl.set_number > es.sets
              and (sl.logged or exists (select 1 from public.set_log_videos v where v.set_log_id = sl.id))),
          '0 — otherwise go on, and report the line'),
      (15, 'exercises whose set count is not their number of prescribed sets',
          (select case when count(*) = 0 then '0'
                       else count(*) || ' (' || count(*) filter (where prescribed < sets) || ' with fewer rows, '
                            || count(*) filter (where prescribed > sets) || ' with more)' end
             from slot where prescribed <> sets),
          '0 — otherwise go on, and report the line')
  ) as t (n, "check", value, expected)
 order by n;
