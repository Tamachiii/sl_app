-- Audit for 2026_10_11_07_profile_rules. Read-only, one result table.
-- Run it before applying the migration, and again after.
--
--    check                                                        before                      after
--    1 running as                                                 postgres                    postgres
--    2 a new account gets its profile                             in place                    in place
--    3 a new account created without a name is given one (B10)    no                          yes
--    4 a signed-in user cannot change the role of a profile       in place                    in place
--    5 the owner of the database can change it (P20)              no                          yes
--    6 a role that a coach-athlete link stands against is refused no                          yes
--    7 functions of this migration a request without a session may execute
--                                                                 none                        none
--    8 functions of this migration a signed-in user may execute   none                        none
--    9 functions of this migration without search_path = public, pg_temp
--                                                                 none                        none
--   10 profiles without a name                                    0                           0
--   11 accounts                                                   a sentence                  the same sentence
--
-- Lines 3, 5 and 6 are the findings: they read as the "after" column once
-- the migration is applied.
-- Line 2 is the trigger on auth.users that gives every account its profile.
-- It must read "in place" before and after: the migration does not write it,
-- and refuses to run where it is missing or switched off.
-- Line 4 is the pin that was already there. It must read "in place" before
-- and after: "missing" before means it was dropped or switched off by hand —
-- any signed-in user could then make themselves a coach — and the migration
-- puts it back.
-- Line 10 is information and does not stop the migration, which changes none
-- of those rows: accounts created without a name before it. The runbook page
-- has the statement that names them
-- (docs/runbook/migrations/07-profile-rules.md).
-- Line 11 is information: how many profiles are coaches, and how many
-- athletes.
with fn (name, signature) as (
  values
    ('handle_new_user',                'public.handle_new_user()'),
    ('profiles_pin_immutable_columns', 'public.profiles_pin_immutable_columns()')
),
-- Both exist before the migration and after.
f as (
  select fn.name,
         p.oid,
         p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as shown,
         p.prosrc,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon_may,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as user_may,
         exists (select 1 from unnest(p.proconfig) as setting
                  where setting = 'search_path=public, pg_temp') as pinned_path
    from fn
    join pg_proc p on p.oid = to_regprocedure(fn.signature)
),
-- The triggers of the two tables, by the function they call: in place means
-- there, calling that function, and not switched off.
trg as (
  select n.nspname as sch, c.relname as tbl, f.name as calls
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join f on f.oid = t.tgfoid
   where not t.tgisinternal
     and t.tgenabled in ('O', 'A')
),
-- What the two functions do, read off their text.
body as (
  select coalesce((select prosrc from f where name = 'handle_new_user'), '') as new_user,
         coalesce((select prosrc from f where name = 'profiles_pin_immutable_columns'), '') as pin
)
select "check", value, expected
  from (
    values
      (1, 'running as',
          current_user::text,
          'postgres'),
      (2, 'a new account gets its profile',
          case when exists (select 1 from trg
                             where sch = 'auth' and tbl = 'users' and calls = 'handle_new_user')
               then 'in place' else 'missing' end,
          'in place, before and after'),
      (3, 'a new account created without a name is given one (B10)',
          (select case when new_user like '%split_part(NEW.email, ''@'', 1)%'
                        and new_user like '%COALESCE(v_name, ''Athlete'')%'
                       then 'yes' else 'no' end
             from body),
          'no before, yes after'),
      (4, 'a signed-in user cannot change the role of a profile',
          (select case when exists (select 1 from trg
                                     where sch = 'public' and tbl = 'profiles'
                                       and calls = 'profiles_pin_immutable_columns')
                        and pin ~ 'NEW\.role\s*:=\s*OLD\.role\s*;'
                       then 'in place' else 'missing' end
             from body),
          'in place, before and after'),
      (5, 'the owner of the database can change it (P20)',
          (select case when pin ~ 'IF auth\.uid\(\) IS NOT NULL THEN\s+NEW\.role\s*:=\s*OLD\.role\s*;'
                       then 'yes' else 'no' end
             from body),
          'no before, yes after'),
      (6, 'a role that a coach-athlete link stands against is refused',
          (select case when pin like '%cannot be made a coach%'
                        and pin like '%cannot stop being a coach%'
                       then 'yes' else 'no' end
             from body),
          'no before, yes after'),
      (7, 'functions of this migration a request without a session may execute',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where anon_may),
          'none, before and after'),
      (8, 'functions of this migration a signed-in user may execute',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where user_may),
          'none, before and after'),
      (9, 'functions of this migration without search_path = public, pg_temp',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where not pinned_path),
          'none, before and after'),
      (10, 'profiles without a name',
          (select count(*)::text from public.profiles where full_name !~ '[^[:space:]]'),
          '0 — otherwise go on, and name them afterwards'),
      (11, 'accounts',
          (select count(*) filter (where role = 'coach') || ' coach(es), '
                  || count(*) filter (where role = 'student') || ' athlete(s)'
             from public.profiles),
          'information; the same before and after')
  ) as t (n, "check", value, expected)
 order by n;
