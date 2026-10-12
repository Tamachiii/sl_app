-- Audit for 2026_10_13_09_review_lifecycle. Read-only, one result table.
-- Run it before applying the migration, and again after.
--
--    check                                                        before                      after
--    1 running as                                                 postgres                    postgres
--    2 an athlete changes or takes back a confirmation only while its session is neither archived nor reviewed (P57)
--                                                                 no                          yes
--    3 … and not while the review of that session is being written
--                                                                 no                          yes
--    4 a signed-in user marks a session as reviewed only once its athlete has confirmed it
--                                                                 no                          yes
--    5 … and sends feedback on a confirmed session only           no                          yes
--    6 a confirmation that is taken back takes its unread notifications with it
--                                                                 no                          yes
--    7 … and so does a swap or a skip that is removed (L12)       no                          yes
--    8 the push of a confirmation is tagged by session            no                          yes
--    9 functions of this migration a request without a session may execute
--                                                                 none                        none
--   10 functions of this migration a signed-in user may execute   none                        session_is_confirmed(uuid); session_writable(uuid)
--   11 functions of this migration without search_path = public, pg_temp
--                                                                 none                        none
--   12 policies that write these tables and that the migration does not know
--                                                                 none                        none
--   13 sessions reviewed without a confirmation                   a number                    the same number
--   14 unread "session completed" notifications whose confirmation is gone
--                                                                 a number                    0
--   15 unread "off-plan" notifications whose swap or skip is gone a number                    0
--
-- Lines 2 to 8 and 10 are the findings: they read as the "after" column once
-- the migration is applied.
-- Line 12 MUST read `none` before the migration: it undoes itself otherwise.
-- A policy listed there lets somebody write session_confirmations or messages
-- under a name this migration does not know. Stop and report it.
-- Line 13 is information, and the migration does not change it: the sessions
-- a coach reviewed while their athlete had not confirmed them, or whose
-- confirmation was taken back after the review. They stay reviewed. Their
-- athlete can still confirm them, and nothing new joins the list through the
-- app from this migration on (docs/runbook/migrations/09-review-lifecycle.md,
-- "Sessions reviewed without a confirmation").
-- Lines 14 and 15 are the rows the migration DELETES: notifications the coach
-- has not read, about a confirmation, a swap or a skip that no longer exists.
-- They read 0 afterwards, and do not come back with the rollback.
with fn (signature) as (
  values ('public.session_is_confirmed(uuid)'),
         ('public.session_writable(uuid)'),
         ('public.review_needs_confirmation()'),
         ('public.block_confirmation_delete_when_reviewed()'),
         ('public.retract_session_completed_notification()'),
         ('public.retract_slot_deviation_notifications()'),
         ('public.notify_coach_on_session_confirm()')
),
-- Those of the seven that exist: two before the migration, all after.
f as (
  select p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as shown,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon_may,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as user_may,
         exists (select 1 from unnest(p.proconfig) as setting
                  where setting = 'search_path=public, pg_temp') as pinned_path
    from fn
    join pg_proc p on p.oid = to_regprocedure(fn.signature)
),
-- Every policy that WRITES one of the two tables, with what it asks of a row
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
   where (n.nspname, c.relname) in (('public', 'session_confirmations'), ('public', 'messages'))
     and p.polcmd <> 'r'
),
-- The write policies the two tables have, before the migration and after.
known (tbl, name) as (
  values ('public.session_confirmations', 'Students insert own session confirmations'),
         ('public.session_confirmations', 'Students update own session confirmations'),
         ('public.session_confirmations', 'Students delete own session confirmations'),
         ('public.messages',              'Send to coach-student counterpart'),
         ('public.messages',              'Recipient marks messages read'),
         ('public.messages',              'Sender deletes own message')
),
-- The triggers the migration creates, those of them that are there and
-- switched on. `line` is the line of this audit that speaks of each.
trg as (
  select w.line
    from (values (3, 'public.session_confirmations', 'block_confirmation_delete_when_reviewed',    'block_confirmation_delete_when_reviewed'),
                 (4, 'public.sessions',              'trg_review_needs_confirmation',              'review_needs_confirmation'),
                 (6, 'public.session_confirmations', 'trg_retract_session_completed_notification', 'retract_session_completed_notification'),
                 (7, 'public.slot_deviations',       'trg_retract_slot_deviation_notifications',   'retract_slot_deviation_notifications')
         ) as w (line, tbl, name, fn)
    join pg_trigger t on t.tgrelid = w.tbl::regclass and t.tgname = w.name
    join pg_proc p on p.oid = t.tgfoid
   where p.pronamespace = 'public'::regnamespace
     and p.proname = w.fn
     and t.tgenabled = 'O'
     and not t.tgisinternal
)
select "check", value, expected
  from (
    values
      (1, 'running as',
          current_user::text,
          'postgres'),
      (2, 'an athlete changes or takes back a confirmation only while its session is neither archived nor reviewed (P57)',
          case when (select count(*) from pol
                      where tbl = 'public.session_confirmations'
                        and (   (name = 'Students update own session confirmations' and cmd = 'w'
                                 and judged like '%session_writable(%' and checked like '%session_writable(%')
                             or (name = 'Students delete own session confirmations' and cmd = 'd'
                                 and judged like '%session_writable(%'))) = 2
               then 'yes' else 'no' end,
          'no before, yes after'),
      (3, '… and not while the review of that session is being written',
          case when exists (select 1 from trg where line = 3) then 'yes' else 'no' end,
          'no before, yes after'),
      (4, 'a signed-in user marks a session as reviewed only once its athlete has confirmed it',
          case when exists (select 1 from trg where line = 4) then 'yes' else 'no' end,
          'no before, yes after'),
      (5, '… and sends feedback on a confirmed session only',
          case when exists (select 1 from pol
                             where tbl = 'public.messages' and name = 'Send to coach-student counterpart'
                               and cmd = 'a' and checked like '%session_is_confirmed(%')
               then 'yes' else 'no' end,
          'no before, yes after'),
      (6, 'a confirmation that is taken back takes its unread notifications with it',
          case when exists (select 1 from trg where line = 6) then 'yes' else 'no' end,
          'no before, yes after'),
      (7, '… and so does a swap or a skip that is removed (L12)',
          case when exists (select 1 from trg where line = 7) then 'yes' else 'no' end,
          'no before, yes after'),
      (8, 'the push of a confirmation is tagged by session',
          case when exists (select 1 from pg_proc p
                             where p.oid = to_regprocedure('public.notify_coach_on_session_confirm()')
                               and p.prosrc like '%''session-confirm-'' || NEW.session_id::text%')
               then 'yes' else 'no' end,
          'no before, yes after'),
      (9, 'functions of this migration a request without a session may execute',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where anon_may),
          'none, before and after'),
      (10, 'functions of this migration a signed-in user may execute',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where user_may),
          'none before; after: session_is_confirmed(uuid); session_writable(uuid)'),
      (11, 'functions of this migration without search_path = public, pg_temp',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where not pinned_path),
          'none, before and after'),
      (12, 'policies that write these tables and that the migration does not know',
          (select coalesce(string_agg(p.tbl || ': ' || p.name, '; ' order by p.tbl collate "C", p.name collate "C"), 'none')
             from pol p
            where not exists (select 1 from known k where k.tbl = p.tbl and k.name = p.name)),
          'none — otherwise stop and report the line'),
      (13, 'sessions reviewed without a confirmation',
          (select count(*)::text
             from public.sessions s
            where s.reviewed_at is not null
              and not exists (select 1 from public.session_confirmations c where c.session_id = s.id)),
          'information; the same before and after'),
      (14, 'unread "session completed" notifications whose confirmation is gone',
          (select count(*)::text
             from public.notifications n
            where n.kind = 'session_completed'
              and n.read_at is null
              and n.payload ? 'confirmation_id'
              and not exists (select 1 from public.session_confirmations c
                               where c.id::text = n.payload->>'confirmation_id')),
          'a number before — the migration deletes them; 0 after'),
      (15, 'unread "off-plan" notifications whose swap or skip is gone',
          (select count(*)::text
             from public.notifications n
            where n.kind in ('session_deviation', 'promote_requested')
              and n.read_at is null
              and n.payload ? 'slot_id'
              and not exists (select 1 from public.slot_deviations d
                               where d.exercise_slot_id::text = n.payload->>'slot_id')),
          'a number before — the migration deletes them; 0 after')
  ) as t (n, "check", value, expected)
 order by n;
