-- Audit for 2026_10_13_17_replay_grace_window. Read-only, one result table.
-- Run it before applying the migration, and again after.
--
--    check                                                        before                      after
--    1 running as                                                 postgres                    postgres
--    2 when an athlete may write in a block (program_active_for_session, P55)
--                                                                 while it is the active one
--                                                                                             while it is the active one, and for 72 hours after it was switched off
--    3 a block says when it was switched off (programs.deactivated_at)
--                                                                 no                          yes
--    4 the trigger that writes that time (trg_stamp_program_deactivated_at)
--                                                                 no                          yes
--    5 functions of these names that the migration does not know  none                        none
--    6 functions of this migration a request without a session may execute
--                                                                 none                        none
--    7 functions of this migration a signed-in user may execute   program_active_for_session(uuid)
--                                                                                             program_active_for_session(uuid)
--    8 functions of this migration that run as their owner        program_active_for_session(uuid)
--                                                                                             program_active_for_session(uuid); stamp_program_deactivated_at()
--    9 functions of this migration without search_path = public, pg_temp
--                                                                 none                        none
--   10 blocks out of the trash                                    a sentence                  the same sentence
--   11 blocks in the trash                                        a number                    the same number
--   12 blocks that are not active and that their athlete may still write in (switched off less than 72 hours ago)
--                                                                 0                           0
--   13 … the last of them closes on                               none                        none
--   14 blocks switched off less than 72 hours ago that are closed all the same: in the trash
--                                                                 0                           0
--   15 blocks that hold a time of switching off and should not: the active one, a draft, or a time still to come
--                                                                 0                           0
--
-- Lines 2, 3, 4 and 8 are the migration: they read as the "after" column
-- once it is applied. Line 7 is meant, before and after: the policies an
-- athlete's write goes through call program_active_for_session with the
-- rights of that athlete.
-- Lines 2 and 5 decide whether the migration runs at all:
--    2  MUST read `while it is the active one` before: the migration
--       replaces that rule and refuses to replace another one. A line that
--       starts with SOMETHING ELSE prints the rule that is there: stop and
--       report it.
--    5  MUST read `none`: a function listed there has one of the two names
--       and was made by hand. Stop and report it.
-- Lines 10 to 15 are the rows. The migration writes none of them:
--   10  `N being trained, M not active, K drafts`. The M are closed for their
--       athlete today, and stay closed: nothing says when they were switched
--       off.
--   12  0 before — no block has a time on record — and 0 right after. From
--       then on: the blocks a coach switched off in the last three days.
--       Each is open for its athlete until 72 hours after the switch.
--   13  when the last of those windows closes, in UTC; `none` while line 12
--       reads 0.
--   14  a block that went to the trash inside its 72 hours: closed.
--   15  written by hand, from the SQL editor — the trigger never leaves
--       one. The runbook page says what each means.
with fn (signature) as (
  values ('public.program_active_for_session(uuid)'),
         ('public.stamp_program_deactivated_at()')
),
-- Those of the two that exist: the first before the migration, both after.
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
-- Every function of public under one of the two names, whatever its
-- arguments.
named as (
  select p.oid, p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as shown
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('program_active_for_session', 'stamp_program_deactivated_at')
),
-- The rule as it is written today, without regard to how the text is laid
-- out.
rule as (
  select regexp_replace(btrim(p.prosrc, E' \t\r\n'), '[[:space:]]+', ' ', 'g') as body
    from pg_proc p
   where p.oid = to_regprocedure('public.program_active_for_session(uuid)')
),
-- The blocks. The time of switching off is read through to_jsonb, so that the
-- query runs where the column is not there yet.
b as (
  select p.is_active,
         p.status,
         p.deleted_at is not null as in_trash,
         (to_jsonb(p) ->> 'deactivated_at')::timestamptz as switched_off
    from public.programs p
),
-- Inside its 72 hours, whatever else the block is.
recent as (
  select b.*, b.switched_off + interval '72 hours' as closes_at
    from b
   where not b.is_active
     and b.status = 'approved'
     and b.switched_off is not null
     and b.switched_off > now() - interval '72 hours'
)
select "check", value, expected
  from (
    values
      (1, 'running as',
          current_user::text,
          'postgres'),
      (2, 'when an athlete may write in a block (program_active_for_session, P55)',
          coalesce(
            (select case
                      when r.body = 'SELECT p.is_active AND p.deleted_at IS NULL FROM public.sessions sess JOIN public.weeks w ON w.id = sess.week_id JOIN public.programs p ON p.id = w.program_id WHERE sess.id = sess_id'
                        then 'while it is the active one'
                      when position('p.deactivated_at > now() - interval ''72 hours''' in r.body) > 0
                        then 'while it is the active one, and for 72 hours after it was switched off'
                      else 'SOMETHING ELSE: ' || r.body
                    end
               from rule r),
            'NOT THERE: no function program_active_for_session(uuid)'),
          'while it is the active one before — otherwise stop and report; and for 72 hours after it was switched off, after'),
      (3, 'a block says when it was switched off (programs.deactivated_at)',
          case when exists (select 1 from pg_attribute a
                             where a.attrelid = to_regclass('public.programs')
                               and a.attname = 'deactivated_at' and not a.attisdropped)
               then 'yes' else 'no' end,
          'no before, yes after'),
      (4, 'the trigger that writes that time (trg_stamp_program_deactivated_at)',
          coalesce(
            (select case t.tgenabled when 'O' then 'yes' else 'THERE, AND SWITCHED OFF' end
               from pg_trigger t
              where t.tgrelid = to_regclass('public.programs')
                and t.tgname = 'trg_stamp_program_deactivated_at' and not t.tgisinternal),
            'no'),
          'no before, yes after'),
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
          'program_active_for_session, before and after: the policies call it'),
      (8, 'functions of this migration that run as their owner',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where as_owner),
          'program_active_for_session before; both after'),
      (9, 'functions of this migration without search_path = public, pg_temp',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where not pinned_path),
          'none, before and after'),
      (10, 'blocks out of the trash',
          (select count(*) filter (where b.is_active) || ' being trained, '
                  || count(*) filter (where not b.is_active and b.status <> 'draft') || ' not active, '
                  || count(*) filter (where b.status = 'draft') || ' drafts'
             from b where not b.in_trash),
          'information; the same before and after'),
      (11, 'blocks in the trash',
          (select count(*)::text from b where b.in_trash),
          'information; the same before and after'),
      (12, 'blocks that are not active and that their athlete may still write in (switched off less than 72 hours ago)',
          (select count(*)::text from recent r where not r.in_trash),
          '0 before and right after; then the blocks switched off in the last three days'),
      (13, '… the last of them closes on',
          (select coalesce(to_char(max(r.closes_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC', 'none')
             from recent r where not r.in_trash),
          'none while line 12 reads 0'),
      (14, 'blocks switched off less than 72 hours ago that are closed all the same: in the trash',
          (select count(*)::text from recent r where r.in_trash),
          'information; 0 before and right after'),
      (15, 'blocks that hold a time of switching off and should not: the active one, a draft, or a time still to come',
          (select count(*)::text from b
            where b.switched_off is not null
              and (b.is_active or b.status = 'draft' or b.switched_off > now())),
          '0 — otherwise written by hand: the runbook page says what each means')
  ) as t (n, "check", value, expected)
 order by n;
