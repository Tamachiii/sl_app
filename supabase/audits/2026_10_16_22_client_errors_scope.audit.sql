-- Audit for 2026_10_16_22_client_errors_scope. Read-only, one result table.
-- Run it before applying the migration, and again after.
--
--    check                                                        before                      after
--    1 running as                                                 postgres                    postgres
--    2 who reads a client error (B6)                              every coach, every line     its author and the coach of its author; every coach, a line without an author
--    3 how many lines an account reports in an hour (L20)         no limit                    30 — the next ones are dropped
--    4 policies of client_errors that the migration does not know none                        none
--    5 lines                                                      a number                    the same number
--    6 … without an author: the database's, or of an account that was deleted
--                                                                 a number                    the same number
--    7 … of an account that no coach of today coaches, other than a coach's own
--                                                                 a number                    the same number
--    8 the most lines one account reported within one hour        a number                    the same number
--    9 lines older than 90 days, which run_retention() deletes    a number                    the same number
--
-- Lines 2 and 3 are the migration: they read as the "after" column once it
-- is applied. Lines 2 and 4 decide whether the migration runs at all:
--    2  MUST read `every coach, every line` before. A line that starts with
--       SOMETHING ELSE: stop and report it.
--    4  MUST read `none`: a policy listed there was made by hand, and would
--       go on letting through what the migration closes. Stop and report.
-- Lines 5 to 9 are the rows. The migration writes none of them:
--    6  read by every coach, before and after.
--    7  lines of an account that is no longer, or never was, somebody's
--       athlete: before, every coach read them; after, their author only.
--    8  above 30, the cap would have dropped the lines of that hour beyond
--       the 30th. The runbook page lists the accounts.
--    9  0 where run_retention() runs (the monthly step of the owner, or the
--       job of migration 19).
with rule as (
  select p.polname, p.polcmd,
         pg_get_expr(p.polqual, p.polrelid) as qual
    from pg_policy p
   where p.polrelid = 'public.client_errors'::regclass
),
cap as (
  select t.tgenabled
    from pg_trigger t
   where t.tgrelid = 'public.client_errors'::regclass
     and t.tgname = 'trg_cap_client_errors' and not t.tgisinternal
),
e as (
  select e.user_id, e.created_at,
         e.user_id is not null
           and not exists (select 1 from public.students s where s.profile_id = e.user_id)
           and not exists (select 1 from public.profiles p where p.id = e.user_id and p.role = 'coach') as unlinked
    from public.client_errors e
)
select "check", value, expected
  from (
    values
      (1, 'running as',
          current_user::text,
          'postgres'),
      (2, 'who reads a client error (B6)',
          case
            when (select count(*) from rule where polcmd = 'r') = 1
                 and exists (select 1 from rule where polname = 'Coaches read client errors' and polcmd = 'r')
              then 'every coach, every line'
            when (select count(*) from rule where polcmd = 'r') = 1
                 and exists (select 1 from rule where polname = 'Authors and their coach read client errors' and polcmd = 'r')
              then 'its author and the coach of its author; every coach, a line without an author'
            else 'SOMETHING ELSE: ' || coalesce((select string_agg(polname, ', ' order by polname) from rule where polcmd in ('r', '*')), 'nobody')
          end,
          'every coach, every line before — otherwise stop and report; the other after'),
      (3, 'how many lines an account reports in an hour (L20)',
          case
            when not exists (select 1 from cap) then 'no limit'
            when (select tgenabled from cap) = 'O' then '30 — the next ones are dropped'
            else 'no limit: trg_cap_client_errors is SWITCHED OFF'
          end,
          'no limit before, 30 after'),
      (4, 'policies of client_errors that the migration does not know',
          coalesce((select string_agg(polname, ', ' order by polname)
                      from rule
                     where polname not in ('Users insert own client errors', 'Coaches read client errors',
                                           'Authors and their coach read client errors')),
                   'none'),
          'none — otherwise stop and report the line'),
      (5, 'lines',
          (select count(*)::text from e),
          'information; the same before and after'),
      (6, '… without an author: the database''s, or of an account that was deleted',
          (select count(*)::text from e where e.user_id is null),
          'information; the same before and after'),
      (7, '… of an account that no coach of today coaches, other than a coach''s own',
          (select count(*)::text from e where e.unlinked),
          'information; the same before and after'),
      (8, 'the most lines one account reported within one hour',
          coalesce((select max(n)::text
                      from (select (select count(*) from e e2
                                     where e2.user_id = e1.user_id
                                       and e2.created_at > e1.created_at - interval '1 hour'
                                       and e2.created_at <= e1.created_at) as n
                              from e e1
                             where e1.user_id is not null) w),
                   '0'),
          'information; the same before and after — above 30, the page lists the accounts'),
      (9, 'lines older than 90 days, which run_retention() deletes',
          (select count(*)::text from e where e.created_at < now() - interval '90 days'),
          'information; 0 where run_retention() runs')
  ) as t (n, "check", value, expected)
 order by n;
