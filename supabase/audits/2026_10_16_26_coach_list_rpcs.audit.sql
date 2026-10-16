-- Audit for 2026_10_16_26_coach_list_rpcs. Read-only, one result table.
-- Run it before applying the migration, and again after.
--
--    check                                                        before                      after
--    1 running as                                                 postgres                    postgres
--    2 the sessions to review of each athlete are counted by the database (coach_review_counts, L18)
--                                                                 no                          yes
--    3 the conversations of an account are listed by the database (my_conversations, L18)
--                                                                 no                          yes
--    4 functions of these names that the migration does not know  none                        none
--    5 functions of this migration a request without a session may execute
--                                                                 none                        none
--    6 functions of this migration a signed-in user may execute   none                        coach_review_counts(); my_conversations()
--    7 functions of this migration that run as their owner        none                        none
--    8 functions of this migration without search_path = public, pg_temp
--                                                                 none                        none
--    9 session confirmations                                      a number                    the same number
--   10 … of sessions still to review, in a block out of the trash
--                                                                 a number                    the same number
--   11 coaches whose sessions to review the app counts from more than 1000 confirmations (L18)
--                                                                 a number                    the same number
--   12 messages                                                   a number                    the same number
--   13 conversations                                              a number                    the same number
--   14 accounts whose conversations the app folds from more than 1000 messages (L18)
--                                                                 a number                    the same number
--
-- Lines 2, 3 and 6 are the migration: they read as the "after" column once it
-- is applied.
-- Line 4 MUST read `none` before the migration: it refuses to run otherwise.
-- A function listed there has one of the two names and was made by hand.
-- Stop and report it. (Before the migration, lines 2 and 3 reading `yes` are
-- the same thing: the function is there and the ledger does not know why.)
-- Lines 9 to 14 are what the two functions read. The migration changes none
-- of them, and none of them stops it. Line 10 is the total of every coach's
-- "to review". Lines 11 and 14 are the accounts whose list the app that is
-- deployed reads cut: the API answers 1000 rows at most, the newest ones —
-- a coach of line 11 does not see the oldest of their sessions to review in
-- the counts, an account of line 14 the oldest of its conversations. 0 means
-- that nobody's list is cut yet.
-- This file never calls the two functions: it runs on a database that does
-- not have them.
with fn (signature) as (
  values ('public.coach_review_counts()'),
         ('public.my_conversations()')
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
     and p.proname in ('coach_review_counts', 'my_conversations')
),
-- The confirmations the roster reads: of a block out of the trash, with the
-- coach of its athlete.
confirmation as (
  select st.coach_id, s.reviewed_at is null and s.archived_at is null as to_review
    from public.session_confirmations c
    join public.sessions s  on s.id = c.session_id
    join public.weeks w     on w.id = s.week_id
    join public.programs p  on p.id = w.program_id
    join public.students st on st.id = p.student_id
   where p.deleted_at is null
),
-- Each message, once from each of its two sides.
side as (
  select m.sender_id as account from public.messages m
  union all
  select m.recipient_id from public.messages m
)
select "check", value, expected
  from (
    values
      (1, 'running as',
          current_user::text,
          'postgres'),
      (2, 'the sessions to review of each athlete are counted by the database (coach_review_counts, L18)',
          case when exists (select 1 from f where signature = 'public.coach_review_counts()')
               then 'yes' else 'no' end,
          'no before, yes after'),
      (3, 'the conversations of an account are listed by the database (my_conversations, L18)',
          case when exists (select 1 from f where signature = 'public.my_conversations()')
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
          'none, before and after'),
      (8, 'functions of this migration without search_path = public, pg_temp',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where not pinned_path),
          'none, before and after'),
      (9, 'session confirmations',
          (select count(*)::text from public.session_confirmations),
          'information; the same before and after'),
      (10, '… of sessions still to review, in a block out of the trash',
          (select count(*)::text from confirmation where to_review),
          'information; the same before and after'),
      (11, 'coaches whose sessions to review the app counts from more than 1000 confirmations (L18)',
          (select count(*)::text
             from (select coach_id from confirmation group by coach_id having count(*) > 1000) cut),
          'information — 0 while no roster is cut; the same before and after'),
      (12, 'messages',
          (select count(*)::text from public.messages),
          'information; the same before and after'),
      (13, 'conversations',
          (select count(*)::text
             from (select distinct least(m.sender_id, m.recipient_id), greatest(m.sender_id, m.recipient_id)
                     from public.messages m) pair),
          'information; the same before and after'),
      (14, 'accounts whose conversations the app folds from more than 1000 messages (L18)',
          (select count(*)::text
             from (select account from side group by account having count(*) > 1000) cut),
          'information — 0 while no list is cut; the same before and after')
  ) as t (n, "check", value, expected)
 order by n;
