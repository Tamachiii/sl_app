-- Audit for 2026_10_13_13_ensure_claim_rpcs. Read-only, one result table.
-- Run it before applying the migration, and again after.
--
--    check                                                        before                      after
--    1 running as                                                 postgres                    postgres
--    2 the missing sets of a session are added by the database (ensure_set_logs, L8)
--                                                                 no                          yes
--    3 a device's push subscription follows the account that signs in (claim_push_subscription, P15)
--                                                                 no                          yes
--    4 functions of these names that the migration does not know  none                        none
--    5 functions of this migration a request without a session may execute
--                                                                 none                        none
--    6 functions of this migration a signed-in user may execute   none                        claim_push_subscription(text, text, text, text); ensure_set_logs(uuid)
--    7 functions of this migration that run as their owner        none                        claim_push_subscription(text, text, text, text); ensure_set_logs(uuid)
--    8 functions of this migration without search_path = public, pg_temp
--                                                                 none                        none
--    9 exercises of a session in progress that miss a set         a number                    the same number
--   10 devices registered for notifications                       a number                    the same number
--
-- Lines 2, 3, 6 and 7 are the migration: they read as the "after" column
-- once it is applied. Line 7 is meant: the two functions do what no policy
-- allows — add a set with the coach's targets, take a device over from
-- another account — so they run as their owner, and ask who calls first.
-- Line 4 MUST read `none` before the migration: it refuses to run otherwise.
-- A function listed there has one of the two names and was made by hand.
-- Stop and report it. (Before the migration, lines 2 and 3 reading `yes` are
-- the same thing: the function is there and the ledger does not know why.)
-- Lines 9 and 10 are what the two functions work on. The migration changes
-- neither, and neither stops it:
--    9  exercises that have fewer sets in the database than their number of
--       sets says, in a session its athlete can still write: the block being
--       trained, a session neither archived nor reviewed. The athlete's app
--       adds the missing ones when the session is opened — with its own
--       INSERT today, through ensure_set_logs with the next version
--       (docs/runbook/migrations/13-ensure-claim-rpcs.md, "Exercises that
--       miss a set").
--   10  rows of push_subscriptions: one per browser or phone on which an
--       account has switched notifications on.
with fn (signature) as (
  values ('public.ensure_set_logs(uuid)'),
         ('public.claim_push_subscription(text, text, text, text)')
),
-- Those of the two that exist: none before the migration, both after.
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
     and p.proname in ('ensure_set_logs', 'claim_push_subscription')
)
select "check", value, expected
  from (
    values
      (1, 'running as',
          current_user::text,
          'postgres'),
      (2, 'the missing sets of a session are added by the database (ensure_set_logs, L8)',
          case when exists (select 1 from f where signature = 'public.ensure_set_logs(uuid)')
               then 'yes' else 'no' end,
          'no before, yes after'),
      (3, 'a device''s push subscription follows the account that signs in (claim_push_subscription, P15)',
          case when exists (select 1 from f where signature = 'public.claim_push_subscription(text, text, text, text)')
               then 'yes' else 'no' end,
          'no before, yes after'),
      (4, 'functions of these names that the migration does not know',
          (select coalesce(string_agg(n.shown, '; ' order by n.shown collate "C"), 'none')
             from named n
            where not exists (select 1 from fn where to_regprocedure(fn.signature) = n.oid)),
          'none — otherwise stop and report the line'),
      (5, 'functions of this migration a request without a session may execute',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where anon_may),
          'none, before and after'),
      (6, 'functions of this migration a signed-in user may execute',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where user_may),
          'none before; the two of them after'),
      (7, 'functions of this migration that run as their owner',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where as_owner),
          'none before; the two of them after'),
      (8, 'functions of this migration without search_path = public, pg_temp',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where not pinned_path),
          'none, before and after'),
      (9, 'exercises of a session in progress that miss a set',
          (select count(*)::text
             from public.exercise_slots es
             join public.sessions s on s.id = es.session_id
             join public.weeks w    on w.id = s.week_id
             join public.programs p on p.id = w.program_id
            where p.is_active and p.deleted_at is null
              and s.archived_at is null and s.reviewed_at is null
              and exists (select 1
                            from generate_series(1, es.sets) as wanted (n)
                           where not exists (select 1 from public.set_logs sl
                                              where sl.exercise_slot_id = es.id and sl.set_number = wanted.n))),
          'information — added when the athlete opens the session; the same before and after'),
      (10, 'devices registered for notifications',
          (select count(*)::text from public.push_subscriptions),
          'information; the same before and after')
  ) as t (n, "check", value, expected)
 order by n;
