-- Audit for 2026_10_11_06_pin_student_writes. Read-only, one result table.
-- Run it before applying the migration, and again after.
--
--    check                                                        before                      after
--    1 running as                                                 postgres                    postgres
--    2 an athlete's update leaves the targets of a set as they were
--                                                                 in place                    in place
--    3 … and its exercise, its number and whether it is an extra set (P14)
--                                                                 no                          yes
--    4 a session of a draft is kept without review, archive, training date and recommended date (P13)
--                                                                 missing                     in place
--    5 approving a draft clears those four columns on its sessions
--                                                                 no                          yes
--    6 the author of a draft cannot take a submission back (B4)   no                          yes
--    7 functions of this migration a request without a session may execute
--                                                                 none                        none
--    8 functions of this migration a signed-in user may execute   approve_program(uuid)       approve_program(uuid)
--    9 functions of this migration without search_path = public, pg_temp
--                                                                 none                        none
--   10 sessions of a draft that carry a review, an archive, a training date or a recommended date
--                                                                 0                           0
--   11 sets marked as added by the athlete that carry a prescription
--                                                                 0                           0
--   12 drafts                                                     a sentence                  the same sentence
--
-- Lines 3 to 6 are the findings: they read as the "after" column once the
-- migration is applied.
-- Line 2 is the pin that was already there. It must read "in place" before
-- and after: "missing" before means it was dropped or switched off by hand,
-- and the migration puts it back.
-- Line 8 must read the same before and after: the function the coach's app
-- calls to approve a draft. Missing afterwards, the coach can no longer
-- approve one.
-- Lines 10 and 11 are information and do not stop the migration, which
-- changes none of those rows. The runbook page says what each one means
-- (docs/runbook/migrations/06-pin-student-writes.md).
-- Line 12 is information: how many drafts athletes are writing, and how many
-- of them wait for the coach.
with fn (name, signature) as (
  values
    ('pin_set_log_targets_for_student', 'public.pin_set_log_targets_for_student()'),
    ('pin_draft_session_columns',       'public.pin_draft_session_columns()'),
    ('pin_program_authoring_columns',   'public.pin_program_authoring_columns()'),
    ('approve_program',                 'public.approve_program(uuid)')
),
-- Those of the four that exist: three before the migration, all after.
f as (
  select fn.name,
         p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as shown,
         p.prosrc,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon_may,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as user_may,
         exists (select 1 from unnest(p.proconfig) as setting
                  where setting = 'search_path=public, pg_temp') as pinned_path
    from fn
    join pg_proc p on p.oid = to_regprocedure(fn.signature)
),
-- The triggers, by table and function: in place means there, calling that
-- function, and not switched off.
trg as (
  select c.relname as tbl, t.tgname as name, p.proname as calls
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_proc p on p.oid = t.tgfoid
   where c.relnamespace = 'public'::regnamespace
     and not t.tgisinternal
     and t.tgenabled in ('O', 'A')
),
-- Is the pin on a set there at all, and what does its function hold?
set_pin as (
  select exists (select 1 from trg
                  where tbl = 'set_logs' and name = 'trg_pin_set_log_targets_for_student'
                    and calls = 'pin_set_log_targets_for_student') as fires,
         coalesce((select prosrc from f where name = 'pin_set_log_targets_for_student'), '') as body
),
-- The sessions of every draft, with the four columns no draft should carry.
draft_session as (
  select s.id, p.id as program_id,
         s.reviewed_at is not null as reviewed,
         s.archived_at is not null as archived,
         s.performed_at is not null as performed,
         s.scheduled_date is not null as dated
    from public.sessions s
    join public.weeks w on w.id = s.week_id
    join public.programs p on p.id = w.program_id
   where p.status = 'draft'
)
select "check", value, expected
  from (
    values
      (1, 'running as',
          current_user::text,
          'postgres'),
      (2, 'an athlete''s update leaves the targets of a set as they were',
          (select case when fires
                        and body ~ 'NEW\.target_reps\s*:=\s*OLD\.target_reps\s*;'
                        and body ~ 'NEW\.target_duration_seconds\s*:=\s*OLD\.target_duration_seconds\s*;'
                        and body ~ 'NEW\.target_weight_kg\s*:=\s*OLD\.target_weight_kg\s*;'
                        and body ~ 'NEW\.target_rest_seconds\s*:=\s*OLD\.target_rest_seconds\s*;'
                       then 'in place' else 'missing' end
             from set_pin),
          'in place, before and after'),
      (3, '… and its exercise, its number and whether it is an extra set (P14)',
          (select case when fires
                        and body ~ 'NEW\.exercise_slot_id\s*:=\s*OLD\.exercise_slot_id\s*;'
                        and body ~ 'NEW\.set_number\s*:=\s*OLD\.set_number\s*;'
                        and body ~ 'NEW\.is_student_added\s*:=\s*OLD\.is_student_added\s*;'
                        and body like '%student_profile_for_slot(OLD.exercise_slot_id)%'
                       then 'yes' else 'no' end
             from set_pin),
          'no before, yes after'),
      (4, 'a session of a draft is kept without review, archive, training date and recommended date (P13)',
          case when exists (select 1 from trg
                             where tbl = 'sessions' and name = 'trg_pin_draft_session_columns'
                               and calls = 'pin_draft_session_columns')
               then 'in place' else 'missing' end,
          'missing before, in place after'),
      (5, 'approving a draft clears those four columns on its sessions',
          case when exists (select 1 from f
                             where name = 'approve_program'
                               and prosrc ~ 'UPDATE public\.sessions s\s+SET reviewed_at = NULL, archived_at = NULL, performed_at = NULL, scheduled_date = NULL')
               then 'yes' else 'no' end,
          'no before, yes after'),
      (6, 'the author of a draft cannot take a submission back (B4)',
          case when exists (select 1 from f
                             where name = 'pin_program_authoring_columns'
                               and prosrc ~ 'NEW\.submitted_at\s*:=\s*OLD\.submitted_at\s*;')
                and exists (select 1 from trg
                             where tbl = 'programs' and name = 'trg_pin_program_authoring_columns'
                               and calls = 'pin_program_authoring_columns')
               then 'yes' else 'no' end,
          'no before, yes after'),
      (7, 'functions of this migration a request without a session may execute',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where anon_may),
          'none, before and after'),
      (8, 'functions of this migration a signed-in user may execute',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where user_may),
          'approve_program(uuid) — before and after'),
      (9, 'functions of this migration without search_path = public, pg_temp',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where not pinned_path),
          'none, before and after'),
      (10, 'sessions of a draft that carry a review, an archive, a training date or a recommended date',
          (select case when count(*) = 0 then '0'
                       else count(*) || ' in ' || count(distinct program_id) || ' draft(s) ('
                            || count(*) filter (where reviewed) || ' reviewed, '
                            || count(*) filter (where archived) || ' archived, '
                            || count(*) filter (where performed) || ' with a training date, '
                            || count(*) filter (where dated) || ' with a recommended date)' end
             from draft_session
            where reviewed or archived or performed or dated),
          '0 — otherwise go on, and report the line'),
      (11, 'sets marked as added by the athlete that carry a prescription',
          (select case when count(*) = 0 then '0'
                       else count(*) || ' in ' || count(distinct exercise_slot_id) || ' exercise(s)' end
             from public.set_logs
            where is_student_added
              and (target_reps is not null or target_duration_seconds is not null
                   or target_weight_kg is not null or target_rest_seconds is not null)),
          '0 — otherwise go on, and report the line'),
      (12, 'drafts',
          (select count(*) || ' draft(s), '
                  || count(*) filter (where submitted_at is not null) || ' of them sent in to the coach'
             from public.programs
            where status = 'draft' and deleted_at is null),
          'information; the same before and after')
  ) as t (n, "check", value, expected)
 order by n;
