-- Audit for 2026_10_16_21_rpe_half_steps_day_check. Read-only, one result table.
-- Run it before applying the migration, and again after.
--
--    check                                                        before                      after
--    1 running as                                                 postgres                    postgres
--    2 what an RPE may be (L34)                                   a whole number from 1 to 10 from 1 to 10, in steps of 0.5
--    3 the RPEs logged, by value                                  a list                      the same list
--    4 what the weekday of a session may be (B12)                 any number                  none, or 1 to 7
--    5 what save_draft_tree writes for a number that is no weekday
--                                                                 the number                  no weekday
--    6 sessions whose weekday is not one (outside 1 to 7)         a number                    0
--    7 sessions of a draft an athlete is writing, with a weekday  a number                    0
--    8 sessions of an approved block an athlete wrote, with a weekday
--                                                                 a number                    0 — the same number with drafts only
--    9 sessions of a block of the coach, with a weekday from 1 to 7
--                                                                 a number                    the same number
--
-- Lines 2, 4 and 5 are the migration: they read as the "after" column once
-- it is applied. Lines 6 to 8 are the rows it writes: the weekdays it clears.
-- The runbook page lists those sessions one by one — read the list before
-- the migration: the values do not come back with the rollback.
--    2  MUST read `a whole number from 1 to 10` before. A line that starts
--       with SOMETHING ELSE: stop and report it — the migration refuses to
--       change a column it does not know.
--    5  MUST read `the number` before — the text of 2026_08_22 production
--       was given and the one of schema.sql both do: they differ by a
--       comment, and comments are left out. SOMETHING ELSE or NOT THERE: stop
--       and report it — the migration refuses to replace another function.
--    3  The values are whole numbers before. The migration keeps each one.
--    6  positions the athlete's draft builder wrote before 2026_08_22 (the
--       9th session of a phase said 9), or a number written by hand.
--    7, 8  every weekday of a block an athlete wrote is an artefact of that
--       builder, which has no weekday control: positions, or Monday for
--       every session. Line 8 stays as it is when the file is run with
--       drafts only (the page gives that command).
--    9  weekdays a coach chose: the migration leaves them alone.
with rpe_column as (
  select format_type(a.atttypid, a.atttypmod) as type
    from pg_attribute a
   where a.attrelid = 'public.set_logs'::regclass and a.attname = 'rpe' and not a.attisdropped
),
rules as (
  select c.conname, c.convalidated
    from pg_constraint c
   where (c.conrelid = 'public.set_logs'::regclass and c.conname in ('set_logs_rpe_check', 'set_logs_rpe_half_step'))
      or (c.conrelid = 'public.sessions'::regclass and c.conname = 'sessions_day_number_weekday')
),
-- save_draft_tree as it is written today, without its `--` comments and
-- without regard to how the text is laid out: d1fd47e4… is the text of
-- 2026_08_22 — the file production was given, and schema.sql before this
-- migration, which differ by a comment only —, 11571955… the text of this
-- migration.
draft_save as (
  select md5(btrim(regexp_replace(regexp_replace(p.prosrc, '-{2}.*', '', 'gn'), '[[:space:]]+', ' ', 'g'))) as body
    from pg_proc p
   where p.oid = to_regprocedure('public.save_draft_tree(jsonb)')
),
s as (
  select s.day_number, p.created_by is not null as by_athlete, p.status
    from public.sessions s
    join public.weeks w    on w.id = s.week_id
    join public.programs p on p.id = w.program_id
   where s.day_number is not null
)
select "check", value, expected
  from (
    values
      (1, 'running as',
          current_user::text,
          'postgres'),
      (2, 'what an RPE may be (L34)',
          case
            when (select type from rpe_column) = 'integer'
                 and not exists (select 1 from rules where conname = 'set_logs_rpe_half_step')
              then 'a whole number from 1 to 10'
            when (select type from rpe_column) = 'numeric(3,1)'
                 and (select count(*) from rules where conname in ('set_logs_rpe_check', 'set_logs_rpe_half_step') and convalidated) = 2
              then 'from 1 to 10, in steps of 0.5'
            else 'SOMETHING ELSE: ' || coalesce((select type from rpe_column), 'no column')
                 || coalesce(' with ' || (select string_agg(conname, ', ' order by conname) from rules where conname like 'set_logs%'), ' and no rule')
          end,
          'a whole number from 1 to 10 before — otherwise stop and report; from 1 to 10, in steps of 0.5 after'),
      (3, 'the RPEs logged, by value',
          coalesce((select string_agg(r.value || ': ' || r.sets, ', ' order by r.rpe)
                      from (select trim_scale(sl.rpe::numeric) as rpe, trim_scale(sl.rpe::numeric)::text as value, count(*) as sets
                              from public.set_logs sl
                             where sl.rpe is not null
                             group by 1, 2) r),
                   'none'),
          'information; the same before and after'),
      (4, 'what the weekday of a session may be (B12)',
          case (select count(*) from rules where conname = 'sessions_day_number_weekday' and convalidated)
            when 1 then 'none, or 1 to 7'
            else 'any number'
          end,
          'any number before, none or 1 to 7 after'),
      (5, 'what save_draft_tree writes for a number that is no weekday',
          coalesce(
            (select case d.body
                      when 'd1fd47e42496f84dd91a2310bce043a5' then 'the number'
                      when '115719550adb6478f07740af7e26f16d' then 'no weekday'
                      else 'SOMETHING ELSE: a text this migration does not know (md5 ' || d.body || ')'
                    end
               from draft_save d),
            'NOT THERE: no function save_draft_tree(jsonb)'),
          'the number before — otherwise stop and report; no weekday after'),
      (6, 'sessions whose weekday is not one (outside 1 to 7)',
          (select count(*)::text from s where s.day_number not between 1 and 7),
          'cleared by the migration: 0 after'),
      (7, 'sessions of a draft an athlete is writing, with a weekday',
          (select count(*)::text from s where s.day_number between 1 and 7 and s.by_athlete and s.status = 'draft'),
          'cleared by the migration: 0 after'),
      (8, 'sessions of an approved block an athlete wrote, with a weekday',
          (select count(*)::text from s where s.day_number between 1 and 7 and s.by_athlete and s.status <> 'draft'),
          'cleared by the migration: 0 after — the same number when it was run with drafts only'),
      (9, 'sessions of a block of the coach, with a weekday from 1 to 7',
          (select count(*)::text from s where s.day_number between 1 and 7 and not s.by_athlete),
          'information; the same before and after')
  ) as t (n, "check", value, expected)
 order by n;
